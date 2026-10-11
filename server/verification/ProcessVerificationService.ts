import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  formatVerificationCommand,
  PROCESS_OUTPUT_TAIL_MAX_BYTES,
  verificationCommandSchema,
  verificationCommandProblem,
  type ActionableReviewFinding,
  type DecideCapturedVerificationEvidenceInput,
  type ListCapturedVerificationsInput,
  type ListCapturedVerificationsResult,
  type PollCapturedVerificationInput,
  type ProcessVerificationOutcome,
  type ProcessVerificationResult,
  type ReviewRequest,
  type StartCapturedVerificationInput,
} from "../../shared/review";
import { canonicalJson, sha256 } from "../util/crypto";
import { createMutex, type Mutex } from "../util/mutex";
import {
  ProcessVerificationStore,
  type ProcessVerificationRecord,
} from "../persistence/ProcessVerificationStore";
import {
  ProcessRunner,
  processRunnerSupported,
  type ProcessCompletion,
  type ProcessRunHandle,
} from "./ProcessRunner";
export const PROCESS_VERIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;
const MAX_CONCURRENT_PROCESS_RUNS = 2;
const MAX_CONCURRENT_PROCESS_RUNS_PER_WORKSPACE = 1;
const OUTPUT_MEMORY_MAX_ENTRIES = 64;

type ProcessReviewRequestMetadata = Pick<ReviewRequest, "scope" | "baseRef" | "headRef" | "filePath">;

type TrustedProcessFinding = {
  finding: ActionableReviewFinding;
  request: ProcessReviewRequestMetadata;
};

type ProcessOutput = { outputTail: string[]; outputTruncated: boolean };
function sanitizeProcessOutput(output: ProcessOutput): ProcessOutput {
  const outputTail: string[] = [];
  let remainingBytes = PROCESS_OUTPUT_TAIL_MAX_BYTES;
  let outputTruncated = output.outputTruncated;
  for (const line of output.outputTail) {
    const escaped = line.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, (character) =>
      `\\u{${character.codePointAt(0)?.toString(16).toUpperCase()}}`,
    );
    let bounded = "";
    for (const character of escaped) {
      const bytes = Buffer.byteLength(character, "utf8");
      if (bytes > remainingBytes) {
        outputTruncated = true;
        break;
      }
      bounded += character;
      remainingBytes -= bytes;
    }
    if (bounded.length > 0 || escaped.length === 0) outputTail.push(bounded);
    if (bounded.length < escaped.length) {
      outputTruncated = true;
      break;
    }
  }
  return { outputTail, outputTruncated };
}

type ProcessReservation = {
  runId: string;
  workspaceId: string;
  projectId: string;
  cwd: string;
  findingId: string;
  reviewRunId: string;
  targetFingerprint: string;
  commandHash: string;
};

type LiveProcess = ProcessReservation & {
  handle: ProcessRunHandle;
};

export interface ProcessVerificationServiceDependencies {
  store?: ProcessVerificationStore;
  runner?: ProcessRunner;
  /** Current target identity, derived from the same snapshot path as review. */
  reviewedTarget(request: ReviewRequest): Promise<{ targetFingerprint: string; worktreePath: string }>;
  /** Fail-closed, symlink-aware directory comparison. */
  sameDirectory(left: string, right: string): Promise<boolean>;
  /** Workspace id → its current project and directory. */
  workspaceIdentity(workspaceId: string, context: PluginHandlerContext): Promise<{ projectId: string; directory: string }>;
  platform?: NodeJS.Platform;
  /** Resolve a server-owned Finding and its run-bound request metadata. */
  trustedFinding(input: {
    workspaceId: string;
    agentId: string;
    reviewRunId: string;
    findingId: string;
    expectedTargetFingerprint: string;
  }, context: PluginHandlerContext): Promise<TrustedProcessFinding | null>;
}

/**
 * Captured Process mode is separate from `VerificationService`: it runs one
 * explicitly approved direct executable + argv, records only metadata and the
 * OS-observed completion, and never infers that a Finding is fixed.
 */
export class ProcessVerificationService {
  private readonly store: ProcessVerificationStore;
  private readonly runner: ProcessRunner;
  private readonly dependencies: ProcessVerificationServiceDependencies;
  private readonly platform: NodeJS.Platform;
  private readonly live = new Map<string, LiveProcess>();
  private readonly outputByRun = new Map<string, ProcessOutput>();
  private readonly startMutex: Mutex = createMutex();
  private readonly reservations = new Map<string, ProcessReservation>();
  private stopping = false;

  constructor(dependencies: ProcessVerificationServiceDependencies) {
    this.store = dependencies.store ?? new ProcessVerificationStore();
    this.platform = dependencies.platform ?? process.platform;
    this.runner = dependencies.runner ?? new ProcessRunner({ platform: this.platform });
    this.dependencies = dependencies;
  }

  supported(): boolean {
    return processRunnerSupported(this.platform);
  }

  async start(input: StartCapturedVerificationInput, context: PluginHandlerContext): Promise<ProcessVerificationResult> {
    if (this.stopping) throw new Error("Review Deck is stopping; no captured verification process was started.");
    if (!this.supported()) {
      throw new Error("Captured verification is disabled on this host because process-group termination has not been verified.");
    }

    const identity = await this.dependencies.workspaceIdentity(input.workspaceId, context);
    const trusted = await this.dependencies.trustedFinding({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      reviewRunId: input.reviewRunId,
      findingId: input.findingId,
      expectedTargetFingerprint: input.expectedTargetFingerprint,
    }, context);
    if (!trusted) throw new Error("The selected Finding is not available from a completed, workspace-bound AI review.");
    const finding = trusted.finding;
    if (
      finding.workspaceId !== input.workspaceId ||
      finding.agentId !== input.agentId ||
      finding.reviewRunId !== input.reviewRunId ||
      finding.targetFingerprint !== input.expectedTargetFingerprint ||
      finding.anchorStatus !== "resolved"
    ) {
      throw new Error("The Finding no longer matches the confirmed workspace, target, or unique anchor.");
    }
    const commandCandidate = finding.verificationCommand;
    if (!commandCandidate || !finding.verificationCommandHash) {
      throw new Error("The selected Finding has no trusted structured verification command.");
    }
    const parsedCommand = verificationCommandSchema.safeParse(commandCandidate);
    if (!parsedCommand.success) {
      throw new Error(verificationCommandProblem(commandCandidate) ?? "The trusted verification command is invalid.");
    }
    const command = parsedCommand.data;
    const commandHash = sha256(canonicalJson({ executable: command.executable, args: command.args }));
    if (commandHash !== finding.verificationCommandHash || commandHash !== input.expectedCommandHash) {
      throw new Error("The confirmed command does not match the Finding's trusted executable and arguments.");
    }
    const commandProblem = processVerificationCommandProblem(command);
    if (commandProblem) throw new Error(`Captured verification refused: ${commandProblem}`);

    const request: ReviewRequest = { cwd: identity.directory, ...trusted.request };
    const target = await this.dependencies.reviewedTarget(request);
    if (
      target.targetFingerprint !== input.expectedTargetFingerprint ||
      !(await this.dependencies.sameDirectory(identity.directory, target.worktreePath))
    ) {
      throw new Error("The reviewed target or workspace changed before the process could start.");
    }

    const runId = randomUUID();
    const reservation: ProcessReservation = {
      runId,
      workspaceId: input.workspaceId,
      projectId: identity.projectId,
      cwd: target.worktreePath,
      findingId: finding.id,
      reviewRunId: finding.reviewRunId,
      targetFingerprint: target.targetFingerprint,
      commandHash,
    };
    const admission = await this.startMutex.run(async () => {
      if (this.stopping) throw new Error("Review Deck is stopping; no captured verification process was started.");
      const activeRuns: ProcessReservation[] = [
        ...this.live.values(),
        ...this.reservations.values(),
      ];
      const sameFinding = activeRuns.find((run) =>
        run.workspaceId === reservation.workspaceId &&
        run.findingId === reservation.findingId &&
        run.reviewRunId === reservation.reviewRunId &&
        run.targetFingerprint === reservation.targetFingerprint &&
        run.commandHash === reservation.commandHash,
      );
      if (sameFinding) {
        return this.reservations.has(sameFinding.runId)
          ? { kind: "preparing" as const }
          : { kind: "existing" as const, runId: sameFinding.runId };
      }
      const activeInWorkspace = activeRuns.filter((run) => run.workspaceId === reservation.workspaceId).length;
      if (
        activeRuns.length >= MAX_CONCURRENT_PROCESS_RUNS ||
        activeInWorkspace >= MAX_CONCURRENT_PROCESS_RUNS_PER_WORKSPACE
      ) {
        throw new Error("A captured verification process is already running for this workspace. Wait for it to finish or cancel it.");
      }
      this.reservations.set(runId, reservation);
      return { kind: "reserved" as const };
    });
    if (admission.kind === "existing") {
      return this.poll({ runId: admission.runId, workspaceId: input.workspaceId }, context);
    }
    if (admission.kind === "preparing") {
      throw new Error("A captured verification process for this Finding is already being prepared.");
    }

    const record: ProcessVerificationRecord = {
      ...reservation,
      targetChanged: false,
      commandPreview: formatVerificationCommand(command),
      command,
      ...trusted.request,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    let runCreated = false;
    let handle: ProcessRunHandle | undefined;
    const startedAt = new Date().toISOString();
    try {
      await this.store.create(record);
      runCreated = true;
      let beforeSpawnTarget: { targetFingerprint: string; worktreePath: string } | null = null;
      try {
        beforeSpawnTarget = await this.dependencies.reviewedTarget(request);
      } catch {
        beforeSpawnTarget = null;
      }
      let beforeSpawnMatches = false;
      try {
        beforeSpawnMatches =
          beforeSpawnTarget !== null &&
          beforeSpawnTarget.targetFingerprint === target.targetFingerprint &&
          await this.dependencies.sameDirectory(identity.directory, beforeSpawnTarget.worktreePath);
      } catch {
        beforeSpawnMatches = false;
      }
      if (!beforeSpawnMatches) {
        await this.store.update(runId, (run) => ({
          ...run,
          status: "error",
          completedAt: new Date().toISOString(),
          ...(beforeSpawnTarget ? { observedTargetFingerprint: beforeSpawnTarget.targetFingerprint } : {}),
          targetChanged: true,
        }));
        throw new Error("The reviewed target changed after confirmation; no process was started.");
      }
      if (this.stopping) {
        await this.store.update(runId, (run) => ({
          ...run,
          status: "canceled",
          completedAt: new Date().toISOString(),
        }));
        throw new Error("Review Deck stopped before the captured process could start.");
      }
      handle = this.runner.start({
        runId,
        executable: command.executable,
        args: command.args,
        cwd: target.worktreePath,
        timeoutMs: DEFAULT_PROCESS_TIMEOUT_MS,
      });
      this.live.set(runId, { ...reservation, handle });
      this.reservations.delete(runId);
      const running = await this.store.update(runId, (current) =>
        current.status === "pending" ? { ...current, status: "running", startedAt } : current,
      );
      if (!running || running.status !== "running") {
        handle.cancel();
        throw new Error("The captured verification run could not enter its running state.");
      }
      void handle.completion.then((completion) => this.finish(runId, startedAt, completion)).catch((error: unknown) => {
        console.error(`[Review Deck] Could not settle captured verification run ${runId}.`, error);
      });
      return this.result(running, false);
    } catch (error) {
      this.reservations.delete(runId);
      if (handle) {
        handle.cancel();
        void handle.completion.then((completion) => this.finish(runId, startedAt, completion)).catch(() => undefined);
      } else if (runCreated) {
        await this.store.update(runId, (run) =>
          run.status === "pending"
            ? { ...run, status: "error", completedAt: new Date().toISOString(), errorCode: "spawn_failed" }
            : run,
        ).catch(() => null);
      }
      throw error;
    }
  }

  async poll(input: PollCapturedVerificationInput, context: PluginHandlerContext): Promise<ProcessVerificationResult> {
    const run = await this.store.get(input.runId);
    if (!run || run.workspaceId !== input.workspaceId) {
      throw new Error("The captured verification run is not available in this workspace.");
    }
    let identity: { projectId: string; directory: string };
    try {
      identity = await this.dependencies.workspaceIdentity(input.workspaceId, context);
    } catch (error) {
      this.live.get(run.runId)?.handle.cancel();
      throw error;
    }
    let workspaceMatches = false;
    try {
      workspaceMatches =
        identity.projectId === run.projectId &&
        await this.dependencies.sameDirectory(identity.directory, run.cwd);
    } catch {
      workspaceMatches = false;
    }
    if (!workspaceMatches) {
      this.live.get(run.runId)?.handle.cancel();
      throw new Error("The captured verification run no longer belongs to this workspace and project.");
    }
    const request = this.requestForRun(run, identity.directory);
    let target: { targetFingerprint: string; worktreePath: string } | null = null;
    try {
      if (request) target = await this.dependencies.reviewedTarget(request);
    } catch {
      target = null;
    }
    let targetMatches = false;
    try {
      targetMatches =
        target !== null &&
        target.targetFingerprint === run.targetFingerprint &&
        await this.dependencies.sameDirectory(identity.directory, target.worktreePath);
    } catch {
      targetMatches = false;
    }
    const targetChanged = !targetMatches || run.targetChanged === true;
    if (targetChanged) this.live.get(run.runId)?.handle.cancel();

    let current = run;
    if (
      target?.targetFingerprint !== run.observedTargetFingerprint ||
      targetChanged !== (run.targetChanged ?? false)
    ) {
      current = (await this.store.update(run.runId, (stored) => ({
        ...stored,
        ...(target ? { observedTargetFingerprint: target.targetFingerprint } : {}),
        targetChanged: (stored.targetChanged ?? false) || targetChanged,
      }))) ?? current;
    }
    if ((current.status === "pending" || current.status === "running") && !this.live.has(current.runId)) {
      current = (await this.store.update(current.runId, (stored) =>
        stored.status === "pending" || stored.status === "running"
          ? { ...stored, status: "abandoned", completedAt: new Date().toISOString() }
          : stored,
      )) ?? current;
    }
    return this.result(current, targetChanged, this.outputByRun.get(run.runId));
  }

  async cancel(input: PollCapturedVerificationInput, context: PluginHandlerContext): Promise<ProcessVerificationResult> {
    const current = await this.poll(input, context);
    if (current.status !== "pending" && current.status !== "running") return current;
    const active = this.live.get(current.runId);
    if (!active) return current;
    active.handle.cancel();
    return this.poll(input, context);
  }

  async list(input: ListCapturedVerificationsInput, context: PluginHandlerContext): Promise<ListCapturedVerificationsResult> {
    let identity: { projectId: string; directory: string };
    try {
      identity = await this.dependencies.workspaceIdentity(input.workspaceId, context);
    } catch (error) {
      for (const run of this.live.values()) {
        if (run.workspaceId === input.workspaceId) run.handle.cancel();
      }
      throw error;
    }
    const candidates: ProcessVerificationRecord[] = [];
    for (const run of await this.store.list()) {
      if (run.workspaceId !== input.workspaceId || run.projectId !== identity.projectId) continue;
      try {
        if (await this.dependencies.sameDirectory(identity.directory, run.cwd)) candidates.push(run);
        else this.live.get(run.runId)?.handle.cancel();
      } catch {
        this.live.get(run.runId)?.handle.cancel();
      }
    }
    candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const runs = await Promise.all(candidates.map((run) => this.poll({ runId: run.runId, workspaceId: input.workspaceId }, context)));
    return { runs, targetChanged: runs.some((run) => run.targetChanged), supported: this.supported() };
  }

  async decide(input: DecideCapturedVerificationEvidenceInput, context: PluginHandlerContext): Promise<ProcessVerificationResult> {
    const current = await this.poll({ runId: input.runId, workspaceId: input.workspaceId }, context);
    if (current.targetChanged || current.targetFingerprint !== input.expectedTargetFingerprint) {
      throw new Error("This evidence belongs to a different target and cannot be used to record the current review decision.");
    }
    if (current.status === "pending" || current.status === "running" || current.status === "abandoned") {
      throw new Error("A final human decision requires an observed process completion; this run is still unknown.");
    }
    const updated = await this.store.update(input.runId, (run) => ({
      ...run,
      humanDecision: input.decision,
      decisionAt: new Date().toISOString(),
    }));
    if (!updated) throw new Error("The captured verification run is no longer available.");
    return this.result(updated, false, this.outputByRun.get(updated.runId));
  }

  async prune(retentionMs = PROCESS_VERIFICATION_TTL_MS): Promise<number> {
    return this.store.pruneCompletedBefore(new Date(Date.now() - retentionMs).toISOString());
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await this.runner.shutdown();
  }

  private requestForRun(run: ProcessVerificationRecord, cwd: string): ReviewRequest | null {
    if (run.scope === undefined) return null;
    return {
      cwd,
      scope: run.scope,
      ...(run.baseRef ? { baseRef: run.baseRef } : {}),
      ...(run.headRef ? { headRef: run.headRef } : {}),
      ...(run.filePath ? { filePath: run.filePath } : {}),
    };
  }

  private async finish(runId: string, startedAt: string, completion: ProcessCompletion): Promise<void> {
    const completedAt = new Date().toISOString();
    let observedTargetFingerprint: string | undefined;
    let targetChanged = false;
    try {
      const current = await this.store.get(runId);
      if (!current) {
        targetChanged = true;
      } else {
        targetChanged = current.targetChanged === true;
        const request = this.requestForRun(current, current.cwd);
        if (!request) {
          targetChanged = true;
        } else {
          const target = await this.dependencies.reviewedTarget(request);
          const directoryMatches = await this.dependencies.sameDirectory(current.cwd, target.worktreePath);
          if (directoryMatches) observedTargetFingerprint = target.targetFingerprint;
          targetChanged ||= !directoryMatches || target.targetFingerprint !== current.targetFingerprint;
        }
      }
    } catch {
      targetChanged = true;
    }
    let updated: ProcessVerificationRecord | null = null;
    try {
      updated = await this.store.update(runId, (run) => {
        if (run.status !== "pending" && run.status !== "running") return run;
        return {
          ...run,
          status: completion.status,
          startedAt: run.startedAt ?? startedAt,
          completedAt,
          ...(observedTargetFingerprint ? { observedTargetFingerprint } : {}),
          targetChanged: (run.targetChanged ?? false) || targetChanged,
          ...(completion.status === "exited" && completion.exitCode !== undefined ? { exitCode: completion.exitCode } : {}),
          ...(completion.signal !== undefined ? { signal: completion.signal } : {}),
          ...(completion.errorCode !== undefined ? { errorCode: completion.errorCode } : {}),
        };
      });
    } catch (error) {
      console.error(`[Review Deck] Could not persist captured verification completion ${runId}.`, error);
    }
    this.outputByRun.set(runId, { outputTail: completion.outputTail, outputTruncated: completion.outputTruncated });
    while (this.outputByRun.size > OUTPUT_MEMORY_MAX_ENTRIES) {
      const oldest = this.outputByRun.keys().next().value;
      if (oldest === undefined) break;
      this.outputByRun.delete(oldest);
    }
    this.live.delete(runId);
    if (!updated) console.error(`[Review Deck] Captured verification run ${runId} disappeared before completion was stored.`);
  }

  private result(
    run: ProcessVerificationRecord,
    targetChanged: boolean,
    output?: ProcessOutput,
  ): ProcessVerificationResult {
    const outcome: ProcessVerificationOutcome = run.status === "exited"
      ? run.exitCode === 0 ? "exit_0" : run.exitCode !== undefined ? "exit_nonzero" : "unknown"
      : run.status === "timed_out"
        ? "timeout"
        : run.status === "canceled"
          ? "canceled"
          : "unknown";
    const observedAt = run.completedAt ?? run.startedAt ?? run.createdAt;
    const stale = targetChanged || run.targetChanged === true;
    const safeOutput = output ? sanitizeProcessOutput(output) : undefined;
    const evidence = {
      id: run.runId,
      source: "verification_run" as const,
      runId: run.runId,
      ...(run.reviewRunId ? { reviewRunId: run.reviewRunId } : {}),
      workspaceId: run.workspaceId,
      targetFingerprint: run.targetFingerprint,
      ...(run.observedTargetFingerprint ? { observedTargetFingerprint: run.observedTargetFingerprint } : {}),
      targetChanged: stale,
      commandHash: run.commandHash,
      observedAt,
      outcome,
      ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
      ...(run.signal !== undefined ? { signal: run.signal } : {}),
      ...(run.findingId ? { linkedFindingId: run.findingId } : {}),
      ...(run.humanDecision ? { humanDecision: run.humanDecision } : {}),
      ...(run.decisionAt ? { decisionAt: run.decisionAt } : {}),
    };
    return {
      ...(run.reviewRunId ? { reviewRunId: run.reviewRunId } : {}),
      runId: run.runId,
      status: run.status,
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      targetFingerprint: run.targetFingerprint,
      ...(run.observedTargetFingerprint ? { observedTargetFingerprint: run.observedTargetFingerprint } : {}),
      ...(run.findingId ? { findingId: run.findingId } : {}),
      commandHash: run.commandHash,
      commandPreview: run.commandPreview,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.completedAt ? { completedAt: run.completedAt } : {}),
      ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
      ...(run.signal !== undefined ? { signal: run.signal } : {}),
      ...(run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
      ...(safeOutput ? { outputTail: safeOutput.outputTail, outputTruncated: safeOutput.outputTruncated } : {}),
      targetChanged: stale,
      evidence,
    };
  }
}

/** Captured mode accepts named test/build tools only; it never treats an unknown executable alias as safe. */
export function processVerificationCommandProblem(command: { executable: string; args: readonly string[] }): string | null {
  const executable = basename(command.executable).toLowerCase();
  const directNodeRuntime = command.executable === process.execPath;
  if (/[\\/]/.test(command.executable) && !directNodeRuntime) {
    return "Captured mode accepts only approved executable names; custom executable paths must use the interactive Terminal.";
  }
  if (PROCESS_APPROVED_EXECUTABLES[executable] !== true) {
    return `Captured mode does not allow executable ${executable}; use an approved test/build tool or the interactive Terminal.`;
  }
  const flags = PROCESS_EVAL_FLAGS[executable];
  const found = flags?.find((flag) => command.args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)));
  if (found !== undefined) return `Inline code-evaluation argument ${found} is not accepted in captured process mode.`;
  if (PACKAGE_MANAGER_EXECUTABLES[executable] === true) {
    const subcommand = command.args[0]?.toLowerCase() ?? "";
    if (SECONDARY_PACKAGE_LAUNCHERS[subcommand] === true) {
      return "Secondary package launchers are not accepted in captured process mode.";
    }
    const nestedInterpreter = command.args.find((arg) => NESTED_EXECUTABLES[arg.toLowerCase()] === true);
    if (nestedInterpreter !== undefined) {
      return `Package managers may not launch nested interpreter ${nestedInterpreter} in captured process mode.`;
    }
  }
  return null;
}

const PROCESS_APPROVED_EXECUTABLES: Record<string, true> = {
  node: true,
  "node.exe": true,
  npm: true,
  pnpm: true,
  yarn: true,
  bun: true,
  "bun.exe": true,
  python: true,
  python3: true,
  "python.exe": true,
  pytest: true,
  pytest3: true,
  ruby: true,
  perl: true,
  php: true,
  deno: true,
  cargo: true,
  go: true,
  gradle: true,
  mvn: true,
  dotnet: true,
  make: true,
  ctest: true,
  swift: true,
  xcodebuild: true,
  tsc: true,
  jest: true,
  vitest: true,
  mocha: true,
};
const PACKAGE_MANAGER_EXECUTABLES: Record<string, true> = {
  npm: true,
  pnpm: true,
  yarn: true,
  bun: true,
};
const SECONDARY_PACKAGE_LAUNCHERS: Record<string, true> = {
  exec: true,
  dlx: true,
  x: true,
};
const NESTED_EXECUTABLES: Record<string, true> = {
  node: true,
  "node.exe": true,
  nodejs: true,
  python: true,
  python3: true,
  "python3.12": true,
  ruby: true,
  perl: true,
  php: true,
  deno: true,
  bun: true,
  npx: true,
  corepack: true,
  sh: true,
  bash: true,
  cmd: true,
  powershell: true,
};

const PROCESS_EVAL_FLAGS: Record<string, readonly string[]> = {
  node: ["-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader", "--experimental-loader"],
  "node.exe": ["-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader", "--experimental-loader"],
  bun: ["-e", "--eval", "-p", "--print", "--preload", "--require"],
  "bun.exe": ["-e", "--eval", "-p", "--print", "--preload", "--require"],
  python: ["-c", "--command"],
  python3: ["-c", "--command"],
  "python.exe": ["-c", "--command"],
  ruby: ["-e"],
  perl: ["-e", "-E"],
  php: ["-r"],
  deno: ["eval", "repl"],
};

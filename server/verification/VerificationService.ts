/**
 * Verification Terminal service (v2.0).
 *
 * One confirmed command per run, typed into an interactive shell terminal that
 * belongs to the Paseo workspace and stays open afterwards. The flow is
 * deliberately split:
 *
 * - `start` re-derives the workspace binding and the target fingerprint and
 *   refuses to run anything when either no longer matches what the caller
 *   confirmed; it then creates the interactive shell terminal, writes the
 *   exact executable + argv as ONE quoted shell line, sends Enter, and stores
 *   metadata only.
 * - `poll` captures a bounded tail of that terminal while it exists and reports
 *   `open`; a terminal that is gone is `closed`, a workspace that cannot be
 *   observed is `unavailable`, and a run whose workspace binding moved is
 *   `error`. None of those is a verdict: captured output is returned as a
 *   bounded transient tail, never interpreted, persisted, or turned into a
 *   success claim.
 *
 * The run store keeps metadata and status only. If a terminal was created but
 * its run record could not be stored, the terminal is stopped so no untracked
 * command keeps running; the user's terminal is never killed for any other
 * reason.
 */
import { randomUUID } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  formatVerificationCommand,
  reviewVerificationSuggestionSchema,
  verificationCommandProblem,
  VERIFICATION_OUTPUT_TAIL_MAX_LINES,
  type ListVerificationRunsResult,
  type PollVerificationRunResult,
  type ReviewLocale,
  type ReviewRequest,
  type ReviewVerificationSuggestion,
  type StartVerificationRunResult,
} from "../../shared/review";
import { VerificationRunStore, type VerificationRunRecord } from "../persistence/VerificationRunStore";
import {
  boundedVerificationOutputTail,
  verificationFailure,
  verificationRunCompletion,
  type VerificationRunCompletion,
  type VerificationRunObservation,
} from "./lifecycle";
import { formatVerificationInvocation, verificationShell } from "./wrapper";

export type StartVerificationRunInput = {
  workspaceId: string;
  request: ReviewRequest;
  expectedTargetFingerprint: string;
  suggestion: ReviewVerificationSuggestion;
  confirmed: true;
};

export type PollVerificationRunInput = {
  runId: string;
  workspaceId: string;
};

export type ListVerificationRunsInput = {
  workspaceId: string;
  request: ReviewRequest;
  expectedTargetFingerprint: string;
};

/**
 * Structural slice of the daemon's interactive terminal handle this module
 * touches: its id, the literal write used to type the command line, and the key
 * sender used for Enter. Kept structural (like ReviewService's transient
 * reviewer child) so the verification module stays compilable without the SDK's
 * package-exports-only typings.
 */
type TerminalHandle = {
  id: string;
  write: (data: string) => unknown;
  sendKeys: (keys: readonly string[]) => unknown;
};

/** Structural slice of the daemon's terminal capture: the lines it returns. */
type TerminalCapture = { lines: string[] };

export interface VerificationServiceDependencies {
  store?: VerificationRunStore;
  /** Target fingerprint and worktree path of a review request. */
  reviewedTarget: (request: ReviewRequest) => Promise<{ targetFingerprint: string; worktreePath: string }>;
  /** Fail-closed directory equality (symlink-aware). */
  sameDirectory: (left: string, right: string) => Promise<boolean>;
  /** Workspace id → the project and directory it currently resolves to. */
  workspaceIdentity: (
    workspaceId: string,
    context: PluginHandlerContext,
  ) => Promise<{ projectId: string; directory: string }>;
}

export class VerificationService {
  private readonly store: VerificationRunStore;
  private readonly dependencies: VerificationServiceDependencies;
  private stopping = false;

  constructor(dependencies: VerificationServiceDependencies) {
    this.store = dependencies.store ?? new VerificationRunStore();
    this.dependencies = dependencies;
  }

  /**
   * Starts one explicitly confirmed run: the workspace must still resolve to
   * the reviewed worktree, the target fingerprint must still match the one the
   * caller confirmed, and the command must be a valid executable + argv. Any
   * mismatch refuses the run before a terminal is created. The confirmed
   * command is typed into a new interactive shell terminal, which then stays
   * open for the user to inspect and close.
   */
  async start(
    input: StartVerificationRunInput,
    context: PluginHandlerContext,
  ): Promise<StartVerificationRunResult> {
    const locale: ReviewLocale = input.request.locale ?? "en";
    if (this.stopping) {
      throw new Error(locale === "zh" ? "Review Deck 正在停止，未启动验证命令。" : "Review Deck is stopping; no verification command was started.");
    }
    const suggestion = reviewVerificationSuggestionSchema.safeParse(input.suggestion);
    if (!suggestion.success) {
      const problem = verificationCommandProblem(input.suggestion.command) ?? "The verification command is not valid.";
      throw new Error(locale === "zh" ? `验证命令无效：${problem}` : problem);
    }
    const command = suggestion.data.command;
    const commandPreview = formatVerificationCommand(command);
    if (suggestion.data.commandPreview !== commandPreview) {
      throw new Error(locale === "zh" ? "验证命令预览与实际参数不一致，命令未执行。" : "The verification preview does not match its executable and arguments; the command was not run.");
    }
    const identity = await this.dependencies.workspaceIdentity(input.workspaceId, context);
    const target = await this.dependencies.reviewedTarget(input.request);
    if (target.targetFingerprint !== input.expectedTargetFingerprint) {
      throw new Error(
        locale === "zh"
          ? "验证运行启动前评审目标已发生变化，命令未执行。请刷新评审后重新确认。"
          : "The review target changed before the verification run started, so no command was run. Refresh the review and confirm again.",
      );
    }
    if (!(await this.dependencies.sameDirectory(identity.directory, target.worktreePath))) {
      throw new Error(
        locale === "zh"
          ? `评审目录 ${target.worktreePath} 不是所选工作区 ${input.workspaceId}（${identity.directory}）的目录；验证命令未执行。`
          : `The reviewed worktree ${target.worktreePath} is not the directory of workspace ${input.workspaceId} (${identity.directory}); the verification command was not run.`,
      );
    }

    const shell = verificationShell(process.platform);
    const invocation = formatVerificationInvocation(command, process.platform);
    const startedAtMs = Date.now();
    let terminal: TerminalHandle;
    try {
      terminal = await context.paseo.workspaces.ref(input.workspaceId).terminals.create({
        cwd: target.worktreePath,
        name: `Review Deck: ${command.executable}`,
        command: shell.command,
        args: shell.args,
      });
    } catch (error) {
      throw new Error(
        locale === "zh"
          ? `无法在工作区 ${input.workspaceId} 中创建验证终端，命令未执行：${error instanceof Error ? error.message : "未知错误"}`
          : `Could not create a verification terminal in workspace ${input.workspaceId}; the command was not run: ${error instanceof Error ? error.message : "unknown error"}`,
        { cause: error },
      );
    }

    const run: VerificationRunRecord = {
      runId: randomUUID(),
      workspaceId: input.workspaceId,
      projectId: identity.projectId,
      cwd: target.worktreePath,
      request: input.request,
      targetFingerprint: target.targetFingerprint,
      suggestion: suggestion.data,
      command,
      commandPreview,
      terminalId: terminal.id,
      status: "open",
      startedAt: new Date(startedAtMs).toISOString(),
    };
    try {
      // Persist the binding before any command is submitted. If storage fails,
      // only an empty interactive shell exists and can be safely killed.
      await this.store.create(run);
    } catch (error) {
      await this.killTerminal(context, terminal.id, "store_failed");
      throw error;
    }
    try {
      // One literal write plus Enter: the command is already quoted for this
      // shell, so no argument can be read as shell syntax.
      terminal.write(invocation);
      terminal.sendKeys(["Enter"]);
    } catch (error) {
      await this.killTerminal(context, terminal.id, "input_failed");
      await this.store.remove(run.runId).catch((storeError) => {
        console.error(`[Review Deck] Could not remove an unsubmitted verification run ${run.runId}.`, storeError);
      });
      throw new Error(
        locale === "zh"
          ? `无法向验证终端提交命令：${error instanceof Error ? error.message : "未知错误"}`
          : `Could not submit the verification command to the workspace terminal: ${error instanceof Error ? error.message : "unknown error"}`,
        { cause: error },
      );
    }
    return this.result(run);
  }

  /**
   * Polls one run. A missing run, or one whose workspace does not match this
   * poll, is refused outright; every other end is reported as a state. A run
   * that already left `open` is returned from the stored record, so a poll is
   * idempotent and can never move a finished run.
   */
  async poll(
    input: PollVerificationRunInput,
    context: PluginHandlerContext,
  ): Promise<PollVerificationRunResult> {
    const run = await this.store.get(input.runId);
    if (!run || run.workspaceId !== input.workspaceId) {
      const locale: ReviewLocale = run?.request.locale ?? "en";
      throw new Error(
        locale === "zh"
          ? "该验证运行已不可用，请重新开始。"
          : "The verification run is no longer available; start it again.",
      );
    }
    if (run.status !== "open") return this.result(run);

    let identity: { projectId: string; directory: string } | null = null;
    try {
      identity = await this.dependencies.workspaceIdentity(run.workspaceId, context);
    } catch {
      // The workspace itself no longer resolves, so its terminal cannot be
      // inspected; that is `unavailable`, never a guess about the command.
      identity = null;
    }
    if (identity === null) {
      return this.finish(run, verificationRunCompletion({ kind: "unobservable" }));
    }
    if (
      identity.projectId !== run.projectId ||
      !(await this.dependencies.sameDirectory(identity.directory, run.cwd))
    ) {
      return this.finish(run, verificationRunCompletion({ kind: "invalid_binding" }));
    }

    const observation = await this.observeTerminal(run, context);
    if (observation.kind === "terminal") {
      return this.result(
        run,
        observation.lines === null ? undefined : boundedVerificationOutputTail(observation.lines),
      );
    }
    return this.finish(run, verificationRunCompletion(observation));
  }

  /**
   * Refuse new runs during plugin teardown. Terminals are workspace-owned and
   * deliberately stay open for the user to inspect or close; the plugin never
   * kills them, and no capture is stored.
   */
  async stop(): Promise<void> {
    this.stopping = true;
  }

  /**
   * Lists recent runs only for the requested current target. A changed
   * fingerprint or workspace binding returns no runs and marks the result as
   * stale, so run metadata can never be shown for a diff the user is no longer
   * reviewing. Open runs are polled for their current state and a bounded tail.
   */
  async list(
    input: ListVerificationRunsInput,
    context: PluginHandlerContext,
  ): Promise<ListVerificationRunsResult> {
    const identity = await this.dependencies.workspaceIdentity(input.workspaceId, context);
    const target = await this.dependencies.reviewedTarget(input.request);
    if (
      target.targetFingerprint !== input.expectedTargetFingerprint ||
      !(await this.dependencies.sameDirectory(identity.directory, target.worktreePath))
    ) {
      return { runs: [], targetChanged: true };
    }
    const candidates = await this.store.list();
    const runs: VerificationRunRecord[] = [];
    for (const run of candidates) {
      if (
        run.workspaceId !== input.workspaceId ||
        run.projectId !== identity.projectId ||
        run.targetFingerprint !== input.expectedTargetFingerprint
      ) continue;
      if (!(await this.dependencies.sameDirectory(identity.directory, run.cwd))) continue;
      runs.push(run);
    }
    runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const results = await Promise.all(
      runs.map((run) =>
        run.status === "open"
          ? this.poll({ runId: run.runId, workspaceId: input.workspaceId }, context)
          : Promise.resolve(this.result(run)),
      ),
    );
    return { runs: results, targetChanged: false };
  }

  /**
   * Drop runs older than the retention window. Expired runs can no longer be
   * inspected (their terminals are long gone); this keeps the store from
   * growing without bound.
   */
  prune(retentionMs: number): Promise<number> {
    return this.store.pruneStartedBefore(new Date(Date.now() - retentionMs).toISOString());
  }

  /**
   * Observe one run's terminal. Existence comes from the workspace listing: a
   * successful listing without the terminal means it is gone, a failed listing
   * means existence is unknown. A capture failure is not a state either — the
   * terminal is still open, only this response carries no tail.
   */
  private async observeTerminal(
    run: VerificationRunRecord,
    context: PluginHandlerContext,
  ): Promise<VerificationRunObservation> {
    const workspace = context.paseo.workspaces.ref(run.workspaceId);
    let listed: { entries: Array<{ id: string }> };
    try {
      listed = await workspace.terminals.list();
    } catch {
      return { kind: "unobservable" };
    }
    if (!listed.entries.some((entry) => entry.id === run.terminalId)) return { kind: "missing" };
    try {
      const capture: TerminalCapture = await context.paseo.terminals.ref(run.terminalId).capture({
        start: -VERIFICATION_OUTPUT_TAIL_MAX_LINES,
        stripAnsi: true,
      });
      return { kind: "terminal", lines: capture.lines };
    } catch {
      return { kind: "terminal", lines: null };
    }
  }

  /**
   * Persist the completion of an open run; the first completion wins, so two
   * polls racing each other can never move a run twice or disagree. Nothing
   * about the captured output is stored.
   */
  private async finish(
    run: VerificationRunRecord,
    completion: VerificationRunCompletion,
  ): Promise<PollVerificationRunResult> {
    const completedAt = new Date().toISOString();
    const finished: VerificationRunRecord = {
      ...run,
      status: completion.status,
      completedAt,
      failureCode: completion.failureCode,
    };
    let stored = finished;
    try {
      stored = (await this.store.update(run.runId, (current) => (current.status === "open" ? finished : current))) ?? finished;
    } catch (error) {
      console.error(`[Review Deck] Could not persist verification run ${run.runId}; returning its state.`, error);
    }
    return this.result(stored);
  }

  /**
   * Project a stored run into the RPC payload; nothing but metadata, status,
   * and the optional transient tail leaves this module.
   */
  private result(run: VerificationRunRecord, outputTail?: string[]): PollVerificationRunResult {
    const locale: ReviewLocale = run.request.locale ?? "en";
    return {
      runId: run.runId,
      status: run.status,
      workspaceId: run.workspaceId,
      targetFingerprint: run.targetFingerprint,
      suggestionId: run.suggestion.id,
      label: run.suggestion.label,
      ...(run.suggestion.filePath !== undefined ? { filePath: run.suggestion.filePath } : {}),
      ...(run.suggestion.hunkId !== undefined ? { hunkId: run.suggestion.hunkId } : {}),
      commandPreview: run.commandPreview,
      terminalId: run.terminalId,
      startedAt: run.startedAt,
      ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
      ...(run.failureCode !== undefined
        ? { failure: verificationFailure(run.failureCode, locale) }
        : {}),
      ...(outputTail !== undefined && outputTail.length > 0 ? { outputTail } : {}),
    };
  }

  /** Best-effort terminal kill; a terminal that is already gone is fine. */
  private async killTerminal(
    context: PluginHandlerContext,
    terminalId: string,
    cause: string,
  ): Promise<void> {
    try {
      await context.paseo.terminals.ref(terminalId).kill();
    } catch (error) {
      console.error(`[Review Deck] Could not stop verification terminal ${terminalId} (${cause}).`, error);
    }
  }
}

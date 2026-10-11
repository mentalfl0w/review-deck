import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ActionableReviewFinding, ProcessVerificationResult, StartCapturedVerificationInput } from "../shared/review";
import type { ProcessVerificationServiceDependencies } from "../server/verification/ProcessVerificationService";
import type { ProcessRunner as ProcessRunnerClass, ProcessRunnerOptions } from "../server/verification/ProcessRunner";
import type { ProcessVerificationRecord, ProcessVerificationStore as ProcessVerificationStoreClass } from "../server/persistence/ProcessVerificationStore";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && extname(specifier) === "") return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const requireFromRepo = createRequire(import.meta.url);
const { canonicalJson, sha256 } = requireFromRepo("../server/util/crypto.ts") as {
  canonicalJson(value: unknown): string;
  sha256(value: string): string;
};
const { ProcessVerificationService } = requireFromRepo("../server/verification/ProcessVerificationService.ts") as {
  ProcessVerificationService: new (dependencies: ProcessVerificationServiceDependencies) => {
    supported(): boolean;
    start(input: StartCapturedVerificationInput, context: PluginHandlerContext): Promise<ProcessVerificationResult>;
    poll(input: { runId: string; workspaceId: string }, context: PluginHandlerContext): Promise<ProcessVerificationResult>;
    cancel(input: { runId: string; workspaceId: string }, context: PluginHandlerContext): Promise<ProcessVerificationResult>;
    list(input: { workspaceId: string }, context: PluginHandlerContext): Promise<{ runs: ProcessVerificationResult[]; targetChanged: boolean; supported: boolean }>;
    decide(input: { runId: string; workspaceId: string; expectedTargetFingerprint: string; decision: "accepted" | "rejected"; confirmed: true }, context: PluginHandlerContext): Promise<ProcessVerificationResult>;
    stop(): Promise<void>;
  };
};
const { ProcessVerificationStore } = requireFromRepo("../server/persistence/ProcessVerificationStore.ts") as {
  ProcessVerificationStore: new (path: string) => ProcessVerificationStoreClass;
};
const { ProcessRunner, processRunnerSupported } = requireFromRepo("../server/verification/ProcessRunner.ts") as {
  ProcessRunner: new (options?: ProcessRunnerOptions) => ProcessRunnerClass;
  processRunnerSupported(platform: NodeJS.Platform): boolean;
};
class GatedProcessStore extends ProcessVerificationStore {
  readonly entered = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();

  override async create(run: ProcessVerificationRecord): Promise<ProcessVerificationRecord> {
    this.entered.resolve();
    await this.release.promise;
    return super.create(run);
  }
}


function makeFinding(id: string, workspaceId: string, agentId: string, reviewRunId: string, targetFingerprint: string, command: { executable: string; args: string[] }): ActionableReviewFinding {
  return {
    id,
    source: "ai_review",
    reviewRunId,
    workspaceId,
    agentId,
    sourceVersion: 1,
    scope: "working",
    targetFingerprint,
    sourceInputFingerprint: `input-${reviewRunId}`,
    filePath: "src/app.ts",
    hunkId: "H-1",
    severity: "high",
    evidenceKind: "ai_inference",
    category: "verification",
    summary: "The behavior needs a focused check.",
    detail: "The process reports mechanical evidence only.",
    verificationCommand: command,
    verificationCommandHash: sha256(canonicalJson({ executable: command.executable, args: command.args })),
    anchorStatus: "resolved",
  };
}

function eventWaiter(directory: string) {
  let gate = Promise.withResolvers<void>();
  const watcher = watch(directory, () => gate.resolve());
  return {
    async waitForTerminal(
      service: InstanceType<typeof ProcessVerificationService>,
      runId: string,
      context: PluginHandlerContext,
    ): Promise<ProcessVerificationResult> {
      // This watchdog bounds a genuine OS-process integration test; the test
      // otherwise waits for the run-store rename event instead of guessing a sleep duration.
      const watchdog = setTimeout(() => gate.reject(new Error(`Process ${runId} did not settle before the integration watchdog.`)), 10_000);
      try {
        while (true) {
          const result = await service.poll({ runId, workspaceId: "workspace-1" }, context);
          if (result.status !== "pending" && result.status !== "running") return result;
          await gate.promise;
          gate = Promise.withResolvers<void>();
        }
      } finally {
        clearTimeout(watchdog);
      }
    },
    close(): void {
      watcher.close();
    },
  };
}

async function main(): Promise<void> {
  if (!processRunnerSupported(process.platform)) {
    console.log("verification-process-service: skipped on unsupported platform");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "review-deck-process-service-"));
  const storagePath = join(root, "process-verification-runs.json");
  const outputScript = join(root, "captured-output.js");
  const longScript = join(root, "captured-long.js");
  await writeFile(outputScript, 'process.stdout.write("stdout proof " + String.fromCharCode(0x202e) + " tail" + String.fromCharCode(10)); process.stderr.write("stderr proof" + String.fromCharCode(10));', "utf8");
  await writeFile(longScript, 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => process.stdout.write("running"), 20);', "utf8");

  let currentTarget = "target-a";
  let trustedFinding = makeFinding("finding-1", "workspace-1", "parent-agent", "review-run-1", currentTarget, {
    executable: process.execPath,
    args: [outputScript],
  });
  const context = {} as PluginHandlerContext;
  const store = new ProcessVerificationStore(storagePath);
  const dependencies: ProcessVerificationServiceDependencies = {
    store,
    workspaceIdentity: async (workspaceId) => ({
      projectId: "project-1",
      directory: workspaceId === "workspace-1" ? root : join(root, "foreign"),
    }),
    sameDirectory: async (left, right) => resolve(left) === resolve(right),
    reviewedTarget: async () => ({ targetFingerprint: currentTarget, worktreePath: root }),
    trustedFinding: async (input) =>
      input.workspaceId === trustedFinding.workspaceId &&
      input.agentId === trustedFinding.agentId &&
      input.reviewRunId === trustedFinding.reviewRunId &&
      input.findingId === trustedFinding.id
        ? { finding: trustedFinding, request: { scope: "working", filePath: "src/app.ts" } }
        : null,
  };
  const service = new ProcessVerificationService(dependencies);
  const watchers: Array<{ close(): void }> = [];

  try {
    const mismatchedHash = await service.start({
      workspaceId: "workspace-1",
      agentId: "parent-agent",
      reviewRunId: "review-run-1",
      findingId: "finding-1",
      expectedTargetFingerprint: "target-a",
      expectedCommandHash: "not-the-trusted-command-hash",
      confirmed: true,
    }, context).then(() => false, () => true);
    assert.equal(mismatchedHash, true, "a confirmation for different argv is refused before persistence");
    assert.equal((await store.list()).length, 0);
    await assert.rejects(service.start({
      workspaceId: "workspace-other",
      agentId: "parent-agent",
      reviewRunId: "review-run-1",
      findingId: "finding-1",
      expectedTargetFingerprint: "target-a",
      expectedCommandHash: trustedFinding.verificationCommandHash!,
      confirmed: true,
    }, context), /not available|workspace-bound/i);
    assert.equal((await store.list()).length, 0, "a cross-workspace Finding cannot start a process");

    const successWatcher = eventWaiter(root);
    watchers.push(successWatcher);
    const started = await service.start({
      workspaceId: "workspace-1",
      agentId: "parent-agent",
      reviewRunId: "review-run-1",
      findingId: "finding-1",
      expectedTargetFingerprint: "target-a",
      expectedCommandHash: trustedFinding.verificationCommandHash!,
      confirmed: true,
    }, context);
    assert.equal(started.status, "running");
    const completed = await successWatcher.waitForTerminal(service, started.runId, context);
    assert.equal(completed.status, "exited");
    assert.equal(completed.exitCode, 0);
    assert.equal(completed.evidence.outcome, "exit_0");
    assert.equal(completed.evidence.linkedFindingId, "finding-1");
    assert.equal(completed.reviewRunId, "review-run-1");
    assert.equal(completed.evidence.reviewRunId, "review-run-1");
    assert.equal(completed.evidence.humanDecision, undefined, "exit 0 never invents a human review decision");
    assert.equal(completed.observedTargetFingerprint, "target-a");
    assert.equal(completed.evidence.observedTargetFingerprint, "target-a");
    assert.equal(completed.targetChanged, false);
    const displayedOutput = completed.outputTail?.join("\n") ?? "";
    const bidiEscape = `${String.fromCharCode(92)}u{202E}`;
    assert.ok(displayedOutput.includes(bidiEscape), "bidi controls are shown as visible escapes");
    assert.equal(displayedOutput.includes(String.fromCharCode(0x202e)), false);
    assert.ok(completed.outputTail?.join("\n").includes("stdout proof"));
    assert.ok(completed.outputTail?.join("\n").includes("stderr proof"));
    const persisted = await readFile(storagePath, "utf8");
    assert.ok(!persisted.includes("stdout proof"));
    assert.ok(!persisted.includes("stderr proof"), "captured output never reaches persistent metadata");

    const accepted = await service.decide({
      runId: completed.runId,
      workspaceId: "workspace-1",
      expectedTargetFingerprint: "target-a",
      decision: "accepted",
      confirmed: true,
    }, context);
    assert.equal(accepted.evidence.humanDecision, "accepted");
    assert.ok(accepted.evidence.decisionAt);

    const listed = await service.list({ workspaceId: "workspace-1" }, context);
    assert.equal(listed.supported, true);
    assert.equal(listed.runs.length, 1);
    assert.equal(listed.runs[0]?.runId, completed.runId);

    trustedFinding = makeFinding("finding-inline", "workspace-1", "parent-agent", "review-run-inline", currentTarget, {
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    const inlineCodeRejected = await service.start({
      workspaceId: "workspace-1",
      agentId: "parent-agent",
      reviewRunId: "review-run-inline",
      findingId: trustedFinding.id,
      expectedTargetFingerprint: currentTarget,
      expectedCommandHash: trustedFinding.verificationCommandHash!,
      confirmed: true,
    }, context).then(() => false, () => true);
    assert.equal(inlineCodeRejected, true, "inline evaluator flags are refused by process mode");
    assert.equal((await store.list()).length, 1, "a refused interpreter command is never persisted");
    trustedFinding = makeFinding("finding-nodejs-alias", "workspace-1", "parent-agent", "review-run-nodejs", currentTarget, {
      executable: "nodejs",
      args: ["-e", "process.exit(0)"],
    });
    await assert.rejects(service.start({
      workspaceId: "workspace-1",
      agentId: "parent-agent",
      reviewRunId: "review-run-nodejs",
      findingId: trustedFinding.id,
      expectedTargetFingerprint: currentTarget,
      expectedCommandHash: trustedFinding.verificationCommandHash!,
      confirmed: true,
    }, context), /does not allow executable nodejs/i);
    trustedFinding = makeFinding("finding-python-alias", "workspace-1", "parent-agent", "review-run-python", currentTarget, {
      executable: "python3.12",
      args: ["-c", "raise SystemExit(0)"],
    });
    await assert.rejects(service.start({
      workspaceId: "workspace-1",
      agentId: "parent-agent",
      reviewRunId: "review-run-python",
      findingId: trustedFinding.id,
      expectedTargetFingerprint: currentTarget,
      expectedCommandHash: trustedFinding.verificationCommandHash!,
      confirmed: true,
    }, context), /does not allow executable python3\.12/i);
    assert.equal((await store.list()).length, 1, "aliased interpreters never reach spawn or persistent history");
    trustedFinding = makeFinding("finding-yarn-node", "workspace-1", "parent-agent", "review-run-yarn", currentTarget, {
      executable: "yarn",
      args: ["node", "-e", "process.exit(0)"],
    });
    await assert.rejects(service.start({
      workspaceId: "workspace-1",
      agentId: "parent-agent",
      reviewRunId: "review-run-yarn",
      findingId: trustedFinding.id,
      expectedTargetFingerprint: currentTarget,
      expectedCommandHash: trustedFinding.verificationCommandHash!,
      confirmed: true,
    }, context), /nested interpreter node/i);
    assert.equal((await store.list()).length, 1, "package managers cannot launch nested interpreters in captured mode");

    trustedFinding = makeFinding("finding-cancel", "workspace-1", "parent-agent", "review-run-cancel", currentTarget, {
      executable: process.execPath,
      args: [longScript],
    });
    const cancelWatcher = eventWaiter(root);
    watchers.push(cancelWatcher);
    const cancelInput = {
      workspaceId: "workspace-1",
      agentId: "parent-agent",
      reviewRunId: "review-run-cancel",
      findingId: trustedFinding.id,
      expectedTargetFingerprint: currentTarget,
      expectedCommandHash: trustedFinding.verificationCommandHash!,
      confirmed: true as const,
    };
    const starts = await Promise.allSettled([
      service.start(cancelInput, context),
      service.start(cancelInput, context),
    ]);
    const startedRuns = starts.filter((result): result is PromiseFulfilledResult<ProcessVerificationResult> => result.status === "fulfilled");
    assert.ok(startedRuns.length >= 1);
    const runIds = new Set(startedRuns.map((result) => result.value.runId));
    assert.equal(runIds.size, 1, "concurrent confirmations for the same Finding never spawn a duplicate run");
    const longRun = startedRuns[0]!.value;
    assert.equal((await store.list()).filter((run) => run.findingId === "finding-cancel").length, 1);
    const cancellation = await service.cancel({ runId: longRun.runId, workspaceId: "workspace-1" }, context);
    assert.ok(cancellation.status === "running" || cancellation.status === "canceled", "cancel waits for the process group to report its end");
    const canceled = await cancelWatcher.waitForTerminal(service, longRun.runId, context);
    assert.equal(canceled.status, "canceled");
    assert.equal(canceled.evidence.outcome, "canceled");
    // Hold the async record write after the first validation, change the
    // workspace target, then verify the second pre-spawn check refuses it.
    currentTarget = "target-a";
    trustedFinding = makeFinding("finding-toctou", "workspace-1", "parent-agent", "review-run-toctou", currentTarget, {
      executable: process.execPath,
      args: [outputScript],
    });
    const gatedStore = new GatedProcessStore(join(root, "pre-spawn-runs.json"));
    let unexpectedSpawnCount = 0;
    const guardedRunner = new ProcessRunner({
      platform: process.platform,
      spawn: () => {
        unexpectedSpawnCount += 1;
        throw new Error("pre-spawn target change should block process creation");
      },
    });
    const guardedService = new ProcessVerificationService({ ...dependencies, store: gatedStore, runner: guardedRunner });
    const preSpawnRequest = {
      workspaceId: "workspace-1",
      agentId: "parent-agent",
      reviewRunId: "review-run-toctou",
      findingId: trustedFinding.id,
      expectedTargetFingerprint: "target-a",
      expectedCommandHash: trustedFinding.verificationCommandHash!,
      confirmed: true as const,
    };
    const preSpawnResult = guardedService.start(preSpawnRequest, context).then(
      () => null,
      (error: unknown) => error,
    );
    await gatedStore.entered.promise;
    currentTarget = "target-b";
    gatedStore.release.resolve();
    const preSpawnError = await preSpawnResult;
    assert.ok(preSpawnError instanceof Error);
    assert.match(preSpawnError.message, /changed after confirmation/i);
    assert.equal(unexpectedSpawnCount, 0);
    const refusedRun = (await gatedStore.list())[0];
    assert.equal(refusedRun?.status, "error");
    assert.equal(refusedRun?.targetChanged, true);
    assert.equal(refusedRun?.observedTargetFingerprint, "target-b");
    await guardedService.stop();
    currentTarget = "target-a";
    const orphanCreatedAt = new Date().toISOString();
    const orphanCommand = { executable: process.execPath, args: [outputScript] };
    const orphanRecord: ProcessVerificationRecord = {
      runId: "unobserved-after-reload",
      workspaceId: "workspace-1",
      projectId: "project-1",
      cwd: root,
      targetFingerprint: currentTarget,
      findingId: "finding-orphan",
      reviewRunId: "review-run-orphan",
      commandHash: sha256(canonicalJson(orphanCommand)),
      commandPreview: "node captured-output.js",
      command: orphanCommand,
      scope: "working",
      filePath: "src/app.ts",
      hunkId: "H-1",
      createdAt: orphanCreatedAt,
      startedAt: orphanCreatedAt,
      status: "running",
    };
    await store.create(orphanRecord);
    const orphanResult = await service.poll({ runId: orphanRecord.runId, workspaceId: "workspace-1" }, context);
    assert.equal(orphanResult.status, "abandoned");
    assert.equal(orphanResult.evidence.outcome, "unknown", "an unobserved completion never receives a success verdict");
    assert.equal(orphanResult.exitCode, undefined);


    currentTarget = "target-b";
    const stale = await service.poll({ runId: completed.runId, workspaceId: "workspace-1" }, context);
    assert.equal(stale.targetChanged, true, "evidence is marked stale when the reviewed target changes");
    assert.equal(stale.observedTargetFingerprint, "target-b");
    assert.equal(stale.evidence.targetChanged, true);
    await assert.rejects(service.decide({
      runId: completed.runId,
      workspaceId: "workspace-1",
      expectedTargetFingerprint: "target-a",
      decision: "rejected",
      confirmed: true,
    }, context), /different target/i);

    const unsupported = new ProcessVerificationService({
      ...dependencies,
      store: new ProcessVerificationStore(join(root, "unsupported-runs.json")),
      platform: "win32",
    });
    assert.equal(unsupported.supported(), false);
    await assert.rejects(unsupported.start({
      workspaceId: "workspace-1",
      agentId: "parent-agent",
      reviewRunId: "review-run-cancel",
      findingId: "finding-cancel",
      expectedTargetFingerprint: "target-b",
      expectedCommandHash: trustedFinding.verificationCommandHash!,
      confirmed: true,
    }, context), /disabled on this host/i);
    await unsupported.stop();
  } finally {
    await service.stop();
    for (const watcher of watchers) watcher.close();
    await rm(root, { recursive: true, force: true });
  }
}

void main().then(() => {
  console.log("verification-process-service: all assertions passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/**
 * Human-gated completion lifecycle.
 *
 * An Agent's COMPLETED outcome is a claim. A comment leaves the queue only
 * after `acceptProjectReviewComment`, which re-proves from durable state and a
 * fresh snapshot that:
 *
 * - the named batch is the newest one that owns the comment;
 * - the Agent reported COMPLETED and the batch recorded a dispatch baseline;
 * - the comment is still the exact original queued record;
 * - the visible target/hunk match the fresh snapshot exactly;
 * - the hunk is the baseline's block (same file or rename alias, overlapping
 *   old-side window) and its own changed lines DIFFER from the baseline.
 *
 * Run: node tests/review-comment-acceptance.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginHandlerContext, PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { ReviewService } from "../server/ReviewService";
import { ReviewBatchStore } from "../server/persistence/ReviewBatchStore";
import { StateStore, type StateEntry } from "../server/persistence/StateStore";
import type { ReviewBatch } from "../shared/review-batch";
import type { ReviewSnapshot } from "../shared/review";

const PROJECT_ID = "project-acceptance";
const WORKSPACE_ID = "workspace-acceptance";
const AGENT_ID = "agent-acceptance";

type FakeTimelineItem = { type: "plugin"; id: string; kind: string; version: number; data: unknown };

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function filler(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, index) => `// filler ${from + index}`);
}

function lifecycleAgent(cwd: string, archivedAt: string | null = null) {
  return {
    id: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    parentAgentId: null,
    provider: "omp",
    cwd,
    title: AGENT_ID,
    status: "idle",
    archivedAt,
  };
}

/** The file bodies used by every scenario; only line 1 / line 20 move. */
function alphaSource(alpha: number, delta: number): string {
  return [
    `const alpha = ${alpha};`,
    ...filler(2, 19),
    `const delta = ${delta};`,
    ...filler(21, 30),
    "",
  ].join("\n");
}

function betaSource(beta: number): string {
  return [`const beta = ${beta};`, ...filler(2, 12), ""].join("\n");
}

function gammaSource(gamma: number): string {
  return [`const gamma = ${gamma};`, ...filler(2, 12), ""].join("\n");
}

function epsilonSource(epsilon: number): string {
  return [`const epsilon = ${epsilon};`, ...filler(2, 12), ""].join("\n");
}

function commentEntry(id: string, filePath: string): StateEntry {
  return {
    id,
    projectId: PROJECT_ID,
    projectName: "Acceptance project",
    workspaceId: WORKSPACE_ID,
    targetFingerprint: "target-legacy",
    hunkId: `hunk-${id}`,
    hunkFingerprint: `fingerprint-${id}`,
    contentId: `content-${id}`,
    filePath,
    hunkHeader: "@@ -1,1 +1,1 @@",
    hunkPatch: "-legacy\n+legacy",
    decision: "commented",
    comment: `Legacy comment ${id}`,
    savedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/cwd",
    scope: "working",
  };
}

async function run(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "review-deck-acceptance-"));
  const repo = join(root, "worktree");
  const statePath = join(root, "reviews.json");
  const batchPath = join(root, "review-batches.json");
  const prompts = new Map<string, string>();
  const messageTurnIds = new Map<string, string>();
  const timelineItems: FakeTimelineItem[] = [];

  try {
    await mkdir(repo, { recursive: true });
    runGit(repo, ["init", "--quiet"]);
    runGit(repo, ["config", "user.name", "Review Deck Test"]);
    runGit(repo, ["config", "user.email", "review-deck-test@example.invalid"]);
    for (const [file, content] of [
      ["src/alpha.ts", alphaSource(1, 4)],
      ["src/beta.ts", betaSource(2)],
      ["src/gamma.ts", gammaSource(3)],
      ["src/epsilon.ts", epsilonSource(5)],
    ]) {
      const path = join(repo, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    }
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "--quiet", "-m", "baseline"]);
    // The pre-dispatch working tree: commentable hunks in every scenario file.
    await writeFile(join(repo, "src/alpha.ts"), alphaSource(10, 40), "utf8");
    await writeFile(join(repo, "src/beta.ts"), betaSource(20), "utf8");
    await writeFile(join(repo, "src/gamma.ts"), gammaSource(30), "utf8");
    await writeFile(join(repo, "src/epsilon.ts"), epsilonSource(50), "utf8");

    const stateStore = new StateStore(statePath);
    const batchStore = new ReviewBatchStore(batchPath);
    const agent = lifecycleAgent(repo);
    const workspace = {
      id: WORKSPACE_ID,
      projectId: PROJECT_ID,
      workspaceDirectory: repo,
      archivingAt: null,
    };
    const paseo = {
      workspaces: {
        ref(workspaceId: string) {
          if (workspaceId !== WORKSPACE_ID) throw new Error(`Unknown fake workspace: ${workspaceId}`);
          return { refresh: async () => workspace, current: () => workspace };
        },
        list: async () => ({ entries: [workspace], pageInfo: { hasMore: false } }),
      },
      agents: {
        ref(agentId: string) {
          if (agentId !== AGENT_ID) throw new Error(`Unknown fake agent: ${agentId}`);
          return {
            refresh: async () => ({ agent }),
            send: async (prompt: string, options?: { messageId?: string }) => {
              assert.ok(options?.messageId, "every batch send carries its stable message id");
              prompts.set(options.messageId, prompt);
            },
            timeline: {
              append: async (item: FakeTimelineItem) => { timelineItems.push(item); },
              refetch: async () => ({
                entries: [...prompts.entries()].map(([messageId, text], index) => ({
                  provider: "omp",
                  item: { type: "user_message", text, messageId, clientMessageId: messageId },
                  ...(messageTurnIds.has(messageId) ? { turnId: messageTurnIds.get(messageId) } : {}),
                  timestamp: "2026-01-01T00:00:00.000Z",
                  seqStart: index + 1,
                  seqEnd: index + 1,
                  sourceSeqRanges: [{ startSeq: index + 1, endSeq: index + 1 }],
                  collapsed: [],
                })),
              }),
            },
          };
        },
      },
    };
    const handlerContext = { paseo } as unknown as PluginHandlerContext;
    const hookContext = { paseo, signal: new AbortController().signal } as unknown as PluginHookContext;
    const service = new ReviewService({ store: stateStore, reviewBatchStore: batchStore });

    const currentSnapshot = (filePath?: string) => service.createSnapshot({
      cwd: repo,
      scope: "working",
      ...(filePath !== undefined ? { filePath } : {}),
    });
    const hunkOf = (snapshot: ReviewSnapshot, filePath: string, oldStart: number) => {
      const file = snapshot.files.find((candidate) => candidate.path === filePath);
      const hunk = file?.hunks.find((candidate) => candidate.oldStart === oldStart);
      if (!hunk) throw new Error(`No hunk at ${filePath}:${oldStart} in the current snapshot.`);
      return hunk;
    };
    const saveComment = async (filePath: string, oldStart: number, body: string) => {
      const snapshot = await currentSnapshot();
      const hunk = hunkOf(snapshot, filePath, oldStart);
      await service.recordDecision({
        projectId: PROJECT_ID,
        cwd: repo,
        targetFingerprint: snapshot.targetFingerprint,
        hunkId: hunk.id,
        hunkFingerprint: hunk.fingerprint,
        filePath: hunk.filePath,
        hunkHeader: hunk.header,
        hunkPatch: hunk.patch,
        decision: "commented",
        scope: "working",
        workspaceId: WORKSPACE_ID,
        comment: body,
      });
      const state = await stateStore.load();
      const entry = Object.values(state)
        .flat()
        .find((candidate) => candidate.filePath === filePath && candidate.comment === body);
      assert.ok(entry, `comment for ${filePath} must be stored`);
      assert.ok(entry.id, `comment for ${filePath} must have an id`);
      return entry.id;
    };
    const completeBatch = async (batch: ReviewBatch, commentIds: readonly string[], turnId: string) => {
      const messageId = batch.delivery?.messageId;
      assert.ok(messageId);
      const prompt = prompts.get(messageId);
      assert.ok(prompt);
      messageTurnIds.set(messageId, turnId);
      const turnEnded: PluginLifecycleEvents["agent.turn_ended"] = {
        agent: lifecycleAgent(repo),
        turnId,
        outcome: { kind: "completed" },
        timeline: [
          { type: "user_message", text: prompt, messageId, clientMessageId: messageId },
          {
            type: "assistant_message",
            text: ["COMMENT OUTCOMES", ...commentIds.map((commentId) => `- ${commentId} | COMPLETED | fixed`)].join("\n"),
          },
        ],
      };
      await service.handleAgentTurnEnded(turnEnded, hookContext);
      const stored = (await batchStore.listByProject(PROJECT_ID)).find((entry) => entry.id === batch.id);
      assert.equal(stored?.status, "completed", `batch ${batch.id} must finish as completed`);
      return stored;
    };
    const dispatch = (commentIds: readonly string[]) =>
      service.processProjectReview({
        projectId: PROJECT_ID,
        agentId: AGENT_ID,
        workspaceId: WORKSPACE_ID,
        workspaceCwd: repo,
        commentIds: [...commentIds],
      }, handlerContext);

    const alphaCommentId = await saveComment("src/alpha.ts", 1, "Use a named constant here.");
    const unrelatedCommentId = await saveComment("src/alpha.ts", 17, "Also check the delta constant.");
    const betaCommentId = await saveComment("src/beta.ts", 1, "Rename beta for clarity.");
    const gammaCommentId = await saveComment("src/gamma.ts", 1, "Move gamma into config.");

    // -----------------------------------------------------------------------
    // 1. Agent completion retains every comment, before and after a reload.
    // -----------------------------------------------------------------------
    const firstBatch = await dispatch([alphaCommentId, unrelatedCommentId, betaCommentId, gammaCommentId]);
    const completedFirst = await completeBatch(
      firstBatch,
      [alphaCommentId, unrelatedCommentId, betaCommentId, gammaCommentId],
      "turn-first",
    );
    assert.deepStrictEqual(completedFirst?.outcomes, {
      [alphaCommentId]: "completed",
      [unrelatedCommentId]: "completed",
      [betaCommentId]: "completed",
      [gammaCommentId]: "completed",
    });
    const afterCompletion = await stateStore.load();
    for (const commentId of [alphaCommentId, unrelatedCommentId, betaCommentId, gammaCommentId]) {
      assert.ok(
        Object.values(afterCompletion).flat().some((entry) => entry.id === commentId),
        `an Agent COMPLETED outcome must not delete ${commentId}`,
      );
    }
    const reloaded = await service.listProjectReviewComments(PROJECT_ID, handlerContext);
    assert.equal(reloaded?.commentCount, 4, "a queue reload keeps Agent-completed comments");
    const alphaReview = reloaded?.reviews.find((review) => review.commentId === alphaCommentId);
    assert.equal(alphaReview?.outcome, "completed");
    assert.equal(alphaReview?.acceptedAt, undefined);
    assert.ok(alphaReview?.baseline, "the dispatch captured a baseline for acceptance");

    // -----------------------------------------------------------------------
    // 2. An unchanged block cannot be accepted, even after a COMPLETED outcome.
    // -----------------------------------------------------------------------
    const unchangedBlock = await currentSnapshot();
    const unchangedAlphaHunk = hunkOf(unchangedBlock, "src/alpha.ts", 1);
    await assert.rejects(
      () => service.acceptProjectReviewComment({
        projectId: PROJECT_ID,
        batchId: firstBatch.id,
        commentId: alphaCommentId,
        expectedTargetFingerprint: unchangedBlock.targetFingerprint,
        expectedFilePath: unchangedAlphaHunk.filePath,
        expectedHunkId: unchangedAlphaHunk.id,
        expectedHunkFingerprint: unchangedAlphaHunk.fingerprint,
      }, hookContext),
      /unchanged since dispatch/,
    );
    assert.ok(
      Object.values(await stateStore.load()).flat().some((entry) => entry.id === alphaCommentId),
      "a refused acceptance leaves the comment queued",
    );

    // -----------------------------------------------------------------------
    // 3. A different, changed hunk in the same file does not qualify.
    // -----------------------------------------------------------------------
    await writeFile(join(repo, "src/alpha.ts"), alphaSource(10, 41), "utf8");
    const movedBlock = await currentSnapshot();
    const changedDeltaHunk = hunkOf(movedBlock, "src/alpha.ts", 17);
    await assert.rejects(
      () => service.acceptProjectReviewComment({
        projectId: PROJECT_ID,
        batchId: firstBatch.id,
        commentId: alphaCommentId,
        expectedTargetFingerprint: movedBlock.targetFingerprint,
        expectedFilePath: changedDeltaHunk.filePath,
        expectedHunkId: changedDeltaHunk.id,
        expectedHunkFingerprint: changedDeltaHunk.fingerprint,
      }, hookContext),
      /does not cover the comment's original change/,
    );
    assert.ok(
      Object.values(await stateStore.load()).flat().some((entry) => entry.id === alphaCommentId),
      "an unrelated changed hunk cannot clear the comment",
    );

    // -----------------------------------------------------------------------
    // 4. A changed block plus an explicit human acceptance removes exactly the
    //    matching original comment id, and only after the acceptance is durable.
    // -----------------------------------------------------------------------
    await writeFile(join(repo, "src/alpha.ts"), alphaSource(11, 41), "utf8");
    const acceptedSnapshot = await currentSnapshot("src/alpha.ts");
    const acceptedHunk = hunkOf(acceptedSnapshot, "src/alpha.ts", 1);
    const acceptInput = {
      projectId: PROJECT_ID,
      batchId: firstBatch.id,
      commentId: alphaCommentId,
      pathFilter: "src/alpha.ts",
      expectedTargetFingerprint: acceptedSnapshot.targetFingerprint,
      expectedFilePath: acceptedHunk.filePath,
      expectedHunkId: acceptedHunk.id,
      expectedHunkFingerprint: acceptedHunk.fingerprint,
    };
    const accepted = await service.acceptProjectReviewComment(acceptInput, hookContext);
    assert.equal(accepted.cleared, 1);
    assert.equal(accepted.commentId, alphaCommentId);
    const storedAcceptance = (await batchStore.listByProject(PROJECT_ID))
      .find((entry) => entry.id === firstBatch.id)?.acceptances?.[alphaCommentId];
    assert.equal(storedAcceptance?.acceptedAt, accepted.acceptedAt);
    assert.notEqual(storedAcceptance?.hunkChangeId, storedAcceptance?.baselineHunkChangeId);
    assert.notEqual(
      storedAcceptance?.changedLinesId,
      firstBatch.baselines?.[alphaCommentId]?.changedLinesId,
    );
    const afterAcceptance = Object.values(await stateStore.load()).flat();
    assert.equal(afterAcceptance.some((entry) => entry.id === alphaCommentId), false);
    for (const commentId of [unrelatedCommentId, betaCommentId, gammaCommentId]) {
      assert.ok(
        afterAcceptance.some((entry) => entry.id === commentId),
        `accepting one comment must not remove ${commentId}`,
      );
    }
    const repeated = await service.acceptProjectReviewComment(acceptInput, hookContext);
    assert.equal(repeated.acceptedAt, accepted.acceptedAt, "a repeated acceptance is idempotent");
    assert.equal(repeated.cleared, 0, "the comment id was already removed");

    // -----------------------------------------------------------------------
    // 5. An edited/replaced comment and a superseded batch both fail closed.
    // -----------------------------------------------------------------------
    const betaBeforeEdit = Object.values(await stateStore.load())
      .flat()
      .find((entry) => entry.id === betaCommentId);
    assert.ok(betaBeforeEdit?.targetFingerprint);
    const betaSnapshot = await currentSnapshot();
    const betaHunk = hunkOf(betaSnapshot, "src/beta.ts", 1);
    await service.recordDecision({
      projectId: PROJECT_ID,
      cwd: repo,
      targetFingerprint: betaSnapshot.targetFingerprint,
      hunkId: betaHunk.id,
      hunkFingerprint: betaHunk.fingerprint,
      filePath: betaHunk.filePath,
      hunkHeader: betaHunk.header,
      hunkPatch: betaHunk.patch,
      decision: "commented",
      scope: "working",
      workspaceId: WORKSPACE_ID,
      comment: "Rename beta and document it.",
      supersedes: { targetFingerprint: betaBeforeEdit.targetFingerprint, entryId: betaCommentId },
    });
    const editedBeta = Object.values(await stateStore.load())
      .flat()
      .find((entry) => entry.filePath === "src/beta.ts" && entry.comment === "Rename beta and document it.");
    const editedBetaId = editedBeta?.id;
    assert.ok(editedBetaId && editedBetaId !== betaCommentId);
    await assert.rejects(
      () => service.acceptProjectReviewComment({
        projectId: PROJECT_ID,
        batchId: firstBatch.id,
        commentId: betaCommentId,
        expectedTargetFingerprint: betaSnapshot.targetFingerprint,
        expectedFilePath: betaHunk.filePath,
        expectedHunkId: betaHunk.id,
        expectedHunkFingerprint: betaHunk.fingerprint,
      }, hookContext),
      /no longer queued under its original identity/,
    );
    assert.ok(
      Object.values(await stateStore.load()).flat().some((entry) => entry.id === editedBetaId),
      "the replacement comment stays queued",
    );

    const secondBatch = await dispatch([gammaCommentId]);
    await completeBatch(secondBatch, [gammaCommentId], "turn-second");
    const supersedingBatch = await dispatch([gammaCommentId]);
    assert.equal(supersedingBatch.status, "submitted");
    await assert.rejects(
      () => service.acceptProjectReviewComment({
        projectId: PROJECT_ID,
        batchId: secondBatch.id,
        commentId: gammaCommentId,
        expectedTargetFingerprint: supersedingBatch.baselines?.[gammaCommentId]?.targetFingerprint ?? "",
        expectedFilePath: "src/gamma.ts",
        expectedHunkId: supersedingBatch.baselines?.[gammaCommentId]?.hunkId ?? "",
        expectedHunkFingerprint: supersedingBatch.baselines?.[gammaCommentId]?.hunkFingerprint ?? "",
      }, hookContext),
      /newer ReviewBatch already owns this comment/,
    );
    assert.ok(
      Object.values(await stateStore.load()).flat().some((entry) => entry.id === gammaCommentId),
      "a superseded batch cannot clear a comment",
    );

    // -----------------------------------------------------------------------
    // 6. A migrated version-2 record keeps its outcome but has no baseline, so
    //    acceptance stays disabled instead of trusting the old COMPLETED claim.
    // -----------------------------------------------------------------------
    const legacyCommentId = "comment-legacy";
    const withLegacy = await stateStore.load();
    withLegacy["target-legacy"] = [commentEntry(legacyCommentId, "src/epsilon.ts")];
    await stateStore.save(withLegacy);
    const legacyBatchPath = join(root, "legacy-batches.json");
    const legacyRaw = `${JSON.stringify({
      version: 2,
      batches: [{
        id: "legacy-batch",
        createdAt: "2026-01-01T00:00:00.000Z",
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        commentIds: [legacyCommentId],
        submittedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:05:00.000Z",
        status: "completed",
        outcomes: { [legacyCommentId]: "completed" },
      }],
    }, null, 2)}\n`;
    await writeFile(legacyBatchPath, legacyRaw, "utf8");
    const legacyService = new ReviewService({
      store: stateStore,
      reviewBatchStore: new ReviewBatchStore(legacyBatchPath),
    });
    const legacyQueue = await legacyService.listProjectReviewComments(PROJECT_ID);
    const legacyReview = legacyQueue?.reviews.find((review) => review.commentId === legacyCommentId);
    assert.equal(legacyReview?.outcome, "completed");
    assert.equal(legacyReview?.baseline, null, "a migrated record gains no dispatch-time baseline");
    assert.equal(legacyReview?.acceptedAt, undefined);
    const epsilonSnapshot = await legacyService.createSnapshot({ cwd: repo, scope: "working" });
    const epsilonHunk = hunkOf(epsilonSnapshot, "src/epsilon.ts", 1);
    await assert.rejects(
      () => legacyService.acceptProjectReviewComment({
        projectId: PROJECT_ID,
        batchId: "legacy-batch",
        commentId: legacyCommentId,
        expectedTargetFingerprint: epsilonSnapshot.targetFingerprint,
        expectedFilePath: epsilonHunk.filePath,
        expectedHunkId: epsilonHunk.id,
        expectedHunkFingerprint: epsilonHunk.fingerprint,
      }, handlerContext),
      /recorded no dispatch-time baseline/,
    );
    assert.ok(
      Object.values(await stateStore.load()).flat().some((entry) => entry.id === legacyCommentId),
      "an old COMPLETED outcome cannot delete a comment after migration",
    );
    assert.ok(timelineItems.some((item) => item.id === `review-deck-batch:${firstBatch.id}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void run().then(() => {
  console.log("Review comment acceptance: all assertions passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

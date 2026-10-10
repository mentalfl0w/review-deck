import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginHandlerContext, PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { ReviewService } from "../server/ReviewService";
import { ReviewBatchStore } from "../server/persistence/ReviewBatchStore";
import { StateStore, type StateEntry } from "../server/persistence/StateStore";
import { reviewBatchTimelineSchema, type ReviewBatch } from "../shared/review-batch";

const PROJECT_ID = "project-batch-test";
const SAVED_AT = "2026-09-30T12:00:00.000Z";

type FakeTimelineItem = { type: "plugin"; id: string; kind: string; version: number; data: unknown };

function commentEntry(id: string, workspaceId: string, cwd: string): StateEntry {
  return {
    id,
    projectId: PROJECT_ID,
    projectName: "Batch test project",
    projectRootPath: cwd,
    workspaceId,
    targetFingerprint: `target-${id}`,
    hunkId: `hunk-${id}`,
    hunkFingerprint: `fingerprint-${id}`,
    contentId: `content-${id}`,
    filePath: `src/${id}.ts`,
    hunkHeader: "@@ -1,1 +1,1 @@",
    hunkPatch: "-old\n+new",
    decision: "commented",
    comment: `Please update ${id}`,
    savedAt: SAVED_AT,
    cwd,
    scope: "working",
    baseRef: "HEAD~1",
    headRef: "HEAD",
  };
}

function lifecycleAgent(id: string, workspaceId: string, cwd: string, archivedAt: string | null = null) {
  return { id, workspaceId, parentAgentId: null, provider: "omp", cwd, title: id, status: "running", archivedAt };
}
function createDeferredSend() {
  let notifyStarted!: () => void;
  let acknowledge!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const acknowledgement = new Promise<void>((resolve) => { acknowledge = resolve; });
  return { started, notifyStarted, acknowledgement, acknowledge };
}
function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function initializeWorkspaceRepo(cwd: string, files: readonly string[]): Promise<void> {
  runGit(cwd, ["init", "--quiet"]);
  runGit(cwd, ["config", "user.name", "Review Deck Test"]);
  runGit(cwd, ["config", "user.email", "review-deck-test@example.invalid"]);
  for (const file of files) {
    const path = join(cwd, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "old\n", "utf8");
  }
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "--quiet", "-m", "baseline"]);
  for (const file of files) await writeFile(join(cwd, file), "new\n", "utf8");
}

async function run(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "review-deck-review-batch-"));
  const workspaceA = join(root, "worktree-a");
  const workspaceB = join(root, "worktree-b");
  const workspaceC = join(root, "worktree-c");
  const workspaceD = join(root, "worktree-d");
  const statePath = join(root, "reviews.json");
  const batchPath = join(root, "review-batches.json");
  const prompts = new Map<string, string[]>();
  const sentMessageIds = new Map<string, string[]>();
  const messageTurnIds = new Map<string, string>();
  const delayedSends = new Map<string, { started: () => void; acknowledgement: Promise<void> }>();
  const timelineItems: FakeTimelineItem[] = [];
  const failSend = new Set<string>(["agent-c"]);
  const failRefresh = new Set<string>();

  try {
    await Promise.all([mkdir(workspaceA), mkdir(workspaceB), mkdir(workspaceC), mkdir(workspaceD)]);
    await Promise.all([
      initializeWorkspaceRepo(workspaceA, ["src/comment-a1.ts", "src/comment-a2.ts", "src/comment-a3.ts"]),
      initializeWorkspaceRepo(workspaceB, ["src/comment-b1.ts"]),
      initializeWorkspaceRepo(workspaceC, ["src/comment-c1.ts"]),
      initializeWorkspaceRepo(workspaceD, ["src/comment-d1.ts"]),
    ]);
    const entries = {
      "target-a1": [commentEntry("comment-a1", "workspace-a", workspaceA)],
      "target-a2": [commentEntry("comment-a2", "workspace-a", workspaceA)],
      "target-a3": [commentEntry("comment-a3", "workspace-a", workspaceA)],
      "target-b1": [commentEntry("comment-b1", "workspace-b", workspaceB)],
      "target-c1": [commentEntry("comment-c1", "workspace-c", workspaceC)],
      "target-d1": [commentEntry("comment-d1", "workspace-d", workspaceD)],
    };
    const stateStore = new StateStore(statePath);
    await stateStore.save(entries);
    const batchStore = new ReviewBatchStore(batchPath);
    const agents = new Map([
      ["agent-a", { ...lifecycleAgent("agent-a", "workspace-a", workspaceA), status: "idle" }],
      ["agent-b", { ...lifecycleAgent("agent-b", "workspace-b", workspaceB), status: "idle" }],
      ["agent-c", { ...lifecycleAgent("agent-c", "workspace-c", workspaceC), status: "idle" }],
      ["agent-d", { ...lifecycleAgent("agent-d", "workspace-d", workspaceD), status: "idle" }],
    ]);
    const workspaces = new Map([
      ["workspace-a", { id: "workspace-a", projectId: PROJECT_ID, workspaceDirectory: workspaceA, archivingAt: null }],
      ["workspace-b", { id: "workspace-b", projectId: PROJECT_ID, workspaceDirectory: workspaceB, archivingAt: null }],
      ["workspace-c", { id: "workspace-c", projectId: PROJECT_ID, workspaceDirectory: workspaceC, archivingAt: null }],
      ["workspace-d", { id: "workspace-d", projectId: PROJECT_ID, workspaceDirectory: workspaceD, archivingAt: null }],
      ["workspace-shared", { id: "workspace-shared", projectId: PROJECT_ID, workspaceDirectory: workspaceA, archivingAt: null }],
    ]);
    const paseo = {
      workspaces: {
        ref(workspaceId: string) {
          const workspace = workspaces.get(workspaceId);
          if (!workspace) throw new Error(`Unknown fake workspace: ${workspaceId}`);
          return {
            refresh: async () => workspace,
            current: () => workspace,
          };
        },
        list: async ({ filter }: { filter: { projectId: string } }) => ({
          entries: [...workspaces.values()].filter((workspace) => workspace.projectId === filter.projectId),
          pageInfo: { hasMore: false },
        }),
      },
      agents: {
        ref(agentId: string) {
          const agent = agents.get(agentId);
          if (!agent) throw new Error(`Unknown fake agent: ${agentId}`);
          return {
            refresh: async () => {
              if (failRefresh.has(agentId)) throw new Error("refresh unavailable");
              return { agent };
            },
            send: async (prompt: string, options?: { messageId?: string }) => {
              const sent = prompts.get(agentId) ?? [];
              sent.push(prompt);
              prompts.set(agentId, sent);
              if (options?.messageId) {
                const ids = sentMessageIds.get(agentId) ?? [];
                ids.push(options.messageId);
                sentMessageIds.set(agentId, ids);
              }
              const delayed = delayedSends.get(agentId);
              if (delayed) {
                delayedSends.delete(agentId);
                delayed.started();
                await delayed.acknowledgement;
              }
              if (failSend.has(agentId)) throw new Error("send acknowledgment timed out after message delivery");
            },
            timeline: {
              append: async (item: FakeTimelineItem) => { timelineItems.push(item); },
              refetch: async () => ({
                entries: (prompts.get(agentId) ?? []).map((text, index) => {
                  const messageId = sentMessageIds.get(agentId)?.[index];
                  const turnId = messageId === undefined ? undefined : messageTurnIds.get(messageId);
                  return {
                    provider: "omp",
                    item: {
                      type: "user_message",
                      text,
                      ...(messageId !== undefined ? { messageId, clientMessageId: messageId } : {}),
                    },
                    ...(turnId !== undefined ? { turnId } : {}),
                    timestamp: SAVED_AT,
                    seqStart: index + 1,
                    seqEnd: index + 1,
                    sourceSeqRanges: [{ startSeq: index + 1, endSeq: index + 1 }],
                    collapsed: [],
                  };
                }),
              }),
            },
          };
        },
      },
    };
    const handlerContext = { paseo } as unknown as PluginHandlerContext;
    const hookContext = { paseo, signal: new AbortController().signal } as unknown as PluginHookContext;
    const service = new ReviewService({ store: stateStore, reviewBatchStore: batchStore });

    const initial = await service.listProjectReviewComments(PROJECT_ID);
    assert.equal(initial?.commentCount, 6);
    assert.deepEqual(initial?.batches, []);
    const agentA = agents.get("agent-a");
    assert.ok(agentA);
    agentA.archivedAt = "2026-10-01T12:00:00.000Z";
    const batchesBeforeArchivedReject = await batchStore.listByProject(PROJECT_ID);
    await assert.rejects(
      () => service.processProjectReview({
        projectId: PROJECT_ID,
        agentId: "agent-a",
        workspaceId: "workspace-a",
        workspaceCwd: workspaceA,
        commentIds: ["comment-a1"],
      }, handlerContext),
      /archived/,
    );
    assert.deepEqual(await batchStore.listByProject(PROJECT_ID), batchesBeforeArchivedReject);
    assert.equal(prompts.has("agent-a"), false);
    agentA.archivedAt = null;
    const batchesBeforeBusyReject = await batchStore.listByProject(PROJECT_ID);
    agentA.status = "running";
    await assert.rejects(
      () => service.processProjectReview({
        projectId: PROJECT_ID,
        agentId: "agent-a",
        workspaceId: "workspace-a",
        workspaceCwd: workspaceA,
        commentIds: ["comment-a1"],
      }, handlerContext),
      /busy/,
    );
    assert.deepEqual(await batchStore.listByProject(PROJECT_ID), batchesBeforeBusyReject);
    assert.equal(prompts.has("agent-a"), false, "a busy Agent receives no ReviewBatch prompt");
    agentA.status = "idle";

    failRefresh.add("agent-a");
    await assert.rejects(
      () => service.processProjectReview({
        projectId: PROJECT_ID,
        agentId: "agent-a",
        workspaceId: "workspace-a",
        workspaceCwd: workspaceA,
        commentIds: ["comment-a1"],
      }, handlerContext),
      /Could not verify the status/,
    );
    assert.deepEqual(await batchStore.listByProject(PROJECT_ID), batchesBeforeBusyReject);
    assert.equal(prompts.has("agent-a"), false, "a failed refresh cannot fall back to a stale Agent snapshot");
    failRefresh.delete("agent-a");
    const staleEntry = commentEntry("comment-a-stale", "workspace-a", workspaceA);
    staleEntry.filePath = "src/not-changed.ts";
    staleEntry.hunkPatch = "-missing\n+different";
    const beforeStalePreflight = await batchStore.listByProject(PROJECT_ID);
    const withStaleComment = await stateStore.load();
    withStaleComment["target-stale"] = [staleEntry];
    await stateStore.save(withStaleComment);
    await assert.rejects(
      () => service.processProjectReview({
        projectId: PROJECT_ID,
        agentId: "agent-a",
        workspaceId: "workspace-a",
        workspaceCwd: workspaceA,
        commentIds: ["comment-a-stale"],
      }, handlerContext),
      /stale or ambiguous/,
    );
    assert.deepEqual(await batchStore.listByProject(PROJECT_ID), beforeStalePreflight);
    assert.ok((await stateStore.load())["target-stale"]?.some((entry) => entry.id === "comment-a-stale"));
    const withoutStaleComment = await stateStore.load();
    delete withoutStaleComment["target-stale"];
    await stateStore.save(withoutStaleComment);


    const submitted = await service.processProjectReview({
      projectId: PROJECT_ID,
      agentId: "agent-a",
      workspaceId: "workspace-a",
      workspaceCwd: workspaceA,
      commentIds: ["comment-a1", "comment-a2", "comment-a3"],
    }, handlerContext);
    assert.equal(submitted.status, "submitted");
    assert.equal(submitted.delivery?.phase, "accepted");
    assert.equal(submitted.delivery?.attempts, 1);
    assert.equal(sentMessageIds.get("agent-a")?.[0], `review-deck-batch:${submitted.id}`);
    assert.deepEqual(submitted.commentIds, ["comment-a1", "comment-a2", "comment-a3"]);
    const prompt = prompts.get("agent-a")?.[0] ?? "";
    assert.ok(prompt.startsWith(`REVIEW DECK BATCH: ${submitted.id}`));
    assert.ok(prompt.includes("comment-a1"));
    assert.ok(prompt.includes("comment-a2"));
    assert.ok(prompt.includes("comment-a3"));
    assert.ok(!prompt.includes("comment-b1"), "a workspace batch never includes sibling-worktree comments");
    assert.ok(!prompt.includes(workspaceB));

    const pending = await service.listProjectReviewComments(PROJECT_ID);
    assert.equal(pending?.commentCount, 6, "submission leaves all comments queued until outcomes arrive");
    assert.deepEqual(pending?.batches.map((batch) => batch.id), [submitted.id]);
    assert.equal(timelineItems.length, 1);
    assert.equal(timelineItems[0]?.id, `review-deck-batch:${submitted.id}`);
    assert.equal(timelineItems[0]?.kind, "review-deck-batch");
    const submittedTimelineItem = timelineItems[0];
    assert.ok(submittedTimelineItem);
    assert.equal(reviewBatchTimelineSchema.parse(submittedTimelineItem.data).status, "submitted");

    const turnStarted: PluginLifecycleEvents["agent.turn_started"] = {
      agent: lifecycleAgent("agent-a", "workspace-a", workspaceA),
      turnId: "turn-a",
    };
    const firstAMessageId = sentMessageIds.get("agent-a")?.[0];
    assert.ok(firstAMessageId);
    messageTurnIds.set(firstAMessageId, "turn-a");
    await service.handleAgentTurnStarted(turnStarted, hookContext);
    assert.equal((await batchStore.listByProject(PROJECT_ID))[0]?.status, "running");
    assert.equal(timelineItems.length, 2);
    assert.equal(timelineItems[0]?.id, timelineItems[1]?.id, "running replaces the submitted row by stable item id");
    const runningTimelineItem = timelineItems[1];
    assert.ok(runningTimelineItem);
    assert.equal(reviewBatchTimelineSchema.parse(runningTimelineItem.data).status, "running");

    // Replacing an edited comment assigns a fresh StateEntry id. A completed
    // outcome for the submitted id must not erase the newer user comment.
    const state = await stateStore.load();
    state["target-a3"] = [{ ...state["target-a3"]![0]!, id: "comment-a3-edited", comment: "Keep this newer comment" }];
    await stateStore.save(state);

    const turnEnded: PluginLifecycleEvents["agent.turn_ended"] = {
      agent: lifecycleAgent("agent-a", "workspace-a", workspaceA),
      turnId: "turn-a",
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: prompt, messageId: firstAMessageId, clientMessageId: firstAMessageId },
        {
          type: "assistant_message",
          text: [
            "### VERIFIED FACTS",
            "The first change was applied.",
            "COMMENT OUTCOMES",
            "- comment-a1 | COMPLETED | changed",
            "- comment-a2 | STALE | target drifted",
            "- comment-a3 | COMPLETED | changed before edit",
          ].join("\n"),
        },
      ],
    };
    await service.handleAgentTurnEnded({ ...turnEnded, turnId: "turn-a-next" }, hookContext);
    const afterMismatchedTurn = (await batchStore.listByProject(PROJECT_ID))[0];
    assert.equal(afterMismatchedTurn?.status, "running", "a replayed Batch marker cannot bind an unrelated Turn");
    assert.deepEqual(afterMismatchedTurn?.outcomes, {});
    assert.ok((await stateStore.load())["target-a1"]?.some((entry) => entry.id === "comment-a1"));
    assert.equal(timelineItems.length, 2, "an uncorrelated Turn does not release the batch claim");
    const conflictingTurnEnded: PluginLifecycleEvents["agent.turn_ended"] = {
      ...turnEnded,
      timeline: [
        { type: "user_message", text: prompt, messageId: firstAMessageId, clientMessageId: firstAMessageId },
        {
          type: "assistant_message",
          text: [
            "COMMENT OUTCOMES",
            "- comment-a1 | UNRESOLVED | first report",
            "COMMENT OUTCOMES",
            "- comment-a1 | COMPLETED | conflicting report",
          ].join("\n"),
        },
      ],
    };
    await service.handleAgentTurnEnded(conflictingTurnEnded, hookContext);
    const afterConflictingOutcomes = (await batchStore.listByProject(PROJECT_ID))[0];
    assert.equal(afterConflictingOutcomes?.status, "failed");
    assert.deepEqual(afterConflictingOutcomes?.outcomes, {
      "comment-a1": "unresolved",
      "comment-a2": "unresolved",
      "comment-a3": "unresolved",
    });
    assert.ok((await stateStore.load())["target-a1"]?.some((entry) => entry.id === "comment-a1"));
    assert.equal(timelineItems.length, 3);
    await service.handleAgentTurnEnded(turnEnded, hookContext);
    const finished = await batchStore.listByProject(PROJECT_ID);
    assert.equal(finished[0]?.status, "partial");
    assert.deepEqual(finished[0]?.outcomes, {
      "comment-a1": "completed",
      "comment-a2": "stale",
      "comment-a3": "completed",
    });
    const after = await stateStore.load();
    assert.equal(after["target-a1"], undefined, "an explicitly completed comment is removed");
    assert.deepEqual(after["target-a2"]?.map((entry) => entry.id), ["comment-a2"]);
    assert.deepEqual(after["target-a3"]?.map((entry) => entry.id), ["comment-a3-edited"]);
    const interruptedCleanup = await stateStore.load();
    interruptedCleanup["target-a1"] = [commentEntry("comment-a1", "workspace-a", workspaceA)];
    await stateStore.save(interruptedCleanup);
    // A terminal outcome is durable, so the next queue read repairs a cleanup
    // interrupted after the batch record committed.
    const afterSummary = await service.listProjectReviewComments(PROJECT_ID);
    assert.equal(afterSummary?.commentCount, 5, "only completed ids are removed; a newer replacement comment remains");
    assert.ok(!afterSummary?.comments.some((comment) => comment.id === "comment-a1"));
    assert.deepEqual(afterSummary?.batches, [], "terminal batches are not reported as in-flight");
    assert.equal(timelineItems.length, 4);
    assert.equal(timelineItems[0]?.id, timelineItems[3]?.id, "final outcomes replace the same timeline item");
    const finalTimelineItem = timelineItems[3];
    assert.ok(finalTimelineItem);
    const rawFinalTimeline = finalTimelineItem.data;
    assert.ok(rawFinalTimeline && typeof rawFinalTimeline === "object" && !Array.isArray(rawFinalTimeline));
    assert.equal("commentIds" in rawFinalTimeline, false);
    assert.equal("filePath" in rawFinalTimeline, false);
    const finalTimeline = reviewBatchTimelineSchema.parse(rawFinalTimeline);
    assert.equal(finalTimeline.completedCount, 2);
    assert.equal(finalTimeline.staleCount, 1);

    await service.handleAgentTurnEnded(turnEnded, hookContext);
    assert.equal(timelineItems.length, 4, "replayed turn-ended events do not reprocess terminal batches");
    const deferredAgentA = createDeferredSend();
    delayedSends.set("agent-a", {
      started: deferredAgentA.notifyStarted,
      acknowledgement: deferredAgentA.acknowledgement,
    });
    const lateAckPromise = service.processProjectReview({
      projectId: PROJECT_ID,
      agentId: "agent-a",
      workspaceId: "workspace-a",
      workspaceCwd: workspaceA,
      commentIds: ["comment-a2"],
    }, handlerContext);
    await deferredAgentA.started;
    const lateAckPrompt = prompts.get("agent-a")?.[1];
    assert.ok(lateAckPrompt);
    const lateAckMessageId = sentMessageIds.get("agent-a")?.[1];
    assert.ok(lateAckMessageId);
    messageTurnIds.set(lateAckMessageId, "turn-a-late");
    await service.handleAgentTurnStarted({
      agent: lifecycleAgent("agent-a", "workspace-a", workspaceA),
      turnId: "turn-a-late",
    }, hookContext);
    await service.handleAgentTurnEnded({
      agent: lifecycleAgent("agent-a", "workspace-a", workspaceA),
      turnId: "turn-a-late",
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: lateAckPrompt, messageId: lateAckMessageId, clientMessageId: lateAckMessageId },
        { type: "assistant_message", text: "COMMENT OUTCOMES\n- comment-a2 | COMPLETED | fixed" },
      ],
    }, hookContext);
    const completedBeforeAck = (await batchStore.listByProject(PROJECT_ID))
      .find((batch) => batch.id !== submitted.id && batch.agentId === "agent-a");
    assert.equal(completedBeforeAck?.status, "completed");
    assert.equal(completedBeforeAck?.delivery?.phase, "accepted", "the matching outcome proves message delivery before ACK");
    deferredAgentA.acknowledge();
    const lateAckResult = await lateAckPromise;
    assert.equal(lateAckResult.status, "completed", "a late ACK cannot regress a terminal batch");
    assert.equal(lateAckResult.delivery?.phase, "accepted");
    assert.ok(!(await stateStore.load())["target-a2"], "only the matching COMPLETED outcome clears this comment");
    const legacyBatchPath = join(root, "legacy-active-batch.json");
    const legacyBatch: ReviewBatch = {
      id: "legacy-active",
      createdAt: "2000-01-01T00:00:00.000Z",
      projectId: PROJECT_ID,
      workspaceId: "workspace-a",
      agentId: "agent-a",
      commentIds: ["comment-a3-edited"],
      submittedAt: "2000-01-01T00:00:00.000Z",
      status: "submitted",
      outcomes: {},
    };
    const legacyBatchRaw = `${JSON.stringify({ version: 1, batches: [legacyBatch] }, null, 2)}\n`;
    await writeFile(legacyBatchPath, legacyBatchRaw, "utf8");
    const legacyBatchStore = new ReviewBatchStore(legacyBatchPath);
    const legacyRecoveryService = new ReviewService({ store: stateStore, reviewBatchStore: legacyBatchStore });
    const legacyRecovery = await legacyRecoveryService.listProjectReviewComments(PROJECT_ID, handlerContext);
    const preservedLegacyBatch = (await legacyBatchStore.listByProject(PROJECT_ID))[0];
    assert.equal(preservedLegacyBatch?.delivery, undefined, "v1 migration does not invent a message identity");
    assert.equal(preservedLegacyBatch?.status, "submitted", "legacy active claims are not auto-released after the startup timeout");
    assert.ok(legacyRecovery?.batches.some((batch) => batch.id === legacyBatch.id));
    assert.equal(await readFile(`${legacyBatchPath}.v1.bak`, "utf8"), legacyBatchRaw);
    await legacyRecoveryService.handleAgentTurnEnded({
      agent: lifecycleAgent("agent-a", "workspace-a", workspaceA),
      turnId: "legacy-turn",
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: "REVIEW DECK BATCH: legacy-active\nReplayed legacy marker" },
        { type: "assistant_message", text: "COMMENT OUTCOMES\n- comment-a3-edited | COMPLETED | replayed" },
      ],
    }, hookContext);
    assert.equal((await legacyBatchStore.listByProject(PROJECT_ID))[0]?.status, "submitted");
    assert.ok((await stateStore.load())["target-a3"]?.some((entry) => entry.id === "comment-a3-edited"));
    const releasedLegacy = await legacyRecoveryService.releaseUnknownReviewBatch({
      projectId: PROJECT_ID,
      workspaceId: "workspace-a",
      batchId: legacyBatch.id,
      confirmDuplicateRisk: true,
    }, handlerContext);
    assert.deepEqual(releasedLegacy, { batchId: legacyBatch.id, released: true });
    assert.equal((await legacyBatchStore.listByProject(PROJECT_ID))[0]?.delivery, undefined);
    assert.equal((await legacyBatchStore.listByProject(PROJECT_ID))[0]?.status, "failed");
    assert.ok((await stateStore.load())["target-a3"]?.some((entry) => entry.id === "comment-a3-edited"));

    const interruptedBatchPath = join(root, "interrupted-batch.json");
    const interruptedBatchStore = new ReviewBatchStore(interruptedBatchPath);
    await interruptedBatchStore.create({
      id: "interrupted-send",
      createdAt: "2000-01-01T00:00:00.000Z",
      projectId: PROJECT_ID,
      workspaceId: "workspace-a",
      agentId: "agent-a",
      commentIds: ["comment-a3-edited"],
      status: "draft",
      outcomes: {},
      delivery: {
        messageId: "review-deck-batch:interrupted-send",
        phase: "sending",
        attempts: 1,
        updatedAt: "2000-01-01T00:00:00.000Z",
      },
    });
    const restartedService = new ReviewService({ store: stateStore, reviewBatchStore: interruptedBatchStore });
    const recoveredSend = await restartedService.listProjectReviewComments(PROJECT_ID, handlerContext);
    const interrupted = (await interruptedBatchStore.listByProject(PROJECT_ID))[0];
    assert.equal(interrupted?.status, "draft");
    assert.equal(interrupted?.delivery?.phase, "unknown");
    assert.equal(interrupted?.delivery?.lastErrorCode, "send_interrupted");
    assert.ok(recoveredSend?.batches.some((batch) => batch.id === "interrupted-send"));
    assert.ok(recoveredSend?.comments.some((comment) => comment.id === "comment-a3-edited"));


    const workspaceBSubmission = await service.processProjectReview({
      projectId: PROJECT_ID,
      agentId: "agent-b",
      workspaceId: "workspace-b",
      workspaceCwd: workspaceB,
      commentIds: ["comment-b1"],
    }, handlerContext);
    assert.equal(workspaceBSubmission.workspaceId, "workspace-b");
    assert.ok(prompts.get("agent-b")?.[0]?.includes("comment-b1"));
    await assert.rejects(
      () => service.processProjectReview({
        projectId: PROJECT_ID,
        agentId: "agent-b",
        workspaceId: "workspace-b",
        workspaceCwd: workspaceB,
        commentIds: ["comment-b1"],
      }, handlerContext),
      /active ReviewBatch/i,
      "an Agent with an active batch cannot receive the same comment set twice",
    );
    assert.equal(prompts.get("agent-b")?.length, 1);
    const turnStartedB: PluginLifecycleEvents["agent.turn_started"] = {
      agent: lifecycleAgent("agent-b", "workspace-b", workspaceB),
      turnId: "turn-b",
    };
    const agentBMessageId = sentMessageIds.get("agent-b")?.[0];
    assert.ok(agentBMessageId);
    messageTurnIds.set(agentBMessageId, "turn-b");
    await service.handleAgentTurnStarted(turnStartedB, hookContext);
    const agentB = agents.get("agent-b");
    assert.ok(agentB);
    agentB.status = "idle";
    const recoveredB = await service.listProjectReviewComments(PROJECT_ID, handlerContext);
    const orphanedB = (await batchStore.listByProject(PROJECT_ID)).find((batch) => batch.agentId === "agent-b");
    assert.equal(orphanedB?.status, "failed");
    assert.deepEqual(orphanedB?.outcomes, { "comment-b1": "unresolved" });
    assert.ok(recoveredB?.comments.some((comment) => comment.id === "comment-b1"));
    assert.deepEqual(recoveredB?.batches, [], "an idle Agent releases an orphaned running batch without clearing comments");

    assert.ok(orphanedB);
    const batchBId = orphanedB.id;
    const batchBPrompt = prompts.get("agent-b")?.[0];
    assert.ok(batchBPrompt);
    const lateTurnEndedB: PluginLifecycleEvents["agent.turn_ended"] = {
      agent: lifecycleAgent("agent-b", "workspace-b", workspaceB),
      turnId: "turn-b",
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: batchBPrompt, messageId: agentBMessageId, clientMessageId: agentBMessageId },
        { type: "assistant_message", text: "COMMENT OUTCOMES\n- comment-b1 | COMPLETED | recovered from timeline" },
      ],
    };
    await service.handleAgentTurnEnded(lateTurnEndedB, hookContext);
    const finalizedB = (await batchStore.listByProject(PROJECT_ID)).find((batch) => batch.id === batchBId);
    assert.equal(finalizedB?.status, "completed", "a late matching turn can replace an orphan failure with its explicit outcome");
    const recoveredAfterLateTurn = await service.listProjectReviewComments(PROJECT_ID, handlerContext);
    assert.ok(!recoveredAfterLateTurn?.comments.some((comment) => comment.id === "comment-b1"));
    const batchBTimeline = timelineItems.filter((item) => item.id === `review-deck-batch:${batchBId}`);
    assert.ok(batchBTimeline.length >= 3);
    const lastBatchBTimelineItem = batchBTimeline[batchBTimeline.length - 1];
    assert.ok(lastBatchBTimelineItem);
    assert.equal(reviewBatchTimelineSchema.parse(lastBatchBTimelineItem.data).status, "completed");


    const workspaceGuardEntry = commentEntry("comment-a-workspace-guard", "workspace-a", workspaceA);
    workspaceGuardEntry.filePath = "src/comment-a2.ts";
    const withWorkspaceGuard = await stateStore.load();
    withWorkspaceGuard["target-workspace-guard"] = [workspaceGuardEntry];
    await stateStore.save(withWorkspaceGuard);

    await assert.rejects(
      () => service.processProjectReview({
        projectId: PROJECT_ID,
        agentId: "agent-b",
        workspaceId: "workspace-a",
        workspaceCwd: workspaceA,
        commentIds: ["comment-a-workspace-guard"],
      }, handlerContext),
      /belongs to workspace workspace-b/,
      "an Agent from another workspace cannot receive this comment group",
    );
    const workspaceDSubmission = await service.processProjectReview({
      projectId: PROJECT_ID,
      agentId: "agent-d",
      workspaceId: "workspace-d",
      workspaceCwd: workspaceD,
      commentIds: ["comment-d1"],
    }, handlerContext);
    assert.equal(workspaceDSubmission.status, "submitted");
    await service.handleAgentArchived({
      agent: lifecycleAgent("agent-d", "workspace-d", workspaceD),
      archivedAt: "2026-09-30T12:01:00.000Z",
    }, hookContext);
    const archivedD = (await batchStore.listByProject(PROJECT_ID)).find((batch) => batch.id === workspaceDSubmission.id);
    assert.equal(archivedD?.status, "submitted", "archiving cannot silently release an accepted message with no observed turn");
    assert.equal(archivedD?.delivery?.phase, "accepted");
    assert.ok((await service.listProjectReviewComments(PROJECT_ID, handlerContext))?.comments.some((comment) => comment.id === "comment-d1"));
    const releaseArchived = await service.releaseUnknownReviewBatch({
      projectId: PROJECT_ID,
      workspaceId: "workspace-d",
      batchId: workspaceDSubmission.id,
      confirmDuplicateRisk: true,
    }, handlerContext);
    assert.deepEqual(releaseArchived, { batchId: workspaceDSubmission.id, released: true });
    assert.equal((await batchStore.listByProject(PROJECT_ID)).find((batch) => batch.id === workspaceDSubmission.id)?.status, "failed");

    const agentD = agents.get("agent-d");
    assert.ok(agentD);
    agentD.archivedAt = null;
    agentD.status = "idle";
    const deferredAgentD = createDeferredSend();
    delayedSends.set("agent-d", {
      started: deferredAgentD.notifyStarted,
      acknowledgement: deferredAgentD.acknowledgement,
    });
    const secondDSubmissionPromise = service.processProjectReview({
      projectId: PROJECT_ID,
      agentId: "agent-d",
      workspaceId: "workspace-d",
      workspaceCwd: workspaceD,
      commentIds: ["comment-d1"],
    }, handlerContext);
    await deferredAgentD.started;
    const secondDPrompt = prompts.get("agent-d")?.[1];
    assert.ok(secondDPrompt);
    const secondDMessageId = sentMessageIds.get("agent-d")?.[1];
    assert.ok(secondDMessageId);
    const turnStartedD: PluginLifecycleEvents["agent.turn_started"] = {
      agent: lifecycleAgent("agent-d", "workspace-d", workspaceD),
      turnId: "turn-d2",
    };
    await service.handleAgentTurnStarted(turnStartedD, hookContext);
    const uncorrelatedD = await batchStore.findActiveForAgent("agent-d");
    assert.equal(uncorrelatedD?.status, "draft", "an unrelated Turn cannot claim a batch by Agent id alone");
    assert.equal(uncorrelatedD?.turnId, undefined);
    messageTurnIds.set(secondDMessageId, "turn-d2");
    await service.handleAgentTurnStarted(turnStartedD, hookContext);
    deferredAgentD.acknowledge();
    const secondDSubmission = await secondDSubmissionPromise;
    assert.equal(secondDSubmission.status, "running", "a late ACK cannot move a running batch back to submitted");
    assert.equal(secondDSubmission.delivery?.phase, "accepted");
    await service.handleAgentTurnEnded({
      agent: lifecycleAgent("agent-d", "workspace-d", workspaceD),
      turnId: "turn-d2",
      outcome: { kind: "failed", error: { message: "Agent turn failed" } },
      timeline: [{ type: "user_message", text: secondDPrompt, messageId: secondDMessageId, clientMessageId: secondDMessageId }],
    }, hookContext);
    const failedWithoutOutput = (await batchStore.listByProject(PROJECT_ID))
      .find((batch) => batch.agentId === "agent-d" && batch.id !== workspaceDSubmission.id);
    assert.equal(failedWithoutOutput?.status, "failed");
    assert.deepEqual(failedWithoutOutput?.outcomes, { "comment-d1": "unresolved" });
    assert.equal(failedWithoutOutput?.delivery?.phase, "accepted");
    assert.ok((await service.listProjectReviewComments(PROJECT_ID, handlerContext))?.comments.some((comment) => comment.id === "comment-d1"));

    const agentC = agents.get("agent-c");
    assert.ok(agentC);
    agentC.status = "idle";
    const stalePrepared: ReviewBatch = {
      id: "stale-prepared-c",
      createdAt: "2000-01-01T00:00:00.000Z",
      projectId: PROJECT_ID,
      workspaceId: "workspace-c",
      agentId: "agent-c",
      commentIds: ["comment-c1-timeout"],
      status: "draft",
      outcomes: {},
      delivery: {
        messageId: "review-deck-batch:stale-prepared-c",
        phase: "prepared",
        attempts: 0,
        updatedAt: "2000-01-01T00:00:00.000Z",
      },
    };
    const timeoutComment = commentEntry("comment-c1-timeout", "workspace-c", workspaceC);
    const timeoutState = await stateStore.load();
    timeoutState["target-c1-timeout"] = [timeoutComment];
    await stateStore.save(timeoutState);
    await batchStore.create(stalePrepared);
    failRefresh.add("agent-c");
    const duringRefreshFailure = await service.listProjectReviewComments(PROJECT_ID, handlerContext);
    assert.equal((await batchStore.listByProject(PROJECT_ID)).find((batch) => batch.id === stalePrepared.id)?.status, "draft");
    assert.ok(duringRefreshFailure?.batches.some((batch) => batch.id === stalePrepared.id));
    failRefresh.delete("agent-c");
    const afterStartTimeout = await service.listProjectReviewComments(PROJECT_ID, handlerContext);
    const timedOutBatch = (await batchStore.listByProject(PROJECT_ID)).find((batch) => batch.id === stalePrepared.id);
    assert.equal(timedOutBatch?.status, "failed");
    assert.deepEqual(timedOutBatch?.outcomes, { "comment-c1-timeout": "unresolved" });
    assert.ok(afterStartTimeout?.comments.some((entry) => entry.id === "comment-c1-timeout"));
    assert.deepEqual(afterStartTimeout?.batches, [], "a prepared batch with no send attempt releases its claim after the grace period");
    await assert.rejects(
      () => service.processProjectReview({
        projectId: PROJECT_ID,
        agentId: "agent-c",
        workspaceId: "workspace-c",
        workspaceCwd: workspaceC,
        commentIds: ["comment-c1"],
      }, handlerContext),
      /send acknowledgment timed out/,
    );
    const uncertain = (await batchStore.listByProject(PROJECT_ID))
      .find((batch) => batch.agentId === "agent-c" && batch.delivery?.phase === "unknown");
    assert.equal(uncertain?.status, "draft", "an ambiguous send error does not mark the business batch terminal");
    assert.equal(uncertain?.delivery?.attempts, 1);
    assert.ok(sentMessageIds.get("agent-c")?.[0]?.startsWith("review-deck-batch:"), "the possibly delivered message has a stable id");
    assert.ok((await service.listProjectReviewComments(PROJECT_ID))?.batches.some((batch) => batch.id === uncertain?.id));
    assert.ok((await service.listProjectReviewComments(PROJECT_ID))?.comments.some((entry) => entry.id === "comment-c1"));
    assert.ok(uncertain);
    await batchStore.update(uncertain.id, (current) => ({ ...current, createdAt: "2000-01-01T00:00:00.000Z" }));
    const recoveredUnknown = await service.listProjectReviewComments(PROJECT_ID, handlerContext);
    const recoveredDelivery = (await batchStore.listByProject(PROJECT_ID)).find((batch) => batch.id === uncertain.id);
    assert.equal(recoveredDelivery?.status, "draft");
    assert.equal(recoveredDelivery?.delivery?.phase, "accepted", "timeline recovery proves delivery without releasing the claim");
    assert.ok(recoveredUnknown?.batches.some((batch) => batch.id === uncertain.id));
    assert.ok(recoveredUnknown?.comments.some((entry) => entry.id === "comment-c1"));
    assert.equal(prompts.get("agent-c")?.length, 1, "unknown delivery is never retried automatically");
    const releasedUnknown = await service.releaseUnknownReviewBatch({
      projectId: PROJECT_ID,
      workspaceId: "workspace-c",
      batchId: uncertain.id,
      confirmDuplicateRisk: true,
    }, handlerContext);
    assert.deepEqual(releasedUnknown, { batchId: uncertain.id, released: true });
    const releasedBatch = (await batchStore.listByProject(PROJECT_ID)).find((batch) => batch.id === uncertain.id);
    assert.equal(releasedBatch?.status, "failed");
    assert.equal(releasedBatch?.delivery?.phase, "accepted", "manual unlock records the delivery fact");
    assert.deepEqual(releasedBatch?.outcomes, { "comment-c1": "unresolved" });
    assert.ok((await service.listProjectReviewComments(PROJECT_ID))?.comments.some((entry) => entry.id === "comment-c1"));
    failSend.delete("agent-c");
    const retriedC = await service.processProjectReview({
      projectId: PROJECT_ID,
      agentId: "agent-c",
      workspaceId: "workspace-c",
      workspaceCwd: workspaceC,
      commentIds: ["comment-c1"],
    }, handlerContext);
    const retriedCPrompt = prompts.get("agent-c")?.[1];
    const retriedCMessageId = sentMessageIds.get("agent-c")?.[1];
    assert.ok(retriedCPrompt);
    assert.ok(retriedCMessageId);
    assert.equal(retriedCMessageId, `review-deck-batch:${retriedC.id}`);
    assert.notEqual(retriedCMessageId, sentMessageIds.get("agent-c")?.[0], "a user-confirmed retry gets a new message identity");
    const recoveredTurnEnded: PluginLifecycleEvents["agent.turn_ended"] = {
      agent: lifecycleAgent("agent-c", "workspace-c", workspaceC),
      turnId: "turn-c-recovered",
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: retriedCPrompt, messageId: retriedCMessageId, clientMessageId: retriedCMessageId },
        { type: "assistant_message", text: "COMMENT OUTCOMES\n- comment-c1 | COMPLETED | delivered after recovery" },
      ],
    };
    await service.handleAgentTurnEnded({ ...recoveredTurnEnded, turnId: "turn-c-unrelated" }, hookContext);
    const stillUnlinkedC = (await batchStore.listByProject(PROJECT_ID)).find((batch) => batch.id === retriedC.id);
    assert.equal(stillUnlinkedC?.status, "submitted", "a marker in an unrelated Turn cannot settle this batch");
    assert.ok((await stateStore.load())["target-c1"]?.some((entry) => entry.id === "comment-c1"));
    messageTurnIds.set(retriedCMessageId, "turn-c-recovered");
    await service.handleAgentTurnEnded(recoveredTurnEnded, hookContext);
    const retriedCCompleted = (await batchStore.listByProject(PROJECT_ID)).find((batch) => batch.id === retriedC.id);
    assert.equal(retriedCCompleted?.status, "completed", "a matching message identity can recover when turn_started was missed");
    assert.equal(retriedCCompleted?.delivery?.phase, "accepted");
    assert.ok(!(await stateStore.load())["target-c1"]);
    // A single eligible Agent cannot claim a cwd shared by another workspace.
    const legacyEntry: StateEntry = { ...commentEntry("legacy-shared", "workspace-a", workspaceA), workspaceId: undefined };
    const stateAfterSetup = await stateStore.load();
    stateAfterSetup["target-legacy-shared"] = [legacyEntry];
    await stateStore.save(stateAfterSetup);
    const batchesBeforeAmbiguousLegacy = await batchStore.listByProject(PROJECT_ID);
    await assert.rejects(
      () => service.processProjectReview({
        projectId: PROJECT_ID,
        agentId: "agent-a",
        workspaceId: "workspace-a",
        workspaceCwd: workspaceA,
        commentIds: ["legacy-shared"],
      }, handlerContext),
      /Legacy comment workspace ownership is ambiguous/,
    );
    assert.equal(
      (await batchStore.listByProject(PROJECT_ID)).length,
      batchesBeforeAmbiguousLegacy.length,
      "ambiguous legacy ownership is rejected before creating a ReviewBatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void run().then(() => {
  console.log("ReviewBatch service integration: all assertions passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

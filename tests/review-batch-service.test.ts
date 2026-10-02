import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function run(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "review-deck-review-batch-"));
  const workspaceA = join(root, "worktree-a");
  const workspaceB = join(root, "worktree-b");
  const workspaceC = join(root, "worktree-c");
  const workspaceD = join(root, "worktree-d");
  const statePath = join(root, "reviews.json");
  const batchPath = join(root, "review-batches.json");
  const prompts = new Map<string, string[]>();
  const timelineItems: FakeTimelineItem[] = [];
  const failSend = new Set<string>(["agent-c"]);
  const failRefresh = new Set<string>();

  try {
    await Promise.all([mkdir(workspaceA), mkdir(workspaceB), mkdir(workspaceC), mkdir(workspaceD)]);
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
      ["agent-a", lifecycleAgent("agent-a", "workspace-a", workspaceA)],
      ["agent-b", lifecycleAgent("agent-b", "workspace-b", workspaceB)],
      ["agent-c", lifecycleAgent("agent-c", "workspace-c", workspaceC)],
      ["agent-d", lifecycleAgent("agent-d", "workspace-d", workspaceD)],
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
            send: async (prompt: string) => {
              if (failSend.has(agentId)) throw new Error("send rejected");
              const sent = prompts.get(agentId) ?? [];
              sent.push(prompt);
              prompts.set(agentId, sent);
            },
            timeline: {
              append: async (item: FakeTimelineItem) => { timelineItems.push(item); },
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

    const submitted = await service.processProjectReview({
      projectId: PROJECT_ID,
      agentId: "agent-a",
      workspaceId: "workspace-a",
      workspaceCwd: workspaceA,
      commentIds: ["comment-a1", "comment-a2", "comment-a3"],
    }, handlerContext);
    assert.equal(submitted.status, "submitted");
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
        { type: "user_message", text: prompt },
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
    assert.equal(afterMismatchedTurn?.status, "failed");
    assert.deepEqual(afterMismatchedTurn?.outcomes, {
      "comment-a1": "unresolved",
      "comment-a2": "unresolved",
      "comment-a3": "unresolved",
    });
    assert.ok((await stateStore.load())["target-a1"]?.some((entry) => entry.id === "comment-a1"));
    const conflictingTurnEnded: PluginLifecycleEvents["agent.turn_ended"] = {
      ...turnEnded,
      timeline: [
        { type: "user_message", text: prompt },
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
    assert.equal(timelineItems.length, 4);
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
    assert.equal(timelineItems.length, 5);
    assert.equal(timelineItems[0]?.id, timelineItems[4]?.id, "final outcomes replace the same timeline item");
    const finalTimelineItem = timelineItems[4];
    assert.ok(finalTimelineItem);
    const rawFinalTimeline = finalTimelineItem.data;
    assert.ok(rawFinalTimeline && typeof rawFinalTimeline === "object" && !Array.isArray(rawFinalTimeline));
    assert.equal("commentIds" in rawFinalTimeline, false);
    assert.equal("filePath" in rawFinalTimeline, false);
    const finalTimeline = reviewBatchTimelineSchema.parse(rawFinalTimeline);
    assert.equal(finalTimeline.completedCount, 2);
    assert.equal(finalTimeline.staleCount, 1);

    await service.handleAgentTurnEnded(turnEnded, hookContext);
    assert.equal(timelineItems.length, 5, "replayed turn-ended events do not reprocess terminal batches");

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
        { type: "user_message", text: batchBPrompt },
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


    await assert.rejects(
      () => service.processProjectReview({
        projectId: PROJECT_ID,
        agentId: "agent-a",
        workspaceId: "workspace-b",
        workspaceCwd: workspaceB,
        commentIds: ["comment-b1"],
      }, handlerContext),
      /belongs to workspace workspace-a/,
      "a comment group cannot be routed through an Agent from another workspace",
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
    assert.equal(archivedD?.status, "failed");
    assert.deepEqual(archivedD?.outcomes, { "comment-d1": "unresolved" });
    assert.ok((await service.listProjectReviewComments(PROJECT_ID, handlerContext))?.comments.some((comment) => comment.id === "comment-d1"));

    const agentD = agents.get("agent-d");
    assert.ok(agentD);
    agentD.archivedAt = null;
    agentD.status = "running";
    await service.processProjectReview({
      projectId: PROJECT_ID,
      agentId: "agent-d",
      workspaceId: "workspace-d",
      workspaceCwd: workspaceD,
      commentIds: ["comment-d1"],
    }, handlerContext);
    const secondDPrompt = prompts.get("agent-d")?.[1];
    assert.ok(secondDPrompt);
    await service.handleAgentTurnStarted({
      agent: lifecycleAgent("agent-d", "workspace-d", workspaceD),
      turnId: "turn-d2",
    }, hookContext);
    await service.handleAgentTurnEnded({
      agent: lifecycleAgent("agent-d", "workspace-d", workspaceD),
      turnId: "turn-d2",
      outcome: { kind: "failed", error: { message: "Agent turn failed" } },
      timeline: [{ type: "user_message", text: secondDPrompt }],
    }, hookContext);
    const failedWithoutOutput = (await batchStore.listByProject(PROJECT_ID))
      .find((batch) => batch.agentId === "agent-d" && batch.id !== workspaceDSubmission.id);
    assert.equal(failedWithoutOutput?.status, "failed");
    assert.deepEqual(failedWithoutOutput?.outcomes, { "comment-d1": "unresolved" });
    assert.ok((await service.listProjectReviewComments(PROJECT_ID, handlerContext))?.comments.some((comment) => comment.id === "comment-d1"));

    await assert.rejects(
      () => service.processProjectReview({
        projectId: PROJECT_ID,
        agentId: "agent-c",
        workspaceId: "workspace-c",
        workspaceCwd: workspaceC,
        commentIds: ["comment-c1"],
      }, handlerContext),
      /send rejected/,
    );
    const failed = (await batchStore.listByProject(PROJECT_ID)).find((batch) => batch.agentId === "agent-c");
    assert.equal(failed?.status, "failed");
    assert.deepEqual(failed?.outcomes, { "comment-c1": "failed" });
    assert.ok((await service.listProjectReviewComments(PROJECT_ID))?.comments.some((entry) => entry.id === "comment-c1"));
    const agentC = agents.get("agent-c");
    assert.ok(agentC);
    agentC.status = "idle";
    const staleSubmitted: ReviewBatch = {
      id: "stale-submitted-c",
      createdAt: "2000-01-01T00:00:00.000Z",
      projectId: PROJECT_ID,
      workspaceId: "workspace-c",
      agentId: "agent-c",
      commentIds: ["comment-c1"],
      submittedAt: "2000-01-01T00:00:00.000Z",
      status: "submitted",
      outcomes: {},
    };
    await batchStore.create(staleSubmitted);
    failRefresh.add("agent-c");
    const duringRefreshFailure = await service.listProjectReviewComments(PROJECT_ID, handlerContext);
    assert.equal((await batchStore.listByProject(PROJECT_ID)).find((batch) => batch.id === staleSubmitted.id)?.status, "submitted");
    assert.ok(duringRefreshFailure?.batches.some((batch) => batch.id === staleSubmitted.id));
    failRefresh.delete("agent-c");
    const afterStartTimeout = await service.listProjectReviewComments(PROJECT_ID, handlerContext);
    const timedOutBatch = (await batchStore.listByProject(PROJECT_ID)).find((batch) => batch.id === staleSubmitted.id);
    assert.equal(timedOutBatch?.status, "failed");
    assert.deepEqual(timedOutBatch?.outcomes, { "comment-c1": "unresolved" });
    assert.ok(afterStartTimeout?.comments.some((entry) => entry.id === "comment-c1"));
    assert.deepEqual(afterStartTimeout?.batches, [], "a submitted batch that never starts releases its claim after the grace period");
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

/**
 * v1.7 workspace activity contract: the Review Deck indicators, the detailed
 * popover summary, the read-mark transition, and the minimized plugin timeline
 * row.
 *
 * Indicators are metadata only — they never resolve Git hunks — and they bind
 * to the workspace Paseo resolves, not to the caller's claim: an unknown,
 * mismatched, archiving, or directory-less workspace fails closed, comments are
 * counted by project and by workspace without ever returning a body, persisted
 * stale/ambiguous anchors are reported as their own buckets disjoint from
 * pending, and a legacy comment without a workspace id is only assigned when
 * its directory belongs to exactly one workspace. The summary is the on-demand
 * sibling: it creates the working-tree snapshot, resolves the stored decisions
 * against it, and reports only counts — the reviewed blocks of the current
 * hunks, the total hunks, and the stale count refreshed from the resolution it
 * just ran.
 *
 * Run: npm test (compiled via tests/tsconfig.anchor-engine.json).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { ReviewService } from "../server/ReviewService";
import { ReviewBatchStore } from "../server/persistence/ReviewBatchStore";
import { StateStore, type StateEntry } from "../server/persistence/StateStore";
import { ReviewRunStore, type ReviewRun } from "../server/persistence/ReviewRunStore";
import type { ReviewBatch } from "../shared/review-batch";
import {
  reviewAiTimelineKind,
  reviewAiTimelineSchema,
  reviewAiTimelineVersion,
} from "../shared/review-activity";


type Indicators = {
  workspaceId: string;
  projectId: string;
  projectPendingCommentCount: number;
  projectStaleCommentCount: number;
  workspacePendingCommentCount: number;
  workspaceStaleCommentCount: number;
  activeBatchCount: number;
  runningAiReviewCount: number;
  unreadAiFindingCount: number;
};

type Service = {
  getWorkspaceReviewIndicators(input: { workspaceId: string }, context: PluginHandlerContext): Promise<Indicators>;
  getWorkspaceReviewSummary(
    input: { workspaceId: string },
    context: PluginHandlerContext,
  ): Promise<Indicators & { reviewedBlockCount: number; totalBlockCount: number }>;
  markWorkspaceReviewResultsRead(input: { workspaceId: string }, context: PluginHandlerContext): Promise<{ markedRunCount: number }>;
  recordDecision(input: Record<string, unknown>): Promise<string>;
  createSnapshot(request: { cwd: string; scope: "working" }): Promise<{
    targetFingerprint: string;
    totalHunks: number;
    files: Array<{ path: string; oldPath?: string; hunks: Array<{ id: string; fingerprint: string; filePath: string; header: string; patch: string }> }>;
  }>;
};

type FakeWorkspace = {
  id: string;
  projectId?: string;
  workspaceDirectory?: string;
  archivingAt?: string | null;
};

const PROJECT_ID = "project-activity";
const WORKSPACE_A = "workspace-a";
const WORKSPACE_B = "workspace-b";
const WORKSPACE_SHARED = "workspace-shared";
const ISO = "2026-10-01T00:00:00.000Z";

const commentEntry = (
  id: string,
  options: {
    projectId?: string;
    workspaceId?: string;
    cwd?: string;
    anchorState?: "exact" | "relocated" | "ambiguous" | "stale";
    decision?: "reviewed" | "commented";
    /** `null` stores no comment at all; omitted stores the default body. */
    comment?: string | null;
  } = {},
): StateEntry => ({
  id,
  projectId: options.projectId ?? PROJECT_ID,
  projectName: "Activity project",
  projectRootPath: options.cwd ?? "/repo",
  ...(options.workspaceId !== undefined ? { workspaceId: options.workspaceId } : {}),
  targetFingerprint: `target-${id}`,
  hunkId: `hunk-${id}`,
  hunkFingerprint: `fingerprint-${id}`,
  contentId: `content-${id}`,
  filePath: `src/${id}.ts`,
  hunkHeader: "@@ -1,1 +1,1 @@",
  hunkPatch: "-old\n+new",
  decision: options.decision ?? "commented",
  ...(options.comment === null ? {} : { comment: options.comment ?? `Please update ${id}` }),
  savedAt: ISO,
  ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  scope: "working",
  ...(options.anchorState !== undefined ? { anchorState: options.anchorState } : {}),
});

const run = (requestId: string, workspaceId: string, overrides: Partial<ReviewRun> = {}): ReviewRun => ({
  requestId,
  childAgentId: `child-${requestId}`,
  parentAgentId: "parent-agent",
  workspaceId,
  cacheKey: `cache-${requestId}`,
  mode: "target",
  status: "completed",
  resultSource: "fresh",
  startedAt: ISO,
  locale: "en",
  provider: "review-provider",
  model: "review-model",
  thinkingOptionId: null,
  reviewerPermissionMode: "read-only",
  depth: "targeted",
  cacheEnabled: true,
  inputFingerprint: `fingerprint-${requestId}`,
  promptVersion: 4,
  schemaVersion: 2,
  ...overrides,
});

const activeRun = (requestId: string, workspaceId: string): ReviewRun =>
  run(requestId, workspaceId, {
    status: "running",
    completedAt: undefined,
    findingCount: undefined,
    highRiskFindingCount: undefined,
  });

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

const numberedLines = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `export const l${String(index + 1).padStart(2, "0")} = ${index + 1};`);

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "review-deck-activity-service-"));
try {
  const repoDir = join(root, "repo"); // workspace A: a real Git worktree
  const plainDir = join(root, "plain"); // workspace B: no Git repository
  const elsewhereDir = join(root, "elsewhere"); // an unowned directory
  await Promise.all([mkdir(repoDir), mkdir(plainDir), mkdir(elsewhereDir)]);

  // A mutable workspace registry so one test can add a second workspace that
  // owns the same directory as the first.
  const workspaces = new Map<string, FakeWorkspace>([
    [WORKSPACE_A, { id: WORKSPACE_A, projectId: PROJECT_ID, workspaceDirectory: repoDir, archivingAt: null }],
    [WORKSPACE_B, { id: WORKSPACE_B, projectId: PROJECT_ID, workspaceDirectory: plainDir, archivingAt: null }],
    ["workspace-mismatched", { id: "workspace-other", projectId: PROJECT_ID, workspaceDirectory: plainDir, archivingAt: null }],
    ["workspace-archiving", { id: "workspace-archiving", projectId: PROJECT_ID, workspaceDirectory: plainDir, archivingAt: ISO }],
    ["workspace-no-project", { id: "workspace-no-project", workspaceDirectory: plainDir, archivingAt: null }],
    ["workspace-no-directory", { id: "workspace-no-directory", projectId: PROJECT_ID, archivingAt: null }],
  ]);
  let workspaceList: FakeWorkspace[] = [...workspaces.values()];
  const context = {
    paseo: {
      workspaces: {
        ref: (workspaceId: string) => {
          const workspace = workspaces.get(workspaceId);
          return {
            refresh: async () => workspace ?? null,
            current: () => workspace ?? null,
          };
        },
        list: async () => ({
          requestId: "req-1",
          entries: [...workspaceList],
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        }),
      },
    },
  } as unknown as PluginHandlerContext;

  // -------------------------------------------------------------------------
  // 1. Indicators: project/workspace comment counts, batch and run activity,
  //    unread findings, and a fail-closed workspace binding. The injected Git
  //    factory throws, so a Git read anywhere in these paths fails the test.
  // -------------------------------------------------------------------------
  const activityState = new StateStore(join(root, "activity-reviews.json"));
  await activityState.save({
    "target-a-exact": [commentEntry("comment-a-exact", { workspaceId: WORKSPACE_A, cwd: repoDir, anchorState: "exact" })],
    "target-a-stale": [commentEntry("comment-a-stale", { workspaceId: WORKSPACE_A, cwd: repoDir, anchorState: "stale" })],
    "target-a-ambiguous": [commentEntry("comment-a-ambiguous", { workspaceId: WORKSPACE_A, cwd: repoDir, anchorState: "ambiguous" })],
    "target-b": [commentEntry("comment-b", { workspaceId: WORKSPACE_B, cwd: plainDir })],
    "target-legacy-a": [commentEntry("comment-legacy-a", { cwd: repoDir, anchorState: "exact" })],
    "target-legacy-orphan": [commentEntry("comment-legacy-orphan", { cwd: elsewhereDir })],
    "target-reviewed": [commentEntry("reviewed-a", { workspaceId: WORKSPACE_A, cwd: repoDir, decision: "reviewed", comment: null })],
    "target-other-project": [commentEntry("comment-other-project", { projectId: "project-other", workspaceId: WORKSPACE_A, cwd: repoDir })],
    "target-blank": [commentEntry("comment-blank", { workspaceId: WORKSPACE_A, cwd: repoDir, comment: "   " })],
    "target-no-cwd": [commentEntry("comment-no-cwd", { workspaceId: WORKSPACE_A })],
  });
  const activityBatches = new ReviewBatchStore(join(root, "activity-batches.json"));
  await activityBatches.create({
    id: "batch-a-active",
    createdAt: ISO,
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_A,
    agentId: "agent-a",
    commentIds: ["c-active"],
    submittedAt: ISO,
    status: "running",
    outcomes: {},
  });
  await activityBatches.create({
    id: "batch-a-done",
    createdAt: ISO,
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_A,
    agentId: "agent-a",
    commentIds: ["c-done"],
    submittedAt: ISO,
    completedAt: ISO,
    status: "completed",
    outcomes: { "c-done": "completed" },
  });
  await activityBatches.create({
    id: "batch-b-draft",
    createdAt: ISO,
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_B,
    agentId: "agent-b",
    commentIds: ["c-b"],
    status: "draft",
    outcomes: {},
  });
  const activityRuns = new ReviewRunStore(join(root, "activity-runs.json"));
  await activityRuns.create(run("run-a1", WORKSPACE_A, { findingCount: 3, highRiskFindingCount: 1 }));
  await activityRuns.create(run("run-a2", WORKSPACE_A, {
    childAgentId: null,
    resultSource: "cached",
    findingCount: 1,
    highRiskFindingCount: 0,
  }));
  await activityRuns.create(run("run-a3", WORKSPACE_A, { findingCount: 2, highRiskFindingCount: 0, readAt: ISO }));
  await activityRuns.create(run("run-a4", WORKSPACE_A, {
    status: "failed",
    findingCount: 2,
    highRiskFindingCount: 1,
    completedAt: ISO,
  }));
  await activityRuns.create(activeRun("run-a5", WORKSPACE_A));
  await activityRuns.create(run("run-b1", WORKSPACE_B, { findingCount: 5, highRiskFindingCount: 2 }));
  await activityRuns.create(activeRun("run-b2", WORKSPACE_B));

  const activityService = new ReviewService({
    store: activityState,
    reviewBatchStore: activityBatches,
    reviewRunStore: activityRuns,
    gitFactory: () => {
      throw new Error("Review indicators must never invoke Git.");
    },
  }) as Service;

  const indicatorsA = await activityService.getWorkspaceReviewIndicators({ workspaceId: WORKSPACE_A }, context);
  assert.deepStrictEqual(indicatorsA, {
    workspaceId: WORKSPACE_A,
    projectId: PROJECT_ID,
    // Pending and stale are disjoint: the two stale/ambiguous comments are
    // reported by the stale count and are not pending items.
    projectPendingCommentCount: 4,
    projectStaleCommentCount: 2,
    // Workspace A: its own exact comment plus the legacy comment whose
    // directory is uniquely owned by workspace A.
    workspacePendingCommentCount: 2,
    workspaceStaleCommentCount: 2,
    activeBatchCount: 1,
    runningAiReviewCount: 1,
    // Completed runs of this workspace without a read mark: 3 + 1 findings.
    unreadAiFindingCount: 4,
  });
  assert.ok(!JSON.stringify(indicatorsA).includes("Please update"), "indicators never return a comment body");

  const indicatorsB = await activityService.getWorkspaceReviewIndicators({ workspaceId: WORKSPACE_B }, context);
  assert.deepStrictEqual(indicatorsB, {
    workspaceId: WORKSPACE_B,
    projectId: PROJECT_ID,
    projectPendingCommentCount: 4,
    projectStaleCommentCount: 2,
    workspacePendingCommentCount: 1,
    workspaceStaleCommentCount: 0,
    activeBatchCount: 1,
    runningAiReviewCount: 1,
    unreadAiFindingCount: 5,
  });

  await assert.rejects(
    activityService.getWorkspaceReviewIndicators({ workspaceId: "workspace-unknown" }, context),
    /does not exist/,
    "an unknown workspace is refused instead of reporting another workspace's activity",
  );
  await assert.rejects(
    activityService.getWorkspaceReviewIndicators({ workspaceId: "workspace-mismatched" }, context),
    /mismatched/,
  );
  await assert.rejects(
    activityService.getWorkspaceReviewIndicators({ workspaceId: "workspace-archiving" }, context),
    /being archived/,
  );
  for (const workspaceId of ["workspace-no-project", "workspace-no-directory"]) {
    await assert.rejects(
      activityService.getWorkspaceReviewIndicators({ workspaceId }, context),
      /declares no project and directory/,
      `${workspaceId} cannot report activity without a project and directory`,
    );
  }

  // -------------------------------------------------------------------------
  // 2. A legacy comment is assigned to a workspace only while its directory
  //    has exactly one owner; a second workspace on the same directory makes
  //    the ownership ambiguous and excludes it from every workspace count.
  // -------------------------------------------------------------------------
  workspaces.set(WORKSPACE_SHARED, {
    id: WORKSPACE_SHARED,
    projectId: PROJECT_ID,
    workspaceDirectory: repoDir,
    archivingAt: null,
  });
  workspaceList = [...workspaces.values()];
  const sharedIndicators = await activityService.getWorkspaceReviewIndicators({ workspaceId: WORKSPACE_SHARED }, context);
  assert.deepStrictEqual(sharedIndicators, {
    workspaceId: WORKSPACE_SHARED,
    projectId: PROJECT_ID,
    projectPendingCommentCount: 4,
    projectStaleCommentCount: 2,
    workspacePendingCommentCount: 0,
    workspaceStaleCommentCount: 0,
    activeBatchCount: 0,
    runningAiReviewCount: 0,
    unreadAiFindingCount: 0,
  });
  const ambiguousIndicators = await activityService.getWorkspaceReviewIndicators({ workspaceId: WORKSPACE_A }, context);
  assert.equal(
    ambiguousIndicators.workspacePendingCommentCount,
    1,
    "the legacy comment leaves workspace A once its directory has two owners",
  );
  assert.equal(ambiguousIndicators.workspaceStaleCommentCount, 2);
  assert.equal(ambiguousIndicators.projectPendingCommentCount, 4, "project counts do not depend on directory ownership");

  // -------------------------------------------------------------------------
  // 3. Opening the deck marks every completed unread run of that workspace
  //    exactly once and never touches another workspace's runs.
  // -------------------------------------------------------------------------
  const marked = await activityService.markWorkspaceReviewResultsRead({ workspaceId: WORKSPACE_A }, context);
  assert.deepStrictEqual(marked, { markedRunCount: 2 });
  assert.ok((await activityRuns.get("run-a1"))?.readAt, "the unread completed run is stamped");
  assert.ok((await activityRuns.get("run-a2"))?.readAt, "a cached completed run is stamped too");
  assert.equal((await activityRuns.get("run-a3"))?.readAt, ISO, "an already-read run keeps its original mark");
  assert.equal((await activityRuns.get("run-a4"))?.readAt, undefined, "a failed run is never marked read");
  assert.equal((await activityRuns.get("run-a5"))?.readAt, undefined, "a running run is never marked read");
  assert.equal((await activityRuns.get("run-b1"))?.readAt, undefined, "another workspace's run is never marked read");
  assert.equal(
    (await activityService.getWorkspaceReviewIndicators({ workspaceId: WORKSPACE_A }, context)).unreadAiFindingCount,
    0,
  );
  assert.deepStrictEqual(
    await activityService.markWorkspaceReviewResultsRead({ workspaceId: WORKSPACE_A }, context),
    { markedRunCount: 0 },
    "a second opening has nothing left to mark",
  );
  assert.equal((await activityService.getWorkspaceReviewIndicators({ workspaceId: WORKSPACE_B }, context)).unreadAiFindingCount, 5);

  // -------------------------------------------------------------------------
  // 4. The detailed summary resolves the working-tree snapshot on demand: the
  //    reviewed blocks of the current hunks, the total hunks, and a stale
  //    count refreshed by the resolution it just ran — counts only.
  // -------------------------------------------------------------------------
  git(repoDir, "init", "-q");
  git(repoDir, "config", "user.name", "Review Deck Test");
  git(repoDir, "config", "user.email", "review-deck-test@example.invalid");
  const baselineA = numberedLines(12);
  const baselineB = numberedLines(4);
  await writeFile(join(repoDir, "a.ts"), `${baselineA.join("\n")}\n`);
  await writeFile(join(repoDir, "b.ts"), `${baselineB.join("\n")}\n`);
  git(repoDir, "add", "a.ts", "b.ts");
  git(repoDir, "commit", "-qm", "baseline");
  const changedA = [...baselineA];
  changedA[1] = "export const l02 = 2; // changed";
  changedA[11] = "export const l12 = 12; // changed";
  const changedB = [...baselineB];
  changedB[2] = "export const l03 = 3; // changed";
  await writeFile(join(repoDir, "a.ts"), `${changedA.join("\n")}\n`);
  await writeFile(join(repoDir, "b.ts"), `${changedB.join("\n")}\n`);

  const summaryState = new StateStore(join(root, "summary-reviews.json"));
  const summaryService = new ReviewService({
    store: summaryState,
    reviewBatchStore: new ReviewBatchStore(join(root, "summary-batches.json")),
    reviewRunStore: new ReviewRunStore(join(root, "summary-runs.json")),
  }) as Service;

  const before = await summaryService.createSnapshot({ cwd: repoDir, scope: "working" });
  assert.equal(before.totalHunks, 3, "two changes in a.ts and one in b.ts are three review blocks");
  const fileA = before.files.find((file) => file.path === "a.ts");
  const fileB = before.files.find((file) => file.path === "b.ts");
  assert.ok(fileA, "a.ts is part of the snapshot");
  assert.ok(fileB, "b.ts is part of the snapshot");
  assert.equal(fileA.hunks.length, 2, "the two changes of a.ts are separate review blocks");
  assert.equal(fileB.hunks.length, 1);
  const [aHunk1, aHunk2] = fileA.hunks;
  const [bHunk1] = fileB.hunks;
  const decision = (
    hunk: { id: string; fingerprint: string; filePath: string; header: string; patch: string },
    overrides: { decision: "reviewed" | "commented"; comment?: string },
  ) => summaryService.recordDecision({
    projectId: PROJECT_ID,
    cwd: repoDir,
    targetFingerprint: before.targetFingerprint,
    hunkId: hunk.id,
    hunkFingerprint: hunk.fingerprint,
    filePath: hunk.filePath,
    hunkHeader: hunk.header,
    hunkPatch: hunk.patch,
    decision: overrides.decision,
    scope: "working",
    workspaceId: WORKSPACE_A,
    ...(overrides.comment !== undefined ? { comment: overrides.comment } : {}),
  });
  await decision(aHunk1, { decision: "reviewed" });
  await decision(aHunk2, { decision: "commented", comment: "Simplify this line." });
  await decision(bHunk1, { decision: "commented", comment: "Rename this constant." });

  // The second change of a.ts is rewritten: its saved comment can no longer be
  // placed on the current hunk, while the reviewed decision and b.ts still
  // resolve against the new target.
  const rewrittenA = [...changedA];
  rewrittenA[11] = "export const l12 = 12; // changed again";
  await writeFile(join(repoDir, "a.ts"), `${rewrittenA.join("\n")}\n`);
  const afterRewrite = await summaryService.createSnapshot({ cwd: repoDir, scope: "working" });
  const rewrittenHunk = afterRewrite.files.find((file) => file.path === "a.ts")?.hunks[1];
  assert.ok(rewrittenHunk, "the rewritten second hunk has a current identity");
  await summaryService.recordDecision({
    projectId: PROJECT_ID,
    cwd: repoDir,
    targetFingerprint: afterRewrite.targetFingerprint,
    hunkId: rewrittenHunk.id,
    hunkFingerprint: rewrittenHunk.fingerprint,
    filePath: rewrittenHunk.filePath,
    hunkHeader: rewrittenHunk.header,
    hunkPatch: rewrittenHunk.patch,
    decision: "reviewed",
    scope: "working",
    workspaceId: WORKSPACE_B,
  });


  const summary = await summaryService.getWorkspaceReviewSummary({ workspaceId: WORKSPACE_A }, context);
  assert.deepStrictEqual(
    Object.keys(summary).sort(),
    [
      "activeBatchCount",
      "projectId",
      "projectPendingCommentCount",
      "projectStaleCommentCount",
      "reviewedBlockCount",
      "runningAiReviewCount",
      "totalBlockCount",
      "unreadAiFindingCount",
      "workspaceId",
      "workspacePendingCommentCount",
      "workspaceStaleCommentCount",
    ].sort(),
    "the summary exposes counts only",
  );
  assert.equal(summary.workspaceId, WORKSPACE_A);
  assert.equal(summary.totalBlockCount, 3);
  assert.equal(
    summary.reviewedBlockCount,
    2,
    "a decision in the same target bucket but bound to another workspace cannot inflate this popover count",
  );
  assert.equal(summary.workspacePendingCommentCount, 1);
  assert.equal(
    summary.workspaceStaleCommentCount,
    1,
    "the stale count is refreshed from the resolution the summary just ran",
  );
  assert.equal(summary.projectPendingCommentCount, 1);
  assert.equal(summary.projectStaleCommentCount, 1);
  assert.equal(summary.activeBatchCount, 0);
  assert.equal(summary.runningAiReviewCount, 0);
  assert.equal(summary.unreadAiFindingCount, 0);
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes(repoDir), "the summary never leaks the workspace directory");
  assert.ok(!serialized.includes("Simplify this line."), "the summary never leaks a comment body");
  assert.ok(!serialized.includes("comment-a-exact"), "the summary never leaks a comment id");

  await assert.rejects(
    summaryService.getWorkspaceReviewSummary({ workspaceId: WORKSPACE_B }, context),
    Error,
    "a workspace whose working tree cannot be resolved fails closed instead of reporting fabricated progress",
  );

  // -------------------------------------------------------------------------
  // 5. The plugin timeline row is a fixed, minimized contract: the kind and
  //    version the renderer keys on, counts and status only, and no field a
  //    finding, path, diff, or comment could travel in.
  // -------------------------------------------------------------------------
  assert.equal(reviewAiTimelineKind, "review-deck-ai-review");
  assert.equal(reviewAiTimelineVersion, 1);
  const timelineRow = {
    workspaceId: WORKSPACE_A,
    mode: "target",
    status: "completed",
    findingCount: 3,
    highRiskFindingCount: 1,
    resultSource: "fresh",
    depth: "targeted",
    usage: { inputTokens: 18_400, outputTokens: 2_100 },
    completedAt: ISO,
  };
  assert.deepStrictEqual(reviewAiTimelineSchema.parse(timelineRow), timelineRow);
  const minimalRow = {
    workspaceId: WORKSPACE_A,
    mode: "file",
    status: "completed",
    findingCount: 0,
    highRiskFindingCount: 0,
    resultSource: "cached",
    completedAt: ISO,
  };
  assert.deepStrictEqual(
    reviewAiTimelineSchema.parse(minimalRow),
    minimalRow,
    "depth and usage stay optional for a result that has none",
  );
  const rejectedTimelineRows = [
    { ...timelineRow, findings: [{ severity: "high", summary: "SQL injection in auth.ts" }] },
    { ...timelineRow, filePath: "src/a.ts" },
    { ...timelineRow, review: "The change needs human review." },
    { ...timelineRow, patch: "@@ -1 +1 @@" },
    { ...timelineRow, comment: "Please simplify this line." },
    { ...timelineRow, requestId: "req-1" },
    { ...timelineRow, highRiskFindingCount: 4, findingCount: 3 },
    { ...timelineRow, findingCount: -1 },
    { ...timelineRow, findingCount: 1.5 },
    { ...timelineRow, mode: "hunk" },
    { ...timelineRow, status: "running" },
    { ...timelineRow, completedAt: "2026-10-01" },
    { ...timelineRow, workspaceId: "" },
  ];
  for (const row of rejectedTimelineRows) {
    assert.equal(
      reviewAiTimelineSchema.safeParse(row).success,
      false,
      `the timeline row must reject ${JSON.stringify(row).slice(0, 90)}`,
    );
  }

  console.log("Review Deck v1.7 workspace activity: all assertions passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

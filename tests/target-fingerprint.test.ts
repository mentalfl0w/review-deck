/**
 * Behavior tests for the cheap target-fingerprint path and the count-only
 * project-comment RPC.
 *
 * Server half (real Git through the real service): ReviewService.getTargetFingerprint
 * must return exactly the fingerprint createSnapshot stamps on its snapshot for
 * the same ReviewRequest — across scopes, refs, the file filter, tracked changes
 * and untracked changes — while parsing nothing; the fingerprint is derived
 * from raw patch CONTENT, so two targets with the same diff stat but different
 * content hash differently. getProjectReviewCommentCount counts exactly the
 * comments listProjectReviewComments lists, without any body leaving the store.
 *
 * Client half (the real useReviewSnapshot under the hook harness, which
 * installs module doubles for `react` / `@getpaseo/plugin/client` and a fake
 * clock): the initial load and every manual refresh run a full snapshot; a
 * workspace-activity change and the 60-second fallback only PROBE the
 * fingerprint and run a full snapshot only when it differs; a failed
 * background probe or load never tears down the shown snapshot; a mounted
 * request change (cwd, file filter, scope/refs) runs its own foreground full
 * snapshot, and a response that lands after it was superseded is dropped
 * without overwriting the new target or reading its obsolete state.
 *
 * The harness import MUST stay ahead of the hook import: it installs the
 * module doubles the hook resolves when it loads.
 *
 * Run: npx tsc --outDir node_modules/.cache/review-deck-tests \
 *   --module commonjs --target ES2020 --moduleResolution node \
 *   --esModuleInterop --skipLibCheck --types node --lib ES2020 \
 *   server/ReviewService.ts client/hooks/useReviewSnapshot.ts \
 *   tests/target-fingerprint.test.ts \
 *   && node node_modules/.cache/review-deck-tests/tests/target-fingerprint.test.js
 *
 * (Compiled rather than type-stripped: GitRunner/StateStore use TypeScript
 * parameter properties, which Node's strip-only mode rejects.)
 */
import { flushMicrotasks, installFakeClock, lastRpcInput, mountWatcher, registerRpcStub, rpcCallCount } from "./harness/review-hook-harness";
import { useReviewSnapshot, type ReviewSnapshotWatcherParams } from "../client/hooks/useReviewSnapshot";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getProjectReviewCommentCount,
  getTargetFingerprint,
  reviewAnchorSchema,
  reviewRequestSchema,
  type ReviewLocale,
  type ReviewRequest,
  type ReviewSnapshot,
} from "../shared/review";
import { ReviewService } from "../server/ReviewService";
import { DiffParser } from "../server/diff/DiffParser";
import { StateStore, type StateEntry } from "../server/persistence/StateStore";

const SNAPSHOT_RPC = "review-deck.snapshot";
const FINGERPRINT_RPC = "review-deck.target-fingerprint";
const STATE_RPC = "review-deck.state";

/** Counts parses so the test can prove the fingerprint probe never reaches the parser. */
class CountingDiffParser extends DiffParser {
  parseCalls = 0;
  override parse(raw: string, targetFingerprint: string, locale: ReviewLocale = "en") {
    this.parseCalls += 1;
    return super.parse(raw, targetFingerprint, locale);
  }
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function snapshotFor(targetFingerprint: string): ReviewSnapshot {
  return {
    repositoryPath: "/repo",
    worktreePath: "/repo",
    scope: "working",
    baseRef: "HEAD",
    headRef: "HEAD",
    baseSha: "a".repeat(40),
    headSha: "a".repeat(40),
    targetFingerprint,
    files: [{
      path: "src/app.txt",
      additions: 1,
      deletions: 1,
      hunks: [{
        id: "H-1",
        fingerprint: `hunk-${targetFingerprint}`,
        filePath: "src/app.txt",
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 2,
        header: "@@ -1,2 +1,2 @@",
        patch: "diff --git a/src/app.txt b/src/app.txt\n@@ -1,2 +1,2 @@\n-alpha\n+ALPHA\n",
        lines: ["-alpha", "+ALPHA"],
        findings: [],
      }],
    }],
    totalHunks: 1,
    priorityHunks: 0,
    generatedAt: "2026-09-29T10:00:00.000Z",
  };
}

/** A parked snapshot RPC: the test decides when — and in which order — each
 * in-flight response lands. */
type ParkedSnapshot = { input: Record<string, unknown>; resolve: (snapshot: ReviewSnapshot) => void };

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 0. RPC contracts
  // -------------------------------------------------------------------------
  assert.equal(getTargetFingerprint.name, "review-deck.target-fingerprint", "probe RPC name");
  assert.equal(getTargetFingerprint.input, reviewRequestSchema, "the probe takes the same ReviewRequest as the snapshot");
  assert.deepEqual(getTargetFingerprint.output.parse({ targetFingerprint: "abc" }), { targetFingerprint: "abc" });
  assert.equal(getProjectReviewCommentCount.name, "review-deck.project-review-comment-count", "count RPC name");
  assert.equal(getProjectReviewCommentCount.input.safeParse({ projectId: "" }).success, false, "an empty projectId is rejected");
  assert.equal(getProjectReviewCommentCount.output.safeParse({ commentCount: -1 }).success, false, "a negative count is rejected");
  assert.deepEqual(getProjectReviewCommentCount.output.parse({ commentCount: 3 }), { commentCount: 3 });

  const anchors = [
    { kind: "file", filePath: "src/app.txt" },
    { kind: "hunk", filePath: "src/app.txt", hunkId: "H-1", hunkFingerprint: "fp-1", contentId: "content-1" },
    {
      kind: "range",
      filePath: "src/app.txt",
      side: "new",
      startLine: 1,
      endLine: 2,
      hunkId: "H-1",
      hunkFingerprint: "fp-1",
      contentId: "content-1",
      selectedTextHash: "selected",
      contextBeforeHash: "before",
      contextAfterHash: "after",
    },
  ];
  for (const anchor of anchors) assert.deepEqual(reviewAnchorSchema.parse(anchor), anchor);
  assert.equal(
    reviewAnchorSchema.safeParse({ kind: "hunk", filePath: "src/app.txt", hunkId: "H-1", hunkFingerprint: "fp-1" }).success,
    false,
    "a reserved HunkAnchor requires its content identity",
  );

  const root = await mkdtemp(join(tmpdir(), "review-deck-fingerprint-"));
  const repo = join(root, "worktree");
  const parser = new CountingDiffParser();
  const store = new StateStore(join(root, "reviews.json"));
  const service = new ReviewService({ store, diffParser: parser });
  const clock = installFakeClock();

  try {
    await mkdir(join(repo, "src"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "review-deck@example.com");
    git(repo, "config", "user.name", "Review Deck Tests");
    git(repo, "config", "commit.gpgsign", "false");
    await writeFile(join(repo, "src", "app.txt"), "alpha\nbeta\n", "utf8");
    git(repo, "add", "src/app.txt");
    git(repo, "commit", "-q", "-m", "initial");

    const working: ReviewRequest = { cwd: repo, scope: "working" };
    const probe = (request: ReviewRequest) => service.getTargetFingerprint(request);
    const snapshot = (request: ReviewRequest) => service.createSnapshot(request);

    // -----------------------------------------------------------------------
    // 1. The probe agrees with the snapshot and parses nothing
    // -----------------------------------------------------------------------
    const cleanProbe = await probe(working);
    assert.deepEqual(Object.keys(cleanProbe), ["targetFingerprint"], "the probe returns only the fingerprint");
    assert.equal(parser.parseCalls, 0, "the fingerprint probe must not parse a diff");
    const cleanSnapshot = await snapshot(working);
    assert.equal(parser.parseCalls, 1, "the full snapshot parses exactly once");
    assert.equal(cleanProbe.targetFingerprint, cleanSnapshot.targetFingerprint, "probe and snapshot must agree on the fingerprint");
    const localizedSnapshot = await snapshot({ ...working, locale: "zh" });
    assert.equal(localizedSnapshot.targetFingerprint, cleanProbe.targetFingerprint, "the fingerprint must not depend on the review locale");

    // -----------------------------------------------------------------------
    // 2. Same diff stat, different patch content
    // -----------------------------------------------------------------------
    await writeFile(join(repo, "src", "app.txt"), "alpha\nGAMMA\n", "utf8");
    const gammaProbe = await probe(working);
    const gammaStat = git(repo, "diff", "--numstat");
    assert.equal(gammaStat, "1\t1\tsrc/app.txt\n", "premise: the edit is one added and one deleted line");
    await writeFile(join(repo, "src", "app.txt"), "alpha\nDELTA\n", "utf8");
    const deltaProbe = await probe(working);
    assert.equal(git(repo, "diff", "--numstat"), gammaStat, "premise: the second edit has the identical diff stat");
    assert.notEqual(deltaProbe.targetFingerprint, gammaProbe.targetFingerprint, "same diff stat but changed patch content must change the fingerprint");
    assert.notEqual(gammaProbe.targetFingerprint, cleanProbe.targetFingerprint, "a working-tree edit must change the fingerprint");

    // -----------------------------------------------------------------------
    // 3. The file filter participates in the identity
    // -----------------------------------------------------------------------
    const fileRequest: ReviewRequest = { cwd: repo, scope: "working", filePath: "src/app.txt" };
    const fileProbe = await probe(fileRequest);
    assert.notEqual(fileProbe.targetFingerprint, deltaProbe.targetFingerprint, "a file-filtered target must not share the unfiltered fingerprint");
    const fileSnapshot = await snapshot(fileRequest);
    assert.equal(fileProbe.targetFingerprint, fileSnapshot.targetFingerprint, "filtered probe and snapshot must agree");
    assert.deepEqual(fileSnapshot.files.map((file) => file.path), ["src/app.txt"], "the filtered snapshot contains only the requested file");

    // -----------------------------------------------------------------------
    // 4. Untracked files: content, not just the file list
    // -----------------------------------------------------------------------
    await writeFile(join(repo, "notes.txt"), "one\ntwo\n", "utf8");
    const untrackedProbe = await probe(working);
    assert.notEqual(untrackedProbe.targetFingerprint, deltaProbe.targetFingerprint, "a new untracked file must change the fingerprint");
    await writeFile(join(repo, "notes.txt"), "one\nTWO\n", "utf8");
    const untrackedEditProbe = await probe(working);
    assert.equal(git(repo, "ls-files", "--others", "--exclude-standard"), "notes.txt\n", "premise: the untracked file list is unchanged");
    assert.notEqual(untrackedEditProbe.targetFingerprint, untrackedProbe.targetFingerprint, "changed untracked content must change the fingerprint");
    // An unchanged target probes to the same fingerprint — still without parsing.
    const parseCallsBeforeRepeat = parser.parseCalls;
    const repeatProbe = await probe(working);
    assert.equal(repeatProbe.targetFingerprint, untrackedEditProbe.targetFingerprint, "an unchanged target must probe to the same fingerprint");
    assert.equal(parser.parseCalls, parseCallsBeforeRepeat, "repeated probes never parse");
    const untrackedSnapshot = await snapshot(working);
    assert.equal(untrackedSnapshot.targetFingerprint, repeatProbe.targetFingerprint, "the snapshot after the probes must match the probe");

    // -----------------------------------------------------------------------
    // 5. Scope is part of the identity
    // -----------------------------------------------------------------------
    git(repo, "add", "src/app.txt");
    const staged: ReviewRequest = { cwd: repo, scope: "staged" };
    const stagedProbe = await probe(staged);
    const stagedSnapshot = await snapshot(staged);
    assert.equal(stagedProbe.targetFingerprint, stagedSnapshot.targetFingerprint, "staged probe and snapshot must agree");
    const workingAfterStage = await probe(working);
    assert.notEqual(stagedProbe.targetFingerprint, workingAfterStage.targetFingerprint, "the staged and working targets must differ");

    // -----------------------------------------------------------------------
    // 6. Explicit refs
    // -----------------------------------------------------------------------
    const baseSha = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "commit", "-q", "-m", "update");
    const commits: ReviewRequest = { cwd: repo, scope: "commits", baseRef: baseSha, headRef: "HEAD" };
    const commitsProbe = await probe(commits);
    const commitsSnapshot = await snapshot(commits);
    assert.equal(commitsProbe.targetFingerprint, commitsSnapshot.targetFingerprint, "commit-range probe and snapshot must agree");
    const emptyRangeProbe = await probe({ ...commits, headRef: baseSha });
    assert.notEqual(emptyRangeProbe.targetFingerprint, commitsProbe.targetFingerprint, "changing the head ref must change the fingerprint");

    // -----------------------------------------------------------------------
    // 7. Branch scope with a resolved base ref
    // -----------------------------------------------------------------------
    const branch: ReviewRequest = { cwd: repo, scope: "branch", baseRef: "main" };
    const branchProbe = await probe(branch);
    const branchSnapshot = await snapshot(branch);
    assert.equal(branchProbe.targetFingerprint, branchSnapshot.targetFingerprint, "branch probe and snapshot must agree");


    // -----------------------------------------------------------------------
    // 8. Persisted HunkAnchor follows a content-identity rebind
    // -----------------------------------------------------------------------
    const anchorPatch = "diff --git a/src/anchor.txt b/src/anchor.txt\n@@ -1 +1 @@\n-old\n+new\n";
    await service.recordDecision({
      projectId: "anchor-project",
      cwd: repo,
      targetFingerprint: "tfp-anchor-old",
      hunkId: "old-hunk",
      hunkFingerprint: "old-fingerprint",
      filePath: "src/anchor.txt",
      hunkHeader: "@@ -1 +1 @@",
      hunkPatch: anchorPatch,
      decision: "commented",
      scope: "working",
      comment: "review this",
    });
    const savedAnchorEntry = (await store.load())["tfp-anchor-old"][0];
    assert.deepEqual(savedAnchorEntry.anchor, {
      kind: "hunk",
      filePath: "src/anchor.txt",
      hunkId: "old-hunk",
      hunkFingerprint: "old-fingerprint",
      contentId: savedAnchorEntry.contentId,
    });
    const reboundState = await service.reviewState({
      targetFingerprint: "tfp-anchor-new",
      currentHunks: [{
        hunkId: "new-hunk",
        filePath: "src/anchor.txt",
        hunkHeader: "@@ -1 +1 @@",
        hunkPatch: anchorPatch,
      }],
    });
    assert.equal((await store.load())["tfp-anchor-old"], undefined, "the migrated entry leaves its source bucket");
    const reboundAnchorEntry = (await store.load())["tfp-anchor-new"][0];
    assert.equal(reboundState.decisions[0]?.anchor?.kind, "hunk");
    assert.equal(reboundState.decisions[0]?.anchorState, "relocated");
    assert.equal(reboundState.decisions[0]?.id, savedAnchorEntry.id);
    assert.deepEqual(reboundState.anchorIssues, []);
    assert.deepEqual(reboundAnchorEntry.anchor, {
      kind: "hunk",
      filePath: "src/anchor.txt",
      hunkId: "new-hunk",
      hunkFingerprint: reboundAnchorEntry.hunkFingerprint,
      contentId: savedAnchorEntry.contentId,
    });
    // -----------------------------------------------------------------------
    // 9. Count-only project comment RPC
    // -----------------------------------------------------------------------
    let seed = 0;
    const entry = (overrides: Partial<StateEntry>): StateEntry => {
      seed += 1;
      return {
        id: `entry-${String(seed)}`,
        hunkId: `H-${String(seed)}`,
        projectId: "proj-1",
        decision: "commented",
        comment: "please tighten this",
        filePath: "src/app.txt",
        hunkFingerprint: `hunk-fp-${String(seed)}`,
        hunkHeader: "@@ -1,2 +1,2 @@",
        hunkPatch: "diff --git a/src/app.txt b/src/app.txt\n@@ -1,2 +1,2 @@\n-alpha\n+ALPHA\n",
        cwd: repo,
        scope: "working",
        targetFingerprint: "tfp-1",
        savedAt: "2026-09-29T10:00:00.000Z",
        ...overrides,
      };
    };
    await store.save({
      "tfp-1": [
        entry({}),
        entry({ comment: "   " }),
        entry({ decision: "reviewed", comment: "not a project comment" }),
        entry({ projectId: "proj-2", comment: "another project" }),
        entry({ comment: undefined }),
        entry({ filePath: undefined }),
      ],
      "tfp-2": [entry({ targetFingerprint: "tfp-2", comment: "second bucket" })],
    });
    const countResult = await service.getProjectReviewCommentCount("proj-1");
    assert.deepEqual(countResult, { commentCount: 2 }, "only complete comments for this project count");
    assert.deepEqual(Object.keys(countResult), ["commentCount"], "the count path returns no other field");
    assert.ok(!JSON.stringify(countResult).includes("tighten"), "no comment body may leave the store through the count path");
    const listed = await service.listProjectReviewComments("proj-1");
    assert.ok(listed !== null, "the project queue must exist for the agreement check");
    assert.equal(listed.commentCount, countResult.commentCount, "the badge count must agree with the listed queue");
    assert.ok(listed.comments.some((comment) => comment.comment === "please tighten this"), "the list path still carries bodies");
    assert.deepEqual(await service.getProjectReviewCommentCount("proj-none"), { commentCount: 0 }, "an unknown project counts zero");
    assert.equal(await service.listProjectReviewComments("proj-none"), null, "an unknown project still lists null");

    // -----------------------------------------------------------------------
    // 10. Client watcher: probe by default, snapshot only on a drifted target
    // -----------------------------------------------------------------------
    let currentFingerprint = "tfp-1";
    let snapshotTarget = "tfp-1";
    const actionErrors: Array<string | null> = [];
    // setActionError(null) clears the panel error on every foreground refresh;
    // only non-null entries are reported failures.
    const reportedErrors = () => actionErrors.filter((entry): entry is string => entry !== null);
    let stateReads = 0;
    registerRpcStub(SNAPSHOT_RPC, async () => snapshotFor(snapshotTarget));
    registerRpcStub(FINGERPRINT_RPC, async () => ({ targetFingerprint: currentFingerprint }));
    registerRpcStub(STATE_RPC, async () => {
      stateReads += 1;
      return { decisions: [], anchorIssues: [] };
    });

    const baseProps: ReviewSnapshotWatcherParams = {
      reviewCwd: "/repo",
      scope: "working",
      baseRef: "",
      headRef: "",
      filePath: "  src/app.txt  ",
      locale: "en",
      projectId: "project-1",
      workspaceId: "workspace-1",
      workspaceDiffStat: { additions: 1, deletions: 1 },
      workspaceStatus: "idle",
      agentRevision: 1,
      setActionError: (message) => {
        actionErrors.push(message);
      },
    };
    const watcher = mountWatcher(useReviewSnapshot, baseProps);
    await flushMicrotasks();
    assert.equal(rpcCallCount(SNAPSHOT_RPC), 1, "the initial load is a full snapshot");
    assert.equal(stateReads, 1, "the initial load reads the saved decisions");
    assert.equal(rpcCallCount(FINGERPRINT_RPC), 0, "the initial load does not probe");
    assert.equal(watcher.value.snapshot?.targetFingerprint, "tfp-1", "the initial snapshot lands");

    // Activity change with an unchanged target: a probe, never a snapshot.
    watcher.setProps({ ...baseProps, workspaceDiffStat: { additions: 2, deletions: 1 } });
    await flushMicrotasks();
    assert.equal(rpcCallCount(FINGERPRINT_RPC), 1, "a workspace activity change probes the fingerprint");
    assert.equal(rpcCallCount(SNAPSHOT_RPC), 1, "an unchanged fingerprint must not run a full snapshot");
    assert.equal(stateReads, 1, "an unchanged fingerprint must not re-read the decisions");

    watcher.setProps({
      ...baseProps,
      workspaceDiffStat: { additions: 2, deletions: 1 },
      workspaceStatus: "running",
    });
    await flushMicrotasks();
    assert.equal(rpcCallCount(FINGERPRINT_RPC), 2, "a workspace status change probes the fingerprint");
    assert.equal(rpcCallCount(SNAPSHOT_RPC), 1, "unchanged content does not parse on a status change");

    watcher.setProps({
      ...baseProps,
      workspaceDiffStat: { additions: 2, deletions: 1 },
      workspaceStatus: "running",
      agentRevision: 2,
    });
    await flushMicrotasks();
    assert.equal(rpcCallCount(FINGERPRINT_RPC), 3, "an agent registry update probes the fingerprint");
    assert.equal(rpcCallCount(SNAPSHOT_RPC), 1, "unchanged content does not parse on an agent update");

    // Activity change with a drifted target: probe, then one full snapshot.
    currentFingerprint = "tfp-2";
    snapshotTarget = "tfp-2";
    watcher.setProps({
      ...baseProps,
      workspaceDiffStat: { additions: 3, deletions: 1 },
      workspaceStatus: "running",
      agentRevision: 2,
    });
    await flushMicrotasks();
    assert.equal(rpcCallCount(FINGERPRINT_RPC), 4, "the activity change probes again");
    assert.equal(rpcCallCount(SNAPSHOT_RPC), 2, "a drifted fingerprint runs a full snapshot");
    assert.equal(stateReads, 2, "the drift loads the saved decisions with it");
    assert.equal(watcher.value.snapshot?.targetFingerprint, "tfp-2", "the drifted snapshot lands");
    assert.equal(watcher.value.stale, true, "landing a drifted target flags the previous review as stale");
    assert.deepEqual(lastRpcInput(FINGERPRINT_RPC), lastRpcInput(SNAPSHOT_RPC), "the probe must ask for the same target as the snapshot");
    assert.deepEqual(lastRpcInput(SNAPSHOT_RPC), { cwd: "/repo", scope: "working", locale: "en", filePath: "src/app.txt" }, "the request carries the trimmed file filter and no refs outside commits scope");

    // Manual refresh stays a full snapshot even when the fingerprint is unchanged.
    await watcher.value.refresh();
    await flushMicrotasks();
    assert.equal(rpcCallCount(SNAPSHOT_RPC), 3, "manual refresh always runs a full snapshot");

    // The 60-second fallback probes without any activity signal.
    const probesBeforeFallback = rpcCallCount(FINGERPRINT_RPC);
    clock.advance(60_000);
    await flushMicrotasks();
    assert.equal(rpcCallCount(FINGERPRINT_RPC), probesBeforeFallback + 1, "the fallback probes the fingerprint");
    assert.equal(rpcCallCount(SNAPSHOT_RPC), 3, "an unchanged fallback probe must not snapshot");

    // A drift no activity signal can show still loads through the fallback.
    currentFingerprint = "tfp-3";
    snapshotTarget = "tfp-3";
    clock.advance(60_000);
    await flushMicrotasks();
    assert.equal(rpcCallCount(SNAPSHOT_RPC), 4, "a drift the diff stat cannot show still loads a full snapshot");
    assert.equal(watcher.value.snapshot?.targetFingerprint, "tfp-3", "the fallback-drifted snapshot lands");

    // A failed background probe keeps the shown snapshot and stays silent.
    registerRpcStub(FINGERPRINT_RPC, async () => {
      throw new Error("git read failed");
    });
    clock.advance(60_000);
    await flushMicrotasks();
    assert.equal(watcher.value.snapshot?.targetFingerprint, "tfp-3", "a failed probe must not tear down the snapshot");
    assert.equal(rpcCallCount(SNAPSHOT_RPC), 4, "a failed probe must not run a snapshot");
    assert.deepEqual(reportedErrors(), [], "a failed background probe surfaces no error");

    // A failed background load keeps the shown snapshot too.
    registerRpcStub(FINGERPRINT_RPC, async () => ({ targetFingerprint: "tfp-4" }));
    registerRpcStub(SNAPSHOT_RPC, async () => {
      throw new Error("git read failed");
    });
    clock.advance(60_000);
    await flushMicrotasks();
    assert.equal(watcher.value.snapshot?.targetFingerprint, "tfp-3", "a failed background load must not tear down the snapshot");
    assert.deepEqual(reportedErrors(), [], "a failed background load surfaces no error");

    // A failed manual refresh still surfaces the error and clears the snapshot.
    await watcher.value.refresh();
    await flushMicrotasks();
    assert.equal(watcher.value.snapshot, null, "a failed manual refresh clears the snapshot");
    assert.deepEqual(reportedErrors(), ["git read failed"], "a failed manual refresh surfaces the error");

    // A commits-scope target carries its refs into both calls.
    watcher.unmount();
    registerRpcStub(SNAPSHOT_RPC, async () => snapshotFor("tfp-5"));
    registerRpcStub(FINGERPRINT_RPC, async () => ({ targetFingerprint: "tfp-5" }));
    const commitsWatcher = mountWatcher(useReviewSnapshot, {
      ...baseProps,
      scope: "commits",
      baseRef: "main",
      headRef: "HEAD",
      filePath: "",
      workspaceDiffStat: null,
    });
    await flushMicrotasks();
    assert.deepEqual(
      lastRpcInput(SNAPSHOT_RPC),
      { cwd: "/repo", scope: "commits", locale: "en", baseRef: "main", headRef: "HEAD" },
      "a commits-scope snapshot carries its refs",
    );
    assert.equal(commitsWatcher.value.snapshot?.targetFingerprint, "tfp-5", "the commits-scope snapshot lands");
    commitsWatcher.unmount();

    // -----------------------------------------------------------------------
    // 11. A mounted-request change supersedes the in-flight snapshot
    // -----------------------------------------------------------------------
    // The old request's full snapshot stays parked in flight while the mounted
    // reviewCwd — then the file filter, then the scope/refs — changes: each
    // switch must run its OWN foreground snapshot, never a probe, and a
    // response that lands after it was superseded must neither overwrite the
    // new target nor pay for a state read against its obsolete one.
    const parkedSnapshots: ParkedSnapshot[] = [];
    const parkedSnapshot = (index: number): ParkedSnapshot => {
      const entry = parkedSnapshots[index];
      assert.ok(entry !== undefined, `snapshot RPC call #${index + 1} must still be in flight`);
      return entry;
    };
    registerRpcStub(SNAPSHOT_RPC, (input) => {
      const call = Promise.withResolvers<ReviewSnapshot>();
      parkedSnapshots.push({ input, resolve: call.resolve });
      return call.promise;
    });

    const oldMount: ReviewSnapshotWatcherParams = { ...baseProps, reviewCwd: "/old-repo", filePath: "src/old.txt" };
    const switchWatcher = mountWatcher(useReviewSnapshot, oldMount);
    await flushMicrotasks();
    assert.equal(parkedSnapshots.length, 1, "the first workspace request mounts a full snapshot");
    assert.deepEqual(parkedSnapshot(0).input, { cwd: "/old-repo", scope: "working", locale: "en", filePath: "src/old.txt" }, "the mounted snapshot asks for the old request");
    const probesBeforeSwitch = rpcCallCount(FINGERPRINT_RPC);
    const readsBeforeSwitch = stateReads;
    const errorsBeforeSwitch = reportedErrors();

    // A cwd switch while that snapshot is still in flight: full, foreground, no probe.
    switchWatcher.setProps({ ...oldMount, reviewCwd: "/new-repo" });
    await flushMicrotasks();
    assert.equal(rpcCallCount(FINGERPRINT_RPC), probesBeforeSwitch, "a mounted-request change must not probe the fingerprint");
    assert.equal(switchWatcher.value.loading, true, "the switched request runs a foreground snapshot");
    assert.equal(parkedSnapshots.length, 2, "the request change launches its own full snapshot");
    assert.deepEqual(parkedSnapshot(1).input, { cwd: "/new-repo", scope: "working", locale: "en", filePath: "src/old.txt" }, "the switched snapshot asks for the new cwd and keeps the other fields");

    // The new request lands first...
    parkedSnapshot(1).resolve(snapshotFor("tfp-new"));
    await flushMicrotasks();
    assert.equal(switchWatcher.value.snapshot?.targetFingerprint, "tfp-new", "the new target's snapshot lands");
    assert.equal(switchWatcher.value.loading, false, "landing the new snapshot ends the foreground load");
    assert.equal(stateReads, readsBeforeSwitch + 1, "the new target reads exactly its own saved decisions");

    // ...and the superseded response afterwards is dropped before it can land or read.
    parkedSnapshot(0).resolve(snapshotFor("tfp-old"));
    await flushMicrotasks();
    assert.equal(switchWatcher.value.snapshot?.targetFingerprint, "tfp-new", "a superseded response must not overwrite the new target");
    assert.equal(stateReads, readsBeforeSwitch + 1, "a superseded response must not read the decisions of its obsolete target");
    assert.deepEqual(reportedErrors(), errorsBeforeSwitch, "a dropped response surfaces no error");

    // A request change that keeps the cwd (the file filter) takes the same path.
    switchWatcher.setProps({ ...oldMount, reviewCwd: "/new-repo", filePath: "src/new.txt" });
    await flushMicrotasks();
    assert.equal(rpcCallCount(FINGERPRINT_RPC), probesBeforeSwitch, "a file-filter change must not probe either");
    assert.equal(parkedSnapshots.length, 3, "the file-filter change launches a full snapshot");
    assert.deepEqual(parkedSnapshot(2).input, { cwd: "/new-repo", scope: "working", locale: "en", filePath: "src/new.txt" }, "the file-filtered snapshot carries the new filter");
    parkedSnapshot(2).resolve(snapshotFor("tfp-file"));
    await flushMicrotasks();
    assert.equal(switchWatcher.value.snapshot?.targetFingerprint, "tfp-file", "the file-filtered target's snapshot lands");
    assert.equal(switchWatcher.value.stale, true, "the filter change flags the previous review as stale");
    assert.equal(stateReads, readsBeforeSwitch + 2, "the file-filtered target reads its decisions once");

    // A scope change that also moves the refs into the request.
    switchWatcher.setProps({ ...oldMount, reviewCwd: "/new-repo", filePath: "src/new.txt", scope: "commits", baseRef: "main", headRef: "HEAD" });
    await flushMicrotasks();
    assert.equal(rpcCallCount(FINGERPRINT_RPC), probesBeforeSwitch, "a scope change must not probe either");
    assert.equal(parkedSnapshots.length, 4, "the scope change launches a full snapshot");
    assert.deepEqual(parkedSnapshot(3).input, { cwd: "/new-repo", scope: "commits", locale: "en", baseRef: "main", headRef: "HEAD", filePath: "src/new.txt" }, "the scope change asks for the new scope, refs and file filter");
    parkedSnapshot(3).resolve(snapshotFor("tfp-commits"));
    await flushMicrotasks();
    assert.equal(switchWatcher.value.snapshot?.targetFingerprint, "tfp-commits", "the commits-scope switch's snapshot lands");
    assert.equal(stateReads, readsBeforeSwitch + 3, "the commits-scope target reads its decisions once, with no read left over for a superseded request");
    switchWatcher.unmount();

    console.log("target-fingerprint: all assertions passed");
    console.log("verdict: getTargetFingerprint returns exactly the createSnapshot fingerprint (scopes, refs, file");
    console.log("         filter, tracked and untracked patch content) while parsing nothing, and");
    console.log("         getProjectReviewCommentCount counts one project's comments without bodies. The");
    console.log("         watcher probes the fingerprint on workspace activity and on its 60-second fallback,");
    console.log("         snapshotting only on a drifted target, never tearing down state on background failure.");
    console.log("         A mounted request change runs its own foreground snapshot, and a superseded response");
    console.log("         is dropped before it can land or read its obsolete state.");
  } finally {
    clock.restore();
    await rm(root, { recursive: true, force: true });
  }
}

main().then(
  () => {},
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);

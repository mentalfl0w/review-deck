/**
 * Review Deck v1.3 anchor engine and re-anchor regression suite (roadmap §5.2,
 * §6.1-§6.5).
 *
 * Server behavior, proven against the real ReviewService and the real state
 * store, with hand-built patches so every scenario is deterministic (real Git
 * only in the two explicitly marked sections, §14 and §15):
 *
 * - range anchors are built from the very hunk patch a decision came from, and
 *   an unusable side/range is rejected before anything is stored;
 * - an unchanged hunk resolves exactly; an insertion above, a rename (matched
 *   ONLY through the current file's oldPath alias), re-derived context around
 *   stable changed lines, and a unique context match all relocate, with the
 *   captured identity hashes never rewritten;
 * - repeated content and repeated context are ambiguous, a deleted hunk is
 *   stale, and neither is ever auto-selected: those entries stay in their
 *   source bucket and come back as anchor issues;
 * - successful resolutions migrate to the current target, restricted to
 *   matching cwd/scope and compatible project/workspace;
 * - a supersede removes exactly the named comment (id and project/workspace/
 *   cwd/scope validated) in the same atomic write that stores its replacement;
 * - re-anchoring never weakens the fail-closed reject path: a relocated
 *   comment still cannot be rejected or reverted under its old target/hunk
 *   fingerprint.
 *
 * Run: npx tsc -p tests/tsconfig.anchor-engine.json \
 *   && node node_modules/.cache/review-deck-anchor-tests/tests/anchor-engine.test.js
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reviewAnchorIssueSchema,
  reviewStateResultSchema,
  type LineRangeReviewAnchor,
  type ReviewAnchor,
  type ReviewStateCurrentHunk,
} from "../shared/review";
import {
  ANCHOR_CONTEXT_LINES,
  anchorTextHash,
  buildLineRangeAnchor,
} from "../server/AnchorEngine";
import { hunkFingerprint } from "../server/diff/DiffParser";
import { StateStore, type StateEntry } from "../server/persistence/StateStore";
import { ReviewService } from "../server/ReviewService";
import { hunkChangeId, hunkContentId } from "../server/util/crypto";

type DecisionInput = Parameters<ReviewService["recordDecision"]>[0];
type StateInput = Parameters<ReviewService["reviewState"]>[0];
type AnchorFileView = NonNullable<StateInput["currentFileViews"]>[number];

const WORKTREE = "/worktrees/project-1/worktree-a";
const PROJECT = "project-1";
const WORKSPACE = "workspace-1";
const APP_PATH = "src/app.txt";
const APP_HEADER = "@@ -1,3 +1,3 @@";
const APP_BODY = [" ctx-a", "-old", "+new", " ctx-b"];
const APP_PATCH = `diff --git a/${APP_PATH} b/${APP_PATH}\nindex 1111111..2222222 100644\n--- a/${APP_PATH}\n+++ b/${APP_PATH}\n${APP_HEADER}\n${APP_BODY.join("\n")}\n`;

function patchFor(filePath: string, header: string, body: readonly string[], oldPath = filePath): string {
  return `diff --git a/${oldPath} b/${filePath}\nindex 1111111..2222222 100644\n--- a/${oldPath}\n+++ b/${filePath}\n${header}\n${body.join("\n")}\n`;
}

/** One hunk exactly as the client would send it for a given target. */
function currentHunkFor(
  targetFingerprint: string,
  filePath: string,
  header: string,
  body: readonly string[],
  ordinal = 0,
  oldPath?: string,
): { currentHunk: ReviewStateCurrentHunk; patch: string; fingerprint: string; hunkId: string } {
  const patch = patchFor(filePath, header, body, oldPath ?? filePath);
  const fingerprint = hunkFingerprint(targetFingerprint, filePath, header, patch, ordinal);
  const hunkId = `H-${fingerprint.slice(0, 10)}`;
  return {
    patch,
    fingerprint,
    hunkId,
    currentHunk: { hunkId, filePath, hunkHeader: header, hunkPatch: patch, ...(oldPath ? { oldPath } : {}) },
  };
}

function stateRequest(
  targetFingerprint: string,
  currentHunks: readonly ReviewStateCurrentHunk[],
  currentFileViews: StateInput["currentFileViews"] = [],
): StateInput {
  return {
    targetFingerprint,
    currentHunks: [...currentHunks],
    request: { cwd: WORKTREE, scope: "working" },
    projectId: PROJECT,
    workspaceId: WORKSPACE,
    currentFileViews,
  };
}

function fullFileView(
  filePath: string,
  rows: AnchorFileView["rows"],
  oldPath?: string,
): AnchorFileView {
  return { filePath, ...(oldPath ? { oldPath } : {}), complete: true, binary: false, truncated: false, rows };
}

function contextRows(
  hunkId: string,
  startLine: number,
  deletedText: string,
  addedText: string,
): AnchorFileView["rows"] {
  return [
    { kind: "context", text: "dup", hunkId, oldLine: startLine, newLine: startLine },
    { kind: "del", text: deletedText, hunkId, oldLine: startLine + 1, newLine: null },
    { kind: "add", text: addedText, hunkId, oldLine: null, newLine: startLine + 1 },
    { kind: "context", text: "dup", hunkId, oldLine: startLine + 2, newLine: startLine + 2 },
  ];
}

function decision(overrides: Partial<DecisionInput>): DecisionInput {
  return {
    projectId: PROJECT,
    workspaceId: WORKSPACE,
    cwd: WORKTREE,
    targetFingerprint: "tfp-decision-1",
    hunkId: "H-decision",
    hunkFingerprint: "fingerprint-decision",
    filePath: APP_PATH,
    hunkHeader: APP_HEADER,
    hunkPatch: APP_PATCH,
    decision: "commented",
    scope: "working",
    comment: "please tighten this",
    ...overrides,
  };
}

let entrySeed = 0;

/** A stored entry as an older build (or another worktree) could have left it. */
function entry(overrides: Partial<StateEntry>): StateEntry {
  entrySeed += 1;
  const contentId = hunkContentId(APP_PATH, APP_PATCH);
  return {
    id: `seeded-${String(entrySeed)}`,
    projectId: PROJECT,
    workspaceId: WORKSPACE,
    cwd: WORKTREE,
    scope: "working",
    hunkId: "H-source",
    decision: "commented",
    comment: "please tighten this",
    filePath: APP_PATH,
    hunkFingerprint: "fingerprint-source",
    hunkHeader: APP_HEADER,
    hunkPatch: APP_PATCH,
    contentId,
    targetFingerprint: "tfp-source",
    anchor: {
      kind: "hunk",
      filePath: APP_PATH,
      hunkId: "H-source",
      hunkFingerprint: "fingerprint-source",
      contentId,
    },
    // Near the present: these entries stand in for an older build's write, but
    // the store's 30-day bucket GC must never prune them mid-test.
    savedAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

/** Narrow a stored anchor to the range anchor the scenario expects. */
function requireRangeAnchor(anchor: ReviewAnchor | undefined): LineRangeReviewAnchor {
  if (anchor?.kind !== "range") throw new Error(`expected a stored range anchor, got ${anchor?.kind ?? "none"}`);
  return anchor;
}

/** The result must survive the frozen RPC schema unmodified (no leaked fields). */
function assertResultContract(state: { decisions: unknown[]; anchorIssues: unknown[] }): void {
  assert.deepEqual(reviewStateResultSchema.parse(state), state, "review state must match the frozen RPC schema exactly");
  for (const issue of state.anchorIssues) {
    assert.deepEqual(reviewAnchorIssueSchema.parse(issue), issue, "anchor issues must match the frozen issue schema exactly");
  }
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "review-deck-anchor-"));
  let section = 0;
  const harness = async (): Promise<{ service: ReviewService; store: StateStore; statePath: string }> => {
    section += 1;
    const statePath = join(root, `s${String(section)}`, "reviews.json");
    const store = new StateStore(statePath);
    return { service: new ReviewService({ store }), store, statePath };
  };

  try {
    // -----------------------------------------------------------------------
    // 1. A range anchor is captured from the decision's own patch, and an
    //    unusable side or range is refused instead of stored half-anchored.
    // -----------------------------------------------------------------------
    const contextHeader = "@@ -1,7 +1,7 @@";
    const contextBody = [" ctx-0", " ctx-1", " ctx-a", "-old", "+new", " ctx-b", " ctx-c", " ctx-d"];
    const contextPatch = patchFor(APP_PATH, contextHeader, contextBody);
    assert.equal(ANCHOR_CONTEXT_LINES, 3, "the captured context is the roadmap's 3-line window");
    const built = buildLineRangeAnchor({
      filePath: APP_PATH,
      hunkId: "H-1",
      hunkFingerprint: "fp-1",
      contentId: "content-1",
      hunkHeader: contextHeader,
      hunkPatch: contextPatch,
      selection: { side: "new", startLine: 4, endLine: 4 },
    });
    assert.deepEqual(built, {
      kind: "range",
      filePath: APP_PATH,
      side: "new",
      startLine: 4,
      endLine: 4,
      hunkId: "H-1",
      hunkFingerprint: "fp-1",
      contentId: "content-1",
      selectedTextHash: anchorTextHash(["new"]),
      selectedTextPreview: "new",
      contextBeforeHash: anchorTextHash(["ctx-0", "ctx-1", "ctx-a"]),
      contextAfterHash: anchorTextHash(["ctx-b", "ctx-c", "ctx-d"]),
    });
    const oldSide = buildLineRangeAnchor({
      filePath: APP_PATH,
      hunkId: "H-1",
      hunkFingerprint: "fp-1",
      contentId: "content-1",
      hunkHeader: contextHeader,
      hunkPatch: contextPatch,
      selection: { side: "old", startLine: 4, endLine: 4 },
    });
    assert.deepEqual(oldSide.selectedTextHash, anchorTextHash(["old"]), "the old side is captured independently");
    assert.deepEqual(oldSide.contextBeforeHash, anchorTextHash(["ctx-0", "ctx-1", "ctx-a"]));
    assert.deepEqual(oldSide.contextAfterHash, anchorTextHash(["ctx-b", "ctx-c", "ctx-d"]));
    const tail = buildLineRangeAnchor({
      filePath: APP_PATH,
      hunkId: "H-1",
      hunkFingerprint: "fp-1",
      contentId: "content-1",
      hunkHeader: contextHeader,
      hunkPatch: contextPatch,
      selection: { side: "new", startLine: 6, endLine: 7 },
    });
    assert.deepEqual(tail.selectedTextHash, anchorTextHash(["ctx-c", "ctx-d"]));
    assert.deepEqual(tail.contextBeforeHash, anchorTextHash(["ctx-a", "new", "ctx-b"]), "at most 3 lines of before context");
    assert.deepEqual(tail.contextAfterHash, anchorTextHash([]), "no lines after the side window");
    assert.throws(
      () => buildLineRangeAnchor({
        filePath: APP_PATH,
        hunkId: "H-1",
        hunkFingerprint: "fp-1",
        contentId: "content-1",
        hunkHeader: contextHeader,
        hunkPatch: contextPatch,
        selection: { side: "new", startLine: 9, endLine: 10 },
      }),
      /outside the new-side window/,
      "a range outside the hunk's side window is refused",
    );
    const addedPatch = patchFor(APP_PATH, "@@ -0,0 +1,2 @@", ["+alpha", "+beta"]);
    assert.throws(
      () => buildLineRangeAnchor({
        filePath: APP_PATH,
        hunkId: "H-add",
        hunkFingerprint: "fp-add",
        contentId: "content-add",
        hunkHeader: "@@ -0,0 +1,2 @@",
        hunkPatch: addedPatch,
        selection: { side: "old", startLine: 1, endLine: 1 },
      }),
      /has no old-side lines/,
      "a pure addition cannot anchor an old-side range",
    );

    // -----------------------------------------------------------------------
    // 2. recordDecision persists the validated anchor and its state.
    // -----------------------------------------------------------------------
    {
      const { service, store, statePath } = await harness();
      const hunk = currentHunkFor("tfp-persist-1", APP_PATH, APP_HEADER, APP_BODY);
      await service.recordDecision(decision({
        targetFingerprint: "tfp-persist-1",
        hunkId: hunk.hunkId,
        hunkFingerprint: hunk.fingerprint,
        hunkPatch: hunk.patch,
        lineRange: { side: "new", startLine: 2, endLine: 2 },
      }));
      const stored = (await store.load())["tfp-persist-1"][0];
      assert.deepEqual(requireRangeAnchor(stored.anchor), {
        kind: "range",
        filePath: APP_PATH,
        side: "new",
        startLine: 2,
        endLine: 2,
        hunkId: hunk.hunkId,
        hunkFingerprint: hunk.fingerprint,
        contentId: stored.contentId,
        selectedTextHash: anchorTextHash(["new"]),
        selectedTextPreview: "new",
        contextBeforeHash: anchorTextHash(["ctx-a"]),
        contextAfterHash: anchorTextHash(["ctx-b"]),
      });
      assert.equal(stored.anchorState, "exact", "a freshly saved decision is exact by construction");
      const reopened = (await new StateStore(statePath).load())["tfp-persist-1"][0];
      assert.deepEqual(reopened.anchor, stored.anchor, "the anchor survives a fresh read of the file");
      assert.equal(reopened.anchorState, "exact");
      await service.recordDecision(decision({
        targetFingerprint: "tfp-persist-1",
        hunkId: "H-plain",
        hunkFingerprint: "fingerprint-plain",
      }));
      const plain = (await store.load())["tfp-persist-1"].find((candidate) => candidate.hunkId === "H-plain")!;
      assert.equal(plain.hunkPatch, APP_PATCH, "the decision's patch is stored verbatim");
      assert.deepEqual(plain.anchor, {
        kind: "hunk",
        filePath: APP_PATH,
        hunkId: "H-plain",
        hunkFingerprint: "fingerprint-plain",
        contentId: hunkContentId(APP_PATH, APP_PATCH),
      }, "a plain decision keeps the v1.2 hunk anchor shape");
      const before = await readFile(statePath, "utf8");
      await assert.rejects(
        service.recordDecision(decision({
          targetFingerprint: "tfp-persist-1",
          hunkId: "H-bad-range",
          hunkHeader: "@@ -0,0 +1,2 @@",
          hunkPatch: addedPatch,
          lineRange: { side: "old", startLine: 1, endLine: 1 },
        })),
        /has no old-side lines/,
      );
      assert.equal(await readFile(statePath, "utf8"), before, "a refused range leaves the store byte-identical");
    }

    // -----------------------------------------------------------------------
    // 3. Unchanged hunk: exact, no issues, and no needless rewrite.
    // -----------------------------------------------------------------------
    {
      const { service, store, statePath } = await harness();
      const hunk = currentHunkFor("tfp-exact-1", APP_PATH, APP_HEADER, APP_BODY);
      await service.recordDecision(decision({
        targetFingerprint: "tfp-exact-1",
        hunkId: hunk.hunkId,
        hunkFingerprint: hunk.fingerprint,
        hunkPatch: hunk.patch,
        lineRange: { side: "new", startLine: 2, endLine: 2 },
      }));
      const stored = (await store.load())["tfp-exact-1"][0];
      const before = await readFile(statePath, "utf8");
      const state = await service.reviewState(stateRequest("tfp-exact-1", [hunk.currentHunk]));
      assertResultContract(state);
      assert.deepEqual(state.decisions, [{
        id: stored.id,
        hunkId: hunk.hunkId,
        decision: "commented",
        comment: "please tighten this",
        savedAt: stored.savedAt,
        anchor: stored.anchor,
        anchorState: "exact",
      }], "an unchanged hunk resolves exactly");
      assert.deepEqual(state.anchorIssues, []);
      assert.equal(await readFile(statePath, "utf8"), before, "an exact resolution that changes nothing must not rewrite the store");
    }

    // -----------------------------------------------------------------------
    // 4. Insertion above: the same hunk moves down, the range follows it.
    // -----------------------------------------------------------------------
    {
      const { service, store } = await harness();
      const hunkA = currentHunkFor("tfp-insert-1", APP_PATH, APP_HEADER, APP_BODY);
      await service.recordDecision(decision({
        targetFingerprint: "tfp-insert-1",
        hunkId: hunkA.hunkId,
        hunkFingerprint: hunkA.fingerprint,
        hunkPatch: hunkA.patch,
        lineRange: { side: "new", startLine: 2, endLine: 2 },
      }));
      const saved = (await store.load())["tfp-insert-1"][0];
      const hunkB = currentHunkFor("tfp-insert-2", APP_PATH, "@@ -6,3 +6,3 @@", APP_BODY);
      assert.equal(hunkContentId(APP_PATH, hunkB.patch), hunkContentId(APP_PATH, hunkA.patch), "premise: only the position moved");
      const state = await service.reviewState(stateRequest("tfp-insert-2", [hunkB.currentHunk]));
      assertResultContract(state);
      assert.equal(state.decisions.length, 1);
      assert.equal(state.decisions[0].anchorState, "relocated");
      assert.equal(state.decisions[0].hunkId, hunkB.hunkId, "the decision is rebound to the current hunk id");
      assert.deepEqual(state.anchorIssues, []);
      const file = await store.load();
      assert.equal(file["tfp-insert-1"], undefined, "the emptied source bucket disappears");
      const moved = file["tfp-insert-2"][0];
      assert.equal(moved.id, saved.id, "the same entry migrates, keeping its identity and save time");
      assert.equal(moved.savedAt, saved.savedAt);
      assert.equal(moved.hunkFingerprint, hunkB.fingerprint);
      assert.equal(moved.hunkPatch, hunkB.patch, "the stored patch now describes the hunk its fingerprint names");
      const movedAnchor = requireRangeAnchor(moved.anchor);
      assert.deepEqual(movedAnchor, {
        kind: "range",
        filePath: APP_PATH,
        side: "new",
        startLine: 7,
        endLine: 7,
        hunkId: hunkB.hunkId,
        hunkFingerprint: hunkB.fingerprint,
        contentId: hunkContentId(APP_PATH, hunkB.patch),
        selectedTextHash: requireRangeAnchor(saved.anchor).selectedTextHash,
        selectedTextPreview: requireRangeAnchor(saved.anchor).selectedTextPreview,
        contextBeforeHash: requireRangeAnchor(saved.anchor).contextBeforeHash,
        contextAfterHash: requireRangeAnchor(saved.anchor).contextAfterHash,
      }, "the range follows the hunk while its captured hashes are untouched");
      // The old side relocates through the same path, against the old file's
      // line numbers (the same body moved down five lines).
      const { service: oldSideService, store: oldSideStore } = await harness();
      const oldSideHunk = currentHunkFor("tfp-oldside-1", APP_PATH, APP_HEADER, APP_BODY);
      await oldSideService.recordDecision(decision({
        targetFingerprint: "tfp-oldside-1",
        hunkId: oldSideHunk.hunkId,
        hunkFingerprint: oldSideHunk.fingerprint,
        hunkPatch: oldSideHunk.patch,
        lineRange: { side: "old", startLine: 2, endLine: 2 },
      }));
      const oldSideMoved = currentHunkFor("tfp-oldside-2", APP_PATH, "@@ -6,3 +6,3 @@", APP_BODY);
      const oldSideState = await oldSideService.reviewState(stateRequest("tfp-oldside-2", [oldSideMoved.currentHunk]));
      assertResultContract(oldSideState);
      const relocatedOldSide = requireRangeAnchor(oldSideState.decisions[0]?.anchor);
      assert.equal(relocatedOldSide.side, "old");
      assert.equal(relocatedOldSide.startLine, 7, "an old-side range relocates on the old side's line numbers");
      assert.equal(relocatedOldSide.endLine, 7);
      assert.equal(relocatedOldSide.selectedTextHash, anchorTextHash(["old"]));
      assert.equal((await oldSideStore.load())["tfp-oldside-1"], undefined, "the old-side entry migrates too");
    }

    // -----------------------------------------------------------------------
    // 5. Context drift with stable changed lines: change identity relocates a
    //    comment; a reviewed record keeps the v1.2 scope and stays put.
    // -----------------------------------------------------------------------
    {
      const { service, store } = await harness();
      const hunkA = currentHunkFor("tfp-drift-1", APP_PATH, APP_HEADER, APP_BODY);
      await service.recordDecision(decision({
        targetFingerprint: "tfp-drift-1",
        hunkId: hunkA.hunkId,
        hunkFingerprint: hunkA.fingerprint,
        hunkPatch: hunkA.patch,
        lineRange: { side: "new", startLine: 2, endLine: 2 },
      }));
      const savedComment = (await store.load())["tfp-drift-1"][0];
      const file = await store.load();
      file["tfp-drift-1"].push(entry({
        id: "reviewed-drift",
        hunkId: hunkA.hunkId,
        decision: "reviewed",
        comment: "a note on a reviewed record",
        hunkFingerprint: hunkA.fingerprint,
        hunkPatch: hunkA.patch,
        contentId: hunkContentId(APP_PATH, hunkA.patch),
        anchor: {
          kind: "hunk",
          filePath: APP_PATH,
          hunkId: hunkA.hunkId,
          hunkFingerprint: hunkA.fingerprint,
          contentId: hunkContentId(APP_PATH, hunkA.patch),
        },
      }));
      await store.save(file);
      const driftB = currentHunkFor("tfp-drift-2", APP_PATH, "@@ -1,4 +1,4 @@", [" ctx-0", " ctx-a", "-old", "+new", " ctx-b"]);
      assert.notEqual(hunkContentId(APP_PATH, driftB.patch), hunkContentId(APP_PATH, hunkA.patch), "premise: the context changed");
      assert.equal(hunkChangeId(APP_PATH, driftB.patch), hunkChangeId(APP_PATH, hunkA.patch), "premise: the changed lines are identical");
      const state = await service.reviewState(stateRequest("tfp-drift-2", [driftB.currentHunk]));
      assertResultContract(state);
      assert.deepEqual(state.decisions.map((row) => row.id), [savedComment.id], "the comment relocated");
      assert.equal(state.decisions[0].anchorState, "relocated");
      assert.deepEqual(state.anchorIssues, [], "a reviewed record never becomes an issue");
      const after = await store.load();
      const relocated = requireRangeAnchor(after["tfp-drift-2"][0].anchor);
      assert.equal(relocated.startLine, 3, "the comment follows its changed line into the re-derived hunk");
      assert.equal(relocated.endLine, 3);
      assert.equal(
        requireRangeAnchor(savedComment.anchor).selectedTextHash,
        relocated.selectedTextHash,
        "the captured hashes are never rewritten",
      );
      assert.deepEqual(after["tfp-drift-1"].map((candidate) => candidate.id), ["reviewed-drift"], "the reviewed record keeps its v1.2 behavior and stays in its bucket");
      assert.equal(after["tfp-drift-1"][0].anchorState, "stale", "its anchor state is recorded as it was resolved");
    }
    // -----------------------------------------------------------------------
    // 5b. Stable changed lines do not authorize a fabricated range when the
    //     selected context line itself disappeared.
    // -----------------------------------------------------------------------
    {
      const { service, store } = await harness();
      const oldContext = currentHunkFor(
        "tfp-lost-context-1",
        APP_PATH,
        "@@ -1,3 +1,3 @@",
        [" ctx-a", "-old", "+new", " ctx-b"],
      );
      await service.recordDecision(decision({
        targetFingerprint: "tfp-lost-context-1",
        hunkId: oldContext.hunkId,
        hunkFingerprint: oldContext.fingerprint,
        hunkPatch: oldContext.patch,
        lineRange: { side: "new", startLine: 1, endLine: 1 },
      }));
      const replacementContext = currentHunkFor(
        "tfp-lost-context-2",
        APP_PATH,
        "@@ -1,3 +1,3 @@",
        [" ctx-replaced", "-old", "+new", " ctx-b"],
      );
      assert.equal(
        hunkChangeId(APP_PATH, oldContext.patch),
        hunkChangeId(APP_PATH, replacementContext.patch),
        "premise: the changed lines still identify the hunk",
      );
      const state = await service.reviewState(stateRequest("tfp-lost-context-2", [replacementContext.currentHunk]));
      assertResultContract(state);
      assert.deepEqual(state.decisions, [], "a shifted range is not fabricated from the hunk header");
      assert.equal(state.anchorIssues[0]?.anchorState, "ambiguous");
      assert.deepEqual(state.anchorIssues[0]?.candidates.map((candidate) => candidate.kind), ["hunk"]);
      const persisted = await store.load();
      assert.ok(persisted["tfp-lost-context-1"]?.[0], "the source comment remains recoverable");
      assert.equal(requireRangeAnchor(persisted["tfp-lost-context-1"][0].anchor).startLine, 1);
    }

    // -----------------------------------------------------------------------
    // 6a. Context match: a unique window relocates the range anchor.
    // -----------------------------------------------------------------------
    const dupHeader = "@@ -1,3 +1,3 @@";
    const dupBody = [" dup", "-aaa", "+bbb", " dup"];
    {
      const { service, store } = await harness();
      const savedHunk = currentHunkFor("tfp-context-1", APP_PATH, dupHeader, dupBody);
      await service.recordDecision(decision({
        targetFingerprint: "tfp-context-1",
        hunkId: savedHunk.hunkId,
        hunkFingerprint: savedHunk.fingerprint,
        hunkHeader: dupHeader,
        hunkPatch: savedHunk.patch,
        lineRange: { side: "new", startLine: 2, endLine: 2 },
      }));
      const saved = (await store.load())["tfp-context-1"][0];
      const uniqueHunk = currentHunkFor("tfp-context-2", APP_PATH, "@@ -10,3 +10,3 @@", [" dup", "-eee", "+bbb", " dup"]);
      assert.notEqual(hunkChangeId(APP_PATH, uniqueHunk.patch), hunkChangeId(APP_PATH, savedHunk.patch), "premise: content and change identity both miss");
      const state = await service.reviewState(stateRequest(
        "tfp-context-2",
        [uniqueHunk.currentHunk],
        [fullFileView(APP_PATH, contextRows(uniqueHunk.hunkId, 10, "eee", "bbb"))],
      ));
      assertResultContract(state);
      assert.equal(state.decisions[0]?.anchorState, "relocated");
      const relocated = requireRangeAnchor(state.decisions[0]?.anchor);
      assert.equal(relocated.startLine, 11, "the unique context match fixes the line");
      assert.equal(relocated.endLine, 11);
      assert.equal(relocated.hunkId, uniqueHunk.hunkId);
      assert.equal(relocated.selectedTextHash, requireRangeAnchor(saved.anchor).selectedTextHash, "the captured hashes are never rewritten");
      assert.deepEqual(state.anchorIssues, []);
    }

    // -----------------------------------------------------------------------
    // 6b. Repeated context: ambiguous, with both candidate windows, never
    //     auto-selected.
    // -----------------------------------------------------------------------
    {
      const { service, store } = await harness();
      const savedHunk = currentHunkFor("tfp-context-3", APP_PATH, dupHeader, dupBody);
      await service.recordDecision(decision({
        targetFingerprint: "tfp-context-3",
        hunkId: savedHunk.hunkId,
        hunkFingerprint: savedHunk.fingerprint,
        hunkHeader: dupHeader,
        hunkPatch: savedHunk.patch,
        lineRange: { side: "new", startLine: 2, endLine: 2 },
      }));
      const saved = (await store.load())["tfp-context-3"][0];
      const first = currentHunkFor("tfp-context-4", APP_PATH, "@@ -10,3 +10,3 @@", [" dup", "-eee", "+bbb", " dup"], 0);
      const second = currentHunkFor("tfp-context-4", APP_PATH, "@@ -20,3 +20,3 @@", [" dup", "-fff", "+bbb", " dup"], 1);
      const state = await service.reviewState(stateRequest(
        "tfp-context-4",
        [first.currentHunk, second.currentHunk],
        [
          fullFileView(APP_PATH, [
            ...contextRows(first.hunkId, 10, "eee", "bbb"),
            ...contextRows(second.hunkId, 20, "fff", "bbb"),
          ]),
        ],
      ));
      assertResultContract(state);
      assert.deepEqual(state.decisions, [], "an ambiguous anchor is never auto-selected");
      assert.equal(state.anchorIssues.length, 1);
      const issue = state.anchorIssues[0];
      assert.equal(issue.anchorState, "ambiguous");
      assert.equal(issue.id, saved.id);
      assert.equal(issue.sourceTargetFingerprint, "tfp-context-3");
      assert.equal(issue.sourceHunkId, savedHunk.hunkId);
      assert.equal(issue.filePath, APP_PATH);
      assert.equal(issue.comment, "please tighten this");
      assert.equal(issue.candidates.length, 2, "both candidate positions are reported");
      assert.equal(issue.matchCount, 2, "all matching file positions contribute to ambiguity");
      assert.deepEqual(
        issue.candidates.map((candidate) => (candidate.kind === "range" ? candidate.startLine : null)).sort(),
        [11, 21],
      );
      assert.deepEqual(
        issue.candidates.map((candidate) => candidate.kind),
        ["range", "range"],
        "each candidate is the anchor a re-anchor would store",
      );
      const preserved = (await store.load())["tfp-context-3"]?.[0];
      assert.equal(preserved?.anchorState, "ambiguous", "the ambiguous source entry is preserved, marked, and not migrated");
      assert.deepEqual(preserved?.anchor, saved.anchor, "the original anchor is not rewritten");
    }

    // -----------------------------------------------------------------------
    // 6c. Identical text outside the reviewable diff still makes a context
    //     match ambiguous; only rows owned by a current hunk are candidates.
    // -----------------------------------------------------------------------
    {
      const { service } = await harness();
      const savedHunk = currentHunkFor("tfp-outside-context-1", APP_PATH, dupHeader, dupBody);
      await service.recordDecision(decision({
        targetFingerprint: "tfp-outside-context-1",
        hunkId: savedHunk.hunkId,
        hunkFingerprint: savedHunk.fingerprint,
        hunkHeader: dupHeader,
        hunkPatch: savedHunk.patch,
        lineRange: { side: "new", startLine: 2, endLine: 2 },
      }));
      const current = currentHunkFor(
        "tfp-outside-context-2",
        APP_PATH,
        "@@ -10,3 +10,3 @@",
        [" dup", "-eee", "+bbb", " dup"],
      );
      const outsideRows = [
        ...contextRows(current.hunkId, 10, "eee", "bbb"),
        { kind: "context" as const, text: "dup", hunkId: null, oldLine: 20, newLine: 20 },
        { kind: "context" as const, text: "bbb", hunkId: null, oldLine: 21, newLine: 21 },
        { kind: "context" as const, text: "dup", hunkId: null, oldLine: 22, newLine: 22 },
      ];
      const state = await service.reviewState(stateRequest(
        "tfp-outside-context-2",
        [current.currentHunk],
        [fullFileView(APP_PATH, outsideRows)],
      ));
      assertResultContract(state);
      assert.deepEqual(state.decisions, [], "a match duplicated in unchanged file content is not auto-selected");
      assert.equal(state.anchorIssues[0]?.anchorState, "ambiguous");
      assert.equal(state.anchorIssues[0]?.candidates.length, 1, "only the changed hunk can be manually selected");
      assert.equal(state.anchorIssues[0]?.matchCount, 2, "off-hunk matches still count toward ambiguity");
    }
    // -----------------------------------------------------------------------
    // 7. Repeated hunk content: ambiguous, with the two hunk candidates.
    // -----------------------------------------------------------------------
    {
      const { service, store } = await harness();
      const hunkA = currentHunkFor("tfp-ambig-1", APP_PATH, APP_HEADER, APP_BODY);
      await service.recordDecision(decision({
        targetFingerprint: "tfp-ambig-1",
        hunkId: hunkA.hunkId,
        hunkFingerprint: hunkA.fingerprint,
        hunkPatch: hunkA.patch,
      }));
      const saved = (await store.load())["tfp-ambig-1"][0];
      const first = currentHunkFor("tfp-ambig-2", APP_PATH, APP_HEADER, APP_BODY, 0);
      const second = currentHunkFor("tfp-ambig-2", APP_PATH, "@@ -9,3 +9,3 @@", APP_BODY, 1);
      assert.equal(hunkContentId(APP_PATH, first.patch), hunkContentId(APP_PATH, second.patch), "premise: both hunks have identical content");
      const state = await service.reviewState(stateRequest("tfp-ambig-2", [first.currentHunk, second.currentHunk]));
      assertResultContract(state);
      assert.deepEqual(state.decisions, [], "an ambiguous anchor is never auto-selected");
      assert.equal(state.anchorIssues.length, 1);
      const issue = state.anchorIssues[0];
      assert.equal(issue.anchorState, "ambiguous");
      assert.deepEqual(
        issue.candidates.map((candidate) => (candidate.kind === "hunk" ? candidate.hunkId : null)).sort(),
        [first.hunkId, second.hunkId].sort(),
      );
      assert.equal(issue.candidates.length, 2);
      const after = await store.load();
      assert.deepEqual(after["tfp-ambig-1"].map((candidate) => candidate.id), [saved.id], "the source entry is preserved in place");
      assert.equal(after["tfp-ambig-1"][0].anchorState, "ambiguous");
      assert.deepEqual(after["tfp-ambig-1"][0].anchor, saved.anchor, "the original anchor is not rewritten");
    }

    // -----------------------------------------------------------------------
    // 8. A rename is recognized only through the current file's oldPath alias.
    // -----------------------------------------------------------------------
    {
      const { service, store } = await harness();
      const oldPath = "src/old.txt";
      const newPath = "src/new.txt";
      const oldHunk = currentHunkFor("tfp-rename-1", oldPath, APP_HEADER, APP_BODY);
      await service.recordDecision(decision({
        targetFingerprint: "tfp-rename-1",
        hunkId: oldHunk.hunkId,
        hunkFingerprint: oldHunk.fingerprint,
        filePath: oldPath,
        hunkPatch: oldHunk.patch,
        lineRange: { side: "new", startLine: 2, endLine: 2 },
      }));
      const saved = (await store.load())["tfp-rename-1"][0];
      const renamed = currentHunkFor("tfp-rename-2", newPath, APP_HEADER, APP_BODY, 0, oldPath);
      assert.equal(hunkContentId(newPath, renamed.patch), hunkContentId(newPath, oldHunk.patch), "premise: identical body under the new path");
      const state = await service.reviewState(stateRequest("tfp-rename-2", [renamed.currentHunk]));
      assertResultContract(state);
      assert.equal(state.decisions[0]?.anchorState, "relocated");
      assert.deepEqual(state.anchorIssues, []);
      const file = await store.load();
      assert.equal(file["tfp-rename-1"], undefined, "the old-path bucket is emptied by the move");
      const moved = file["tfp-rename-2"][0];
      assert.equal(moved.filePath, newPath, "the entry follows the rename");
      assert.equal(moved.id, saved.id);
      const movedAnchor = requireRangeAnchor(moved.anchor);
      assert.equal(movedAnchor.filePath, newPath);
      assert.equal(movedAnchor.selectedTextHash, requireRangeAnchor(saved.anchor).selectedTextHash, "the captured hashes are never rewritten");
      // Without the alias the same target must NOT be matched by a path guess.
      const { service: unaliasedService, store: unaliasedStore } = await harness();
      const unaliasedOld = currentHunkFor("tfp-rename-3", oldPath, APP_HEADER, APP_BODY);
      await unaliasedService.recordDecision(decision({
        targetFingerprint: "tfp-rename-3",
        hunkId: unaliasedOld.hunkId,
        hunkFingerprint: unaliasedOld.fingerprint,
        filePath: oldPath,
        hunkPatch: unaliasedOld.patch,
        lineRange: { side: "new", startLine: 2, endLine: 2 },
      }));
      const movedFile = currentHunkFor("tfp-rename-4", newPath, APP_HEADER, APP_BODY);
      const unaliased = await unaliasedService.reviewState(stateRequest("tfp-rename-4", [movedFile.currentHunk]));
      assertResultContract(unaliased);
      assert.deepEqual(unaliased.decisions, []);
      assert.equal(unaliased.anchorIssues.length, 1);
      assert.equal(unaliased.anchorIssues[0].anchorState, "stale");
      assert.deepEqual(unaliased.anchorIssues[0].candidates, [], "a file that moved without an alias yields no candidate");
      assert.equal((await unaliasedStore.load())["tfp-rename-3"].length, 1, "the stale entry stays in its source bucket");
    }

    // -----------------------------------------------------------------------
    // 9. A deleted hunk is stale, never relocated somewhere else.
    // -----------------------------------------------------------------------
    {
      const { service, store } = await harness();
      const hunk = currentHunkFor("tfp-gone-1", APP_PATH, APP_HEADER, APP_BODY);
      await service.recordDecision(decision({
        targetFingerprint: "tfp-gone-1",
        hunkId: hunk.hunkId,
        hunkFingerprint: hunk.fingerprint,
        hunkPatch: hunk.patch,
        lineRange: { side: "new", startLine: 2, endLine: 2 },
      }));
      const saved = (await store.load())["tfp-gone-1"][0];
      const state = await service.reviewState(stateRequest("tfp-gone-2", []));
      assertResultContract(state);
      assert.deepEqual(state.decisions, []);
      assert.equal(state.anchorIssues.length, 1);
      assert.equal(state.anchorIssues[0].id, saved.id);
      assert.equal(state.anchorIssues[0].anchorState, "stale");
      assert.deepEqual(state.anchorIssues[0].candidates, []);
      assert.equal((await store.load())["tfp-gone-1"][0].anchorState, "stale");
    }

    // -----------------------------------------------------------------------
    // 10. Cross-snapshot restoration: an anchor that went stale (or migrated)
    //     resolves again when its target returns.
    // -----------------------------------------------------------------------
    {
      const { service, store } = await harness();
      const hunkA = currentHunkFor("tfp-restore-1", APP_PATH, APP_HEADER, APP_BODY);
      await service.recordDecision(decision({
        targetFingerprint: "tfp-restore-1",
        hunkId: hunkA.hunkId,
        hunkFingerprint: hunkA.fingerprint,
        hunkPatch: hunkA.patch,
        lineRange: { side: "new", startLine: 2, endLine: 2 },
      }));
      const saved = (await store.load())["tfp-restore-1"][0];
      const stale = await service.reviewState(stateRequest("tfp-restore-away", []));
      assert.equal(stale.anchorIssues[0]?.anchorState, "stale");
      assert.equal((await store.load())["tfp-restore-1"][0].anchorState, "stale");
      const restored = await service.reviewState(stateRequest("tfp-restore-1", [hunkA.currentHunk]));
      assertResultContract(restored);
      assert.equal(restored.decisions[0]?.anchorState, "exact", "the original snapshot restores the exact anchor");
      assert.equal(restored.decisions[0]?.id, saved.id);
      assert.deepEqual(restored.anchorIssues, []);
      assert.equal((await store.load())["tfp-restore-1"][0].anchorState, "exact");
      // A migrated anchor comes back too: T2 moved it, T1 moves it back.
      const hunkB = currentHunkFor("tfp-restore-2", APP_PATH, "@@ -6,3 +6,3 @@", APP_BODY);
      const migrated = await service.reviewState(stateRequest("tfp-restore-2", [hunkB.currentHunk]));
      assert.equal(migrated.decisions[0]?.anchorState, "relocated");
      assert.equal((await store.load())["tfp-restore-1"], undefined);
      const returned = await service.reviewState(stateRequest("tfp-restore-1", [hunkA.currentHunk]));
      assertResultContract(returned);
      assert.equal(returned.decisions[0]?.anchorState, "relocated", "the returned snapshot is reached by content identity");
      const back = await store.load();
      assert.equal(back["tfp-restore-2"], undefined, "the entry lives in the target it was last resolved against");
      assert.equal(back["tfp-restore-1"][0].hunkId, hunkA.hunkId);
      assert.equal(back["tfp-restore-1"][0].hunkPatch, hunkA.patch);
      assert.deepEqual(back["tfp-restore-1"][0].anchor, saved.anchor);
    }

    // -----------------------------------------------------------------------
    // 11. Migration is restricted to matching cwd/scope and compatible
    //     project/workspace; an unknown field never blocks.
    // -----------------------------------------------------------------------
    {
      const { service, store } = await harness();
      const hunk = currentHunkFor("tfp-owner-2", APP_PATH, APP_HEADER, APP_BODY);
      const foreign = (id: string, overrides: Partial<StateEntry>): StateEntry => entry({
        id,
        hunkPatch: hunk.patch,
        contentId: hunkContentId(APP_PATH, hunk.patch),
        ...overrides,
      });
      await store.save({
        "tfp-owner-1": [
          foreign("other-cwd", { cwd: "/worktrees/project-1/worktree-b" }),
          foreign("other-project", { projectId: "project-2" }),
          foreign("other-workspace", { workspaceId: "workspace-2" }),
          foreign("other-scope", { scope: "staged" }),
          foreign("legacy-unknown", { projectId: undefined, workspaceId: undefined, cwd: undefined, scope: undefined }),
        ],
      });
      const state = await service.reviewState(stateRequest("tfp-owner-2", [hunk.currentHunk]));
      assertResultContract(state);
      assert.deepEqual(state.decisions.map((row) => row.id), ["legacy-unknown"], "only the compatible entry migrates");
      assert.deepEqual(state.anchorIssues, []);
      const file = await store.load();
      assert.equal(file["tfp-owner-2"].length, 1);
      assert.deepEqual(
        file["tfp-owner-1"].map((candidate) => candidate.id),
        ["other-cwd", "other-project", "other-workspace", "other-scope"],
        "a foreign worktree's, project's, workspace's, or scope's comment is never migrated",
      );
    }
    // -----------------------------------------------------------------------
    // 11b. A file-scoped snapshot never marks comments on other files stale
    //      just because the current hunk list is filtered.
    // -----------------------------------------------------------------------
    {
      const { service, store } = await harness();
      const sourceApp = currentHunkFor("tfp-filter-source", APP_PATH, APP_HEADER, APP_BODY);
      const otherPath = "src/other.txt";
      const sourceOther = currentHunkFor("tfp-filter-source", otherPath, APP_HEADER, APP_BODY);
      const storedEntry = (
        id: string,
        hunk: ReturnType<typeof currentHunkFor>,
        filePath: string,
      ): StateEntry => {
        const contentId = hunkContentId(filePath, hunk.patch);
        return entry({
          id,
          targetFingerprint: "tfp-filter-source",
          hunkId: hunk.hunkId,
          hunkFingerprint: hunk.fingerprint,
          filePath,
          hunkHeader: APP_HEADER,
          hunkPatch: hunk.patch,
          contentId,
          anchor: {
            kind: "hunk",
            filePath,
            hunkId: hunk.hunkId,
            hunkFingerprint: hunk.fingerprint,
            contentId,
          },
        });
      };
      await store.save({
        "tfp-filter-source": [
          storedEntry("app-comment", sourceApp, APP_PATH),
          storedEntry("other-comment", sourceOther, otherPath),
        ],
      });
      const currentApp = currentHunkFor("tfp-filter-current", APP_PATH, APP_HEADER, APP_BODY);
      const baseRequest = stateRequest("tfp-filter-current", [currentApp.currentHunk]);
      const state = await service.reviewState({
        ...baseRequest,
        request: { cwd: WORKTREE, scope: "working", filePath: APP_PATH },
      });
      assertResultContract(state);
      assert.deepEqual(state.decisions.map((row) => row.id), ["app-comment"]);
      assert.deepEqual(state.anchorIssues, []);
      const file = await store.load();
      assert.deepEqual(file["tfp-filter-source"].map((candidate) => candidate.id), ["other-comment"]);
      assert.equal(file["tfp-filter-source"][0].anchorState, undefined, "an unrelated file is not marked stale");
    }

    // -----------------------------------------------------------------------
    // 11c. The path filter is a Git pathspec: a directory filter still
    //      surfaces the review's own entries instead of hiding the whole state.
    // -----------------------------------------------------------------------
    {
      const { service, store } = await harness();
      const otherPath = "src/other.txt";
      const sourceApp = currentHunkFor("tfp-pathspec-source", APP_PATH, APP_HEADER, APP_BODY);
      const sourceOther = currentHunkFor("tfp-pathspec-source", otherPath, APP_HEADER, APP_BODY);
      const storedEntry = (id: string, hunk: ReturnType<typeof currentHunkFor>, filePath: string): StateEntry => {
        const contentId = hunkContentId(filePath, hunk.patch);
        return entry({
          id,
          targetFingerprint: "tfp-pathspec-source",
          hunkId: hunk.hunkId,
          hunkFingerprint: hunk.fingerprint,
          filePath,
          hunkPatch: hunk.patch,
          contentId,
          anchor: { kind: "hunk", filePath, hunkId: hunk.hunkId, hunkFingerprint: hunk.fingerprint, contentId },
        });
      };
      await store.save({
        "tfp-pathspec-source": [
          storedEntry("app-comment", sourceApp, APP_PATH),
          storedEntry("other-comment", sourceOther, otherPath),
        ],
      });
      const currentApp = currentHunkFor("tfp-pathspec-current", APP_PATH, APP_HEADER, APP_BODY);
      const currentOther = currentHunkFor("tfp-pathspec-current", otherPath, APP_HEADER, APP_BODY);
      const state = await service.reviewState({
        ...stateRequest("tfp-pathspec-current", [currentApp.currentHunk, currentOther.currentHunk]),
        request: { cwd: WORKTREE, scope: "working", filePath: "src" },
      });
      assertResultContract(state);
      assert.deepEqual(
        state.decisions.map((row) => row.id).sort(),
        ["app-comment", "other-comment"],
        "a directory pathspec selects the whole subtree, not one literal path",
      );
      assert.deepEqual(state.anchorIssues, []);
      assert.equal((await store.load())["tfp-pathspec-source"], undefined, "both comments followed their hunks into the current target");
    }

    // -----------------------------------------------------------------------
    // 11d. A wildcard filter keeps its own match and never touches another
    //      file's entry.
    // -----------------------------------------------------------------------
    {
      const { service, store } = await harness();
      const otherPath = "src/other.txt";
      const sourceApp = currentHunkFor("tfp-wildcard-source", APP_PATH, APP_HEADER, APP_BODY);
      const sourceOther = currentHunkFor("tfp-wildcard-source", otherPath, APP_HEADER, APP_BODY);
      const storedEntry = (id: string, hunk: ReturnType<typeof currentHunkFor>, filePath: string): StateEntry => {
        const contentId = hunkContentId(filePath, hunk.patch);
        return entry({
          id,
          targetFingerprint: "tfp-wildcard-source",
          hunkId: hunk.hunkId,
          hunkFingerprint: hunk.fingerprint,
          filePath,
          hunkPatch: hunk.patch,
          contentId,
          anchor: { kind: "hunk", filePath, hunkId: hunk.hunkId, hunkFingerprint: hunk.fingerprint, contentId },
        });
      };
      await store.save({
        "tfp-wildcard-source": [
          storedEntry("app-comment", sourceApp, APP_PATH),
          storedEntry("other-comment", sourceOther, otherPath),
        ],
      });
      const currentApp = currentHunkFor("tfp-wildcard-current", APP_PATH, APP_HEADER, APP_BODY);
      const state = await service.reviewState({
        ...stateRequest("tfp-wildcard-current", [currentApp.currentHunk]),
        request: { cwd: WORKTREE, scope: "working", filePath: "src/app*" },
      });
      assertResultContract(state);
      assert.deepEqual(state.decisions.map((row) => row.id), ["app-comment"]);
      assert.deepEqual(state.anchorIssues, []);
      const file = await store.load();
      assert.deepEqual(file["tfp-wildcard-source"].map((candidate) => candidate.id), ["other-comment"]);
      assert.equal(file["tfp-wildcard-source"][0].anchorState, undefined, "the wildcard's non-match is untouched");
    }

    // -----------------------------------------------------------------------
    // 11e. A foreign entry that shares the requested bucket still surfaces as a
    //      decision, but this review never marks it or turns it into an issue
    //      the supersede path would refuse to heal.
    // -----------------------------------------------------------------------
    {
      const { service, store } = await harness();
      const hunk = currentHunkFor("tfp-foreign-bucket", APP_PATH, APP_HEADER, APP_BODY);
      const driftedPatch = patchFor(APP_PATH, "@@ -80,3 +80,3 @@", [" ctx-a", "-gone", "+gone", " ctx-b"]);
      await store.save({
        "tfp-foreign-bucket": [
          entry({
            id: "foreign-present",
            projectId: "project-2",
            targetFingerprint: "tfp-foreign-bucket",
            hunkId: hunk.hunkId,
            hunkFingerprint: hunk.fingerprint,
            hunkPatch: hunk.patch,
            contentId: hunkContentId(APP_PATH, hunk.patch),
            anchor: {
              kind: "hunk",
              filePath: APP_PATH,
              hunkId: hunk.hunkId,
              hunkFingerprint: hunk.fingerprint,
              contentId: hunkContentId(APP_PATH, hunk.patch),
            },
          }),
          entry({
            id: "foreign-drifted",
            projectId: "project-2",
            targetFingerprint: "tfp-foreign-bucket",
            hunkId: "H-foreign-gone",
            hunkFingerprint: "fingerprint-foreign-gone",
            hunkHeader: "@@ -80,3 +80,3 @@",
            hunkPatch: driftedPatch,
            contentId: hunkContentId(APP_PATH, driftedPatch),
            anchor: {
              kind: "hunk",
              filePath: APP_PATH,
              hunkId: "H-foreign-gone",
              hunkFingerprint: "fingerprint-foreign-gone",
              contentId: hunkContentId(APP_PATH, driftedPatch),
            },
          }),
        ],
      });
      const state = await service.reviewState(stateRequest("tfp-foreign-bucket", [hunk.currentHunk]));
      assertResultContract(state);
      assert.deepEqual(state.decisions.map((row) => row.id), ["foreign-present"], "a resolvable foreign entry keeps the v1.2 bucket surfacing");
      assert.deepEqual(state.anchorIssues, [], "a foreign comment never raises an issue this review cannot heal");
      const file = await store.load();
      assert.equal(file["tfp-foreign-bucket"].find((candidate) => candidate.id === "foreign-drifted")?.anchorState, undefined, "the drifting foreign entry is not marked");
      assert.equal(file["tfp-foreign-bucket"].find((candidate) => candidate.id === "foreign-present")?.anchorState, "exact");
    }

    // -----------------------------------------------------------------------
    // 12. Supersede safety: exactly the named comment is removed, atomically,
    //     and only after its ownership was validated.
    // -----------------------------------------------------------------------
    {
      const { service, store, statePath } = await harness();
      await store.save({
        "tfp-supersede-src": [
          entry({ id: "comment-1", anchorState: "ambiguous" }),
          entry({ id: "comment-2", hunkId: "H-keep" }),
          entry({ id: "review-1", hunkId: "H-reviewed", decision: "reviewed", comment: undefined }),
        ],
      });
      const newHunk = currentHunkFor("tfp-supersede-dst", APP_PATH, APP_HEADER, APP_BODY);
      const savedAt = await service.recordDecision(decision({
        targetFingerprint: "tfp-supersede-dst",
        hunkId: newHunk.hunkId,
        hunkFingerprint: newHunk.fingerprint,
        hunkPatch: newHunk.patch,
        comment: "moved here",
        lineRange: { side: "new", startLine: 2, endLine: 2 },
        supersedes: { targetFingerprint: "tfp-supersede-src", entryId: "comment-1" },
      }));
      const file = await store.load();
      assert.deepEqual(
        file["tfp-supersede-src"].map((candidate) => candidate.id),
        ["comment-2", "review-1"],
        "exactly the superseded comment leaves, nothing else",
      );
      assert.equal(file["tfp-supersede-dst"].length, 1);
      assert.equal(file["tfp-supersede-dst"][0].comment, "moved here");
      assert.equal(file["tfp-supersede-dst"][0].savedAt, savedAt);
      assert.equal(file["tfp-supersede-dst"][0].anchor?.kind, "range");
      // The client may name a source bucket the entry already migrated out of:
      // exactly one holder is accepted.
      await store.save({ ...file, "tfp-far": [entry({ id: "comment-far" })] });
      await service.recordDecision(decision({
        targetFingerprint: "tfp-supersede-dst",
        hunkId: "H-far",
        supersedes: { targetFingerprint: "tfp-supersede-gone", entryId: "comment-far" },
      }));
      assert.equal((await store.load())["tfp-far"], undefined, "the single holder of a migrated id is found and removed");
      const refusals: Array<{ name: string; input: Partial<DecisionInput>; expected: RegExp }> = [
        { name: "an unknown id", input: { supersedes: { targetFingerprint: "tfp-supersede-src", entryId: "missing" } }, expected: /no longer exists/ },
        { name: "another project", input: { projectId: "project-2", supersedes: { targetFingerprint: "tfp-supersede-src", entryId: "comment-2" } }, expected: /different project/ },
        { name: "another cwd", input: { cwd: "/elsewhere", supersedes: { targetFingerprint: "tfp-supersede-src", entryId: "comment-2" } }, expected: /different cwd/ },
        { name: "another scope", input: { scope: "staged", supersedes: { targetFingerprint: "tfp-supersede-src", entryId: "comment-2" } }, expected: /different scope/ },
        { name: "another workspace", input: { workspaceId: "workspace-2", supersedes: { targetFingerprint: "tfp-supersede-src", entryId: "comment-2" } }, expected: /different workspace/ },
        { name: "a reviewed record", input: { supersedes: { targetFingerprint: "tfp-supersede-src", entryId: "review-1" } }, expected: /not a saved comment/ },
      ];
      for (const refusal of refusals) {
        const before = await readFile(statePath, "utf8");
        await assert.rejects(
          service.recordDecision(decision({
            targetFingerprint: "tfp-supersede-dst",
            hunkId: "H-refused",
            ...refusal.input,
          })),
          refusal.expected,
          `superseding ${refusal.name} must be refused`,
        );
        assert.equal(await readFile(statePath, "utf8"), before, `a refused supersede (${refusal.name}) leaves the store byte-identical`);
      }
      // Two buckets holding the same id is ambiguous: refused unless the client
      // names the bucket it actually saw.
      await store.save({
        ...(await store.load()),
        "tfp-dup-a": [entry({ id: "comment-dup" })],
        "tfp-dup-b": [entry({ id: "comment-dup" })],
      });
      const beforeDuplicate = await readFile(statePath, "utf8");
      await assert.rejects(
        service.recordDecision(decision({
          targetFingerprint: "tfp-supersede-dst",
          hunkId: "H-dup",
          supersedes: { targetFingerprint: "tfp-dup-nowhere", entryId: "comment-dup" },
        })),
        /exists in 2 review targets/,
      );
      assert.equal(await readFile(statePath, "utf8"), beforeDuplicate, "an ambiguous supersede removes nothing");
      // An invalid new range is refused before the source comment is touched.
      await assert.rejects(
        service.recordDecision(decision({
          targetFingerprint: "tfp-supersede-dst",
          hunkId: "H-bad",
          hunkHeader: "@@ -0,0 +1,2 @@",
          hunkPatch: addedPatch,
          lineRange: { side: "old", startLine: 1, endLine: 1 },
          supersedes: { targetFingerprint: "tfp-supersede-src", entryId: "comment-2" },
        })),
        /has no old-side lines/,
      );
      assert.equal(await readFile(statePath, "utf8"), beforeDuplicate, "the source comment survives a rejected replacement");
    }
    // -----------------------------------------------------------------------
    // 12b. A current comment collision is surfaced and cannot be overwritten
    //      by superseding an older comment onto the same hunk.
    // -----------------------------------------------------------------------
    {
      const { service, store, statePath } = await harness();
      const oldHunk = currentHunkFor("tfp-comment-collision-old", APP_PATH, APP_HEADER, APP_BODY);
      await service.recordDecision(decision({
        targetFingerprint: "tfp-comment-collision-old",
        hunkId: oldHunk.hunkId,
        hunkFingerprint: oldHunk.fingerprint,
        hunkPatch: oldHunk.patch,
        comment: "older comment",
        lineRange: { side: "new", startLine: 2, endLine: 2 },
      }));
      const oldEntry = (await store.load())["tfp-comment-collision-old"][0];
      const oldEntryId = oldEntry.id;
      assert.ok(oldEntryId, "persisted comments have entry IDs");
      const currentHunk = currentHunkFor("tfp-comment-collision-current", APP_PATH, APP_HEADER, APP_BODY);
      await service.recordDecision(decision({
        targetFingerprint: "tfp-comment-collision-current",
        hunkId: currentHunk.hunkId,
        hunkFingerprint: currentHunk.fingerprint,
        hunkPatch: currentHunk.patch,
        comment: "current comment",
        lineRange: { side: "new", startLine: 2, endLine: 2 },
      }));
      const state = await service.reviewState(
        stateRequest("tfp-comment-collision-current", [currentHunk.currentHunk]),
      );
      assertResultContract(state);
      assert.equal(state.decisions[0]?.comment, "current comment");
      assert.equal(state.anchorIssues.length, 1, "the older comment remains visible as an issue");
      assert.equal(state.anchorIssues[0]?.id, oldEntryId);
      assert.equal(state.anchorIssues[0]?.anchorState, "ambiguous");
      assert.equal(state.anchorIssues[0]?.candidates.length, 1);
      const beforeRefusal = await readFile(statePath, "utf8");
      await assert.rejects(
        service.recordDecision(decision({
          targetFingerprint: "tfp-comment-collision-current",
          hunkId: currentHunk.hunkId,
          hunkFingerprint: currentHunk.fingerprint,
          hunkPatch: currentHunk.patch,
          comment: "older comment moved",
          lineRange: { side: "new", startLine: 2, endLine: 2 },
          supersedes: {
            targetFingerprint: "tfp-comment-collision-old",
            entryId: oldEntryId,
          },
        })),
        /Another saved comment already owns this change block/,
      );
      assert.equal(
        await readFile(statePath, "utf8"),
        beforeRefusal,
        "a refused collision keeps both comments byte-identical",
      );
    }

    // -----------------------------------------------------------------------
    // 13. Project comments carry the anchor and its state; the count path
    //     still ships no body.
    // -----------------------------------------------------------------------
    {
      const { service, store } = await harness();
      const rangeAnchor = buildLineRangeAnchor({
        filePath: APP_PATH,
        hunkId: "H-project",
        hunkFingerprint: "fingerprint-project",
        contentId: hunkContentId(APP_PATH, APP_PATCH),
        hunkHeader: APP_HEADER,
        hunkPatch: APP_PATCH,
        selection: { side: "new", startLine: 2, endLine: 2 },
      });
      await store.save({
        "tfp-project-1": [entry({ id: "project-comment", anchor: rangeAnchor, anchorState: "relocated" })],
      });
      const project = await service.listProjectReviewComments(PROJECT);
      assert.equal(project?.comments.length, 1);
      assert.deepEqual(project?.comments[0].anchor, rangeAnchor);
      assert.equal(project?.comments[0].anchorState, "relocated");
      assert.deepEqual(await service.getProjectReviewCommentCount(PROJECT), { commentCount: 1 });
    }

    // -----------------------------------------------------------------------
    // 14. Re-anchoring never weakens the fail-closed reject/revert checks:
    //     after a comment relocated, the old target/hunk fingerprints still
    //     refuse, and only the current ones are accepted.
    // -----------------------------------------------------------------------
    {
      const { service, store } = await harness();
      const repo = join(root, "reject-repo");
      await mkdir(repo, { recursive: true });
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "review-deck@example.com");
      git(repo, "config", "user.name", "Review Deck Tests");
      git(repo, "config", "commit.gpgsign", "false");
      const original = Array.from({ length: 30 }, (_, index) => `line-${String(index + 1)}`).join("\n") + "\n";
      await writeFile(join(repo, "app.txt"), original, "utf8");
      git(repo, "add", "app.txt");
      git(repo, "commit", "-q", "-m", "initial");
      const firstEdit = original.replace("line-20\n", "LINE-TWENTY\n");
      await writeFile(join(repo, "app.txt"), firstEdit, "utf8");
      const snapshotA = await service.createSnapshot({ cwd: repo, scope: "working" });
      assert.equal(snapshotA.files[0].hunks.length, 1, "premise: the working tree holds one hunk");
      const hunkA = snapshotA.files[0].hunks[0];
      await service.recordDecision({
        projectId: PROJECT,
        cwd: repo,
        workspaceId: WORKSPACE,
        targetFingerprint: snapshotA.targetFingerprint,
        hunkId: hunkA.id,
        hunkFingerprint: hunkA.fingerprint,
        filePath: hunkA.filePath,
        hunkHeader: hunkA.header,
        hunkPatch: hunkA.patch,
        decision: "commented",
        scope: "working",
        comment: "why is this line different?",
        lineRange: { side: "new", startLine: hunkA.newStart + 3, endLine: hunkA.newStart + 3 },
      });
      // An insertion far above the change leaves the hunk body intact.
      await writeFile(join(repo, "app.txt"), `inserted-at-the-top\n${firstEdit}`, "utf8");
      const snapshotB = await service.createSnapshot({ cwd: repo, scope: "working" });
      assert.equal(snapshotB.files[0].hunks.length, 2, "premise: the insertion and the change stay separate hunks");
      const hunkB = snapshotB.files[0].hunks[1];
      assert.ok(hunkB.patch.includes("+LINE-TWENTY"), "premise: the second hunk is the reviewed change");
      assert.equal(hunkContentId(hunkB.filePath, hunkB.patch), hunkContentId(hunkA.filePath, hunkA.patch), "premise: only the position moved");
      const state = await service.reviewState({
        targetFingerprint: snapshotB.targetFingerprint,
        currentHunks: snapshotB.files[0].hunks.map((hunk) => ({
          hunkId: hunk.id,
          filePath: hunk.filePath,
          hunkHeader: hunk.header,
          hunkPatch: hunk.patch,
        })),
        request: { cwd: repo, scope: "working" },
        projectId: PROJECT,
        workspaceId: WORKSPACE,
      });
      assertResultContract(state);
      assert.equal(state.decisions[0]?.anchorState, "relocated", "the comment followed its hunk");
      assert.equal((await store.load())[snapshotA.targetFingerprint], undefined);
      // The re-anchor granted no write capability: both old identities refuse.
      await assert.rejects(
        service.reverseHunk({ cwd: repo, scope: "working" }, snapshotA.targetFingerprint, hunkA.id, hunkA.fingerprint),
        /Review snapshot is stale/,
      );
      await assert.rejects(
        service.reverseHunk({ cwd: repo, scope: "working" }, snapshotB.targetFingerprint, hunkB.id, hunkA.fingerprint),
        /Hunk is stale/,
        "the current hunk is refused under the old hunk fingerprint",
      );
      await assert.rejects(
        service.revertFile({
          cwd: repo,
          scope: "working",
          filePath: hunkA.filePath,
          expectedTargetFingerprint: snapshotA.targetFingerprint,
          skipPatches: [],
        }),
        /Review snapshot is stale/,
      );
      // Only the current target and hunk fingerprint are accepted.
      const reverted = await service.reverseHunk(
        { cwd: repo, scope: "working" },
        snapshotB.targetFingerprint,
        hunkB.id,
        hunkB.fingerprint,
      );
      assert.equal(reverted.removedHunkId, hunkB.id);
      assert.equal(
        await readFile(join(repo, "app.txt"), "utf8"),
        `inserted-at-the-top\n${original}`,
        "the accepted reject reverted exactly the reviewed hunk",
      );
    }

    // -----------------------------------------------------------------------
    // 15. The server loads the complete current file before a Level 3 match.
    //     This exercises the real working-tree reader, not injected rows.
    // -----------------------------------------------------------------------
    {
      const { service } = await harness();
      const repo = join(root, "context-repo");
      await mkdir(repo, { recursive: true });
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "review-deck@example.com");
      git(repo, "config", "user.name", "Review Deck Tests");
      git(repo, "config", "commit.gpgsign", "false");
      const original = Array.from({ length: 30 }, (_, index) => `line-${String(index + 1)}`).join("\n") + "\n";
      await writeFile(join(repo, "app.txt"), original, "utf8");
      git(repo, "add", "app.txt");
      git(repo, "commit", "-q", "-m", "initial");
      const firstEdit = original.replace("line-20\n", "LINE-TWENTY\n");
      await writeFile(join(repo, "app.txt"), firstEdit, "utf8");
      const snapshotA = await service.createSnapshot({ cwd: repo, scope: "working" });
      const hunkA = snapshotA.files[0].hunks[0];
      await service.recordDecision({
        projectId: PROJECT,
        cwd: repo,
        workspaceId: WORKSPACE,
        targetFingerprint: snapshotA.targetFingerprint,
        hunkId: hunkA.id,
        hunkFingerprint: hunkA.fingerprint,
        filePath: hunkA.filePath,
        hunkHeader: hunkA.header,
        hunkPatch: hunkA.patch,
        decision: "commented",
        scope: "working",
        comment: "keep this line attached",
        lineRange: { side: "new", startLine: hunkA.newStart + 3, endLine: hunkA.newStart + 3 },
      });
      const secondEdit = firstEdit.replace("line-25\n", "LINE-TWENTY-FIVE\n");
      await writeFile(join(repo, "app.txt"), secondEdit, "utf8");
      const snapshotB = await service.createSnapshot({ cwd: repo, scope: "working" });
      assert.equal(snapshotB.files[0].hunks.length, 1, "premise: both nearby changes remain in one hunk");
      const hunkB = snapshotB.files[0].hunks[0];
      assert.notEqual(hunkContentId(hunkA.filePath, hunkA.patch), hunkContentId(hunkB.filePath, hunkB.patch));
      assert.notEqual(hunkChangeId(hunkA.filePath, hunkA.patch), hunkChangeId(hunkB.filePath, hunkB.patch));
      const state = await service.reviewState({
        targetFingerprint: snapshotB.targetFingerprint,
        request: { cwd: repo, scope: "working" },
        projectId: PROJECT,
        workspaceId: WORKSPACE,
        currentHunks: snapshotB.files.flatMap((file) => file.hunks.map((hunk) => ({
          hunkId: hunk.id,
          filePath: hunk.filePath,
          oldPath: file.oldPath,
          hunkHeader: hunk.header,
          hunkPatch: hunk.patch,
        }))),
      });
      assertResultContract(state);
      assert.equal(state.anchorIssues.length, 0);
      assert.equal(state.decisions[0]?.anchorState, "relocated");
      const anchor = requireRangeAnchor(state.decisions[0]?.anchor);
      assert.equal(anchor.startLine, hunkB.newStart + 3);
      assert.equal(anchor.selectedTextPreview, "LINE-TWENTY");
    }

    console.log("  full-file Level 3 matching reads real Git workspace content.");
    // -----------------------------------------------------------------------
    // 16a. A selection longer than the preview limit still relocates through
    //      the full-file scan: the preview prefilter must never drop a match.
    // -----------------------------------------------------------------------
    {
      const { service, store } = await harness();
      const block = Array.from({ length: 12 }, (_, index) => `long-block-${String(index)}-${"x".repeat(30)}`);
      const savedHunk = currentHunkFor("tfp-long-1", APP_PATH, "@@ -1,13 +1,13 @@", ["-old-line", ...block.map((line) => `+${line}`)]);
      await service.recordDecision(decision({
        targetFingerprint: "tfp-long-1",
        hunkId: savedHunk.hunkId,
        hunkFingerprint: savedHunk.fingerprint,
        hunkHeader: "@@ -1,13 +1,13 @@",
        hunkPatch: savedHunk.patch,
        lineRange: { side: "new", startLine: 1, endLine: 12 },
      }));
      const stored = (await store.load())["tfp-long-1"][0];
      const storedPreview = requireRangeAnchor(stored.anchor).selectedTextPreview;
      assert.equal(storedPreview?.length, 301, "premise: the captured preview is truncated at the 300-character limit");
      assert.ok(storedPreview.endsWith("…"), "premise: the truncation is marked");
      const currentHunk = currentHunkFor("tfp-long-2", APP_PATH, "@@ -10,13 +10,13 @@", ["-other-line", ...block.map((line) => `+${line}`)]);
      assert.notEqual(hunkContentId(APP_PATH, savedHunk.patch), hunkContentId(APP_PATH, currentHunk.patch), "premise: content identity misses");
      assert.notEqual(hunkChangeId(APP_PATH, savedHunk.patch), hunkChangeId(APP_PATH, currentHunk.patch), "premise: change identity misses");
      const rows: AnchorFileView["rows"] = [
        { kind: "context", text: "ctx-7", hunkId: null, oldLine: 7, newLine: 7 },
        { kind: "context", text: "ctx-8", hunkId: null, oldLine: 8, newLine: 8 },
        { kind: "context", text: "ctx-9", hunkId: null, oldLine: 9, newLine: 9 },
        ...block.map((text, index) => ({ kind: "add" as const, text, hunkId: currentHunk.hunkId, oldLine: null, newLine: 10 + index })),
      ];
      const state = await service.reviewState(stateRequest("tfp-long-2", [currentHunk.currentHunk], [fullFileView(APP_PATH, rows)]));
      assertResultContract(state);
      assert.equal(state.decisions[0]?.anchorState, "relocated");
      const relocated = requireRangeAnchor(state.decisions[0]?.anchor);
      assert.equal(relocated.startLine, 10, "the long selection follows its text");
      assert.equal(relocated.endLine, 21);
      assert.equal(relocated.selectedTextPreview, storedPreview, "the captured hashes and preview are never rewritten");
      assert.deepEqual(state.anchorIssues, []);
    }

    // -----------------------------------------------------------------------
    // 16b. The same long selection repeated in the file stays ambiguous.
    // -----------------------------------------------------------------------
    {
      const { service } = await harness();
      const block = Array.from({ length: 12 }, (_, index) => `long-block-${String(index)}-${"x".repeat(30)}`);
      const savedHunk = currentHunkFor("tfp-long-3", APP_PATH, "@@ -1,13 +1,13 @@", ["-old-line", ...block.map((line) => `+${line}`)]);
      await service.recordDecision(decision({
        targetFingerprint: "tfp-long-3",
        hunkId: savedHunk.hunkId,
        hunkFingerprint: savedHunk.fingerprint,
        hunkHeader: "@@ -1,13 +1,13 @@",
        hunkPatch: savedHunk.patch,
        lineRange: { side: "new", startLine: 1, endLine: 12 },
      }));
      const first = currentHunkFor("tfp-long-4", APP_PATH, "@@ -10,13 +10,13 @@", ["-other-line", ...block.map((line) => `+${line}`)]);
      const second = currentHunkFor("tfp-long-4", APP_PATH, "@@ -40,13 +40,13 @@", ["-third-line", ...block.map((line) => `+${line}`)], 1);
      const rows: AnchorFileView["rows"] = [
        { kind: "context", text: "ctx-9", hunkId: null, oldLine: 9, newLine: 9 },
        ...block.map((text, index) => ({ kind: "add" as const, text, hunkId: first.hunkId, oldLine: null, newLine: 10 + index })),
        { kind: "context", text: "ctx-39", hunkId: null, oldLine: 39, newLine: 39 },
        ...block.map((text, index) => ({ kind: "add" as const, text, hunkId: second.hunkId, oldLine: null, newLine: 40 + index })),
      ];
      const state = await service.reviewState(stateRequest(
        "tfp-long-4",
        [first.currentHunk, second.currentHunk],
        [fullFileView(APP_PATH, rows)],
      ));
      assertResultContract(state);
      assert.deepEqual(state.decisions, [], "a repeated long block is never auto-selected");
      assert.equal(state.anchorIssues[0]?.anchorState, "ambiguous");
      assert.equal(state.anchorIssues[0]?.matchCount, 2);
      assert.deepEqual(state.anchorIssues[0]?.candidates.map((candidate) => candidate.kind), ["range", "range"]);
    }

    console.log("anchor-engine: every v1.3 re-anchor scenario passed");
    console.log("  unchanged hunk exact; insertion above; context drift/core stable; repeated context and repeated content");
    console.log("  ambiguity (never auto-selected); rename via oldPath only; deleted hunk stale; cross-snapshot restoration;");
    console.log("  migration ownership (cwd/scope/project/workspace); supersede atomicity and refusals; project comment anchors;");
    console.log("  fail-closed reject/revert fingerprints after a re-anchor.");
    console.log("  missing selected context never relocates by a line delta; conflicting saved comments remain recoverable.");
    console.log("  file-filtered state reads leave unrelated files untouched.");
    console.log("  directory/wildcard path filters keep the review's own entries; long selections keep relocating;");
    console.log("  a foreign entry in the requested bucket is neither marked nor turned into an unhealable issue.");
  } finally {
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

/**
 * Pure identity + prompt contract for Review Deck's AI review (v1.4).
 *
 * The helpers in `server/ai-review-prompt.ts` decide two things that must not
 * be conflated: WHICH input a reviewer result belongs to (cache identity) and
 * WHAT the reviewer is told (the prompt).
 *
 * - Identity is location independent: the same hunk body under a different
 *   `@@` header, a different file-blob `index` line, a line shift, or a
 *   completely different `snapshot.targetFingerprint` keeps the same stable
 *   hunk id and the same hunk/file input fingerprint, while a changed body,
 *   path, or enclosing section does not. A file fingerprint is order
 *   insensitive across its hunks; a targeted target review is identified by
 *   the index it sends, and only a full target review falls back to the raw
 *   target fingerprint.
 * - The prompt shows stable ids only (never a target-bound `H-…` id), sends no
 *   patch text for a targeted file/target review, sends the selected hunk's
 *   patch verbatim in hunk mode, and in full mode admits whole patches up to
 *   160,000 characters while the INDEX stays complete — an over-budget patch is
 *   marked omitted rather than cut, so no fragment is ever misattributed.
 *
 * Run: node --experimental-strip-types tests/ai-review-prompt.test.ts
 */
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { extname } from "node:path";
import type * as PromptModule from "../server/ai-review-prompt";

// Production modules use bundler-style extensionless imports, which node's
// type stripping does not resolve; this test loads the real server module, so
// relative specifiers without an extension get the .ts extension here.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && extname(specifier) === "") {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

// A static ESM import cannot load this module: its relative specifiers are
// extensionless (strip-only resolution needs the hook above) and a literal
// ".ts" specifier is a type error while allowImportingTsExtensions is off, so
// the real module is required at its true .ts path (as the ai-review-cache
// suite does). Types come from the type-only namespace import above.
const requireFromRepo = createRequire(import.meta.url);
const promptModule: typeof PromptModule = requireFromRepo("../server/ai-review-prompt.ts");

const {
  AI_REVIEW_PATCH_CHAR_LIMIT,
  AI_REVIEW_PROMPT_VERSION,
  AI_REVIEW_SCHEMA_VERSION,
  aiReviewInputFingerprint,
  buildAiReviewPrompt,
  fileFingerprint,
  hunkStableFingerprint,
  hunkStableId,
  normalizeHunkContext,
  promptHunk,
  severityRank,
  triageBucket,
} = promptModule;

const file = (path: string, hunks: readonly PromptModule.AiReviewPromptHunk[]): PromptModule.AiReviewPromptFile => ({ path, hunks });
const patch = (lines: readonly string[]): string => lines.join("\n");

const patchAlpha = patch([
  "diff --git a/server/Foo.ts b/server/Foo.ts",
  "index 1111111..2222222 100644",
  "--- a/server/Foo.ts",
  "+++ b/server/Foo.ts",
  "@@ -1,4 +1,5 @@ export function foo() {",
  " const a = 1;",
  "+const b = 2;",
  " return a;",
  " }",
]);
// Same body and section as patchAlpha, different line ranges and file-blob hash.
const patchAlphaShifted = patchAlpha
  .replace("@@ -1,4 +1,5 @@", "@@ -140,4 +140,5 @@")
  .replace("1111111..2222222", "9999999..8888888");
const patchBeta = patch([
  "diff --git a/server/Foo.ts b/server/Foo.ts",
  "index 1111111..2222222 100644",
  "--- a/server/Foo.ts",
  "+++ b/server/Foo.ts",
  "@@ -20,3 +21,4 @@ export function bar() {",
  " const c = 1;",
  "+const d = 2;",
  " }",
]);
const patchAlphaOtherFile = patchAlpha.replace(/server\/Foo\.ts/g, "server/Baz.ts");
const patchBar = "+const bar = 1;";

const hunkAlpha = promptHunk({
  path: "server/Foo.ts",
  header: "@@ -1,4 +1,5 @@ export function foo() {",
  patch: patchAlpha,
  findings: [{ severity: "high", category: "concurrency" }, { severity: "low", category: "style" }],
});
const hunkBeta = promptHunk({
  path: "server/Foo.ts",
  header: "@@ -20,3 +21,4 @@ export function bar() {",
  patch: patchBeta,
  findings: [{ severity: "informational", category: "docs" }],
});
const hunkBar = promptHunk({
  path: "client/Bar.tsx",
  header: "@@ -1,1 +1,2 @@",
  patch: patchBar,
  findings: [{ severity: "medium", category: "api" }],
});
const fileFoo = file("server/Foo.ts", [hunkAlpha, hunkBeta]);
const fileBar = file("client/Bar.tsx", [hunkBar]);
const changedFiles = [fileFoo, fileBar];

const input = (overrides: Partial<PromptModule.AiReviewPromptInput> = {}): PromptModule.AiReviewPromptInput => ({
  mode: "target",
  depth: "targeted",
  preset: "balanced",
  scope: "working",
  workspace: "/repo",
  targetFingerprint: "target-1",
  files: changedFiles,
  ...overrides,
});

// ---------------------------------------------------------------------------
// 0. Contract constants.
// ---------------------------------------------------------------------------
assert.strictEqual(AI_REVIEW_PROMPT_VERSION, 2);
assert.strictEqual(AI_REVIEW_SCHEMA_VERSION, 1);
assert.strictEqual(AI_REVIEW_PATCH_CHAR_LIMIT, 160_000);

// ---------------------------------------------------------------------------
// 1. Stable hunk identity is location independent: the same body and section
//    under shifted line ranges and a different file-blob hash keep the id; a
//    changed path, body, or enclosing section does not.
// ---------------------------------------------------------------------------
assert.strictEqual(hunkStableId("server/Foo.ts", patchAlpha), hunkStableId("server/Foo.ts", patchAlphaShifted));
assert.match(hunkStableId("server/Foo.ts", patchAlpha), /^H-[0-9a-f]{12}$/);
assert.strictEqual(
  hunkStableFingerprint("server/Foo.ts", patchAlpha, "export function foo() {"),
  hunkStableFingerprint("server/Foo.ts", patchAlphaShifted, "@@ -140,4 +140,5 @@ export function foo()"),
  "a raw @@ header and a bare section caption must normalize to the same context",
);
assert.notStrictEqual(
  hunkStableId("server/Foo.ts", patchAlpha),
  hunkStableId("server/Foo.ts", patchAlpha, "export function other()"),
  "a different enclosing section is a different identity",
);
assert.notStrictEqual(hunkStableId("server/Foo.ts", patchAlpha), hunkStableId("server/Baz.ts", patchAlphaOtherFile));
assert.notStrictEqual(hunkStableId("server/Foo.ts", patchAlpha), hunkStableId("server/Foo.ts", patchBeta));

// The hunk body changes identity; only its file preamble does not.
const patchAlphaBodyChanged = patchAlpha.replace("+const b = 2;", "+const b = 3;");
const patchAlphaPreambleOnly = patchAlpha.replace("index 1111111..2222222 100644", "index 3333333..4444444 100644");
assert.notStrictEqual(hunkStableId("server/Foo.ts", patchAlpha), hunkStableId("server/Foo.ts", patchAlphaBodyChanged));
assert.strictEqual(hunkStableId("server/Foo.ts", patchAlpha), hunkStableId("server/Foo.ts", patchAlphaPreambleOnly));

// `promptHunk` derives that same context from the header and keeps it.
assert.strictEqual(hunkAlpha.context, "export function foo()");
assert.strictEqual(promptHunk({ path: "server/Foo.ts", header: "@@ -1,4 +1,5 @@ export function foo() {", patch: patchAlpha }).stableId, hunkAlpha.stableId);

// ---------------------------------------------------------------------------
// 2. Context normalization: section text survives, line ranges and whitespace
//    noise do not.
// ---------------------------------------------------------------------------
assert.strictEqual(normalizeHunkContext("@@ -1,4 +1,5 @@ export   function  foo() {"), "export function foo()");
assert.strictEqual(normalizeHunkContext("  Foo\n\tBar  "), "Foo Bar");
assert.strictEqual(normalizeHunkContext("@@ -1 +1 @@"), "");
assert.strictEqual(normalizeHunkContext(undefined), "");

// ---------------------------------------------------------------------------
// 3. File identity is path + SORTED hunk fingerprints.
// ---------------------------------------------------------------------------
assert.strictEqual(fileFingerprint("server/Foo.ts", [hunkAlpha.stableFingerprint, hunkBeta.stableFingerprint]), fileFingerprint("server/Foo.ts", [hunkBeta.stableFingerprint, hunkAlpha.stableFingerprint]));
assert.notStrictEqual(fileFingerprint("server/Foo.ts", [hunkAlpha.stableFingerprint, hunkBeta.stableFingerprint]), fileFingerprint("server/Foo.ts", [hunkAlpha.stableFingerprint]));
assert.notStrictEqual(fileFingerprint("server/Foo.ts", [hunkAlpha.stableFingerprint]), fileFingerprint("server/Baz.ts", [hunkAlpha.stableFingerprint]));

// ---------------------------------------------------------------------------
// 4. Mode-specific input identity. Hunk and file identities ignore the target
//    fingerprint (an unrelated change elsewhere must not invalidate them), a
//    targeted target review is identified by the index it sends, and only a
//    full target review is identified by the raw target fingerprint.
// ---------------------------------------------------------------------------
const hunkIdentity = (targetFingerprint: string, files: readonly PromptModule.AiReviewPromptFile[] = changedFiles): string =>
  aiReviewInputFingerprint(input({ mode: "hunk", depth: "targeted", targetFingerprint, files }));
assert.strictEqual(hunkIdentity("target-1"), hunkIdentity("target-2"));
assert.strictEqual(hunkIdentity("target-1"), hunkAlpha.stableFingerprint);
// Another file joining the changeset does not move a hunk or a file identity.
assert.strictEqual(hunkIdentity("target-1"), hunkIdentity("target-1", [fileFoo, fileBar, file("docs/README.md", [promptHunk({ path: "docs/README.md", header: "@@ -1,1 +1,2 @@", patch: "+docs" })])]));

const fileIdentity = (targetFingerprint: string): string =>
  aiReviewInputFingerprint(input({ mode: "file", targetFingerprint }));
assert.strictEqual(fileIdentity("target-1"), fileIdentity("target-2"));
assert.strictEqual(fileIdentity("target-1"), fileFingerprint("server/Foo.ts", [hunkAlpha.stableFingerprint, hunkBeta.stableFingerprint]));

const targetedIdentity = (targetFingerprint: string, files: readonly PromptModule.AiReviewPromptFile[] = changedFiles): string =>
  aiReviewInputFingerprint(input({ mode: "target", depth: "targeted", targetFingerprint, files }));
assert.strictEqual(targetedIdentity("target-1"), targetedIdentity("target-2"));
assert.notStrictEqual(targetedIdentity("target-1"), targetedIdentity("target-1", [fileFoo]));
assert.strictEqual(
  targetedIdentity("target-1"),
  targetedIdentity("target-1", [file("server/Foo.ts", [hunkBeta, hunkAlpha]), fileBar]),
  "the targeted index identity ignores listing order",
);

const fullIdentity = (targetFingerprint: string): string =>
  aiReviewInputFingerprint(input({ mode: "target", depth: "full", targetFingerprint }));
assert.strictEqual(fullIdentity("target-1"), "target-1");
assert.notStrictEqual(fullIdentity("target-1"), fullIdentity("target-2"));

// ---------------------------------------------------------------------------
// 5. Targeted prompt: index only, no patch text, stable ids, complete index.
// ---------------------------------------------------------------------------
const targeted = buildAiReviewPrompt(input({ mode: "target", depth: "targeted" }));
assert.deepStrictEqual(targeted.hunkIds, [hunkAlpha.stableId, hunkBeta.stableId, hunkBar.stableId]);
assert.deepStrictEqual(targeted.includedPatchHunkIds, []);
assert.deepStrictEqual(targeted.omittedPatchHunkIds, []);
assert.strictEqual(targeted.patchCharacters, 0);
assert.ok(targeted.prompt.includes("HUNK INDEX"));
assert.ok(targeted.prompt.includes("Changed files: 2"));
assert.ok(targeted.prompt.includes(`- ${hunkAlpha.stableId} · server/Foo.ts · @@ -1,4 +1,5 @@ export function foo() { · HIGH · concurrency · MUST REVIEW`));
assert.ok(targeted.prompt.includes("INFORMATIONAL · docs · AS NEEDED") && targeted.prompt.includes("MEDIUM · api · WITHIN BUDGET"));
for (const forbidden of [patchAlpha, patchBeta, patchBar, "+const b = 2;", "diff --git", "HUNK PATCHES"]) {
  assert.ok(!targeted.prompt.includes(forbidden), `targeted review must not send patch text: ${forbidden}`);
}
// Only stable ids are cited — never a target-bound H-… from the diff parser.
assert.deepStrictEqual([...new Set(targeted.prompt.match(/H-[0-9a-f]{12}/g) ?? [])].sort(), [...targeted.hunkIds].sort());
assert.strictEqual(targeted.inputFingerprint, targetedIdentity("target-1"));
assert.strictEqual(targeted.promptVersion, AI_REVIEW_PROMPT_VERSION);
assert.strictEqual(targeted.schemaVersion, AI_REVIEW_SCHEMA_VERSION);
assert.strictEqual(targeted.mode, "target");
assert.strictEqual(targeted.depth, "targeted");
assert.strictEqual(targeted.locale, "en");
assert.equal(targeted.preset, "balanced");
assert.strictEqual(targeted.scope, "working");
assert.strictEqual(targeted.workspace, "/repo");
assert.strictEqual(targeted.targetFingerprint, "target-1");
assert.ok(targeted.prompt.endsWith("\n"));

// The same review under a different target keeps its ids and its input
// identity, even though the prompt reports the current fingerprint.
const retargeted = buildAiReviewPrompt(input({ mode: "target", depth: "targeted", targetFingerprint: "target-2" }));
assert.deepStrictEqual(retargeted.hunkIds, targeted.hunkIds);
assert.strictEqual(retargeted.inputFingerprint, targeted.inputFingerprint);
assert.ok(retargeted.prompt.includes("Review fingerprint: target-2") && !retargeted.prompt.includes("target-1"));

// ---------------------------------------------------------------------------
// 6. Hunk mode: the selected hunk's patch is verbatim even when targeted, and
//    it is the only index entry.
// ---------------------------------------------------------------------------
const hunkReview = buildAiReviewPrompt(input({ mode: "hunk", depth: "targeted" }));
assert.ok(hunkReview.prompt.includes(patchAlpha));
assert.strictEqual(hunkReview.patchCharacters, patchAlpha.length);
assert.deepStrictEqual(hunkReview.hunkIds, [hunkAlpha.stableId]);
assert.deepStrictEqual(hunkReview.includedPatchHunkIds, [hunkAlpha.stableId]);
assert.strictEqual(hunkReview.inputFingerprint, hunkAlpha.stableFingerprint);
const mediumHunkReview = buildAiReviewPrompt(input({
  mode: "hunk",
  depth: "targeted",
  preset: "balanced",
  files: [fileBar],
}));
for (const preset of ["economical", "deep"] as const) {
  const presetVariant = buildAiReviewPrompt(input({ mode: "hunk", depth: "targeted", preset, files: [fileBar] }));
  assert.strictEqual(presetVariant.prompt, mediumHunkReview.prompt, `hunk prompt ignores the ${preset} budget preset`);
  assert.strictEqual(presetVariant.inputFingerprint, mediumHunkReview.inputFingerprint);
}
assert.ok(!hunkReview.prompt.includes("Review budget:"));
assert.ok(!hunkReview.prompt.includes(patchBeta) && !hunkReview.prompt.includes(hunkBeta.stableId));

// ---------------------------------------------------------------------------
// 7. Full review: patches are bounded by whole-patch admission at 160,000
//    characters, and the INDEX stays complete either way.
// ---------------------------------------------------------------------------
const bigPatch = (marker: string, size: number): string => `+${marker.repeat(size - 1)}`;
const bigOne = promptHunk({ path: "a/big.txt", header: "@@ -1,1 +1,2 @@", patch: bigPatch("b", 100_000) });
const bigTwo = promptHunk({ path: "b/big2.txt", header: "@@ -1,1 +1,2 @@", patch: bigPatch("c", 100_000) });
const full = buildAiReviewPrompt(input({ mode: "target", depth: "full", files: [file("a/big.txt", [bigOne]), file("b/big2.txt", [bigTwo])] }));
assert.deepStrictEqual(full.includedPatchHunkIds, [bigOne.stableId]);
assert.deepStrictEqual(full.omittedPatchHunkIds, [bigTwo.stableId]);
assert.strictEqual(full.patchCharacters, bigOne.patch.length);
assert.ok(full.patchCharacters <= AI_REVIEW_PATCH_CHAR_LIMIT);
assert.ok(full.prompt.includes(bigOne.patch), "an included patch is verbatim");
assert.ok(!full.prompt.includes(bigTwo.patch));
assert.ok(full.prompt.includes(bigTwo.stableId) && full.prompt.includes("patch omitted"));
assert.deepStrictEqual(full.includedPatchHunkIds.concat(full.omittedPatchHunkIds), full.hunkIds, "every index hunk is accounted for");
assert.ok(full.prompt.indexOf("HUNK INDEX") < full.prompt.indexOf("HUNK PATCHES"));
assert.ok(full.prompt.includes("Full review:") && !full.prompt.includes("Targeted review:"));

// Boundary: patches summing to exactly the limit both fit; one character more
// does not, and nothing is ever cut mid-patch.
const exactFirst = promptHunk({ path: "a/exact.txt", header: "@@ -1,1 +1,2 @@", patch: bigPatch("d", 100_000) });
const exactSecond = promptHunk({ path: "b/exact2.txt", header: "@@ -1,1 +1,2 @@", patch: bigPatch("e", 60_000) });
const exactFill = buildAiReviewPrompt(input({ mode: "target", depth: "full", files: [file("a/exact.txt", [exactFirst]), file("b/exact2.txt", [exactSecond])] }));
assert.strictEqual(exactFill.patchCharacters, AI_REVIEW_PATCH_CHAR_LIMIT);
assert.deepStrictEqual(exactFill.includedPatchHunkIds, [exactFirst.stableId, exactSecond.stableId]);
assert.deepStrictEqual(exactFill.omittedPatchHunkIds, []);

const justOver = buildAiReviewPrompt(input({
  mode: "target",
  depth: "full",
  files: [file("a/over.txt", [promptHunk({ path: "a/over.txt", header: "@@ -1,1 +1,2 @@", patch: bigPatch("f", AI_REVIEW_PATCH_CHAR_LIMIT + 1) })])],
}));
assert.strictEqual(justOver.patchCharacters, 0);
assert.deepStrictEqual(justOver.includedPatchHunkIds, []);
assert.deepStrictEqual(justOver.omittedPatchHunkIds, justOver.hunkIds);
assert.ok(!justOver.prompt.includes("ffff"), "an over-budget patch is omitted whole, never truncated");

// File-mode full review sends that file's patches only, still bounded.
const fileFull = buildAiReviewPrompt(input({ mode: "file", depth: "full", files: [fileFoo, file("b/big2.txt", [bigTwo])] }));
assert.deepStrictEqual(fileFull.includedPatchHunkIds, [hunkAlpha.stableId, hunkBeta.stableId]);
assert.strictEqual(fileFull.patchCharacters, patchAlpha.length + patchBeta.length);
assert.ok(!fileFull.prompt.includes(bigTwo.patch));
assert.strictEqual(fileFull.inputFingerprint, fileIdentity("target-1"));

// ---------------------------------------------------------------------------
// 8. Triage: severity ranking, buckets, and a highest-severity hunk caption.
// ---------------------------------------------------------------------------
assert.ok(severityRank("critical") > severityRank("high"));
assert.ok(severityRank("high") > severityRank("medium"));
assert.ok(severityRank("medium") > severityRank("low"));
assert.ok(severityRank("low") > severityRank("informational"));
assert.deepStrictEqual(
  (["critical", "high", "medium", "low", "informational"] as PromptModule.AiReviewSeverity[]).map((severity) => triageBucket(severity, "balanced")),
  ["must-review", "must-review", "within-budget", "as-needed", "as-needed"],
);
assert.deepStrictEqual(
  (["critical", "high", "medium", "low", "informational"] as PromptModule.AiReviewSeverity[]).map((severity) => triageBucket(severity, "economical")),
  ["must-review", "must-review", "as-needed", "as-needed", "as-needed"],
);
assert.deepStrictEqual(
  (["critical", "high", "medium", "low", "informational"] as PromptModule.AiReviewSeverity[]).map((severity) => triageBucket(severity, "deep")),
  ["must-review", "must-review", "must-review", "must-review", "must-review"],
);
assert.strictEqual(hunkAlpha.severity, "high");
assert.strictEqual(hunkAlpha.category, "concurrency");
const noFindings = promptHunk({ path: "server/Foo.ts", header: "@@ -1,1 +1,2 @@", patch: "+const x = 1;" });
assert.strictEqual(noFindings.severity, "informational");
assert.strictEqual(noFindings.category, "general");
const economical = buildAiReviewPrompt(input({ preset: "economical" }));
assert.ok(economical.prompt.includes("Review budget: Economical"));
assert.ok(economical.prompt.includes("medium/low/informational: skip"));
const deep = buildAiReviewPrompt(input({ preset: "deep", depth: "full" }));
assert.ok(deep.prompt.includes("Review budget: Deep"));
assert.ok(deep.prompt.includes("inspect every hunk"));
assert.ok(targeted.prompt.includes("critical/high: always inspect") && targeted.prompt.includes("medium: inspect while") && targeted.prompt.includes("low/informational: inspect only"));

// ---------------------------------------------------------------------------
// 9. Locale: instructions and headings switch, identity metadata does not.
// ---------------------------------------------------------------------------
const zh = buildAiReviewPrompt(input({ mode: "target", depth: "targeted", locale: "zh" }));
assert.ok(zh.prompt.includes("变更块索引") && zh.prompt.includes("变更文件: 2") && zh.prompt.includes("用中文回答。"));
assert.ok(zh.prompt.includes("- critical/high：必须检查") && zh.prompt.includes("工作区: /repo") && zh.prompt.includes("评审指纹: target-1"));
assert.ok(!zh.prompt.includes("HUNK INDEX") && !zh.prompt.includes("Answer in English"));
assert.ok(targeted.prompt.includes("HUNK INDEX") && targeted.prompt.includes("Answer in English.") && !targeted.prompt.includes("变更块索引"));
assert.strictEqual(zh.locale, "zh");
assert.strictEqual(zh.inputFingerprint, targeted.inputFingerprint);
assert.deepStrictEqual(zh.hunkIds, targeted.hunkIds);
assert.strictEqual(zh.promptVersion, targeted.promptVersion);
assert.strictEqual(zh.schemaVersion, targeted.schemaVersion);
assert.strictEqual(zh.patchCharacters, 0);

// ---------------------------------------------------------------------------
// 10. An empty review unit is a caller error, not a silently empty prompt.
// ---------------------------------------------------------------------------
assert.throws(() => buildAiReviewPrompt(input({ mode: "hunk", depth: "targeted", files: [] })), /at least one file/);
assert.throws(() => buildAiReviewPrompt(input({ mode: "file", depth: "targeted", files: [] })), /at least one file/);
assert.throws(() => buildAiReviewPrompt(input({ mode: "hunk", depth: "targeted", files: [file("server/Empty.ts", [])] })), /selected hunk/);

// An empty target review still produces a well-formed, identifiable prompt.
const emptyTarget = buildAiReviewPrompt(input({ mode: "target", depth: "targeted", files: [] }));
assert.deepStrictEqual(emptyTarget.hunkIds, []);
assert.ok(emptyTarget.prompt.includes("(No text hunks found.)"));
assert.strictEqual(emptyTarget.inputFingerprint, targetedIdentity("target-1", []));

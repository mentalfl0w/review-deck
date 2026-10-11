import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { extname } from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && extname(specifier) === "") return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const requireFromRepo = createRequire(import.meta.url);
const { DiffParser } = requireFromRepo("../server/diff/DiffParser.ts") as {
  DiffParser: new () => { parse(raw: string, targetFingerprint: string, locale?: "en" | "zh", identity?: { scope?: string; worktreePath?: string }): Array<{ path: string; hunks: Array<{ id: string; findings: Array<{ id: string; originId?: string; anchorFingerprint?: string }> }> }> };
};

const parser = new DiffParser();
const makeHunk = (header: string, before: string, after: string, index = "1111111..2222222") => [
  "diff --git a/src/api.ts b/src/api.ts",
  `index ${index} 100644`,
  "--- a/src/api.ts",
  "+++ b/src/api.ts",
  header,
  ` ${before}`,
  "-const legacy = 1;",
  "+export const api = 2;",
  ` ${after}`,
].join("\n");
const parsedFindings = (raw: string, targetFingerprint: string, scope = "working", worktreePath = "/repo") =>
  parser.parse(raw, targetFingerprint, "en", { scope, worktreePath })[0]!.hunks.map((hunk) => ({
    hunkId: hunk.id,
    finding: hunk.findings.find((finding) => finding.originId === "breaking_api_change")!,
  }));

const original = makeHunk("@@ -1,3 +1,3 @@", "const before = 1;", "const after = 1;");
const first = parsedFindings(original, "target-a")[0]!;
const sameContentNewTarget = parsedFindings(makeHunk("@@ -20,3 +20,3 @@", "const before = 1;", "const after = 1;", "aaaaaaaa..bbbbbbbb"), "target-b")[0]!;
assert.notEqual(first.hunkId, sameContentNewTarget.hunkId, "the display Hunk id remains target-bound");
assert.equal(first.finding.id, sameContentNewTarget.finding.id, "the finding id does not drift with target fingerprint, line number, or file blob metadata");
assert.equal(first.finding.anchorFingerprint, sameContentNewTarget.finding.anchorFingerprint);

const differentContext = parsedFindings(makeHunk("@@ -1,3 +1,3 @@", "const otherBefore = 1;", "const otherAfter = 1;"), "target-a")[0]!;
assert.notEqual(first.finding.anchorFingerprint, differentContext.finding.anchorFingerprint);
assert.notEqual(first.finding.id, differentContext.finding.id, "different surrounding context yields a distinct anchor identity");

const repeated = [
  "diff --git a/src/api.ts b/src/api.ts",
  "index 1111111..2222222 100644",
  "--- a/src/api.ts",
  "+++ b/src/api.ts",
  "@@ -1,3 +1,3 @@",
  " const before = 1;",
  "-const legacy = 1;",
  "+export const api = 2;",
  " const after = 1;",
  "@@ -20,3 +20,3 @@",
  " const before = 1;",
  "-const legacy = 1;",
  "+export const api = 2;",
  " const after = 1;",
].join("\n");
const repeatedFindings = parsedFindings(repeated, "target-a");
assert.equal(repeatedFindings.length, 2);
assert.notEqual(repeatedFindings[0]!.finding.id, repeatedFindings[1]!.finding.id, "identical repeated hunks receive distinct occurrence identities");
const repeatedAgain = parsedFindings(repeated, "target-b");
assert.deepEqual(repeatedAgain.map(({ finding }) => finding.id), repeatedFindings.map(({ finding }) => finding.id), "duplicate occurrence ids survive target-fingerprint changes");

assert.notEqual(
  parsedFindings(original, "target-a", "staged")[0]!.finding.id,
  first.finding.id,
  "scope is part of a finding's identity",
);
assert.notEqual(
  parsedFindings(original, "target-a", "working", "/other-worktree")[0]!.finding.id,
  first.finding.id,
  "worktree identity prevents cross-worktree deduplication",
);
const withUnrelatedHunk = [
  "diff --git a/src/api.ts b/src/api.ts",
  "index 1111111..2222222 100644",
  "--- a/src/api.ts",
  "+++ b/src/api.ts",
  "@@ -10,3 +10,3 @@",
  " const before = 1;",
  "-const oldValue = 1;",
  "+const newValue = 2;",
  " const after = 1;",
  "@@ -30,3 +30,3 @@",
  " const before = 1;",
  "-const legacy = 1;",
  "+export const api = 2;",
  " const after = 1;",
].join("\n");
const stableAfterUnrelated = parser
  .parse(withUnrelatedHunk, "target-c", "en", { scope: "working", worktreePath: "/repo" })
  .flatMap((file) => file.hunks.flatMap((hunk) => hunk.findings))
  .find((finding) => finding.originId === "breaking_api_change");
assert.equal(stableAfterUnrelated?.id, first.finding.id, "an unrelated Hunk does not perturb a finding's identity");

const renamedFileFinding = parsedFindings(original.replaceAll("src/api.ts", "src/renamed-api.ts"), "target-a")[0]!.finding;
assert.notEqual(renamedFileFinding.id, first.finding.id, "renames do not merge findings across file identities");


console.log("finding-identity: all assertions passed");

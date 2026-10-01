import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { extname } from "node:path";
import type { ProjectReviewComment } from "../shared/review";
import type { ReviewBatch } from "../shared/review-batch";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && extname(specifier) === "") {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const requireFromRepo = createRequire(import.meta.url);
const {
  buildReviewBatchPrompt,
  extractReviewBatchAssistantResponse,
  parseReviewCommentOutcomes,
  reviewBatchTimelineData,
} = requireFromRepo("../server/review-batch.ts") as {
  buildReviewBatchPrompt(input: {
    batchId: string;
    projectId: string;
    workspaceId: string;
    workspaceCwd: string;
    comments: ProjectReviewComment[];
  }): string;
  extractReviewBatchAssistantResponse(
    timeline: Array<{ type: string; text?: string }>,
    batchId: string,
  ): { found: boolean; hasAssistantMessage: boolean; hasOutcomesSection: boolean; text: string };
  parseReviewCommentOutcomes(response: string, commentIds: string[]): Record<string, string>;
  reviewBatchTimelineData(batch: ReviewBatch): Record<string, unknown>;
};

const comment = (id: string, workspaceId: string, cwd: string): ProjectReviewComment => ({
  id,
  projectId: "project-1",
  workspaceId,
  targetFingerprint: `target-${id}`,
  hunkId: `hunk-${id}`,
  hunkFingerprint: `fingerprint-${id}`,
  filePath: `src/${id}.ts`,
  hunkHeader: "@@ -1 +1 @@",
  hunkPatch: `-old-${id}\n+new-${id}`,
  cwd,
  scope: "working",
  comment: `Please update ${id}`,
  savedAt: "2026-09-30T12:00:00.000Z",
});

const prompt = buildReviewBatchPrompt({
  batchId: "batch-123",
  projectId: "project-1",
  workspaceId: "workspace-a",
  workspaceCwd: "/repo/worktree-a",
  comments: [comment("comment-a", "workspace-a", "/repo/worktree-a")],
});
assert.ok(prompt.startsWith("REVIEW DECK BATCH: batch-123"));
assert.ok(prompt.includes("Workspace id: workspace-a"));
assert.ok(prompt.includes("Workspace cwd: /repo/worktree-a"));
assert.ok(prompt.includes("COMMENT OUTCOMES"));
assert.ok(prompt.split(/\r?\n/).some((line) => line === "COMMENT OUTCOMES"));
assert.ok(prompt.includes("- <comment-id> | COMPLETED | optional short detail"));
assert.ok(prompt.includes("comment-a"));
assert.ok(!prompt.includes("workspace-b"));

const delayedAssistantResponse = extractReviewBatchAssistantResponse([
  { type: "user_message", text: "REVIEW DECK BATCH: batch-123\nProcess comments" },
  { type: "user_message", text: "A later user message arrived before the Agent answered." },
  { type: "assistant_message", text: "COMMENT OUTCOMES\n- comment-a | COMPLETED | fixed" },
], "batch-123");
assert.equal(delayedAssistantResponse.found, true);
assert.equal(delayedAssistantResponse.hasAssistantMessage, false);
assert.equal(delayedAssistantResponse.hasOutcomesSection, false);
assert.equal(delayedAssistantResponse.text, "", "an assistant response after another user turn is not attributed to the Batch");

const sameTurnResponse = extractReviewBatchAssistantResponse([
  { type: "user_message", text: "REVIEW DECK BATCH: batch-123\nProcess comments" },
  { type: "assistant_message", text: "COMMENT OUTCOMES\n- comment-a | COMPLETED | fixed" },
  { type: "user_message", text: "REVIEW DECK BATCH: batch-456\nA different batch" },
  { type: "assistant_message", text: "This later response is not part of the batch." },
], "batch-123");
assert.equal(sameTurnResponse.found, true);
assert.equal(sameTurnResponse.hasAssistantMessage, true);
assert.equal(sameTurnResponse.hasOutcomesSection, true);
assert.ok(sameTurnResponse.text.includes("comment-a | COMPLETED"));
assert.ok(!sameTurnResponse.text.includes("This later response"));
const queuedBatchPrompt = extractReviewBatchAssistantResponse([
  { type: "user_message", text: "REVIEW DECK BATCH: batch-123\nProcess comments" },
], "batch-123");
assert.deepEqual(queuedBatchPrompt, {
  found: true,
  hasAssistantMessage: false,
  hasOutcomesSection: false,
  text: "",
}, "a queued Batch user message is not treated as a completed turn response");
assert.equal(
  extractReviewBatchAssistantResponse([
    { type: "user_message", text: "Quoted marker: REVIEW DECK BATCH: batch-123" },
  ], "batch-123").found,
  false,
  "the batch marker must be its own user-message line",
);

const outcomes = parseReviewCommentOutcomes([
  "COMMENT OUTCOMES",
  "- comment-a | COMPLETED | finished",
  "- comment-b | STALE | patch changed",
  "- comment-c | FAILED | tool error",
  "- comment-d | UNRESOLVED | not attempted",
  "- foreign-comment | COMPLETED | not in this batch",
  "- comment-a | COMPLETED | duplicate must fail closed",
].join("\n"), ["comment-a", "comment-b", "comment-c", "comment-d"]);
assert.deepEqual(outcomes, {
  "comment-a": "unresolved",
  "comment-b": "stale",
  "comment-c": "failed",
  "comment-d": "unresolved",
});
for (const heading of ["## COMMENT OUTCOMES:", "COMMENT OUTCOMES:"]) {
  assert.deepEqual(
    parseReviewCommentOutcomes(`${heading}\n- comment-a | COMPLETED | done`, ["comment-a"]),
    { "comment-a": "completed" },
    `decorated heading ${heading} still allows only the explicit outcome line`,
  );
}
assert.deepEqual(
  parseReviewCommentOutcomes([
    "COMMENT OUTCOMES",
    "- comment-a | UNRESOLVED | incomplete first report",
    "COMMENT OUTCOMES",
    "- comment-a | COMPLETED | conflicting second report",
  ].join("\n"), ["comment-a"]),
  { "comment-a": "unresolved" },
  "conflicting outcomes sections fail closed instead of selecting the last one",
);
assert.deepEqual(
  parseReviewCommentOutcomes("COMMENT OUTCOMES\n- comment-a | COMPLETED?", ["comment-a"]),
  { "comment-a": "unresolved" },
  "malformed status text never counts as COMPLETED",
);
assert.deepEqual(
  parseReviewCommentOutcomes("No outcomes section", ["comment-a"]),
  { "comment-a": "unresolved" },
  "a missing outcomes section leaves every comment unresolved",
);


const batch: ReviewBatch = {
  id: "batch-123",
  createdAt: "2026-09-30T11:59:00.000Z",
  projectId: "project-1",
  workspaceId: "workspace-a",
  agentId: "agent-a",
  commentIds: ["comment-a", "comment-b"],
  submittedAt: "2026-09-30T12:00:00.000Z",
  completedAt: "2026-09-30T12:01:00.000Z",
  status: "partial",
  outcomes: { "comment-a": "completed", "comment-b": "stale" },
};
assert.deepEqual(reviewBatchTimelineData(batch), {
  workspaceId: "workspace-a",
  commentCount: 2,
  status: "partial",
  completedCount: 1,
  staleCount: 1,
  failedCount: 0,
  unresolvedCount: 0,
  submittedAt: "2026-09-30T12:00:00.000Z",
  completedAt: "2026-09-30T12:01:00.000Z",
});
console.log("ReviewBatch prompt/parser: all assertions passed");

import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { ProjectReviewComment } from "../shared/review";
import {
  reviewBatchTimelineSchema,
  type ReviewBatch,
  type ReviewBatchTimelineData,
  type ReviewCommentOutcome,
} from "../shared/review-batch";

export type ReviewBatchOutcomeCounts = {
  completedCount: number;
  staleCount: number;
  failedCount: number;
  unresolvedCount: number;
};

export function buildReviewBatchPrompt(input: {
  batchId: string;
  projectId: string;
  projectName?: string;
  workspaceId: string;
  workspaceCwd: string;
  comments: readonly ProjectReviewComment[];
}): string {
  const commentBlocks = input.comments.map((comment, index) => [
    `[${index + 1}] Comment id: ${comment.id}`,
    `File: ${comment.filePath}`,
    `Workspace cwd: ${comment.cwd}`,
    `Workspace id: ${comment.workspaceId ?? input.workspaceId}`,
    `Scope: ${comment.scope}`,
    `Base ref: ${comment.baseRef ?? "(repository default)"}`,
    `Head ref: ${comment.headRef ?? "(repository default)"}`,
    `Target fingerprint: ${comment.targetFingerprint}`,
    `Hunk fingerprint: ${comment.hunkFingerprint}`,
    `Hunk header: ${comment.hunkHeader}`,
    `Human comment: ${comment.comment}`,
    `Exact hunk patch:\n${comment.hunkPatch}`,
  ].join("\n"));

  return [
    `REVIEW DECK BATCH: ${input.batchId}`,
    "Process every saved review comment below as one task. This batch contains comments from exactly one workspace.",
    "You MUST work only in the executing Agent's workspace listed below. Do not edit a different worktree, project root, or any unlisted file or hunk.",
    "Verify each comment against the current target and exact hunk fingerprint before editing. If either has drifted, do not edit that comment and report it as STALE.",
    "For each matching comment, make only the requested change in its listed hunk. Run focused verification when appropriate; never claim checks passed unless you ran them.",
    "Use exactly these headings: VERIFIED FACTS, AI INFERENCE, HUMAN VERIFICATION RECOMMENDED.",
    "At the very end, add a machine-parseable outcomes section with exactly one line per listed comment id, using this heading and exact line format:",
    "COMMENT OUTCOMES",
    "- <comment-id> | COMPLETED | optional short detail",
    "- <comment-id> | STALE | optional short detail",
    "- <comment-id> | FAILED | optional short detail",
    "- <comment-id> | UNRESOLVED | optional short detail",
    "Mark COMPLETED only when the requested change is finished. Mark STALE when fingerprints do not match, FAILED when you attempted but could not finish, and UNRESOLVED when you did not address the comment. Only an explicit COMPLETED outcome may remove a comment from Review Deck.",
    `Project id: ${input.projectId}`,
    ...(input.projectName !== undefined ? [`Project name: ${input.projectName}`] : []),
    `Workspace id: ${input.workspaceId}`,
    `Workspace cwd: ${input.workspaceCwd}`,
    `Comments (${input.comments.length}):`,
    commentBlocks.join("\n\n"),
  ].join("\n\n");
}

export function extractReviewBatchAssistantResponse(
  timeline: PluginLifecycleEvents["agent.turn_ended"]["timeline"],
  batchId: string,
): { found: boolean; hasAssistantMessage: boolean; hasOutcomesSection: boolean; text: string } {
  const marker = `REVIEW DECK BATCH: ${batchId}`;
  let messageIndex = -1;
  for (let index = 0; index < timeline.length; index++) {
    const item = timeline[index];
    if (
      item?.type === "user_message" &&
      item.text.split(/\r?\n/).some((line) => line.trim() === marker)
    ) {
      messageIndex = index;
    }
  }
  if (messageIndex < 0) {
    return { found: false, hasAssistantMessage: false, hasOutcomesSection: false, text: "" };
  }

  const assistantMessages: string[] = [];
  for (let index = messageIndex + 1; index < timeline.length; index++) {
    const item = timeline[index];
    if (item?.type === "user_message") break;
    if (item?.type === "assistant_message") assistantMessages.push(item.text);
  }
  const outcomeMessages = assistantMessages.filter((text) =>
    text.split(/\r?\n/).some(isReviewCommentOutcomesHeading),
  );
  return {
    found: true,
    hasAssistantMessage: assistantMessages.length > 0,
    hasOutcomesSection: outcomeMessages.length > 0,
    text: (outcomeMessages.length > 0 ? outcomeMessages : assistantMessages).join("\n"),
  };
}

function isReviewCommentOutcomesHeading(line: string): boolean {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/:\s*$/, "")
    .trim()
    .toUpperCase() === "COMMENT OUTCOMES";
}

export function parseReviewCommentOutcomes(
  response: string,
  commentIds: readonly string[],
): Record<string, ReviewCommentOutcome> {
  const expectedIds = new Set(commentIds);
  const parsed = new Map<string, ReviewCommentOutcome>();
  const seen = new Set<string>();
  const lines = response.split(/\r?\n/);
  let sectionStart = -1;
  let sectionCount = 0;
  for (let index = 0; index < lines.length; index++) {
    if (isReviewCommentOutcomesHeading(lines[index] ?? "")) {
      sectionStart = index;
      sectionCount++;
    }
  }

  if (sectionCount === 1) {
    for (const rawLine of lines.slice(sectionStart + 1)) {
      const line = rawLine.trim();
      if (line.length === 0 || /^`{3,}$/.test(line)) continue;
      const candidateId = line.startsWith("-") ? line.slice(1).split("|")[0]?.trim() ?? "" : "";
      if (!expectedIds.has(candidateId)) continue;
      const match = /^-\s+([^|]+?)\s*\|\s*(COMPLETED|STALE|FAILED|UNRESOLVED)(?:\s*\|\s*(.*))?$/i.exec(line);
      if (!match || seen.has(candidateId)) {
        seen.add(candidateId);
        parsed.set(candidateId, "unresolved");
        continue;
      }
      seen.add(candidateId);
      parsed.set(candidateId, match[2]!.toLowerCase() as ReviewCommentOutcome);
    }
  }

  return Object.fromEntries(commentIds.map((commentId) => [commentId, parsed.get(commentId) ?? "unresolved"]));
}

export function reviewBatchOutcomeCounts(batch: ReviewBatch): ReviewBatchOutcomeCounts {
  const counts: ReviewBatchOutcomeCounts = {
    completedCount: 0,
    staleCount: 0,
    failedCount: 0,
    unresolvedCount: 0,
  };
  for (const commentId of batch.commentIds) {
    switch (batch.outcomes[commentId]) {
      case "completed": counts.completedCount++; break;
      case "stale": counts.staleCount++; break;
      case "failed": counts.failedCount++; break;
      case "unresolved": counts.unresolvedCount++; break;
      default: break;
    }
  }
  return counts;
}

export function reviewBatchTimelineData(batch: ReviewBatch): ReviewBatchTimelineData {
  if (!batch.submittedAt) throw new Error(`ReviewBatch ${batch.id} has no submission timestamp.`);
  const counts = reviewBatchOutcomeCounts(batch);
  return reviewBatchTimelineSchema.parse({
    workspaceId: batch.workspaceId,
    commentCount: batch.commentIds.length,
    status: batch.status === "draft" ? "submitted" : batch.status,
    ...counts,
    submittedAt: batch.submittedAt,
    ...(batch.completedAt !== undefined ? { completedAt: batch.completedAt } : {}),
  });
}

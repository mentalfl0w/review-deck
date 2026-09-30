import { z } from "zod";

export const reviewBatchStatusSchema = z.enum([
  "draft",
  "submitted",
  "running",
  "completed",
  "partial",
  "failed",
]);
export type ReviewBatchStatus = z.infer<typeof reviewBatchStatusSchema>;

export const reviewCommentOutcomeSchema = z.enum([
  "completed",
  "stale",
  "failed",
  "unresolved",
]);
export type ReviewCommentOutcome = z.infer<typeof reviewCommentOutcomeSchema>;

export const reviewBatchSchema = z.object({
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  commentIds: z.array(z.string().min(1)).min(1),
  submittedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  status: reviewBatchStatusSchema,
  outcomes: z.record(z.string().min(1), reviewCommentOutcomeSchema),
  turnId: z.string().min(1).optional(),
}).strict().superRefine((batch, context) => {
  const commentIds = new Set(batch.commentIds);
  if (commentIds.size !== batch.commentIds.length) {
    context.addIssue({ code: "custom", path: ["commentIds"], message: "ReviewBatch comment ids must be unique." });
  }
  for (const outcomeId of Object.keys(batch.outcomes)) {
    if (!commentIds.has(outcomeId)) {
      context.addIssue({ code: "custom", path: ["outcomes", outcomeId], message: "Outcome id is not part of this ReviewBatch." });
    }
  }
  const terminal = batch.status === "completed" || batch.status === "partial" || batch.status === "failed";
  if (terminal && batch.completedAt === undefined) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Terminal ReviewBatch requires completedAt." });
  }
  if (!terminal && batch.completedAt !== undefined) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Non-terminal ReviewBatch cannot have completedAt." });
  }
  if ((batch.status === "submitted" || batch.status === "running" || terminal) && batch.submittedAt === undefined && batch.status !== "failed") {
    context.addIssue({ code: "custom", path: ["submittedAt"], message: "Submitted ReviewBatch requires submittedAt." });
  }
  if (terminal && batch.commentIds.some((commentId) => batch.outcomes[commentId] === undefined)) {
    context.addIssue({ code: "custom", path: ["outcomes"], message: "Terminal ReviewBatch requires one outcome for every comment." });
  }
});
export type ReviewBatch = z.infer<typeof reviewBatchSchema>;

export const activeReviewBatchSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  commentIds: z.array(z.string().min(1)).min(1),
  status: z.enum(["draft", "submitted", "running"]),
}).strict();
export type ActiveReviewBatch = z.infer<typeof activeReviewBatchSchema>;

export const reviewBatchTimelineKind = "review-deck-batch";
export const reviewBatchTimelineVersion = 1;

export const reviewBatchTimelineSchema = z.object({
  workspaceId: z.string().min(1),
  commentCount: z.number().int().positive(),
  status: z.enum(["submitted", "running", "completed", "partial", "failed"]),
  completedCount: z.number().int().nonnegative(),
  staleCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  unresolvedCount: z.number().int().nonnegative(),
  submittedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
}).strict();
export type ReviewBatchTimelineData = z.infer<typeof reviewBatchTimelineSchema>;

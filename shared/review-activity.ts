import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  aiReviewDepthSchema,
  aiReviewResultSourceSchema,
  aiReviewUsageSchema,
} from "./review";

/** Metadata-only status for a workspace's Review Deck entry points. */
export const reviewWorkspaceIndicatorsSchema = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  projectPendingCommentCount: z.number().int().nonnegative(),
  projectStaleCommentCount: z.number().int().nonnegative(),
  workspacePendingCommentCount: z.number().int().nonnegative(),
  workspaceStaleCommentCount: z.number().int().nonnegative(),
  activeBatchCount: z.number().int().nonnegative(),
  runningAiReviewCount: z.number().int().nonnegative(),
  unreadAiFindingCount: z.number().int().nonnegative(),
}).strict();
export type ReviewWorkspaceIndicators = z.infer<typeof reviewWorkspaceIndicatorsSchema>;

export const getWorkspaceReviewIndicators = defineRpc({
  name: "review-deck.workspace-review-indicators",
  input: z.object({ workspaceId: z.string().min(1) }).strict(),
  output: reviewWorkspaceIndicatorsSchema,
});

/** Detailed popover summary. Git hunks are resolved only when the user opens it. */
export const workspaceReviewSummarySchema = reviewWorkspaceIndicatorsSchema.extend({
  reviewedBlockCount: z.number().int().nonnegative(),
  totalBlockCount: z.number().int().nonnegative(),
}).strict();
export type WorkspaceReviewSummary = z.infer<typeof workspaceReviewSummarySchema>;

export const getWorkspaceReviewSummary = defineRpc({
  name: "review-deck.workspace-review-summary",
  input: z.object({ workspaceId: z.string().min(1) }).strict(),
  output: workspaceReviewSummarySchema,
});

/** Opening the bound Review Deck marks its completed AI findings as read. */
export const markWorkspaceReviewResultsRead = defineRpc({
  name: "review-deck.mark-workspace-review-results-read",
  input: z.object({ workspaceId: z.string().min(1) }).strict(),
  output: z.object({ markedRunCount: z.number().int().nonnegative() }).strict(),
});

export const reviewAiTimelineKind = "review-deck-ai-review";
export const reviewAiTimelineVersion = 1;
export const reviewAiTimelineSchema = z.object({
  workspaceId: z.string().min(1),
  mode: z.enum(["file", "target"]),
  status: z.enum(["completed", "failed"]),
  findingCount: z.number().int().nonnegative(),
  highRiskFindingCount: z.number().int().nonnegative(),
  resultSource: aiReviewResultSourceSchema,
  depth: aiReviewDepthSchema.optional(),
  usage: aiReviewUsageSchema.optional(),
  completedAt: z.iso.datetime(),
}).strict().superRefine((item, context) => {
  if (item.highRiskFindingCount > item.findingCount) {
    context.addIssue({ code: "custom", path: ["highRiskFindingCount"], message: "High-risk findings cannot exceed the total findings." });
  }
});
export type ReviewAiTimelineData = z.infer<typeof reviewAiTimelineSchema>;

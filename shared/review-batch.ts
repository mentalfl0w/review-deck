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

/** Message transport state is orthogonal to the ReviewBatch work lifecycle. */
export const reviewBatchDeliveryPhaseSchema = z.enum([
  "prepared",
  "sending",
  "accepted",
  "unknown",
  "rejected",
]);
export type ReviewBatchDeliveryPhase = z.infer<typeof reviewBatchDeliveryPhaseSchema>;

export const reviewBatchDeliverySchema = z.object({
  messageId: z.string().min(1),
  phase: reviewBatchDeliveryPhaseSchema,
  attempts: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
  lastErrorCode: z.string().min(1).optional(),
}).strict();
export type ReviewBatchDelivery = z.infer<typeof reviewBatchDeliverySchema>;

/**
 * Review scope as the batch store sees it. Duplicated here instead of imported
 * from `shared/review` on purpose: `shared/review` imports this module, and a
 * cycle would leave one side initialized before its schema exists.
 */
export const reviewBatchScopeSchema = z.enum(["working", "staged", "branch", "commits"]);
export type ReviewBatchScope = z.infer<typeof reviewBatchScopeSchema>;

/** Strict pre-delivery shape used only to validate version-1 Store records. */
export const reviewBatchV1PayloadSchema = z.object({
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
}).strict();

/**
 * What one dispatched comment was resolved to — ownership, anchor, and the
 * hunk's own changed-line identity — captured at the final preflight.
 *
 * `hunkChangeId` is deliberately NOT `hunkFingerprint`: the fingerprint mixes
 * the target fingerprint and the ordinal in, so an unrelated edit elsewhere in
 * the target changes it, while the hunk's own +/- lines stay byte-identical.
 * Human acceptance requires the CURRENT hunk's `changedLinesId` to differ from
 * this baseline, so only a real change to the commented block can clear it.
 */
export const reviewBatchBaselineSchema = z.object({
  commentId: z.string().min(1),
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  scope: reviewBatchScopeSchema,
  baseRef: z.string().min(1).optional(),
  headRef: z.string().min(1).optional(),
  filePath: z.string().min(1),
  /** Rename alias of the dispatched file, when Git reported one. */
  oldPath: z.string().min(1).optional(),
  targetFingerprint: z.string().min(1),
  hunkId: z.string().min(1),
  hunkFingerprint: z.string().min(1),
  hunkChangeId: z.string().min(1),
  /**
   * Path-independent identity of the same changed lines. Acceptance compares
   * THIS value: a pure rename changes `hunkChangeId` without changing a single
   * reviewed line, and that must not count as "the block was edited".
   */
  changedLinesId: z.string().min(1),
  oldStart: z.number().int().nonnegative(),
  oldCount: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newCount: z.number().int().nonnegative(),
}).strict();
export type ReviewBatchBaseline = z.infer<typeof reviewBatchBaselineSchema>;

/**
 * The durable record of ONE human decision: a reviewer looked at the current
 * change block and accepted the Agent's COMPLETED report. Only this record
 * authorizes deleting the exact original comment id, and it is written before
 * the deletion so an interrupted cleanup is retried, never re-invented.
 */
export const reviewCommentAcceptanceSchema = z.object({
  commentId: z.string().min(1),
  acceptedAt: z.iso.datetime(),
  /** The target the reviewer was looking at when they accepted. */
  targetFingerprint: z.string().min(1),
  filePath: z.string().min(1),
  hunkId: z.string().min(1),
  hunkFingerprint: z.string().min(1),
  /** The current hunk's path-scoped change id. */
  hunkChangeId: z.string().min(1),
  /** The current changed-line identity, independent of target and path. */
  changedLinesId: z.string().min(1),
  /** The dispatch-time change id it was proven different from. */
  baselineHunkChangeId: z.string().min(1),
}).strict();
export type ReviewCommentAcceptance = z.infer<typeof reviewCommentAcceptanceSchema>;

const reviewBatchFieldsSchema = reviewBatchV1PayloadSchema.extend({
  delivery: reviewBatchDeliverySchema.optional(),
}).strict();

/** The version-2 shape: fields and delivery, without baselines/acceptances. */
export const reviewBatchV2Schema = reviewBatchFieldsSchema.superRefine((batch, context) => {
  refineReviewBatchLifecycle(batch, context);
});
export type ReviewBatchV2 = z.infer<typeof reviewBatchV2Schema>;

/** Version 3 adds the dispatch-time baselines and human acceptances. */
const reviewBatchV3FieldsSchema = reviewBatchFieldsSchema.extend({
  baselines: z.record(z.string().min(1), reviewBatchBaselineSchema).optional(),
  acceptances: z.record(z.string().min(1), reviewCommentAcceptanceSchema).optional(),
}).strict();

export const reviewBatchSchema = reviewBatchV3FieldsSchema.superRefine((batch, context) => {
  refineReviewBatchLifecycle(batch, context);
  const commentIds = new Set(batch.commentIds);
  for (const [key, baseline] of Object.entries(batch.baselines ?? {})) {
    if (!commentIds.has(key) || baseline.commentId !== key) {
      context.addIssue({ code: "custom", path: ["baselines", key], message: "Baseline id is not part of this ReviewBatch." });
    }
    if (baseline.projectId !== batch.projectId || baseline.workspaceId !== batch.workspaceId) {
      context.addIssue({ code: "custom", path: ["baselines", key], message: "Baseline ownership must match its ReviewBatch." });
    }
  }
  for (const [key, acceptance] of Object.entries(batch.acceptances ?? {})) {
    if (!commentIds.has(key) || acceptance.commentId !== key) {
      context.addIssue({ code: "custom", path: ["acceptances", key], message: "Acceptance id is not part of this ReviewBatch." });
    }
    if (batch.outcomes[key] !== "completed") {
      context.addIssue({
        code: "custom",
        path: ["acceptances", key],
        message: "A comment can be accepted only after the Agent reported it COMPLETED.",
      });
    }
    const baseline = batch.baselines?.[key];
    if (!baseline) {
      context.addIssue({
        code: "custom",
        path: ["acceptances", key],
        message: "A comment cannot be accepted without a dispatch-time baseline.",
      });
    } else if (
      acceptance.baselineHunkChangeId !== baseline.hunkChangeId ||
      acceptance.changedLinesId === baseline.changedLinesId
    ) {
      context.addIssue({
        code: "custom",
        path: ["acceptances", key],
        message: "A human acceptance must prove the hunk's changed lines differ from its baseline.",
      });
    }
  }
});
export type ReviewBatch = z.infer<typeof reviewBatchSchema>;

/** The lifecycle rules every stored batch version shares. */
function refineReviewBatchLifecycle(
  batch: {
    commentIds: string[];
    outcomes: Record<string, ReviewCommentOutcome>;
    status: ReviewBatchStatus;
    completedAt?: string | undefined;
    submittedAt?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
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
}

export const activeReviewBatchSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  commentIds: z.array(z.string().min(1)).min(1),
  status: z.enum(["draft", "submitted", "running"]),
  delivery: reviewBatchDeliverySchema.optional(),
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

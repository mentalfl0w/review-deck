import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const reviewScopeSchema = z.enum(["working", "staged", "branch", "commits"]);
export type ReviewScope = z.infer<typeof reviewScopeSchema>;

export const reviewLocaleSchema = z.enum(["zh", "en"]);
export type ReviewLocale = z.infer<typeof reviewLocaleSchema>;

export const reviewRequestSchema = z.object({
  cwd: z.string().min(1),
  scope: reviewScopeSchema.default("working"),
  locale: reviewLocaleSchema.optional(),
  baseRef: z.string().trim().min(1).optional(),
  headRef: z.string().trim().min(1).optional(),
  filePath: z.string().trim().min(1).optional(),
});
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

export const severitySchema = z.enum(["critical", "high", "medium", "low", "informational"]);
export const evidenceKindSchema = z.enum([
  "verified_fact",
  "ai_inference",
  "human_verification_recommended",
]);

export const reviewFindingSchema = z.object({
  id: z.string(),
  category: z.string(),
  severity: severitySchema,
  evidenceKind: evidenceKindSchema,
  summary: z.string(),
  detail: z.string(),
  suggestedCheck: z.string().optional(),
});

export const reviewHunkSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  filePath: z.string(),
  oldStart: z.number().int().nonnegative(),
  oldCount: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newCount: z.number().int().nonnegative(),
  header: z.string(),
  patch: z.string(),
  lines: z.array(z.string()),
  findings: z.array(reviewFindingSchema),
  functionHint: z.string().optional(),
  language: z.string().optional(),
});

export const reviewFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(reviewHunkSchema),
  language: z.string().optional(),
});

export const reviewSnapshotSchema = z.object({
  repositoryPath: z.string(),
  worktreePath: z.string(),
  scope: reviewScopeSchema,
  baseRef: z.string().nullable(),
  headRef: z.string().nullable(),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  targetFingerprint: z.string(),
  files: z.array(reviewFileSchema),
  totalHunks: z.number().int().nonnegative(),
  priorityHunks: z.number().int().nonnegative(),
  generatedAt: z.string(),
});
export type ReviewSnapshot = z.infer<typeof reviewSnapshotSchema>;

export const getSnapshot = defineRpc({
  name: "review-deck.snapshot",
  input: reviewRequestSchema,
  output: reviewSnapshotSchema,
});
export const reviewSectionsSchema = z.object({
  verifiedFacts: z.array(z.string()),
  aiInference: z.array(z.string()),
  humanVerificationRecommended: z.array(z.string()),
});
export type ReviewSections = z.infer<typeof reviewSectionsSchema>;

export const explainHunkResultSchema = z.object({
  hunkId: z.string(),
  verifiedFacts: z.array(z.string()),
  aiInference: z.array(z.string()),
  humanVerificationRecommended: z.array(z.string()),
});
export type ExplainHunkResult = z.infer<typeof explainHunkResultSchema>;

export const explainHunk = defineRpc({
  name: "review-deck.explain-hunk",
  input: reviewRequestSchema.extend({ hunkId: z.string().min(1) }),
  output: explainHunkResultSchema,
});
export const explainHunkAiResultSchema = explainHunkResultSchema.extend({
  status: z.enum(["idle", "error", "permission", "timeout"]),
  provider: z.string(),
  model: z.string(),
});
export type ExplainHunkAiResult = z.infer<typeof explainHunkAiResultSchema>;

// Async read-only AI review: the plugin host RPC layer times out long reviews,
// so the read-only flows (AI评审变更块 / AI评审文件) start a transient child
// agent with a start RPC and the client polls for the result.
export const aiReviewStatusSchema = z.enum(["running", "idle", "error", "permission", "timeout"]);
export type AiReviewStatus = z.infer<typeof aiReviewStatusSchema>;

export const pollAiReviewResultSchema = z.object({
  status: aiReviewStatusSchema,
  review: z.string(),
  sections: reviewSectionsSchema,
  provider: z.string(),
  model: z.string(),
});
export type PollAiReviewResult = z.infer<typeof pollAiReviewResultSchema>;

// The async read-only review RPCs carry an explicit workspace binding: the
// reviewed cwd is derived from the workspace id (the server revalidates the
// claimed workspace's directory and the parent agent's workspace/cwd before
// any child is created), and pollAiReview repeats the start-time
// workspace/agent binding so a request id alone never resolves a review.
export const startExplainHunkAi = defineRpc({
  name: "review-deck.start-explain-hunk-ai",
  input: reviewRequestSchema.extend({
    hunkId: z.string().min(1),
    agentId: z.string().min(1),
    workspaceId: z.string().min(1),
  }),
  output: z.object({ requestId: z.string().min(1) }),
});
export const startRunReview = defineRpc({
  name: "review-deck.start-run-review",
  input: reviewRequestSchema.extend({ agentId: z.string().min(1), workspaceId: z.string().min(1) }),
  output: z.object({ requestId: z.string().min(1) }),
});
// The requestId is a per-request capability (never the transient child's
// globally discoverable agent id); workspaceId and agentId must match the
// binding recorded at start time or the poll is refused.
export const pollAiReview = defineRpc({
  name: "review-deck.poll-ai-review",
  input: z.object({
    requestId: z.string().min(1),
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
  }),
  output: pollAiReviewResultSchema,
});
export const explainFile = defineRpc({
  name: "review-deck.explain-file",
  input: reviewRequestSchema.extend({ filePath: z.string().min(1) }),
  output: explainHunkResultSchema,
});
export const hunkDecision = defineRpc({
  name: "review-deck.hunk-decision",
  input: z.object({
    projectId: z.string().min(1),
    cwd: z.string().min(1),
    targetFingerprint: z.string().min(1),
    hunkId: z.string().min(1),
    hunkFingerprint: z.string().min(1),
    filePath: z.string().min(1),
    hunkHeader: z.string().min(1),
    hunkPatch: z.string().min(1),
    decision: z.enum(["reviewed", "commented"]),
    scope: reviewScopeSchema,
    projectName: z.string().trim().min(1).optional(),
    projectRootPath: z.string().trim().min(1).optional(),
    workspaceId: z.string().trim().min(1).optional(),
    baseRef: z.string().trim().min(1).optional(),
    headRef: z.string().trim().min(1).optional(),
    comment: z.string().trim().max(8000).optional(),
  }),
  output: z.object({ savedAt: z.string() }),
});
export const clearHunkState = defineRpc({
  name: "review-deck.clear-hunk-state",
  input: z.object({
    targetFingerprint: z.string().min(1),
    hunkId: z.string().min(1),
  }),
  output: z.object({ cleared: z.boolean() }),
});

export const clearReviewState = defineRpc({
  name: "review-deck.clear-review-state",
  input: z.object({ targetFingerprint: z.string().min(1) }),
  output: z.object({ cleared: z.boolean() }),
});

export const listReviewStates = defineRpc({
  name: "review-deck.list-review-states",
  input: z.object({}),
  output: z.object({
    reviews: z.array(
      z.object({
        targetFingerprint: z.string(),
        cwd: z.string().optional(),
        scope: reviewScopeSchema.optional(),
        decisionCount: z.number().int().nonnegative(),
        commentCount: z.number().int().nonnegative(),
        lastSavedAt: z.string(),
      }),
    ),
  }),
});

export const clearAllReviewStates = defineRpc({
  name: "review-deck.clear-all-review-states",
  input: z.object({}),
  output: z.object({ cleared: z.number().int().nonnegative() }),
});

export const rejectHunk = defineRpc({
  name: "review-deck.reject-hunk",
  input: reviewRequestSchema.extend({
    expectedTargetFingerprint: z.string().min(1),
    hunkId: z.string().min(1),
    expectedHunkFingerprint: z.string().min(1),
  }),
  output: z.object({ targetFingerprint: z.string(), removedHunkId: z.string() }),
});
export const revertFile = defineRpc({
  name: "review-deck.revert-file",
  input: reviewRequestSchema.extend({
    filePath: z.string().min(1),
    expectedTargetFingerprint: z.string().min(1),
    skipPatches: z.array(z.string()).default([]),
  }),
  output: z.object({ reverted: z.number().int(), skipped: z.number().int(), failed: z.number().int() }),
});

export const reviewStateCurrentHunkSchema = z.object({
  hunkId: z.string().min(1),
  filePath: z.string().min(1),
  hunkHeader: z.string().min(1),
  hunkPatch: z.string().min(1),
});
export type ReviewStateCurrentHunk = z.infer<typeof reviewStateCurrentHunkSchema>;

export const getReviewState = defineRpc({
  name: "review-deck.state",
  input: z.object({
    targetFingerprint: z.string().min(1),
    currentHunks: z.array(reviewStateCurrentHunkSchema).optional(),
  }),
  output: z.object({
    decisions: z.array(
      z.object({
        hunkId: z.string(),
        decision: z.enum(["reviewed", "commented"]),
        comment: z.string().optional(),
        savedAt: z.string(),
      }),
    ),
  }),
});
export const fileViewRowSchema = z.object({
  kind: z.enum(["context", "add", "del"]),
  text: z.string(),
  hunkId: z.string().nullable(),
  oldLine: z.number().int().nullable(),
  newLine: z.number().int().nullable(),
});
export type FileViewRow = z.infer<typeof fileViewRowSchema>;

export const getFileView = defineRpc({
  name: "review-deck.file-view",
  input: reviewRequestSchema.extend({
    filePath: z.string().min(1),
    targetFingerprint: z.string().min(1),
    hunks: z.array(reviewStateCurrentHunkSchema),
  }),
  output: z.object({ binary: z.boolean(), truncated: z.boolean(), rows: z.array(fileViewRowSchema) }),
});
export const projectReviewCommentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string().optional(),
  projectRootPath: z.string().optional(),
  workspaceId: z.string().optional(),
  targetFingerprint: z.string(),
  hunkId: z.string(),
  hunkFingerprint: z.string(),
  filePath: z.string(),
  hunkHeader: z.string(),
  hunkPatch: z.string(),
  cwd: z.string(),
  scope: reviewScopeSchema,
  baseRef: z.string().optional(),
  headRef: z.string().optional(),
  comment: z.string(),
  savedAt: z.string(),
});
export type ProjectReviewComment = z.infer<typeof projectReviewCommentSchema>;

export const projectReviewSummarySchema = z.object({
  projectId: z.string(),
  projectName: z.string().optional(),
  projectRootPath: z.string().optional(),
  commentCount: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  targetCount: z.number().int().nonnegative(),
  comments: z.array(projectReviewCommentSchema),
});
export type ProjectReviewSummary = z.infer<typeof projectReviewSummarySchema>;

export const listProjectReviewComments = defineRpc({
  name: "review-deck.list-project-review-comments",
  input: z.object({ projectId: z.string().min(1) }),
  output: z.object({ project: projectReviewSummarySchema.nullable() }),
});

// processProjectReview hands every comment to the selected agent's workflow
// (fire-and-forget; results appear in the agent's conversation) and removes the
// comments from Review Deck — the result is a submission confirmation only.
export const processProjectReviewResultSchema = z.object({
  projectId: z.string(),
  workspaceId: z.string(),
  workspaceCwd: z.string(),
  processedCommentIds: z.array(z.string()),
  commentCount: z.number().int().nonnegative(),
  submittedAt: z.string(),
});
export type ProcessProjectReviewResult = z.infer<typeof processProjectReviewResultSchema>;

export const processProjectReview = defineRpc({
  name: "review-deck.process-project-review",
  input: z.object({
    projectId: z.string().min(1),
    agentId: z.string().min(1),
    workspaceId: z.string().min(1),
    workspaceCwd: z.string().min(1),
  }),
  output: processProjectReviewResultSchema,
});

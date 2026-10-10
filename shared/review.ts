import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { activeReviewBatchSchema, reviewBatchSchema } from "./review-batch";

export const reviewScopeSchema = z.enum(["working", "staged", "branch", "commits"]);
export type ReviewScope = z.infer<typeof reviewScopeSchema>;

export const fileReviewAnchorSchema = z.object({
  kind: z.literal("file"),
  filePath: z.string().min(1),
}).strict();
export type FileReviewAnchor = z.infer<typeof fileReviewAnchorSchema>;

export const hunkReviewAnchorSchema = z.object({
  kind: z.literal("hunk"),
  filePath: z.string().min(1),
  hunkId: z.string().min(1),
  hunkFingerprint: z.string().min(1),
  contentId: z.string().min(1),
}).strict();
export type HunkReviewAnchor = z.infer<typeof hunkReviewAnchorSchema>;

export const lineRangeReviewAnchorSchema = z.object({
  kind: z.literal("range"),
  filePath: z.string().min(1),
  side: z.enum(["old", "new"]),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  hunkId: z.string().min(1),
  hunkFingerprint: z.string().min(1),
  contentId: z.string().min(1),
  selectedTextHash: z.string().min(1),
  selectedTextPreview: z.string().optional(),
  contextBeforeHash: z.string().min(1),
  contextAfterHash: z.string().min(1),
}).strict();
export type LineRangeReviewAnchor = z.infer<typeof lineRangeReviewAnchorSchema>;

export const reviewAnchorSchema = z.discriminatedUnion("kind", [
  fileReviewAnchorSchema,
  hunkReviewAnchorSchema,
  lineRangeReviewAnchorSchema,
]);
export type ReviewAnchor = z.infer<typeof reviewAnchorSchema>;
export const anchorStateSchema = z.enum(["exact", "relocated", "ambiguous", "stale"]);
export type AnchorState = z.infer<typeof anchorStateSchema>;

export const lineRangeSelectionSchema = z.object({
  side: z.enum(["old", "new"]),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).strict().refine((range) => range.startLine <= range.endLine, {
  message: "endLine must be greater than or equal to startLine",
});
export type LineRangeSelection = z.infer<typeof lineRangeSelectionSchema>;

export const reviewAnchorCandidateSchema = z.union([
  hunkReviewAnchorSchema,
  lineRangeReviewAnchorSchema,
]);

export const reviewAnchorIssueSchema = z.object({
  id: z.string().min(1),
  sourceTargetFingerprint: z.string().min(1),
  sourceHunkId: z.string().min(1),
  filePath: z.string().min(1),
  anchor: reviewAnchorSchema,
  anchorState: z.enum(["ambiguous", "stale"]),
  candidates: z.array(reviewAnchorCandidateSchema),
  matchCount: z.number().int().nonnegative(),
  comment: z.string().min(1),
  savedAt: z.string().min(1),
}).strict();
export type ReviewAnchorIssue = z.infer<typeof reviewAnchorIssueSchema>;

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

export const aiReviewModeSchema = z.enum(["hunk", "file", "target"]);
export type AiReviewMode = z.infer<typeof aiReviewModeSchema>;
export const aiReviewDepthSchema = z.enum(["targeted", "full"]);
export type AiReviewDepth = z.infer<typeof aiReviewDepthSchema>;
export const aiReviewBudgetPresetSchema = z.enum(["economical", "balanced", "deep"]);
export type AiReviewBudgetPreset = z.infer<typeof aiReviewBudgetPresetSchema>;
export const aiReviewPermissionModeSchema = z.enum(["read-only", "ask"]);
export type AiReviewPermissionMode = z.infer<typeof aiReviewPermissionModeSchema>;
export const aiReviewPresetDefaultDepth: Record<AiReviewBudgetPreset, AiReviewDepth> = {
  economical: "targeted",
  balanced: "targeted",
  deep: "full",
};
export const aiReviewResultSourceSchema = z.enum(["cached", "fresh"]);
export type AiReviewResultSource = z.infer<typeof aiReviewResultSourceSchema>;
export const aiReviewUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  cachedTokens: z.number().nonnegative().optional(),
  contextTokens: z.number().nonnegative().optional(),
}).strict();
export type AiReviewUsage = z.infer<typeof aiReviewUsageSchema>;

export const severitySchema = z.enum(["critical", "high", "medium", "low", "informational"]);
export const evidenceKindSchema = z.enum([
  "verified_fact",
  "ai_inference",
  "human_verification_recommended",
]);

/** Maximum argv entries one verification command may carry. */
export const VERIFICATION_COMMAND_MAX_ARGS = 64;
/** Maximum characters of one verification argv entry (the executable included). */
export const VERIFICATION_COMMAND_MAX_LENGTH = 512;
/** Maximum characters of one verification suggestion caption. */
export const VERIFICATION_SUGGESTION_LABEL_MAX_LENGTH = 512;

/**
 * Shells, shell builtins, code evaluators, and launchers would turn argv back
 * into source or bypass the direct-program contract. The list covers the
 * POSIX shells and their builtins, the Windows command hosts, and the
 * PowerShell aliases/cmdlets that evaluate or launch their input. The UI still
 * previews every accepted executable and requires explicit confirmation.
 */
const VERIFICATION_UNSAFE_EXECUTABLES: Record<string, true> = {
  // POSIX shells: they re-parse their arguments as source.
  sh: true, bash: true, dash: true, zsh: true, ksh: true, ksh93: true, mksh: true,
  csh: true, tcsh: true, fish: true, ash: true, busybox: true,
  // Windows command hosts and PowerShell hosts.
  cmd: true, "cmd.exe": true, powershell: true, "powershell.exe": true, pwsh: true,
  "pwsh.exe": true,
  // Launchers: they run another program, or escalate privileges.
  env: true, xargs: true, sudo: true, doas: true, su: true, wsl: true, "wsl.exe": true,
  // POSIX shell builtins and evaluators: not direct programs, and several
  // evaluate their arguments as code (`eval`, `.`, `source`, `trap`, `let`).
  ".": true, ":": true, "[": true, "[[": true, "]]": true, eval: true, exec: true,
  source: true, command: true, builtin: true, trap: true, alias: true, unalias: true,
  declare: true, typeset: true, local: true, export: true, readonly: true, set: true,
  unset: true, shift: true, getopts: true, read: true, cd: true, pwd: true, pushd: true,
  popd: true, dirs: true, hash: true, type: true, umask: true, ulimit: true, wait: true,
  jobs: true, fg: true, bg: true, disown: true, return: true, break: true, continue: true,
  exit: true, fc: true, let: true, echo: true, printf: true, test: true, true: true,
  false: true, kill: true, sleep: true, times: true,
  // PowerShell aliases, cmdlets, and launch helpers that evaluate or start
  // arbitrary input.
  iex: true, icm: true, irm: true, iwr: true, "invoke-expression": true,
  "invoke-command": true, "invoke-restmethod": true, "invoke-webrequest": true,
  "start-process": true, "start-job": true, "start-threadjob": true, "add-type": true,
  start: true, saps: true, sajb: true,
  curl: true, wget: true,
};
const VERIFICATION_BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const VERIFICATION_BIDI_CONTROLS_GLOBAL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * Why a candidate verification command cannot be run, or null when it can.
 *
 * The rules exist so a command is always an exact executable plus argv and can
 * never smuggle a shell string: the executable is one program name or path (no
 * whitespace, no shell metacharacters `; | & < > $ \``, no glob or grouping
 * characters `( ) { } [ ] ! * ?`, no terminal controls, and not a shell launcher.
 * Each argument must be a plain string without terminal controls or bidi
 * formatting characters that could spoof the preview. Shell-looking punctuation
 * in an argument is safe because each token is quoted before it is typed into
 * the interactive shell; the executable itself cannot contain shell syntax.
 */
export function verificationCommandProblem(command: {
  executable: string;
  args: readonly string[];
}): string | null {
  const executable = command.executable.trim();
  if (executable.length === 0) {
    return "A verification command needs a non-empty executable.";
  }
  if (executable.length > VERIFICATION_COMMAND_MAX_LENGTH) {
    return `The verification executable must be at most ${VERIFICATION_COMMAND_MAX_LENGTH} characters.`;
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(executable)) {
    return "The verification executable must not contain control characters.";
  }
  if (VERIFICATION_BIDI_CONTROLS.test(executable)) {
    return "The verification executable must not contain bidirectional formatting characters.";
  }
  if (/\s/.test(executable)) {
    return "The verification executable must be a single program name or path, never a command line.";
  }
  if (/[;&|<>`$(){}\[\]!*?]/.test(executable)) {
    return "The verification executable must not contain shell metacharacters; name the program alone.";
  }
  const launcher = executable.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (VERIFICATION_UNSAFE_EXECUTABLES[launcher] === true) {
    return `The verification executable is a shell builtin, interpreter, or launcher (${launcher}); name a direct program instead.`;
  }
  if (command.args.length > VERIFICATION_COMMAND_MAX_ARGS) {
    return `A verification command may carry at most ${VERIFICATION_COMMAND_MAX_ARGS} arguments.`;
  }
  for (const arg of command.args) {
    if (arg.length > VERIFICATION_COMMAND_MAX_LENGTH) {
      return `A verification argument must be at most ${VERIFICATION_COMMAND_MAX_LENGTH} characters.`;
    }
    // Interactive terminal line editors consume control characters before the
    // shell receives them; reject all C0/C1 controls, including tabs.
    if (/[\u0000-\u001f\u007f-\u009f]/.test(arg)) {
      return "A verification argument must not contain terminal control characters.";
    }
    if (VERIFICATION_BIDI_CONTROLS.test(arg)) {
      return "A verification argument must not contain bidirectional formatting characters.";
    }
  }
  return null;
}

/** Display-only canonical form of a verification command, used by the exact
 * command preview the user confirms. It is never handed to a shell: arguments
 * that need quoting are shown JSON-quoted so the preview cannot be misread as
 * a shell line. */
export function formatVerificationCommand(command: {
  executable: string;
  args: readonly string[];
}): string {
  const displayArgument = (value: string) => {
    if (/^[A-Za-z0-9._/:@%+,=-]+$/.test(value)) return value;
    // JSON-quote syntax-sensitive ASCII, and escape every non-ASCII code point
    // so visually confusable executable/argv characters are explicit in the
    // confirmation UI (e.g. Cyrillic `о` becomes `\u{43E}`).
    return JSON.stringify(value).replace(/[^\x20-\x7e]/gu, (character) =>
      `\\u{${character.codePointAt(0)?.toString(16).toUpperCase()}}`,
    );
  };
  return [command.executable.trim(), ...command.args].map(displayArgument).join(" ");
}

/**
 * Structured verification command: an executable plus argv, never a free-form
 * shell string. Optional everywhere it appears (a finding without a safe exact
 * command simply carries none) and strict about its shape, so provider output
 * and user input share one contract.
 */
export const verificationCommandSchema = z
  .object({
    executable: z.string().trim().min(1).max(VERIFICATION_COMMAND_MAX_LENGTH),
    args: z.array(z.string().max(VERIFICATION_COMMAND_MAX_LENGTH)).max(VERIFICATION_COMMAND_MAX_ARGS),
  })
  .strict()
  .superRefine((command, context) => {
    const problem = verificationCommandProblem(command);
    if (problem) context.addIssue({ code: "custom", path: ["executable"], message: problem });
  });
export type VerificationCommand = z.infer<typeof verificationCommandSchema>;

export const reviewFindingSchema = z.object({
  id: z.string(),
  category: z.string(),
  severity: severitySchema,
  evidenceKind: evidenceKindSchema,
  summary: z.string(),
  detail: z.string(),
  suggestedCheck: z.string().optional(),
});
export const structuredReviewFindingSchema = z.object({
  hunkId: z.string().min(1).optional(),
  filePath: z.string().min(1),
  severity: severitySchema,
  evidenceKind: evidenceKindSchema,
  category: z.string().min(1),
  summary: z.string().min(1),
  detail: z.string().min(1),
  suggestedCheck: z.string().min(1).optional(),
  /** Exact executable + argv the user may confirm to verify this finding; the
   * model must omit it rather than guess, and Review Deck never runs it on its
   * own. */
  verificationCommand: verificationCommandSchema.optional(),
}).strict();
export type StructuredReviewFinding = z.infer<typeof structuredReviewFindingSchema>;

export const structuredReviewResultSchema = z.object({
  findings: z.array(structuredReviewFindingSchema),
  summary: z.string().optional(),
}).strict();
export type StructuredReviewResult = z.infer<typeof structuredReviewResultSchema>;

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
// The cheap sibling of review-deck.snapshot: the same request, but only the
// Git target fingerprint (never a parsed hunk). The client's watcher probes
// this while the user works and requests a full snapshot only when the
// returned fingerprint differs from the one on screen.
export const getTargetFingerprint = defineRpc({
  name: "review-deck.target-fingerprint",
  input: reviewRequestSchema,
  output: z.object({ targetFingerprint: z.string() }),
});
/**
 * One verification command as the UI receives it: the validated command, its
 * exact display preview, and enough context to caption it. `evidenceKind` names
 * the section the suggestion belongs to, `label` is that section entry's first
 * line for a structured finding (or the entry's own caption for the Markdown
 * fallback), and `id` is a stable identity for associating the result with its finding.
 */
export const verificationSuggestionEvidenceKindSchema = z.enum([
  "ai_inference",
  "human_verification_recommended",
]);
export type VerificationSuggestionEvidenceKind = z.infer<typeof verificationSuggestionEvidenceKindSchema>;

/**
 * One verification command as the UI receives it: the validated command, its
 * exact display preview, and enough context to caption it. `evidenceKind` names
 * the section the suggestion belongs to, `label` is that section entry's first
 * line, and `id` is a stable identity for associating the result with its finding.
 */
export const reviewVerificationSuggestionSchema = z.object({
  id: z.string().min(1),
  evidenceKind: verificationSuggestionEvidenceKindSchema,
  label: z.string().min(1).max(VERIFICATION_SUGGESTION_LABEL_MAX_LENGTH),
  hunkId: z.string().min(1).optional(),
  filePath: z.string().min(1).optional(),
  command: verificationCommandSchema,
  commandPreview: z.string().min(1),
}).strict();
export type ReviewVerificationSuggestion = z.infer<typeof reviewVerificationSuggestionSchema>;

export const reviewSectionsSchema = z.object({
  summary: z.string().optional(),
  verifiedFacts: z.array(z.string()),
  aiInference: z.array(z.string()),
  humanVerificationRecommended: z.array(z.string()),
  /** Verification commands the user may confirm and run. Never executed by
   * Review Deck on its own. A run types the confirmed command into an
   * interactive workspace terminal and never infers its success. */
  verificationCommands: z.array(reviewVerificationSuggestionSchema).optional(),
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
  summary: z.string().optional(),
  provider: z.string(),
  model: z.string(),
  thinkingOptionId: z.string().nullable().optional(),
  reviewerPermissionMode: aiReviewPermissionModeSchema.optional(),
  resultSource: aiReviewResultSourceSchema.optional(),
  mode: z.literal("hunk").optional(),
  reviewPreset: aiReviewBudgetPresetSchema.optional(),
  usage: aiReviewUsageSchema.optional(),
});
export type ExplainHunkAiResult = z.infer<typeof explainHunkAiResultSchema>;

// Async AI review RPCs use a transient child agent, then poll its result.
// The server validates workspace binding and a native Read-only/Plan or
// approval-gated Ask provider mode before creating the child.
export const aiReviewStatusSchema = z.enum(["running", "idle", "error", "permission", "timeout"]);
export type AiReviewStatus = z.infer<typeof aiReviewStatusSchema>;

export const pollAiReviewResultSchema = z.object({
  status: aiReviewStatusSchema,
  review: z.string(),
  sections: reviewSectionsSchema,
  provider: z.string(),
  model: z.string(),
  thinkingOptionId: z.string().nullable().optional(),
  reviewerPermissionMode: aiReviewPermissionModeSchema.optional(),
  resultSource: aiReviewResultSourceSchema.optional(),
  mode: aiReviewModeSchema.optional(),
  depth: aiReviewDepthSchema.optional(),
  reviewPreset: aiReviewBudgetPresetSchema.optional(),
  usage: aiReviewUsageSchema.optional(),
});
export type PollAiReviewResult = z.infer<typeof pollAiReviewResultSchema>;

// The async AI review RPCs carry an explicit workspace binding: the reviewed
// cwd is derived from the workspace id (the server revalidates the claimed
// directory and parent agent binding before any child is created), and poll
// repeats the start-time workspace/agent binding so a request id alone never resolves a review.
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
  input: reviewRequestSchema.extend({
    reviewMode: z.enum(["file", "target"]),
    reviewDepthOverride: aiReviewDepthSchema.optional(),
    agentId: z.string().min(1),
    workspaceId: z.string().min(1),
  }),
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
export const clearAiReviewCache = defineRpc({
  name: "review-deck.clear-ai-review-cache",
  input: z.object({}),
  output: z.object({ cleared: z.boolean() }),
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
    lineRange: lineRangeSelectionSchema.optional(),
    supersedes: z.object({
      targetFingerprint: z.string().min(1),
      entryId: z.string().min(1),
    }).strict().optional(),
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
  oldPath: z.string().min(1).optional(),
  hunkHeader: z.string().min(1),
  hunkPatch: z.string().min(1),
});
export type ReviewStateCurrentHunk = z.infer<typeof reviewStateCurrentHunkSchema>;

export const reviewStateDecisionSchema = z.object({
  id: z.string().min(1).optional(),
  hunkId: z.string(),
  decision: z.enum(["reviewed", "commented"]),
  comment: z.string().optional(),
  savedAt: z.string(),
  anchor: reviewAnchorSchema.optional(),
  anchorState: anchorStateSchema.optional(),
});
export type ReviewStateDecision = z.infer<typeof reviewStateDecisionSchema>;

export const reviewStateResultSchema = z.object({
  decisions: z.array(reviewStateDecisionSchema),
  anchorIssues: z.array(reviewAnchorIssueSchema),
});
export type ReviewStateResult = z.infer<typeof reviewStateResultSchema>;

export const getReviewState = defineRpc({
  name: "review-deck.state",
  input: z.object({
    targetFingerprint: z.string().min(1),
    request: reviewRequestSchema,
    projectId: z.string().min(1).optional(),
    workspaceId: z.string().trim().min(1).optional(),
    currentHunks: z.array(reviewStateCurrentHunkSchema),
  }),
  output: reviewStateResultSchema,
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
  anchor: reviewAnchorSchema.optional(),
  anchorState: anchorStateSchema.optional(),
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
  batches: z.array(activeReviewBatchSchema),
});
export type ProjectReviewSummary = z.infer<typeof projectReviewSummarySchema>;

export const listProjectReviewComments = defineRpc({
  name: "review-deck.list-project-review-comments",
  input: z.object({ projectId: z.string().min(1) }),
  output: z.object({ project: projectReviewSummarySchema.nullable() }),
});

// Count-only sibling of review-deck.list-project-review-comments for the
// client's project badge: the same comment predicate, but no comment body
// ever leaves the state store.
export const getProjectReviewCommentCount = defineRpc({
  name: "review-deck.project-review-comment-count",
  input: z.object({ projectId: z.string().min(1) }),
  output: z.object({ commentCount: z.number().int().nonnegative() }),
});

// Submit one workspace's selected comments as a persisted ReviewBatch. Comments
// remain queued until the Agent's turn reports explicit COMPLETED outcomes.
export const processProjectReviewResultSchema = reviewBatchSchema;
export type ProcessProjectReviewResult = z.infer<typeof processProjectReviewResultSchema>;

export const processProjectReview = defineRpc({
  name: "review-deck.process-project-review",
  input: z.object({
    projectId: z.string().min(1),
    agentId: z.string().min(1),
    workspaceId: z.string().min(1),
    workspaceCwd: z.string().min(1),
    commentIds: z.array(z.string().min(1)).min(1),
  }),
  output: processProjectReviewResultSchema,
});
// Explicitly releases an ambiguous delivery claim after the user accepts the duplicate-risk warning.
export const releaseUnknownReviewBatch = defineRpc({
  name: "review-deck.release-unknown-review-batch",
  input: z.object({
    projectId: z.string().min(1),
    workspaceId: z.string().min(1),
    batchId: z.string().min(1),
    confirmDuplicateRisk: z.literal(true),
  }).strict(),
  output: z.object({
    batchId: z.string().min(1),
    released: z.literal(true),
  }).strict(),
});

// ---------------------------------------------------------------------------
// Verification Terminal (v2.0)
//
// One confirmed command is typed into an interactive shell terminal owned by
// the workspace and bound to the workspace, its project, the reviewed target
// fingerprint, and the command itself. Review Deck captures a bounded tail of
// that terminal while it exists and never interprets the output: there is no
// exit code, no pass/fail, and no verified fact anywhere in this contract. A
// terminal that is gone is simply `closed`, and the user inspects and closes
// the terminal themselves.
// ---------------------------------------------------------------------------

export const verificationRunStatusSchema = z.enum([
  /** The terminal exists; captured output remains inspectable. */
  "open",
  /** The terminal is gone (closed, killed, or its command finished). */
  "closed",
  /** The terminal's existence could not be determined (workspace unavailable). */
  "unavailable",
  /** The run no longer matches its workspace binding. */
  "error",
]);
export type VerificationRunStatus = z.infer<typeof verificationRunStatusSchema>;

export const verificationFailureCodeSchema = z.enum([
  /** The workspace terminal is gone; Review Deck has no result to report. */
  "terminal_closed",
  /** The workspace or its terminal list could not be observed. */
  "terminal_unavailable",
  /** The run no longer resolves to its original workspace and project. */
  "invalid_binding",
]);
export type VerificationFailureCode = z.infer<typeof verificationFailureCodeSchema>;

export const verificationFailureSchema = z.object({
  code: verificationFailureCodeSchema,
  /** Localized, user-facing reason; never terminal output and never a verdict. */
  message: z.string().min(1),
}).strict();
export type VerificationFailure = z.infer<typeof verificationFailureSchema>;

/** Maximum lines of transient terminal output one response may carry. */
export const VERIFICATION_OUTPUT_TAIL_MAX_LINES = 200;
/** Maximum characters one captured output line may carry. */
export const VERIFICATION_OUTPUT_TAIL_LINE_MAX_LENGTH = 1_000;
/** Maximum characters one whole captured output tail may carry. */
export const VERIFICATION_OUTPUT_TAIL_MAX_CHARACTERS = 20_000;

export const verificationOutputTailSchema = z
  .array(z.string().max(VERIFICATION_OUTPUT_TAIL_LINE_MAX_LENGTH))
  .max(VERIFICATION_OUTPUT_TAIL_MAX_LINES);

/**
 * One verification run as every RPC reports it. `open` means the workspace
 * terminal still exists; `closed` means it is gone; `unavailable` means its
 * existence could not be determined; `error` means the run no longer matches
 * its workspace binding. `outputTail` is a bounded, transient copy of the
 * terminal's last lines — it is never stored, never interpreted, and never a
 * verdict.
 */
export const verificationRunResultSchema = z.object({
  runId: z.string().min(1),
  status: verificationRunStatusSchema,
  workspaceId: z.string().min(1),
  targetFingerprint: z.string().min(1),
  suggestionId: z.string().min(1),
  label: z.string().min(1).max(VERIFICATION_SUGGESTION_LABEL_MAX_LENGTH),
  filePath: z.string().min(1).optional(),
  hunkId: z.string().min(1).optional(),
  /** Exact command the user confirmed; display only. */
  commandPreview: z.string().min(1),
  terminalId: z.string().min(1).optional(),
  startedAt: z.iso.datetime(),
  /** Set once the run leaves `open`. */
  completedAt: z.iso.datetime().optional(),
  /** Why the run is no longer open; never a command verdict. */
  failure: verificationFailureSchema.optional(),
  /** Bounded transient tail captured for this response only; never stored. */
  outputTail: verificationOutputTailSchema.optional(),
});
export type VerificationRunResult = z.infer<typeof verificationRunResultSchema>;

export const startVerificationRunResultSchema = verificationRunResultSchema;
export type StartVerificationRunResult = VerificationRunResult;
export const pollVerificationRunResultSchema = verificationRunResultSchema;
export type PollVerificationRunResult = VerificationRunResult;

/**
 * Starts one explicitly confirmed verification run. The workspace id, the
 * review request, and the expected target fingerprint are all required. The
 * caller sends the structured finding suggestion it displayed; the user must
 * confirm its exact executable/argv preview (`confirmed: true`). The command is
 * typed into a new interactive workspace terminal, which stays open for the
 * user to inspect.
 */
export const startVerificationRun = defineRpc({
  name: "review-deck.start-verification-run",
  input: z.object({
    workspaceId: z.string().min(1),
    request: reviewRequestSchema,
    expectedTargetFingerprint: z.string().min(1),
    suggestion: reviewVerificationSuggestionSchema,
    /** Explicit user confirmation of the exact command; never defaulted. */
    confirmed: z.literal(true),
  }).strict(),
  output: startVerificationRunResultSchema,
});

/**
 * Polls one verification run for the current state of its terminal. A missing
 * run, or one whose workspace does not match the poll, is refused; every other
 * end is reported as a state so the UI can show whether the terminal is still
 * open. No captured output is interpreted or persisted.
 */
export const pollVerificationRun = defineRpc({
  name: "review-deck.poll-verification-run",
  input: z.object({
    runId: z.string().min(1),
    workspaceId: z.string().min(1),
  }).strict(),
  output: pollVerificationRunResultSchema,
});
/**
 * Recent verification runs for one workspace and its current target. The run
 * store keeps metadata and status only; a bounded output tail is captured for
 * this response and never crosses into storage.
 */
export const listVerificationRunsResultSchema = z.object({
  runs: z.array(pollVerificationRunResultSchema),
  targetChanged: z.boolean(),
}).strict();
export type ListVerificationRunsResult = z.infer<typeof listVerificationRunsResultSchema>;

export const listVerificationRuns = defineRpc({
  name: "review-deck.list-verification-runs",
  input: z.object({
    workspaceId: z.string().min(1),
    request: reviewRequestSchema,
    expectedTargetFingerprint: z.string().min(1),
  }).strict(),
  output: listVerificationRunsResultSchema,
});

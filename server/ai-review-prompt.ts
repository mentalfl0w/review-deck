/**
 * Pure prompt and cache-identity helpers for Review Deck's AI review (v1.4).
 *
 * Two identities live here, and keeping them separate is the whole point:
 *
 * - STABLE hunk/file identity is location independent. `hunkStableFingerprint`
 *   is `hunkContentId(path, patch)` (which already drops the file preamble —
 *   including the whole-file blob hash on the `index` line — and every `@@ `
 *   header) plus the normalized enclosing section/function context, so an
 *   unrelated edit elsewhere in the same file, a line shift, or a different
 *   whole-target fingerprint never changes it. Cache keys and the ids cited in
 *   the prompt are built from this identity, so cached output never cites a
 *   target-bound `H-…` id that a later snapshot cannot resolve.
 * - TARGET identity is `snapshot.targetFingerprint`, used only by a full
 *   target review, where the whole changeset really is the input.
 *
 * The prompt builder never guesses: every fact it prints (stable id, path,
 * header, severity, category, patch text) is passed in already computed, and
 * the returned `AiReviewPrompt` reports exactly which patch bodies fit the
 * 160,000-character budget, which were left out, and how many patch characters
 * were emitted — the hunk INDEX is always complete, so a bounded patch section
 * can never misattribute or renumber an id.
 *
 * No provider SDK is imported here; this module is pure (crypto helpers aside)
 * and returns a plain string plus its identity metadata.
 */
import type { AiReviewBudgetPreset, AiReviewDepth, AiReviewMode, ReviewLocale, ReviewScope } from "../shared/review";
import { canonicalJson, hunkContentId, sha256 } from "./util/crypto";

/** Version of the prompt layout/instructions; bump on any wording change. */
export const AI_REVIEW_PROMPT_VERSION = 2;

/** Version of the structured review output contract the prompt requests. */
export const AI_REVIEW_SCHEMA_VERSION = 1;

/** Maximum patch text (in characters) a full review prompt may carry. */
export const AI_REVIEW_PATCH_CHAR_LIMIT = 160_000;

/** Hex characters of the stable fingerprint used as the readable hunk id. */
export const AI_REVIEW_STABLE_HUNK_ID_LENGTH = 12;

export type AiReviewSeverity = "critical" | "high" | "medium" | "low" | "informational";

const SEVERITY_RANK: Record<AiReviewSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  informational: 1,
};

/** Numeric rank of a severity (critical 5 … informational 1). */
export function severityRank(severity: AiReviewSeverity): number {
  return SEVERITY_RANK[severity];
}

/** How a budget preset classifies a hunk for the reviewer. */
export type AiReviewTriageBucket = "must-review" | "within-budget" | "as-needed";
/** Critical/high are always mandatory; other buckets vary by preset. */
export function triageBucket(
  severity: AiReviewSeverity,
  preset: AiReviewBudgetPreset = "balanced",
): AiReviewTriageBucket {
  const rank = severityRank(severity);
  if (rank >= 4 || preset === "deep") return "must-review";
  if (rank === 3 && preset === "balanced") return "within-budget";
  return "as-needed";
}

/**
 * Normalizes an enclosing section/function caption into a stable identity
 * input: a raw `@@ -1,4 +1,5 @@ section` header is reduced to its section
 * text (the line ranges are location, not identity), whitespace is collapsed,
 * and a trailing `{` is dropped, so `function foo() {` and `function foo()`
 * are the same context. An unknown context normalizes to the empty string.
 */
export function normalizeHunkContext(context?: string | null): string {
  if (!context) return "";
  return context
    .replace(/^@@+[^@]*@@+\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*\{\s*$/, "")
    .trim();
}

/**
 * Location-independent fingerprint of one hunk: the content identity of its
 * patch (path + changed/context body, preamble and `@@ ` headers dropped)
 * combined with its normalized enclosing section/function context. Whole-target
 * changes that do not touch this hunk's own body or section leave it untouched.
 */
export function hunkStableFingerprint(path: string, patch: string, context?: string | null): string {
  return sha256(canonicalJson({
    contentId: hunkContentId(path, patch),
    context: normalizeHunkContext(context),
  }));
}

/** Readable stable hunk id (`H-` + 12 hex characters of the stable fingerprint). */
export function hunkStableId(path: string, patch: string, context?: string | null): string {
  return `H-${hunkStableFingerprint(path, patch, context).slice(0, AI_REVIEW_STABLE_HUNK_ID_LENGTH)}`;
}

/**
 * File identity: the file path plus its stable hunk fingerprints, SORTED, so
 * the order in which hunks happen to be listed (or re-derived by git) never
 * changes the fingerprint. Duplicate hunks are kept: two identical bodies in
 * one file are still two hunks of the input.
 */
export function fileFingerprint(path: string, hunkFingerprints: readonly string[]): string {
  return sha256(canonicalJson({ path, hunks: [...hunkFingerprints].sort() }));
}

/** A finding as far as prompt identity is concerned (structurally typed). */
export type AiReviewPromptFinding = { severity: AiReviewSeverity; category: string };

export type AiReviewPromptHunkInput = {
  /** File path the hunk belongs to. */
  path: string;
  /** Git hunk header (`@@ -a,b +c,d @@ section`). */
  header: string;
  /** Verbatim hunk patch (file preamble and body), as parsed from the diff. */
  patch: string;
  /**
   * Enclosing section/function caption. When omitted, the header's own section
   * text is used, so callers that only have a header still get stable context.
   */
  context?: string | null;
  /** Rule-engine findings for this hunk; the highest severity wins. */
  findings?: readonly AiReviewPromptFinding[];
};

/** One hunk as presented to the reviewer and cited by cached output. */
export type AiReviewPromptHunk = {
  /** Stable, location-independent id; the ONLY id the reviewer may cite. */
  stableId: string;
  /** Full stable fingerprint behind `stableId` (cache identity input). */
  stableFingerprint: string;
  path: string;
  header: string;
  /** Highest finding severity (informational when there is no finding). */
  severity: AiReviewSeverity;
  /** Category of the highest-severity finding ("general" when none). */
  category: string;
  /** Verbatim patch text. */
  patch: string;
  /** Normalized enclosing section/function context ("" when unknown). */
  context: string;
};

/**
 * Builds the reviewer-facing view of one hunk: stable id/fingerprint, the
 * highest severity with its category, and the normalized context. The severity
 * is what the targeted prompt's triage instructions key off.
 */
export function promptHunk(input: AiReviewPromptHunkInput): AiReviewPromptHunk {
  const context = normalizeHunkContext(input.context ?? input.header);
  let top: AiReviewPromptFinding | null = null;
  for (const finding of input.findings ?? []) {
    if (top === null || severityRank(finding.severity) > severityRank(top.severity)) top = finding;
  }
  const stableFingerprint = hunkStableFingerprint(input.path, input.patch, context);
  return {
    stableId: `H-${stableFingerprint.slice(0, AI_REVIEW_STABLE_HUNK_ID_LENGTH)}`,
    stableFingerprint,
    path: input.path,
    header: input.header,
    severity: top?.severity ?? "informational",
    category: top?.category.trim() || "general",
    patch: input.patch,
    context,
  };
}

export type AiReviewPromptFile = {
  path: string;
  hunks: readonly AiReviewPromptHunk[];
};

export type AiReviewPromptInput = {
  /** `hunk` reviews one selected hunk, `file` one file's hunks, `target` the changeset. */
  mode: AiReviewMode;
  /** `targeted` sends the index only; `full` also sends bounded patch text. */
  depth: AiReviewDepth;
  /** Risk coverage preset; the selected model remains the one in Settings. */
  preset: AiReviewBudgetPreset;
  /** Instruction language; defaults to English. */
  locale?: ReviewLocale;
  scope: ReviewScope;
  /** Reviewed worktree path. */
  workspace: string;
  /** `snapshot.targetFingerprint` — target identity, never hunk/file identity. */
  targetFingerprint: string;
  /**
   * Review units. For `hunk` mode the selected hunk must be the first hunk of
   * the first file; for `file` mode the first file is the review unit.
   */
  files: readonly AiReviewPromptFile[];
};

/** Content identity for the mode/depth; the preset is a separate cache-key dimension. */
export function aiReviewInputFingerprint(input: AiReviewPromptInput): string {
  if (input.mode === "hunk") return selectedHunk(input).stableFingerprint;
  if (input.mode === "file") {
    const file = requireFile(input);
    return fileFingerprint(file.path, file.hunks.map((hunk) => hunk.stableFingerprint));
  }
  // A full target review really does consume the whole changeset.
  if (input.depth === "full") return input.targetFingerprint;
  // A targeted target review consumes only the index: the sorted stable
  // identities it shows, so unrelated target drift never invalidates it.
  const files = [...input.files].map((file) => ({
    path: file.path,
    hunks: [...file.hunks]
      .map((hunk) => ({ fingerprint: hunk.stableFingerprint, severity: hunk.severity, category: hunk.category }))
      .sort((left, right) => (left.fingerprint < right.fingerprint ? -1 : left.fingerprint > right.fingerprint ? 1 : 0)),
  })).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return sha256(canonicalJson({ mode: "target", depth: "targeted", files }));
}

function requireFile(input: AiReviewPromptInput): AiReviewPromptFile {
  const file = input.files[0];
  if (!file) {
    throw new Error(`AI review prompt needs at least one file for mode "${input.mode}".`);
  }
  return file;
}

function selectedHunk(input: AiReviewPromptInput): AiReviewPromptHunk {
  const hunk = requireFile(input).hunks[0];
  if (!hunk) {
    throw new Error('AI review prompt needs the selected hunk as the first hunk of the first file for mode "hunk".');
  }
  return hunk;
}

export type AiReviewPrompt = {
  /** The prompt text handed to the reviewer agent. */
  prompt: string;
  mode: AiReviewMode;
  depth: AiReviewDepth;
  preset: AiReviewBudgetPreset;
  locale: ReviewLocale;
  scope: ReviewScope;
  workspace: string;
  targetFingerprint: string;
  promptVersion: number;
  schemaVersion: number;
  /** `aiReviewInputFingerprint` for this input; the cache-key input identity. */
  inputFingerprint: string;
  /** Stable ids of every hunk in the index, in presented order (never truncated). */
  hunkIds: readonly string[];
  /** Stable ids whose patch text was included verbatim. */
  includedPatchHunkIds: readonly string[];
  /** Stable ids whose patch text was left out for budget; read from the workspace. */
  omittedPatchHunkIds: readonly string[];
  /** Characters of patch text included; ≤ AI_REVIEW_PATCH_CHAR_LIMIT except a hunk-mode unit. */
  patchCharacters: number;
};

type PromptCopy = {
  role: string;
  mode: string;
  depth: string;
  budgetPreset: string;
  presetLabels: Record<AiReviewBudgetPreset, string>;
  triageBucketLabels: Record<AiReviewTriageBucket, string>;
  scope: string;
  workspace: string;
  fingerprint: string;
  changedFiles: string;
  hunkIndexTitle: string;
  hunkPatchesTitle: string;
  noHunks: string;
  patchOmitted: string;
  outputTitle: string;
  outputLines: readonly string[];
  targetedIntro: string;
  triageLines: Record<AiReviewBudgetPreset, readonly string[]>;
  fullLine: string;
  hunkOnlyLine: string;
  hunkSingular: string;
  hunkPlural: string;
};

const PROMPT_COPY: Record<ReviewLocale, PromptCopy> = {
  en: {
    role: "You are Review Deck's AI reviewer in a human-in-the-loop code-review workspace. Work strictly read-only: inspect the workspace with read-only tools, never modify files or Git state, and never request permission to run write or exec tools.",
    mode: "Mode",
    depth: "Review depth",
    budgetPreset: "Review budget",
    presetLabels: { economical: "Economical", balanced: "Balanced", deep: "Deep" },
    triageBucketLabels: { "must-review": "MUST REVIEW", "within-budget": "WITHIN BUDGET", "as-needed": "AS NEEDED" },
    scope: "Scope",
    workspace: "Workspace",
    fingerprint: "Review fingerprint",
    changedFiles: "Changed files",
    hunkIndexTitle: "HUNK INDEX",
    hunkPatchesTitle: "HUNK PATCHES",
    noHunks: "(No text hunks found.)",
    patchOmitted: "(patch omitted: over budget — read this hunk from the workspace with read-only tools)",
    outputTitle: "OUTPUT REQUIREMENTS",
    outputLines: [
      "Report only findings you can ground in the change or in what you inspected.",
      "Cite the stable hunk id from the index above (the `H-…` ids) as `hunkId` on every finding.",
      "Never use a hunk header, a line number, or any other identifier as a hunk id.",
      "Answer in English.",
    ],
    targetedIntro: "Targeted review: hunk patches are NOT included. Inspect the workspace with read-only tools before judging.",
    triageLines: {
      economical: [
        "- critical/high: inspect the hunk, its file, and its callers/tests.",
        "- medium/low/informational: skip unless needed to understand a critical/high risk.",
      ],
      balanced: [
        "- critical/high: always inspect the hunk, its file, and its callers/tests.",
        "- medium: inspect while the inspection budget allows.",
        "- low/informational: inspect only when it is needed to explain a higher-severity finding.",
      ],
      deep: [
        "- inspect every hunk, including low/informational; read its file and relevant callers/tests.",
        "- do not skip a hunk because its deterministic severity is low.",
      ],
    },
    fullLine: `Full review: the patches below are included verbatim, bounded to ${AI_REVIEW_PATCH_CHAR_LIMIT} characters of patch text. A hunk marked omitted did not fit — read it from the workspace with read-only tools if you need it.`,
    hunkOnlyLine: "The exact patch of the selected hunk is included below; review this hunk only and keep your findings on its stable id.",
    hunkSingular: "hunk",
    hunkPlural: "hunks",
  },
  zh: {
    role: "你是 Review Deck 在人工代码评审工作区中的 AI reviewer。只做只读检查：使用只读工具查看工作区，绝不修改文件或 Git 状态，也不要请求执行写入或命令工具的权限。",
    mode: "模式",
    depth: "评审深度",
    budgetPreset: "评审预算",
    presetLabels: { economical: "节省", balanced: "均衡", deep: "深入" },
    triageBucketLabels: { "must-review": "必审", "within-budget": "按预算检查", "as-needed": "按需检查" },
    scope: "范围",
    workspace: "工作区",
    fingerprint: "评审指纹",
    changedFiles: "变更文件",
    hunkIndexTitle: "变更块索引",
    hunkPatchesTitle: "变更块补丁",
    noHunks: "（没有找到文本变更块。）",
    patchOmitted: "（补丁已省略：超出预算——如需该变更块，请用只读工具从工作区读取）",
    outputTitle: "输出要求",
    outputLines: [
      "只报告能在变更本身或你检查过的内容中证实的结论。",
      "每条结论都必须以上方索引中的稳定变更块 ID（`H-…`）作为 `hunkId`。",
      "不要用变更块 header、行号或其他任何标识充当变更块 ID。",
      "用中文回答。",
    ],
    targetedIntro: "定向评审：不发送变更块补丁。请先用只读工具检查工作区再下结论。",
    triageLines: {
      economical: [
        "- critical/high：检查变更块、所在文件及其调用方/测试。",
        "- medium/low/informational：除非理解高风险问题必须用到，否则跳过。",
      ],
      balanced: [
        "- critical/high：必须检查该变更块、所在文件及其调用方/测试。",
        "- medium：在检查预算允许时检查。",
        "- low/informational：仅当需要解释更高严重程度的问题时才检查。",
      ],
      deep: [
        "- 必须检查所有变更块，包括 low/informational；按需读取文件、调用方和测试。",
        "- 不要因为确定性严重级别较低就跳过变更块。",
      ],
    },
    fullLine: `完整评审：下方补丁按原文附带，补丁文本上限为 ${AI_REVIEW_PATCH_CHAR_LIMIT} 个字符。标记为“已省略”的变更块未纳入预算——如需请用只读工具从工作区读取。`,
    hunkOnlyLine: "下方附带所选变更块的完整补丁；只评审该变更块，并把结论锚定到它的稳定 ID。",
    hunkSingular: "个变更块",
    hunkPlural: "个变更块",
  },
};

/**
 * Builds the reviewer prompt for one mode/depth and reports the identity
 * metadata the cache and the UI need.
 *
 * Patch text is included exactly when it is the review unit itself (hunk mode:
 * the selected hunk, verbatim) or when the depth is `full`, where whole patches
 * are admitted in index order while they fit `AI_REVIEW_PATCH_CHAR_LIMIT` and
 * every patch that does not fit is marked omitted instead of being cut — so no
 * patch fragment can ever be read as part of another hunk. The INDEX is always
 * complete and is printed before the patch section.
 */
export function buildAiReviewPrompt(input: AiReviewPromptInput): AiReviewPrompt {
  const locale: ReviewLocale = input.locale ?? "en";
  const copy = PROMPT_COPY[locale];
  const hunkMode = input.mode === "hunk";
  const includePatches = hunkMode || input.depth === "full";

  const files: readonly AiReviewPromptFile[] = input.mode === "target"
    ? input.files
    : input.mode === "file"
      ? [requireFile(input)]
      : [{ path: requireFile(input).path, hunks: [selectedHunk(input)] }];
  const hunks = files.flatMap((file) => file.hunks);

  const included: AiReviewPromptHunk[] = [];
  const omitted: AiReviewPromptHunk[] = [];
  let patchCharacters = 0;
  if (includePatches) {
    for (const hunk of hunks) {
      // The selected hunk IS the review unit, so it is always verbatim; every
      // other patch is whole-or-absent against the remaining budget.
      if (hunkMode || patchCharacters + hunk.patch.length <= AI_REVIEW_PATCH_CHAR_LIMIT) {
        included.push(hunk);
        patchCharacters += hunk.patch.length;
      } else {
        omitted.push(hunk);
      }
    }
  }

  const lines: string[] = [
    copy.role,
    "",
    `${copy.mode}: ${input.mode}`,
    `${copy.depth}: ${input.depth}`,
    ...(hunkMode ? [] : [`${copy.budgetPreset}: ${copy.presetLabels[input.preset]}`]),
    `${copy.scope}: ${input.scope}`,
    `${copy.workspace}: ${input.workspace}`,
    `${copy.fingerprint}: ${input.targetFingerprint}`,
    "",
    `${copy.changedFiles}: ${files.length}`,
  ];
  for (const file of files) {
    lines.push(`- ${file.path} (${file.hunks.length} ${file.hunks.length === 1 ? copy.hunkSingular : copy.hunkPlural})`);
  }
  lines.push("", copy.hunkIndexTitle);
  if (hunks.length === 0) lines.push(copy.noHunks);
  for (const hunk of hunks) {
    const triageLabel = hunkMode ? "" : ` · ${copy.triageBucketLabels[triageBucket(hunk.severity, input.preset)]}`;
    lines.push(`- ${hunk.stableId} · ${hunk.path} · ${hunk.header} · ${hunk.severity.toUpperCase()} · ${hunk.category}${triageLabel}`);
  }

  lines.push("");
  if (hunkMode) {
    lines.push(copy.hunkOnlyLine);
  } else {
    lines.push(input.depth === "full" ? copy.fullLine : copy.targetedIntro, ...copy.triageLines[input.preset]);
  }

  if (included.length > 0 || omitted.length > 0) {
    lines.push("", copy.hunkPatchesTitle);
    for (const hunk of included) {
      lines.push(`### ${hunk.stableId} · ${hunk.path} · ${hunk.header}`, hunk.patch);
    }
    for (const hunk of omitted) {
      lines.push(`### ${hunk.stableId} · ${hunk.path} · ${hunk.header}`, copy.patchOmitted);
    }
  }

  lines.push("", copy.outputTitle, ...copy.outputLines);

  return {
    prompt: `${lines.join("\n").trimEnd()}\n`,
    mode: input.mode,
    depth: input.depth,
    locale,
    preset: input.preset,
    scope: input.scope,
    workspace: input.workspace,
    targetFingerprint: input.targetFingerprint,
    promptVersion: AI_REVIEW_PROMPT_VERSION,
    schemaVersion: AI_REVIEW_SCHEMA_VERSION,
    inputFingerprint: aiReviewInputFingerprint(input),
    hunkIds: hunks.map((hunk) => hunk.stableId),
    includedPatchHunkIds: included.map((hunk) => hunk.stableId),
    omittedPatchHunkIds: omitted.map((hunk) => hunk.stableId),
    patchCharacters,
  };
}

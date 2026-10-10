import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { PluginHandlerContext, PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type {
  AiReviewDepth,
  AiReviewBudgetPreset,
  AiReviewMode,
  AiReviewPermissionMode,
  AiReviewResultSource,
  AiReviewUsage,
  AnchorState,
  ExplainHunkResult,
  LineRangeSelection,
  PollAiReviewResult,
  PollVerificationRunResult,
  ListVerificationRunsResult,
  ProcessProjectReviewResult,
  ProjectReviewComment,
  ProjectReviewSummary,
  ReviewAnchor,
  ReviewAnchorIssue,
  ReviewLocale,
  ReviewRequest,
  ReviewSections,
  ReviewScope,
  ReviewSnapshot,
  ReviewStateCurrentHunk,
  ReviewStateDecision,
  ReviewStateResult,
  StartVerificationRunResult,
  FileViewRow,
} from "../shared/review";
import { aiReviewPresetDefaultDepth } from "../shared/review";
import {
  reviewDeckSettingsSchema,
  type ReviewDeckSettingsHandle,
  type ReviewDeckSettingsValues,
} from "../shared/review-settings";
import {
  reviewBatchTimelineKind,
  reviewBatchTimelineVersion,
  type ActiveReviewBatch,
  type ReviewBatch,
  type ReviewCommentOutcome,
} from "../shared/review-batch";
import {
  reviewAiTimelineKind,
  reviewAiTimelineSchema,
  reviewAiTimelineVersion,
  type ReviewWorkspaceIndicators,
  type WorkspaceReviewSummary,
} from "../shared/review-activity";
import { canonicalJson, hunkChangeId, hunkContentId, sha256 } from "./util/crypto";
import {
  buildLineRangeAnchor,
  currentHunkDescriptors,
  ownershipMismatch,
  resolveAnchor,
  type AnchorResolution,
  type OwnershipConstraints,
} from "./AnchorEngine";
import { createMutex, RepoMutexRegistry } from "./util/mutex";
import { displayLanguage } from "./lang/languages";
import { severityRank } from "./diff/FindingDetector";
import { DiffParser, hunkBodyLines, parseRange, type Hunk } from "./diff/DiffParser";
import { GitRunner } from "./git/GitRunner";
import { StateStore, type StateEntry, type StateFile } from "./persistence/StateStore";
import {
  AiReviewCacheStore,
  type AiReviewCacheEntry,
} from "./persistence/AiReviewCacheStore";
import { ReviewBatchStore } from "./persistence/ReviewBatchStore";
import { ReviewRunStore, type ReviewRun } from "./persistence/ReviewRunStore";
import {
  AI_REVIEW_PROMPT_VERSION,
  AI_REVIEW_SCHEMA_VERSION,
  buildAiReviewPrompt,
  promptHunk,
  type AiReviewPromptFile,
} from "./ai-review-prompt";
import {
  buildReviewBatchPrompt,
  extractReviewBatchAssistantResponse,
  parseReviewCommentOutcomes,
  reviewBatchTimelineData,
} from "./review-batch";
import {
  AI_REVIEW_OUTPUT_SCHEMA,
  normalizeStructuredReviewResult,
  parseStructuredReviewResult,
  reviewSectionsFromMarkdown,
} from "./structured-review";
import { VerificationRunStore } from "./persistence/VerificationRunStore";
import {
  VerificationService,
  type ListVerificationRunsInput,
  type PollVerificationRunInput,
  type StartVerificationRunInput,
} from "./verification/VerificationService";
import { VERIFICATION_RUN_TTL_MS } from "./verification/lifecycle";
import type { ReviewAnchorFileView } from "./AnchorEngine";


export interface ReviewServiceDependencies {
  settings?: ReviewDeckSettingsHandle;
  store?: StateStore;
  aiReviewCacheStore?: AiReviewCacheStore;
  reviewBatchStore?: ReviewBatchStore;
  reviewRunStore?: ReviewRunStore;
  verificationRunStore?: VerificationRunStore;
  diffParser?: DiffParser;
  repoMutexes?: RepoMutexRegistry;
  gitFactory?: (cwd: string) => GitRunner;
}

/** Short wait window per poll; the daemon reports "timeout" while the turn is
 * still running, so a poll never blocks the plugin RPC layer. */
const READONLY_REVIEW_POLL_WAIT_MS = 2_000;
/** Persistent run records remain recoverable for one hour. */
const READONLY_REVIEW_ENTRY_TTL_MS = 60 * 60_000;
/** Bound startup expiry to Batches that never persisted a send attempt. */
const REVIEW_BATCH_START_TIMEOUT_MS = 2 * 60_000;

/** Conservative allowlist: Paseo currently forwards outputSchema only for these provider adapters. */
const STRUCTURED_REVIEW_PROVIDER_IDS = new Set(["codex", "opencode"]);
function supportsStructuredReviewOutput(provider: string): boolean {
  return STRUCTURED_REVIEW_PROVIDER_IDS.has(provider.split("/")[0]?.toLowerCase() ?? "");
}

function isActiveReviewBatch(status: ReviewBatch["status"]): boolean {
  return status === "draft" || status === "submitted" || status === "running";
}

function isOrphanedReviewBatch(batch: ReviewBatch): boolean {
  return batch.status === "failed" &&
    batch.commentIds.every((commentId) => batch.outcomes[commentId] === "unresolved");
}

/** Finding tally of one AI review result, as the run record and the timeline
 * row report it. */
type AiReviewFindingCounts = {
  findingCount: number;
  highRiskFindingCount: number;
};

/**
 * Count the findings of a terminal AI review from the source-neutral UI
 * sections: one section entry is one finding, which is exactly what the panel
 * lists for the same result. A structured result carries one entry per
 * validated finding, and its entries start with the normalized
 * `**SEVERITY · category**` marker, so critical/high findings are counted
 * exactly; a Markdown fallback has no machine-readable severity and therefore
 * reports zero high-risk findings instead of guessing from prose.
 */
function countSectionFindings(sections: ReviewSections): AiReviewFindingCounts {
  const entries = [
    ...sections.verifiedFacts,
    ...sections.aiInference,
    ...sections.humanVerificationRecommended,
  ];
  return {
    findingCount: entries.length,
    // The normalized structured finding marker is `**SEVERITY · category**`,
    // so this only matches a severity the structured result actually assigned.
    highRiskFindingCount: entries.filter((entry) => /^\*\*(?:CRITICAL|HIGH) · /.test(entry.trimStart())).length,
  };
}

function emptyReviewSections(): ReviewSections {
  return { verifiedFacts: [], aiInference: [], humanVerificationRecommended: [] };
}
/** The transient child handle surface pollAiReview needs: waitForFinish plus
 * timeline access for the last-assistant-text recovery fallback. */
type TransientAgentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  contextWindowUsedTokens?: number;
};
type TransientReviewChildHandle = {
  id: string;
  waitForFinish(timeoutMs?: number): Promise<{
    status: "idle" | "error" | "permission" | "timeout";
    error: string | null;
    lastMessage: string | null;
    final?: { lastUsage?: TransientAgentUsage | null } | null;
  }>;
  timeline?: { refetch(options?: { limit?: number }): Promise<unknown> };
};
type TransientReviewEntry = {
  handle: TransientReviewChildHandle | null;
  cachedResult?: Pick<AiReviewCacheEntry, "review" | "sections" | "usage">;
  locale: ReviewLocale | undefined;
  provider: string;
  model: string | null;
  workspaceId: string;
  agentId: string;
  startedAt: number;
  mode: AiReviewMode;
  depth?: AiReviewDepth;
  reviewPreset?: AiReviewBudgetPreset;
  reviewerPermissionMode: AiReviewPermissionMode;
  resultSource: AiReviewResultSource;
  cacheEnabled: boolean;
  cacheKey: string;
  inputFingerprint: string;
  thinkingOptionId: string | null;
};
type ReviewRunRecoveryResult =
  | { kind: "restored"; entry: TransientReviewEntry }
  | { kind: "retry"; run: ReviewRun }
  | { kind: "unavailable"; run: ReviewRun | null };
function toAiReviewUsage(usage: TransientAgentUsage | null | undefined): AiReviewUsage | undefined {
  if (!usage) return undefined;
  const result: AiReviewUsage = {};
  if (typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0) {
    result.inputTokens = usage.inputTokens;
  }
  if (typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0) {
    result.outputTokens = usage.outputTokens;
  }
  if (typeof usage.cachedInputTokens === "number" && Number.isFinite(usage.cachedInputTokens) && usage.cachedInputTokens >= 0) {
    result.cachedTokens = usage.cachedInputTokens;
  }
  if (typeof usage.contextWindowUsedTokens === "number" && Number.isFinite(usage.contextWindowUsedTokens) && usage.contextWindowUsedTokens >= 0) {
    result.contextTokens = usage.contextWindowUsedTokens;
  }
  return result.inputTokens !== undefined || result.outputTokens !== undefined || result.cachedTokens !== undefined || result.contextTokens !== undefined
    ? result
    : undefined;
}
/** Structural slice of the daemon's fetch_agent_timeline payload. */
type TransientTimelinePayload = {
  entries?: Array<{ item?: { type?: string; text?: unknown; content?: unknown } }>;
};

const FILE_VIEW_MAX_ROWS = 20_000;
const STATE_BUCKET_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const ANCHOR_FILE_VIEW_CACHE_SIZE = 8;
interface ReviewTarget {
  repositoryPath: string;
  worktreePath: string;
  gitDir: string;
  baseRef: string | null;
  headRef: string;
  baseSha: string | null;
  headSha: string | null;
}
type DeterministicCopy = {
  file: string;
  formatLabel: (label: string, value: string) => string;
  enclosingSymbol: string;
  language: string;
  changedRange: string;
  changedLines: (added: number, removed: number) => string;
  fallbackHumanCheck: string;
  fallbackCategoryCheck: (category: string) => string;
  fileHunk: (header: string) => string;
};

type CompleteProjectCommentEntry = StateEntry & Required<Pick<
  StateEntry,
  "id" | "filePath" | "hunkFingerprint" | "hunkHeader" | "hunkPatch" | "cwd" | "scope"
>>;

type FileViewInput = ReviewRequest & {
  filePath: string;
  targetFingerprint: string;
  hunks: ReviewStateCurrentHunk[];
};
type FileViewData = {
  binary: boolean;
  truncated: boolean;
  complete: boolean;
  rows: FileViewRow[];
};
type ReviewStateInput = {
  targetFingerprint: string;
  currentHunks: readonly ReviewStateCurrentHunk[];
  request?: ReviewRequest;
  projectId?: string;
  workspaceId?: string;
  /** Internal injection for deterministic service tests; the RPC never accepts it. */
  currentFileViews?: readonly ReviewAnchorFileView[];
};
const DETERMINISTIC_COPY: Record<ReviewLocale, DeterministicCopy> = {
  en: {
    file: "File",
    formatLabel: (label, value) => `${label}: ${value}.`,
    enclosingSymbol: "Enclosing symbol",
    language: "Language",
    changedRange: "Changed range",
    changedLines: (added, removed) => `The hunk adds ${added} lines and removes ${removed} lines.`,
    fallbackHumanCheck: "Confirm the changed behavior against its callers and its nearest focused test.",
    fallbackCategoryCheck: (category) => `Confirm the ${category} implications.`,
    fileHunk: (header) => `Hunk ${header}:`,
  },
  zh: {
    file: "文件",
    formatLabel: (label, value) => `${label}：${value}。`,
    enclosingSymbol: "所在符号",
    language: "语言",
    changedRange: "变更范围",
    changedLines: (added, removed) => `此变更块新增 ${added} 行，删除 ${removed} 行。`,
    fallbackHumanCheck: "请结合调用方和最近的针对性测试，确认变更后的行为。",
    fallbackCategoryCheck: (category) => `请确认 ${category} 相关影响。`,
    fileHunk: (header) => `变更块 ${header}：`,
  },
};

function deterministicCopy(locale: ReviewLocale | undefined): DeterministicCopy {
  return DETERMINISTIC_COPY[locale === "zh" ? "zh" : "en"];
}



const STRICT_READ_ONLY_MODE_NAMES = new Set(["readonly", "readonlymode", "plan", "planmode"]);
const APPROVAL_GATED_MODE_NAMES = new Set(["ask", "alwaysask", "alwaysaskmode"]);
type CodexReadOnlyProviderOptions = {
  approval_policy: "on-request";
  sandbox_mode: "read-only";
};
const CODEX_READ_ONLY_PROVIDER_OPTIONS: CodexReadOnlyProviderOptions = {
  approval_policy: "on-request",
  sandbox_mode: "read-only",
};

function resolveReviewerMode(provider: string, modes: readonly { id: string; label: string }[]): {
  id: string;
  permissionMode: AiReviewPermissionMode;
  providerOptions?: CodexReadOnlyProviderOptions;
} | null {
  for (const mode of modes) {
    if (STRICT_READ_ONLY_MODE_NAMES.has(mode.id.toLowerCase().replace(/[^a-z0-9]/g, "")) || STRICT_READ_ONLY_MODE_NAMES.has(mode.label.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
      return {
        id: mode.id,
        permissionMode: "read-only",
        ...(provider === "codex" ? { providerOptions: CODEX_READ_ONLY_PROVIDER_OPTIONS } : {}),
      };
    }
  }
  for (const mode of modes) {
    if (APPROVAL_GATED_MODE_NAMES.has(mode.id.toLowerCase().replace(/[^a-z0-9]/g, "")) || APPROVAL_GATED_MODE_NAMES.has(mode.label.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
      return { id: mode.id, permissionMode: "ask" };
    }
  }
  if (provider === "codex") {
    const defaultApprovalMode = modes.find((mode) => mode.id === "auto");
    if (defaultApprovalMode) {
      return {
        id: defaultApprovalMode.id,
        permissionMode: "read-only",
        providerOptions: CODEX_READ_ONLY_PROVIDER_OPTIONS,
      };
    }
  }
  return null;
}

/**
 * Composes the Git runner, diff parser, language heuristics, and state store
 * behind Review Deck's RPC surface. Every git invocation goes through a
 * GitRunner bound to the request's cwd; repository-level mutual exclusion and
 * the decision state file are injected dependencies rather than module globals.
 */
export class ReviewService {
  /** Retain the host settings capability for server-side review configuration. */
  private readonly settings: ReviewDeckSettingsHandle | undefined;
  private readonly store: StateStore;
  private readonly aiReviewCacheStore: AiReviewCacheStore;
  private readonly reviewBatchStore: ReviewBatchStore;
  private readonly sendingReviewBatchIds = new Set<string>();
  private readonly reviewRunStore: ReviewRunStore;
  private readonly verifications: VerificationService;
  private readonly reviewBatchTimelineMutex = createMutex();
  private readonly diffParser: DiffParser;
  private readonly repoMutexes: RepoMutexRegistry;
  private readonly gitFactory: (cwd: string) => GitRunner;
  private readonly anchorFileViewCache = new Map<string, ReviewAnchorFileView>();
  // Request UUIDs are unguessable capabilities, never child agent IDs. Polling
  // stays bound to the workspace/agent selected when this one-shot review began.
  private readonly transientReviewAgents = new Map<string, TransientReviewEntry>();

  private async sweepTransientReviewAgents(): Promise<void> {
    const now = Date.now();
    for (const [id, entry] of this.transientReviewAgents) {
      if (now - entry.startedAt > READONLY_REVIEW_ENTRY_TTL_MS) this.transientReviewAgents.delete(id);
    }
    let runs: ReviewRun[];
    try {
      runs = await this.reviewRunStore.list();
    } catch (error) {
      console.error("[Review Deck] Could not read ReviewRun metadata during cleanup.", error);
      return;
    }
    for (const run of runs) {
      if (now - Date.parse(run.startedAt) <= READONLY_REVIEW_ENTRY_TTL_MS) continue;
      if (run.status === "running") {
        try {
          await this.reviewRunStore.update(run.requestId, (current) =>
            current.status === "running" ? { ...current, status: "abandoned" } : current,
          );
        } catch (error) {
          console.error(`[Review Deck] Could not abandon expired ReviewRun ${run.requestId}.`, error);
        }
      } else {
        try {
          await this.reviewRunStore.remove(run.requestId);
        } catch (error) {
          console.error(`[Review Deck] Could not remove expired ReviewRun ${run.requestId}.`, error);
        }
      }
    }
  }
  private toReviewRun(
    requestId: string,
    entry: TransientReviewEntry,
    childAgentId: string | null,
    status: ReviewRun["status"],
  ): ReviewRun {
    return {
      requestId,
      childAgentId,
      parentAgentId: entry.agentId,
      workspaceId: entry.workspaceId,
      cacheKey: entry.cacheKey,
      mode: entry.mode,
      status,
      resultSource: entry.resultSource,
      startedAt: new Date(entry.startedAt).toISOString(),
      ...(entry.locale !== undefined ? { locale: entry.locale } : {}),
      provider: entry.provider,
      model: entry.model,
      thinkingOptionId: entry.thinkingOptionId,
      reviewerPermissionMode: entry.reviewerPermissionMode,
      ...(entry.depth ? { depth: entry.depth } : {}),
      ...(entry.reviewPreset ? { reviewPreset: entry.reviewPreset } : {}),
      cacheEnabled: entry.cacheEnabled,
      inputFingerprint: entry.inputFingerprint,
      promptVersion: AI_REVIEW_PROMPT_VERSION,
      schemaVersion: AI_REVIEW_SCHEMA_VERSION,
    };
  }
  private transientEntryFromRun(
    run: ReviewRun,
    handle: TransientReviewChildHandle | null,
    cachedResult?: TransientReviewEntry["cachedResult"],
  ): TransientReviewEntry {
    if (!run.inputFingerprint) throw new Error(`ReviewRun ${run.requestId} is missing its input fingerprint.`);
    return {
      handle,
      ...(cachedResult ? { cachedResult } : {}),
      locale: run.locale,
      provider: run.provider,
      model: run.model,
      workspaceId: run.workspaceId,
      agentId: run.parentAgentId,
      startedAt: Date.parse(run.startedAt),
      mode: run.mode,
      reviewerPermissionMode: run.reviewerPermissionMode,
      ...(run.depth ? { depth: run.depth } : {}),
      ...(run.reviewPreset ? { reviewPreset: run.reviewPreset } : {}),
      resultSource: run.resultSource,
      cacheEnabled: run.cacheEnabled,
      cacheKey: run.cacheKey,
      inputFingerprint: run.inputFingerprint,
      thinkingOptionId: run.thinkingOptionId,
    };
  }

  private matchesReviewRunCache(run: ReviewRun, cached: AiReviewCacheEntry): boolean {
    return cached.key === run.cacheKey &&
      cached.mode === run.mode &&
      cached.provider === run.provider &&
      cached.model === run.model &&
      cached.thinking === run.thinkingOptionId &&
      cached.promptVersion === run.promptVersion &&
      cached.schemaVersion === run.schemaVersion &&
      cached.inputFingerprint === run.inputFingerprint &&
      cached.depth === run.depth;
  }

  private async abandonReviewRun(requestId: string): Promise<ReviewRun | null> {
    return this.reviewRunStore.update(requestId, (current) =>
      current.resultSource !== "cached" &&
      (current.status === "running" || current.status === "completed")
        ? { ...current, status: "abandoned" }
        : current,
    );
  }

  private async restoreTransientReviewEntry(
    input: { requestId: string; workspaceId: string; agentId: string },
    context: PluginHandlerContext,
  ): Promise<ReviewRunRecoveryResult> {
    let run: ReviewRun | null;
    try {
      run = await this.reviewRunStore.get(input.requestId);
    } catch (error) {
      console.error("[Review Deck] Could not read ReviewRun metadata while recovering a poll.", error);
      return { kind: "unavailable", run: null };
    }
    if (!run || run.workspaceId !== input.workspaceId || run.parentAgentId !== input.agentId) {
      return { kind: "unavailable", run };
    }
    if (run.status === "failed" || run.status === "abandoned") return { kind: "unavailable", run };
    if (
      Date.now() - Date.parse(run.startedAt) >= READONLY_REVIEW_ENTRY_TTL_MS ||
      run.promptVersion !== AI_REVIEW_PROMPT_VERSION ||
      run.schemaVersion !== AI_REVIEW_SCHEMA_VERSION ||
      !run.inputFingerprint
    ) {
      const abandoned = await this.abandonReviewRun(run.requestId);
      return { kind: "unavailable", run: abandoned ?? run };
    }

    if (run.resultSource === "cached") {
      let cached: AiReviewCacheEntry | null;
      try {
        cached = await this.aiReviewCacheStore.get(run.cacheKey);
      } catch {
        return { kind: "retry", run };
      }
      if (!cached || !this.matchesReviewRunCache(run, cached)) {
        const abandoned = await this.abandonReviewRun(run.requestId);
        return { kind: "unavailable", run: abandoned ?? run };
      }
      const entry = this.transientEntryFromRun(run, null, {
        review: cached.review,
        sections: cached.sections,
        usage: cached.usage,
      });
      this.transientReviewAgents.set(run.requestId, entry);
      return { kind: "restored", entry };
    }

    if (run.cacheEnabled) {
      try {
        const cached = await this.aiReviewCacheStore.get(run.cacheKey);
        if (cached && this.matchesReviewRunCache(run, cached)) {
          let availableRun = run;
          if (run.status === "running") {
            try {
              availableRun = await this.reviewRunStore.update(run.requestId, (current) =>
                current.status === "running" ? { ...current, status: "completed" } : current,
              ) ?? run;
            } catch (error) {
              console.error(`[Review Deck] Could not mark recovered ReviewRun ${run.requestId} completed.`, error);
            }
          }
          if (availableRun.status === "failed" || availableRun.status === "abandoned") {
            return { kind: "unavailable", run: availableRun };
          }
          const entry = this.transientEntryFromRun(availableRun, null, {
            review: cached.review,
            sections: cached.sections,
            usage: cached.usage,
          });
          this.transientReviewAgents.set(run.requestId, entry);
          return { kind: "restored", entry };
        }
      } catch {
        // A cache miss or damaged optional cache does not prevent Agent recovery.
      }
    }

    let listed: Awaited<ReturnType<PluginHandlerContext["paseo"]["agents"]["list"]>>;
    try {
      listed = await context.paseo.agents.list({
        filter: {
          labels: {
            "review-deck.kind": "ai-review",
            "review-deck.request": run.requestId,
          },
          includeArchived: true,
        },
      });
    } catch {
      return { kind: "retry", run };
    }
    const matches = listed.entries
      .map((entry) => entry.agent)
      .filter((agent) =>
        agent.labels["review-deck.kind"] === "ai-review" &&
        agent.labels["review-deck.request"] === run.requestId &&
        agent.labels["review-deck.mode"] === run.mode,
      );
    if (matches.length !== 1) {
      const abandoned = await this.abandonReviewRun(run.requestId);
      return { kind: "unavailable", run: abandoned ?? run };
    }
    const listedAgent = matches[0]!;
    const parentLabel = listedAgent.labels["paseo.parent-agent-id"];
    if (
      listedAgent.archivedAt !== null ||
      listedAgent.workspaceId !== run.workspaceId ||
      parentLabel !== run.parentAgentId ||
      (run.childAgentId !== null && listedAgent.id !== run.childAgentId)
    ) {
      const abandoned = await this.abandonReviewRun(run.requestId);
      return { kind: "unavailable", run: abandoned ?? run };
    }

    const handle = context.paseo.agents.ref(listedAgent.id);
    let refreshed;
    try {
      refreshed = await handle.refresh();
    } catch {
      return { kind: "retry", run };
    }
    const agent = refreshed?.agent;
    if (
      !agent ||
      agent.archivedAt !== null ||
      agent.workspaceId !== run.workspaceId ||
      agent.labels["review-deck.kind"] !== "ai-review" ||
      agent.labels["review-deck.request"] !== run.requestId ||
      agent.labels["review-deck.mode"] !== run.mode ||
      agent.labels["paseo.parent-agent-id"] !== run.parentAgentId ||
      (run.childAgentId !== null && agent.id !== run.childAgentId)
    ) {
      const abandoned = await this.abandonReviewRun(run.requestId);
      return { kind: "unavailable", run: abandoned ?? run };
    }

    const recorded = run.childAgentId === null
      ? await this.reviewRunStore.update(run.requestId, (current) =>
        current.status === "running" && current.childAgentId === null
          ? { ...current, childAgentId: agent.id }
          : current,
      )
      : run;
    if (
      !recorded ||
      recorded.childAgentId !== agent.id ||
      (recorded.status !== "running" && recorded.status !== "completed")
    ) {
      return { kind: "unavailable", run: recorded ?? run };
    }
    const entry = this.transientEntryFromRun(recorded, handle);
    this.transientReviewAgents.set(run.requestId, entry);
    return { kind: "restored", entry };
  }

  constructor(dependencies: ReviewServiceDependencies = {}) {
    this.settings = dependencies.settings;
    this.store = dependencies.store ?? new StateStore();
    this.aiReviewCacheStore = dependencies.aiReviewCacheStore ?? new AiReviewCacheStore();
    this.reviewBatchStore = dependencies.reviewBatchStore ?? new ReviewBatchStore();
    this.reviewRunStore = dependencies.reviewRunStore ?? new ReviewRunStore();
    this.diffParser = dependencies.diffParser ?? new DiffParser();
    this.repoMutexes = dependencies.repoMutexes ?? new RepoMutexRegistry();
    this.gitFactory = dependencies.gitFactory ?? ((cwd) => new GitRunner(cwd));
    // The verification service reuses this service's workspace binding and
    // target fingerprint: a Verification Terminal run is only ever started and
    // confirmed against the same reviewed target the review itself uses.
    this.verifications = new VerificationService({
      store: dependencies.verificationRunStore ?? new VerificationRunStore(),
      reviewedTarget: (request) => this.verificationTarget(request),
      sameDirectory: (left, right) => this.directoriesMatch(left, right),
      workspaceIdentity: (workspaceId, context) => this.resolveWorkspaceIdentity(workspaceId, context),
    });
  }

  /**
   * Narrow adapter for the Verification service: the worktree path the command
   * runs in, and the fingerprint the run binds to. Both come from the same
   * implementation the review snapshot uses, so a run can never be started
   * against a target the review is not showing.
   */
  private async verificationTarget(
    request: ReviewRequest,
  ): Promise<{ targetFingerprint: string; worktreePath: string }> {
    const { target, targetFingerprint } = await this.fingerprintTarget(request);
    return { targetFingerprint, worktreePath: target.worktreePath };
  }

  /**
   * Start one explicitly confirmed Verification Terminal run: a structured
   * executable + argv typed into an interactive workspace terminal, bound to
   * the workspace, its project, the current target fingerprint, and the
   * command. The caller confirms the exact preview it showed the user; nothing
   * here is ever derived from free-form review text.
   */
  async startVerificationRun(
    input: StartVerificationRunInput,
    context: PluginHandlerContext,
  ): Promise<StartVerificationRunResult> {
    return this.verifications.start(input, context);
  }

  /**
   * Poll one verification run for the state of its workspace terminal. A run
   * captures a bounded tail of output while the terminal exists and never
   * interprets it: `open`/`closed`/`unavailable`/`error` are states of the
   * terminal, not pass/fail verdicts, and no verified fact is ever produced.
   */
  async pollVerificationRun(
    input: PollVerificationRunInput,
    context: PluginHandlerContext,
  ): Promise<PollVerificationRunResult> {
    return this.verifications.poll(input, context);
  }

  /** Current-target verification runs for panel reloads and refreshes. */
  async listVerificationRuns(
    input: ListVerificationRunsInput,
    context: PluginHandlerContext,
  ): Promise<ListVerificationRunsResult> {
    return this.verifications.list(input, context);
  }

  async createSnapshot(request: ReviewRequest): Promise<ReviewSnapshot> {
    const { target, targetFingerprint, untracked } = await this.fingerprintTarget(request);
    const files = this.diffParser.parse(await this.diffFor(request, target, untracked), targetFingerprint, request.locale ?? "en");
    const totalHunks = files.reduce((total, file) => total + file.hunks.length, 0);
    const priorityHunks = files.reduce(
      (total, file) => total + file.hunks.filter((hunk) => hunk.findings.some((finding) => severityRank(finding.severity) >= 4)).length,
      0,
    );
    return {
      repositoryPath: target.repositoryPath,
      worktreePath: target.worktreePath,
      scope: request.scope,
      baseRef: target.baseRef,
      headRef: target.headRef,
      baseSha: target.baseSha,
      headSha: target.headSha,
      targetFingerprint,
      files,
      totalHunks,
      priorityHunks,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Cheap sibling of createSnapshot for the client's refresh watcher: the same
   * target fingerprint createSnapshot stamps on its snapshot, computed from the
   * raw Git state alone — and without parsing a single hunk. The watcher probes
   * this while the user works and requests a full snapshot only when the
   * returned fingerprint differs from the one it currently shows.
   */
  async getTargetFingerprint(request: ReviewRequest): Promise<{ targetFingerprint: string }> {
    const { targetFingerprint } = await this.fingerprintTarget(request);
    return { targetFingerprint };
  }

  /**
   * The one fingerprint implementation shared by createSnapshot and
   * getTargetFingerprint, so the light probe can never disagree with the full
   * snapshot it guards: identity of the reviewed target derived from the raw
   * Git state (repository/worktree/gitDir, scope, refs and their resolved SHAs,
   * the staged and worktree diffs, porcelain status, untracked patches, and
   * the file filter) — never from parsed hunks. Untracked patches are returned
   * so createSnapshot reuses this pass for its diff assembly instead of
   * listing and diffing them twice.
   */
  private async fingerprintTarget(
    request: ReviewRequest,
  ): Promise<{ target: ReviewTarget; targetFingerprint: string; untracked: string[] }> {
    const target = await this.resolveReviewTarget(request);
    const [indexDiff, worktreeDiff, status] = await Promise.all([
      this.gitFactory(target.repositoryPath).run(["diff", "--cached", "--binary", "--no-ext-diff"]),
      this.gitFactory(target.repositoryPath).run(["diff", "--binary", "--no-ext-diff"]),
      this.gitFactory(target.repositoryPath).run(["status", "--porcelain=v2", "-z"]),
    ]);
    const untracked = request.scope === "working" ? await this.collectUntrackedPatches(target.repositoryPath, request) : [];
    const untrackedStateHash = untracked.length > 0 ? sha256(untracked.join("\u0000")) : "";
    const targetFingerprint = sha256(canonicalJson({
      repositoryPath: target.repositoryPath,
      worktreePath: target.worktreePath,
      gitDir: target.gitDir,
      scope: request.scope,
      baseRef: target.baseRef,
      headRef: target.headRef,
      baseSha: target.baseSha,
      headSha: target.headSha,
      indexStateHash: sha256(indexDiff),
      worktreeStateHash: sha256(`${status}\u0000${worktreeDiff}\u0000${untrackedStateHash}`),
      filePath: request.filePath ?? null,
    }));
    return { target, targetFingerprint, untracked };
  }

  findHunk(snapshot: ReviewSnapshot, hunkId: string): Hunk {
    for (const file of snapshot.files) {
      const found = file.hunks.find((hunk) => hunk.id === hunkId);
      if (found) return found;
    }
    throw new Error(`Hunk ${hunkId} is no longer present in this review snapshot.`);
  }
  /**
   * Whole-file view of a hunk's target state (the "+" side), with the given
   * hunks' changed lines overlaid as add/del rows. Content is taken from the
   * worktree (working scope), the index (staged), or the head revision
   * (branch/commits); binary content yields an empty view.
   */
  async fileView(input: FileViewInput): Promise<{ binary: boolean; truncated: boolean; rows: FileViewRow[] }> {
    const { binary, truncated, rows } = await this.fileViewData(input);
    return { binary, truncated, rows };
  }

  private async fileViewData(input: FileViewInput): Promise<FileViewData> {
    const target = await this.resolveReviewTarget(input);
    const gitRunner = this.gitFactory(target.repositoryPath);
    gitRunner.validatePathSpec(input.filePath);
    let content: string | null = null;
    let sourceAvailable = false;
    if (input.scope === "working") {
      try {
        const repositoryPath = await realpath(target.repositoryPath);
        const sourcePath = await realpath(join(repositoryPath, input.filePath));
        const repositoryPrefix = repositoryPath === sep ? repositoryPath : `${repositoryPath}${sep}`;
        if (sourcePath !== repositoryPath && !sourcePath.startsWith(repositoryPrefix)) {
          throw new Error("Review Deck refuses to read a file outside the repository.");
        }
        const buffer = await readFile(sourcePath);
        if (buffer.includes(0)) return { binary: true, truncated: false, complete: false, rows: [] };
        content = buffer.toString("utf8");
        sourceAvailable = true;
      } catch {
        // Unreadable or missing worktree file: fall through to patch-only
        // assembly when hunks are available.
        content = null;
      }
    } else {
      try {
        const spec = input.scope === "staged"
          ? `:${input.filePath}`
          : `${target.headSha ?? target.headRef}:${input.filePath}`;
        const shown = await gitRunner.run(["show", spec]);
        if (shown.includes("\u0000")) return { binary: true, truncated: false, complete: false, rows: [] };
        content = shown;
        sourceAvailable = true;
      } catch {
        // Revision or index lookup failed (e.g. the file does not exist in
        // that state): fall through to patch-only assembly.
        content = null;
      }
    }
    const rows = content === null
      ? input.hunks.length > 0
        ? this.assemblePatchOnly(input.hunks)
        : []
      : this.assembleFileView(content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n"), input.hunks);
    const truncated = rows.length > FILE_VIEW_MAX_ROWS;
    return {
      binary: false,
      truncated,
      complete: sourceAvailable && !truncated,
      rows: truncated ? rows.slice(0, FILE_VIEW_MAX_ROWS) : rows,
    };
  }

  private async loadAnchorFileViews(input: ReviewStateInput): Promise<ReviewAnchorFileView[]> {
    const request = input.request;
    if (!request) return [];
    const stored = await this.store.load();
    const constraints: OwnershipConstraints = {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      cwd: request.cwd,
      scope: request.scope,
    };
    const sourcePaths = new Set<string>();
    for (const entries of Object.values(stored)) {
      for (const entry of entries) {
        if (
          entry.decision === "commented" &&
          entry.comment?.trim() &&
          entry.anchor?.kind === "range" &&
          entry.filePath &&
          ownershipMismatch(entry, constraints) === null
        ) {
          sourcePaths.add(entry.filePath);
        }
      }
    }
    if (sourcePaths.size === 0) return [];

    const groups = new Map<string, ReviewStateCurrentHunk[]>();
    for (const hunk of input.currentHunks) {
      // The hunks already come from the pathspec-scoped snapshot, so no second
      // file filter is applied here: a directory or wildcard filter has no
      // single matching file path to compare against.
      if (!sourcePaths.has(hunk.filePath) && (!hunk.oldPath || !sourcePaths.has(hunk.oldPath))) continue;
      const group = groups.get(hunk.filePath) ?? [];
      group.push(hunk);
      groups.set(hunk.filePath, group);
    }
    if (
      request.filePath &&
      sourcePaths.has(request.filePath) &&
      !groups.has(request.filePath)
    ) {
      groups.set(request.filePath, []);
    }

    const views = await Promise.all([...groups].map(async ([filePath, hunks]) => {
      const cacheKey = canonicalJson([request.cwd, request.scope, input.targetFingerprint, filePath]);
      const cached = this.anchorFileViewCache.get(cacheKey);
      if (cached) {
        this.anchorFileViewCache.delete(cacheKey);
        this.anchorFileViewCache.set(cacheKey, cached);
        return cached;
      }
      try {
        const data = await this.fileViewData({
          ...request,
          filePath,
          targetFingerprint: input.targetFingerprint,
          hunks,
        });
        const view: ReviewAnchorFileView = {
          filePath,
          oldPath: hunks.find((hunk) => hunk.oldPath !== undefined)?.oldPath,
          complete: data.complete,
          binary: data.binary,
          truncated: data.truncated,
          rows: data.rows,
        };
        this.anchorFileViewCache.set(cacheKey, view);
        while (this.anchorFileViewCache.size > ANCHOR_FILE_VIEW_CACHE_SIZE) {
          const oldest = this.anchorFileViewCache.keys().next().value;
          if (oldest === undefined) break;
          this.anchorFileViewCache.delete(oldest);
        }
        return view;
      } catch {
        // An unreadable source is not evidence of a unique match. The engine
        // falls back to manual-only patch candidates for this target.
        return null;
      }
    }));
    return views.filter((view): view is ReviewAnchorFileView => view !== null);
  }
  /**
   * Run one maintenance pass: prune every decision bucket whose newest savedAt
   * is older than 30 days (the shared dead-bucket GC used by reviewState).
   * Serialized through the state store's mutex; the file is only rewritten
   * when something was actually pruned. Returns the number of buckets removed.
   */
  async maintain(): Promise<number> {
    const removed = await this.store.runExclusive(async () => {
      const file = await this.store.load();
      const removed = this.pruneStaleBuckets(file, "");
      if (removed > 0) await this.store.save(file);
      return removed;
    });
    await this.sweepTransientReviewAgents();
    try {
      await this.verifications.prune(VERIFICATION_RUN_TTL_MS);
    } catch (error) {
      // A damaged verification store is left as it is; maintenance keeps going.
      console.error("[Review Deck] Could not prune verification runs.", error);
    }
    return removed;
  }

  /**
   * Start a periodic maintenance timer; the returned function stops it. The
   * timer handle is unref'd when the runtime supports it, so a pending
   * interval never keeps the process alive by itself.
   */
  startMaintenance(intervalMs: number): () => void {
    const timer = setInterval(() => {
      void this.maintain().catch(() => {});
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * Refuse new verification runs before the plugin daemon session closes. The
   * workspace terminals themselves stay open for the user to inspect or close.
   */
  async dispose(): Promise<void> {
    await this.verifications.stop();
  }

  /**
   * Save one hunk decision. The persisted entry always carries a validated
   * anchor (roadmap §5.2): a hunk anchor, or — when the client selected lines —
   * a line range anchor whose hashes and preview are derived from the very
   * patch the decision was taken from, so an unusable range is rejected before
   * anything is written.
   *
   * `supersedes` is the re-anchor write path: after the whole entry (including
   * the new anchor) validated, exactly the comment it names — matched by entry
   * id, and only inside the intended project/workspace/cwd/scope — is removed
   * in the same critical section that stores the replacement, so a re-anchor
   * can never duplicate a comment or strand its original.
   */
  async recordDecision(input: {
    projectId: string;
    cwd: string;
    targetFingerprint: string;
    hunkId: string;
    hunkFingerprint: string;
    filePath: string;
    hunkHeader: string;
    hunkPatch: string;
    decision: StateEntry["decision"];
    scope: ReviewScope;
    projectName?: string;
    projectRootPath?: string;
    workspaceId?: string;
    baseRef?: string;
    headRef?: string;
    comment?: string;
    lineRange?: LineRangeSelection;
    supersedes?: { targetFingerprint: string; entryId: string };
  }): Promise<string> {
    const contentId = hunkContentId(input.filePath, input.hunkPatch);
    const anchor: ReviewAnchor = input.lineRange
      ? buildLineRangeAnchor({
        filePath: input.filePath,
        hunkId: input.hunkId,
        hunkFingerprint: input.hunkFingerprint,
        contentId,
        hunkHeader: input.hunkHeader,
        hunkPatch: input.hunkPatch,
        selection: input.lineRange,
      })
      : {
        kind: "hunk",
        filePath: input.filePath,
        hunkId: input.hunkId,
        hunkFingerprint: input.hunkFingerprint,
        contentId,
      };
    return this.store.runExclusive(async () => {
      const savedAt = new Date().toISOString();
      const file = await this.store.load();
      if (input.supersedes) {
        if (input.decision !== "commented") {
          throw new Error("A re-anchored comment must remain a saved comment.");
        }
        const sourceEntryId = input.supersedes.entryId;
        const conflictingComment = (file[input.targetFingerprint] ?? []).find((entry) =>
          entry.hunkId === input.hunkId &&
          entry.id !== sourceEntryId &&
          entry.decision === "commented" &&
          Boolean(entry.comment?.trim()));
        if (conflictingComment) {
          throw new Error("Another saved comment already owns this change block; preserve or clear it before re-anchoring.");
        }
        this.removeSupersededComment(file, input, input.supersedes);
      }
      const entries = file[input.targetFingerprint] ?? [];
      const next = entries.filter((entry) => entry.hunkId !== input.hunkId);
      next.push({
        id: randomUUID(),
        projectId: input.projectId,
        hunkId: input.hunkId,
        decision: input.decision,
        ...(input.comment ? { comment: input.comment } : {}),
        cwd: input.cwd,
        scope: input.scope,
        targetFingerprint: input.targetFingerprint,
        hunkFingerprint: input.hunkFingerprint,
        filePath: input.filePath,
        hunkHeader: input.hunkHeader,
        hunkPatch: input.hunkPatch,
        contentId,
        anchor,
        anchorState: "exact",
        ...(input.projectName ? { projectName: input.projectName } : {}),
        ...(input.projectRootPath ? { projectRootPath: input.projectRootPath } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.baseRef ? { baseRef: input.baseRef } : {}),
        ...(input.headRef ? { headRef: input.headRef } : {}),
        savedAt,
      });
      file[input.targetFingerprint] = next;
      await this.store.save(file);
      return savedAt;
    });
  }

  /**
   * Remove exactly the comment a re-anchor supersedes. The source is the entry
   * carrying the given id inside the named target bucket; when an earlier
   * resolution already migrated it, the single bucket that still holds the id
   * is used instead. The removal is refused — leaving the store untouched —
   * unless the entry really is a saved comment and its project, workspace, cwd,
   * and scope are compatible with the incoming decision.
   */
  private removeSupersededComment(
    file: StateFile,
    input: { projectId: string; cwd: string; scope: ReviewScope; workspaceId?: string },
    supersedes: { targetFingerprint: string; entryId: string },
  ): void {
    const holders = Object.entries(file)
      .map(([key, entries]) => ({ key, entry: entries.find((candidate) => candidate.id === supersedes.entryId) }))
      .filter((holder): holder is { key: string; entry: StateEntry } => holder.entry !== undefined);
    const named = holders.find((holder) => holder.key === supersedes.targetFingerprint);
    const source = named ?? holders[0];
    if (!source) {
      throw new Error(
        `Superseded comment ${supersedes.entryId} no longer exists in the review state; refresh before re-anchoring it.`,
      );
    }
    if (!named && holders.length > 1) {
      throw new Error(
        `Superseded comment ${supersedes.entryId} exists in ${holders.length} review targets; refresh before re-anchoring it.`,
      );
    }
    const mismatch = ownershipMismatch(source.entry, {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      scope: input.scope,
    });
    if (mismatch) {
      throw new Error(
        `Superseded comment ${supersedes.entryId} belongs to a different ${mismatch} than this decision; refusing to remove it.`,
      );
    }
    if (source.entry.decision !== "commented" || !(source.entry.comment?.trim())) {
      throw new Error(
        `Superseded entry ${supersedes.entryId} is not a saved comment; refusing to remove it.`,
      );
    }
    const next = file[source.key].filter((entry) => entry !== source.entry);
    if (next.length === 0) delete file[source.key];
    else file[source.key] = next;
  }

  /**
   * Resolve the saved decisions against the hunks the client currently shows
   * (roadmap v1.3 §6).
   *
   * Entries that resolve exactly or by relocation are migrated to the current
   * target — identity, anchor position, and the patch fields the handoff
   * prompt reads are rewritten — and returned as decisions. Stale and
   * ambiguous anchors are never auto-selected: they stay where they are, keep
   * their last known anchor state, and are surfaced as anchor issues with their
   * candidate positions so the user can re-anchor them. Migration (and
   * surfacing) is restricted to entries whose cwd/scope match the request and
   * whose project/workspace are compatible, so one worktree's review never
   * leaks into another; a field either side does not define never blocks. A
   * foreign entry that shares the requested bucket is still surfaced as a
   * decision, but it is neither marked nor turned into an anchor issue: the
   * supersede write path refuses to replace another project's comment, so such
   * an issue could never be healed from this review.
   */
  async reviewState(input: ReviewStateInput): Promise<ReviewStateResult> {
    const fileViews = input.currentFileViews ?? await this.loadAnchorFileViews(input);
    return this.store.runExclusive(async () => {
      const file = await this.store.load();
      let changed = false;
      // Fallback GC: whole buckets whose newest decision predates the 30-day
      // window are dead; drop everything but the requested target.
      if (this.pruneStaleBuckets(file, input.targetFingerprint) > 0) changed = true;
      const descriptors = currentHunkDescriptors(input.targetFingerprint, input.currentHunks);
      const requestedPath = input.request?.filePath;
      // request.filePath is a Git pathspec — the snapshot hands it to git — so
      // it may name a directory or a wildcard pattern: every file the snapshot
      // actually contains is relevant, not only an exact string match. A stored
      // path under the filter's directory stays relevant too, so an entry whose
      // file left the diff is still surfaced as a stale anchor issue.
      const relevantFiles = new Set<string>();
      if (requestedPath) {
        relevantFiles.add(requestedPath);
        for (const descriptor of descriptors) {
          relevantFiles.add(descriptor.hunk.filePath);
          if (descriptor.hunk.oldPath) relevantFiles.add(descriptor.hunk.oldPath);
        }
      }
      const requestedDirectory = requestedPath === undefined
        ? null
        : requestedPath.endsWith("/")
          ? requestedPath
          : `${requestedPath}/`;
      const withinRequestedPath = (filePath: string): boolean =>
        relevantFiles.has(filePath) ||
        (requestedDirectory !== null && filePath.startsWith(requestedDirectory));
      const constraints: OwnershipConstraints = {
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        cwd: input.request?.cwd,
        scope: input.request?.scope,
      };
      const decisions: ReviewStateDecision[] = [];
      const issues: ReviewAnchorIssue[] = [];
      const moved: StateEntry[] = [];
      // The requested target's own entries are resolved first, so a migrated
      // entry can neither shadow nor duplicate one the target already holds.
      const presentHunkIds = new Set((file[input.targetFingerprint] ?? []).map((entry) => entry.hunkId));
      const keys = [input.targetFingerprint, ...Object.keys(file).filter((key) => key !== input.targetFingerprint)];
      for (const key of keys) {
        const entries = file[key];
        if (entries === undefined) continue;
        const sameTarget = key === input.targetFingerprint;
        for (const entry of entries) {
          if (requestedPath && (!entry.filePath || !withinRequestedPath(entry.filePath))) continue;
          // An entry whose cwd/scope/project/workspace does not match this
          // review is never migrated. In the requested bucket it still surfaces
          // (the v1.2 bucket semantics), but this review never marks it or
          // raises an issue for it: the supersede write path refuses to replace
          // another project's/workspace's comment, so such an issue could never
          // be healed from here.
          const foreign = ownershipMismatch(entry, constraints) !== null;
          if (!sameTarget && foreign) continue;
          const resolution = resolveAnchor({
            entry,
            descriptors,
            sameTarget,
            // Comments take every drift level; reviewed records keep the v1.2
            // scope (exact fingerprint or content identity only).
            fileViews,
            fullDrift: entry.decision === "commented",
          });
          if (!sameTarget && resolution.descriptor !== undefined && presentHunkIds.has(resolution.descriptor.hunk.hunkId)) {
            if (entry.decision === "commented") {
              // A current decision already owns this hunk. Never silently drop
              // an older comment: preserve it as an explicit ambiguity, and let
              // the supersede write path refuse to overwrite another comment.
              const descriptor = resolution.descriptor;
              const candidate: ReviewAnchor = resolution.anchor?.kind === "range" || resolution.anchor?.kind === "hunk"
                ? resolution.anchor
                : {
                  kind: "hunk",
                  filePath: descriptor.hunk.filePath,
                  hunkId: descriptor.hunk.hunkId,
                  hunkFingerprint: descriptor.fingerprint,
                  contentId: descriptor.contentId,
                };
              const collision: AnchorResolution = { ...resolution, state: "ambiguous", candidates: [candidate] };
              if (!foreign && entry.anchor !== undefined && entry.anchorState !== "ambiguous") {
                entry.anchorState = "ambiguous";
                changed = true;
              }
              const issue = foreign ? null : this.anchorIssue(entry, key, collision);
              if (issue) issues.push(issue);
            }
            continue;
          }
          if (resolution.state === "exact" || resolution.state === "relocated") {
            if (this.applyAnchorResolution(entry, resolution, input.targetFingerprint) > 0) changed = true;
            if (!sameTarget) {
              if (resolution.descriptor !== undefined) presentHunkIds.add(resolution.descriptor.hunk.hunkId);
              moved.push(entry);
            }
            decisions.push(this.decisionRow(entry, resolution.state));
            continue;
          }
          // Stale and ambiguous anchors stay where they are (the old target may
          // return, making them exact again); comments are surfaced with their
          // candidate positions, and every anchor keeps its last known state.
          if (!foreign && entry.anchor !== undefined && entry.anchorState !== resolution.state) {
            entry.anchorState = resolution.state;
            changed = true;
          }
          const issue = foreign ? null : this.anchorIssue(entry, key, resolution);
          if (issue) issues.push(issue);
        }
      }
      if (moved.length > 0) {
        const moving = new Set(moved);
        for (const key of Object.keys(file)) {
          if (key === input.targetFingerprint) continue;
          const entries = file[key];
          const next = entries.filter((entry) => !moving.has(entry));
          if (next.length === entries.length) continue;
          if (next.length === 0) delete file[key];
          else file[key] = next;
          changed = true;
        }
        file[input.targetFingerprint] = [...(file[input.targetFingerprint] ?? []), ...moved];
      }
      if (changed) await this.store.save(file);
      issues.sort((left, right) => left.savedAt.localeCompare(right.savedAt) || left.id.localeCompare(right.id));
      return { decisions, anchorIssues: issues };
    });
  }

  /**
   * Write a resolution back onto an entry: its current target, the resolved
   * hunk identity, the anchor rewritten for the current target, and — for a
   * relocation — the patch fields the handoff prompt reads, so the stored
   * fingerprint and the stored patch always describe the same hunk. Returns
   * the number of fields that changed, so an unchanged resolution never
   * rewrites the store.
   */
  private applyAnchorResolution(entry: StateEntry, resolution: AnchorResolution, targetFingerprint: string): number {
    let changes = 0;
    if (entry.targetFingerprint !== targetFingerprint) {
      entry.targetFingerprint = targetFingerprint;
      changes += 1;
    }
    const descriptor = resolution.descriptor;
    if (descriptor) {
      if (entry.hunkId !== descriptor.hunk.hunkId) {
        entry.hunkId = descriptor.hunk.hunkId;
        changes += 1;
      }
      if (entry.hunkFingerprint !== descriptor.fingerprint) {
        entry.hunkFingerprint = descriptor.fingerprint;
        changes += 1;
      }
      if (entry.contentId !== descriptor.contentId) {
        entry.contentId = descriptor.contentId;
        changes += 1;
      }
      if (entry.filePath !== descriptor.hunk.filePath) {
        entry.filePath = descriptor.hunk.filePath;
        changes += 1;
      }
      if (resolution.state === "relocated") {
        if (entry.hunkHeader !== descriptor.hunk.hunkHeader) {
          entry.hunkHeader = descriptor.hunk.hunkHeader;
          changes += 1;
        }
        if (entry.hunkPatch !== descriptor.hunk.hunkPatch) {
          entry.hunkPatch = descriptor.hunk.hunkPatch;
          changes += 1;
        }
      }
    }
    if (resolution.anchor !== undefined && canonicalJson(entry.anchor) !== canonicalJson(resolution.anchor)) {
      entry.anchor = resolution.anchor;
      changes += 1;
    }
    if (entry.anchor !== undefined && entry.anchorState !== resolution.state) {
      entry.anchorState = resolution.state;
      changes += 1;
    }
    return changes;
  }

  /** One resolved entry as the review-state RPC exposes it. */
  private decisionRow(entry: StateEntry, anchorState: AnchorState): ReviewStateDecision {
    return {
      ...(entry.id !== undefined ? { id: entry.id } : {}),
      hunkId: entry.hunkId,
      decision: entry.decision,
      ...(entry.comment !== undefined ? { comment: entry.comment } : {}),
      savedAt: entry.savedAt,
      ...(entry.anchor !== undefined ? { anchor: entry.anchor } : {}),
      anchorState,
    };
  }

  /**
   * The re-anchor issue of one stale or ambiguous comment: its original anchor,
   * the candidate positions detected in the current target, and the body the
   * user wrote. Only a saved comment can be re-anchored, so the predicate
   * matches the supersede path exactly: a reviewed record, an entry without an
   * id, and an entry without comment text are never surfaced.
   */
  private anchorIssue(
    entry: StateEntry,
    sourceTargetFingerprint: string,
    resolution: AnchorResolution,
  ): ReviewAnchorIssue | null {
    const comment = entry.comment?.trim();
    const anchor = entry.anchor;
    if (resolution.state !== "ambiguous" && resolution.state !== "stale") return null;
    if (entry.decision !== "commented" || entry.id === undefined || anchor === undefined) return null;
    if (entry.filePath === undefined || !comment) return null;
    return {
      id: entry.id,
      sourceTargetFingerprint,
      sourceHunkId: entry.hunkId,
      filePath: entry.filePath,
      anchor,
      anchorState: resolution.state,
      candidates: resolution.candidates,
      matchCount: resolution.matchCount ?? resolution.candidates.length,
      comment,
      savedAt: entry.savedAt,
    };
  }

  /**
   * Remove a single hunk's saved decision. Returns false when the target or the
   * hunk has no saved entry; the target key is dropped when its array empties.
   */
  async clearHunkState(targetFingerprint: string, hunkId: string): Promise<boolean> {
    return this.store.runExclusive(async () => {
      const file = await this.store.load();
      const entries = file[targetFingerprint];
      if (!entries || entries.length === 0) return false;
      const next = entries.filter((entry) => entry.hunkId !== hunkId);
      if (next.length === entries.length) return false;
      if (next.length === 0) delete file[targetFingerprint];
      else file[targetFingerprint] = next;
      await this.store.save(file);
      return true;
    });
  }

  /** Remove every saved decision for one target fingerprint. Returns whether any existed. */
  async clearReviewState(targetFingerprint: string): Promise<boolean> {
    return this.store.runExclusive(async () => {
      const file = await this.store.load();
      const entries = file[targetFingerprint];
      if (entries === undefined) return false;
      delete file[targetFingerprint];
      await this.store.save(file);
      return true;
    });
  }

  /**
   * Summarize the saved decisions of every target fingerprint. cwd/scope are taken
   * from the latest entry that carries them; lastSavedAt is the newest savedAt;
   * commentCount counts entries that store a comment.
   */
  async listReviewStates(): Promise<
    Array<{
      targetFingerprint: string;
      cwd?: string;
      scope?: ReviewScope;
      decisionCount: number;
      commentCount: number;
      lastSavedAt: string;
    }>
  > {
    const file = await this.store.load();
    return Object.entries(file).map(([targetFingerprint, entries]) => {
      let cwd: string | undefined;
      let scope: ReviewScope | undefined;
      let lastSavedAt = "";
      let commentCount = 0;
      for (const entry of [...entries].sort((left, right) => left.savedAt.localeCompare(right.savedAt))) {
        if (entry.savedAt > lastSavedAt) lastSavedAt = entry.savedAt;
        if (entry.cwd !== undefined) cwd = entry.cwd;
        if (entry.scope !== undefined) scope = entry.scope;
        if (entry.comment) commentCount += 1;
      }
      return {
        targetFingerprint,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(scope !== undefined ? { scope } : {}),
        decisionCount: entries.length,
        commentCount,
        lastSavedAt,
      };
    });
  }

  /** Wipe every saved decision; returns the number of targets that were cleared (0 when already empty). */
  async clearAllReviewStates(): Promise<number> {
    return this.store.runExclusive(async () => {
      const file = await this.store.load();
      const count = Object.keys(file).length;
      if (count === 0) return 0;
      await this.store.save({});
      return count;
    });
  }

  /**
   * List a project's queued comments and in-flight batches. Completed outcomes
   * are reconciled against the queue before the summary is returned.
   */
  async listProjectReviewComments(
    projectId: string,
    context?: PluginHandlerContext,
  ): Promise<ProjectReviewSummary | null> {
    if (context) await this.reconcileStalledReviewBatches(projectId, context);
    const storedBatches = await this.reviewBatchStore.listByProject(projectId);
    const completedCommentIds = [...new Set(storedBatches
      .filter((batch) => !isActiveReviewBatch(batch.status))
      .flatMap((batch) => batch.commentIds.filter((commentId) => batch.outcomes[commentId] === "completed")))];
    if (completedCommentIds.length > 0) {
      await this.clearProjectReviewComments(projectId, completedCommentIds);
    }
    const [file, activeBatches] = await Promise.all([
      this.store.load(),
      this.reviewBatchStore.listActiveByProject(projectId),
    ]);
    const comments = sortProjectComments(this.projectComments(file, projectId));
    if (comments.length === 0 && activeBatches.length === 0) return null;
    const identity = comments.length > 0 ? this.projectCommentIdentity(comments) : null;
    return {
      projectId,
      ...(identity?.projectName !== undefined ? { projectName: identity.projectName } : {}),
      ...(identity?.projectRootPath !== undefined ? { projectRootPath: identity.projectRootPath } : {}),
      commentCount: comments.length,
      fileCount: new Set(comments.map((comment) => comment.filePath)).size,
      targetCount: new Set(comments.map((comment) => comment.targetFingerprint)).size,
      comments,
      batches: activeBatches.map((batch): ActiveReviewBatch => ({
        id: batch.id,
        workspaceId: batch.workspaceId,
        agentId: batch.agentId,
        commentIds: batch.commentIds,
        status: batch.status as ActiveReviewBatch["status"],
        ...(batch.delivery ? { delivery: batch.delivery } : {}),
      })),
    };
  }

  private async reconcileStalledReviewBatches(projectId: string, context: PluginHandlerContext): Promise<void> {
    const batches = await this.reviewBatchStore.listActiveByProject(projectId);
    for (const batch of batches) {
      if (this.sendingReviewBatchIds.has(batch.id)) continue;
      let current = batch;
      if (!current.delivery) continue;
      if (current.delivery.phase === "rejected") {
        await this.failActiveBatchAsUnresolved(current.id, context);
        continue;
      }
      if (current.delivery.phase === "sending") {
        const recovered = await this.reviewBatchStore.update(current.id, (stored) => {
          if (!isActiveReviewBatch(stored.status) || stored.delivery?.phase !== "sending") return stored;
          return {
            ...stored,
            delivery: {
              ...stored.delivery,
              phase: "unknown",
              updatedAt: new Date().toISOString(),
              lastErrorCode: "send_interrupted",
            },
          };
        });
        if (!recovered || !isActiveReviewBatch(recovered.status)) continue;
        current = recovered;
      }
      if (!current.delivery) continue;
      if (
        (current.delivery.phase === "unknown" || current.delivery.phase === "accepted") &&
        current.turnId === undefined
      ) {
        const observed = await this.findReviewBatchTimelineMessage(current, context);
        if (!observed.found) continue;
        const acceptedAt = new Date().toISOString();
        const recovered = await this.reviewBatchStore.update(current.id, (stored) => {
          if (
            !isActiveReviewBatch(stored.status) ||
            !stored.delivery ||
            stored.delivery.messageId !== current.delivery?.messageId ||
            (observed.turnId !== null && stored.turnId !== undefined && stored.turnId !== observed.turnId)
          ) return stored;
          return {
            ...stored,
            ...(observed.turnId !== null ? {
              status: "running",
              submittedAt: stored.submittedAt ?? acceptedAt,
              turnId: stored.turnId ?? observed.turnId,
            } : {}),
            delivery: stored.delivery.phase === "accepted"
              ? stored.delivery
              : { ...stored.delivery, phase: "accepted", updatedAt: acceptedAt },
          };
        });
        if (!recovered || !isActiveReviewBatch(recovered.status)) continue;
        current = recovered;
        if (recovered.submittedAt) await this.appendReviewBatchTimeline(recovered, context);
        if (observed.turnId === null) continue;
      }
      const delivery = current.delivery;
      if (!delivery) continue;
      if (delivery.phase === "rejected") {
        await this.failActiveBatchAsUnresolved(current.id, context);
        continue;
      }
      const turnWasObserved = current.turnId !== undefined;
      if ((delivery.phase === "accepted" || delivery.phase === "unknown") && !turnWasObserved) continue;
      const startExpired = delivery.phase === "prepared" &&
        (current.status === "draft" || current.status === "submitted") &&
        Date.now() - Date.parse(current.createdAt) >= REVIEW_BATCH_START_TIMEOUT_MS;
      const handle = context.paseo.agents.ref(current.agentId);
      let refreshed;
      try {
        refreshed = await handle.refresh();
      } catch {
        // An RPC/transport failure is not evidence that the Agent is gone.
        continue;
      }
      const agent = refreshed?.agent;
      if (!agent) continue;
      if (!agent.archivedAt && (agent.status === "running" || agent.status === "initializing")) continue;
      if (!turnWasObserved && !startExpired) continue;
      await this.failActiveBatchAsUnresolved(current.id, context);
    }
  }

  private async failActiveBatchAsUnresolved(
    batchId: string,
    context: PluginHandlerContext | PluginHookContext,
  ): Promise<void> {
    const completedAt = new Date().toISOString();
    let finalized = false;
    const updated = await this.reviewBatchStore.update(batchId, (current) => {
      if (!isActiveReviewBatch(current.status)) return current;
      finalized = true;
      const outcomes = Object.fromEntries(
        current.commentIds.map((commentId): [string, ReviewCommentOutcome] => [commentId, "unresolved"]),
      );
      return { ...current, status: "failed", outcomes, completedAt };
    });
    if (finalized && updated) await this.appendReviewBatchTimeline(updated, context);
  }

  /**
   * Count one project's saved review comments. The count-only sibling of
   * listProjectReviewComments for the client's project badge: it applies the
   * same comment predicate (projectId + commented + non-blank body) but never
   * materializes a comment row, so no comment body leaves the state store.
   */
  async getProjectReviewCommentCount(projectId: string): Promise<{ commentCount: number }> {
    const file = await this.store.load();
    return { commentCount: this.countProjectComments(file, projectId) };
  }

  private countProjectComments(file: StateFile, projectId: string): number {
    let commentCount = 0;
    for (const entries of Object.values(file)) {
      for (const entry of entries) {
        if (this.projectCommentBody(entry, projectId) !== null) commentCount += 1;
      }
    }
    return commentCount;
  }

  /**
   * The workspace binding every v1.7 activity RPC starts from: the project the
   * workspace belongs to and the directory its reviews run in, both resolved
   * from Paseo instead of trusted from the caller. Fails closed when the
   * workspace cannot be resolved, answers for a different id, or declares no
   * project/directory of its own, so a stale, archived, or forged workspace id
   * can never report or mark another workspace's activity.
   */
  private async resolveWorkspaceIdentity(
    workspaceId: string,
    context: PluginHandlerContext,
  ): Promise<{ workspaceId: string; projectId: string; directory: string }> {
    const handle = context.paseo.workspaces.ref(workspaceId);
    let workspace: {
      id?: string;
      projectId?: string | null;
      workspaceDirectory?: string | null;
      archivingAt?: string | null;
    } | null | undefined;
    try {
      workspace = (await handle.refresh()) ?? handle.current();
    } catch {
      workspace = handle.current();
    }
    if (!workspace) {
      throw new Error(
        `Workspace ${workspaceId} does not exist; refusing to report Review Deck activity for an unknown workspace.`,
      );
    }
    if (workspace.id !== undefined && workspace.id !== workspaceId) {
      throw new Error(
        `Workspace ${workspaceId} resolved to workspace ${workspace.id}; refusing to report mismatched Review Deck activity.`,
      );
    }
    if (typeof workspace.archivingAt === "string" && workspace.archivingAt.length > 0) {
      throw new Error(
        `Workspace ${workspaceId} is being archived; refusing to report Review Deck activity for it.`,
      );
    }
    const projectId = typeof workspace.projectId === "string" && workspace.projectId.length > 0
      ? workspace.projectId
      : null;
    const directory = typeof workspace.workspaceDirectory === "string" && workspace.workspaceDirectory.length > 0
      ? workspace.workspaceDirectory
      : null;
    if (!projectId || !directory) {
      throw new Error(
        `Workspace ${workspaceId} declares no project and directory; refusing to report Review Deck activity for it.`,
      );
    }
    return { workspaceId, projectId, directory };
  }

  /**
   * Count one workspace's queued review comments without ever building a
   * comment row: the queue predicate is the same one the project list uses
   * (projectId + commented + non-blank body), and the workspace binding is the
   * comment's recorded workspaceId. The pending counter and the stale counter
   * are disjoint action categories — a comment whose stored anchor is stale or
   * ambiguous counts as stale, every other comment counts as pending — so
   * pending + stale is the raw queued total and the header can show both
   * without double counting. A legacy comment saved before v1.4 recorded a
   * workspaceId belongs to this workspace only when its recorded cwd is the
   * workspace directory and this workspace is the project's sole owner of that
   * directory — never when the directory is shared, so one comment can never be
   * counted into two workspaces. The counters carry bodies nowhere: the strings
   * are inspected inside this method and discarded with it.
   */
  private async countWorkspaceReviewComments(
    file: StateFile,
    identity: { workspaceId: string; projectId: string; directory: string },
    context: PluginHandlerContext,
  ): Promise<{
    projectPendingCommentCount: number;
    projectStaleCommentCount: number;
    workspacePendingCommentCount: number;
    workspaceStaleCommentCount: number;
  }> {
    let projectPendingCommentCount = 0;
    let projectStaleCommentCount = 0;
    let workspacePendingCommentCount = 0;
    let workspaceStaleCommentCount = 0;
    // Resolved at most once per call, and only when a legacy row is actually
    // considered, so a store without legacy rows pays no workspace-list read.
    let legacyAssignable: boolean | null = null;
    for (const entries of Object.values(file)) {
      for (const entry of entries) {
        if (this.projectCommentBody(entry, identity.projectId) === null) continue;
        // Pending and stale are disjoint: a comment whose stored resolution
        // could not attach to a hunk (stale or ambiguous) is a stale item, and
        // every other queued comment is a pending item.
        const stale = entry.anchorState === "stale" || entry.anchorState === "ambiguous";
        if (stale) projectStaleCommentCount += 1;
        else projectPendingCommentCount += 1;
        let inWorkspace: boolean;
        if (entry.workspaceId !== undefined) {
          inWorkspace = entry.workspaceId === identity.workspaceId;
        } else if (entry.cwd === undefined) {
          inWorkspace = false;
        } else {
          if (legacyAssignable === null) {
            legacyAssignable = await this.legacyCommentsBelongToWorkspace(identity, context);
          }
          inWorkspace = legacyAssignable && await this.directoriesMatch(entry.cwd, identity.directory);
        }
        if (!inWorkspace) continue;
        if (stale) workspaceStaleCommentCount += 1;
        else workspacePendingCommentCount += 1;
      }
    }
    return {
      projectPendingCommentCount,
      projectStaleCommentCount,
      workspacePendingCommentCount,
      workspaceStaleCommentCount,
    };
  }

  /**
   * Whether this workspace is the project's sole owner of its directory — the
   * only case in which a legacy comment (saved before v1.4 recorded a
   * workspaceId) may be counted as this workspace's. Resolved from Paseo in one
   * unpaged list: a failed list, a truncated page, or a second listed
   * workspace resolving to the same directory all keep legacy comments
   * project-scoped instead of guessing a workspace.
   */
  private async legacyCommentsBelongToWorkspace(
    identity: { workspaceId: string; projectId: string; directory: string },
    context: PluginHandlerContext,
  ): Promise<boolean> {
    let listed: {
      entries: ReadonlyArray<{ id: string; workspaceDirectory?: string }>;
      pageInfo: { hasMore: boolean };
    };
    try {
      listed = await context.paseo.workspaces.list({ filter: { projectId: identity.projectId } });
    } catch {
      return false;
    }
    if (listed.pageInfo.hasMore) return false;
    const owners: string[] = [];
    for (const workspace of listed.entries) {
      if (!workspace.workspaceDirectory) continue;
      if (!(await this.directoriesMatch(workspace.workspaceDirectory, identity.directory))) continue;
      owners.push(workspace.id);
    }
    return owners.length === 1 && owners[0] === identity.workspaceId;
  }

  /**
   * Metadata-only activity of one workspace: queued comment counts (project
   * and workspace scoped), stored stale/ambiguous anchor counts, in-flight
   * batches, running AI review runs, and the findings of completed runs the
   * user has not opened Review Deck for yet. Pending and stale are disjoint
   * action categories — pending + stale is the raw queued total — and the
   * header can therefore show both without double counting. Reads no Git state
   * — the detailed summary owns that — so the header badge stays cheap, and
   * stale counts come from the states the last resolution stored.
   */
  async getWorkspaceReviewIndicators(
    input: { workspaceId: string },
    context: PluginHandlerContext,
  ): Promise<ReviewWorkspaceIndicators> {
    return this.workspaceReviewIndicators(await this.resolveWorkspaceIdentity(input.workspaceId, context), context);
  }

  private async workspaceReviewIndicators(
    identity: { workspaceId: string; projectId: string; directory: string },
    context: PluginHandlerContext,
  ): Promise<ReviewWorkspaceIndicators> {
    const [file, batches, runs] = await Promise.all([
      this.store.load(),
      this.reviewBatchStore.list(),
      this.reviewRunStore.list(),
    ]);
    const commentCounts = await this.countWorkspaceReviewComments(file, identity, context);
    return {
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      ...commentCounts,
      activeBatchCount: batches.filter(
        (batch) => batch.workspaceId === identity.workspaceId && isActiveReviewBatch(batch.status),
      ).length,
      deliveryUnknownBatchCount: batches.filter(
        (batch) =>
          batch.workspaceId === identity.workspaceId &&
          isActiveReviewBatch(batch.status) &&
          (!batch.delivery || batch.delivery.phase === "sending" || batch.delivery.phase === "unknown"),
      ).length,
      runningAiReviewCount: runs.filter(
        (run) => run.workspaceId === identity.workspaceId && run.status === "running",
      ).length,
      unreadAiFindingCount: runs.reduce(
        (total, run) => run.workspaceId === identity.workspaceId &&
          run.mode !== "hunk" &&
          run.status === "completed" &&
          run.readAt === undefined
          ? total + (run.findingCount ?? 0)
          : total,
        0,
      ),
    };
  }

  /**
   * The detailed popover summary: the indicators plus the reviewed/total block
   * counts of the workspace's default working-tree snapshot. The anchors of
   * that snapshot are refreshed first — resolving entries against the current
   * working tree exactly like the panel does, migrating and re-stating what
   * resolves — so the stale/ambiguous counts describe the current target
   * instead of the last stored resolution, and a block counts as reviewed when
   * it carries a saved decision, the same mark the panel shows. A workspace
   * whose working tree cannot be resolved fails closed rather than reporting
   * fabricated progress.
   */
  async getWorkspaceReviewSummary(
    input: { workspaceId: string },
    context: PluginHandlerContext,
  ): Promise<WorkspaceReviewSummary> {
    const identity = await this.resolveWorkspaceIdentity(input.workspaceId, context);
    const snapshot = await this.createSnapshot({ cwd: identity.directory, scope: "working" });
    const currentHunks: ReviewStateCurrentHunk[] = snapshot.files.flatMap((file) =>
      file.hunks.map((hunk) => ({
        hunkId: hunk.id,
        filePath: hunk.filePath,
        ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
        hunkHeader: hunk.header,
        hunkPatch: hunk.patch,
      })),
    );
    const resolved = await this.reviewState({
      targetFingerprint: snapshot.targetFingerprint,
      currentHunks,
      request: { cwd: identity.directory, scope: "working" },
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
    });
    const indicators = await this.workspaceReviewIndicators(identity, context);
    const currentHunkIds = new Set(currentHunks.map((hunk) => hunk.hunkId));
    const constraints: OwnershipConstraints = {
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      cwd: identity.directory,
      scope: "working",
    };
    const targetEntries = (await this.store.load())[snapshot.targetFingerprint] ?? [];
    let legacyDirectoryOwner: boolean | null = null;
    const ownedCurrentHunkIds = new Set<string>();
    for (const entry of targetEntries) {
      if (ownershipMismatch(entry, constraints) !== null) continue;
      if (entry.workspaceId === undefined) {
        if (!entry.cwd) continue;
        if (legacyDirectoryOwner === null) {
          legacyDirectoryOwner = await this.legacyCommentsBelongToWorkspace(identity, context);
        }
        if (!legacyDirectoryOwner || !(await this.directoriesMatch(entry.cwd, identity.directory))) continue;
      }
      if (currentHunkIds.has(entry.hunkId)) ownedCurrentHunkIds.add(entry.hunkId);
    }
    const reviewedHunkIds = new Set(
      resolved.decisions
        .map((decision) => decision.hunkId)
        .filter((hunkId) => currentHunkIds.has(hunkId) && ownedCurrentHunkIds.has(hunkId)),
    );
    return {
      ...indicators,
      reviewedBlockCount: reviewedHunkIds.size,
      totalBlockCount: snapshot.totalHunks,
    };
  }

  /**
   * Opening the deck: every completed file or target run of the workspace that
   * reported at least one finding and has not been read yet is stamped with one
   * readAt, and the answer counts the runs this call actually transitioned.
   * Hunk explanations carry no tally and runs with nothing to read are left
   * alone, so the mark only ever covers what the unread counter reported. Each
   * run goes through its own ReviewRunStore update, so the check and the write
   * are a single atomic read-modify-write — a concurrent opening that loses the
   * race observes the stored readAt and leaves it alone instead of counting the
   * run twice.
   */
  async markWorkspaceReviewResultsRead(
    input: { workspaceId: string },
    context: PluginHandlerContext,
  ): Promise<{ markedRunCount: number }> {
    const identity = await this.resolveWorkspaceIdentity(input.workspaceId, context);
    const runs = await this.reviewRunStore.list();
    const readAt = new Date().toISOString();
    let markedRunCount = 0;
    for (const run of runs) {
      if (
        run.workspaceId !== identity.workspaceId ||
        run.mode === "hunk" ||
        run.status !== "completed" ||
        run.readAt !== undefined ||
        (run.findingCount ?? 0) <= 0
      ) continue;
      const updated = await this.reviewRunStore.update(run.requestId, (current) =>
        current.workspaceId === identity.workspaceId &&
          current.mode !== "hunk" &&
          current.status === "completed" &&
          (current.findingCount ?? 0) > 0 &&
          current.readAt === undefined
          ? { ...current, readAt }
          : current,
      );
      if (updated?.readAt === readAt) markedRunCount += 1;
    }
    return { markedRunCount };
  }

  private projectCommentPreflightIdentity(comment: ProjectReviewComment): string {
    return canonicalJson([
      comment.id,
      comment.projectId,
      comment.workspaceId ?? null,
      comment.targetFingerprint,
      comment.hunkId,
      comment.hunkFingerprint,
      comment.filePath,
      comment.hunkHeader,
      comment.hunkPatch,
      comment.cwd,
      comment.scope,
      comment.baseRef ?? null,
      comment.headRef ?? null,
      comment.comment,
      comment.savedAt,
      comment.anchor ?? null,
      comment.anchorState ?? null,
    ]);
  }

  /**
   * Resolve every selected comment against a fresh snapshot before dispatch.
   * This is read-only: stale or ambiguous anchors fail the whole batch, while
   * unique relocations are reflected only in the prompt payload.
   */
  private async preflightProjectReviewComments(
    comments: readonly ProjectReviewComment[],
    selectedIds: ReadonlySet<string>,
    identity: { projectId: string; workspaceId: string; directory: string },
  ): Promise<ProjectReviewComment[]> {
    const state = await this.store.load();
    const currentComments = sortProjectComments(this.projectComments(state, identity.projectId))
      .filter((comment) => selectedIds.has(comment.id));
    const currentIds = new Set(currentComments.map((comment) => comment.id));
    if (
      currentComments.length !== selectedIds.size ||
      currentIds.size !== selectedIds.size ||
      currentComments.some((comment, index) => comment.id !== comments[index]?.id)
    ) {
      throw new Error("The selected comments changed during preflight. Refresh the queue and confirm the batch again.");
    }
    const currentById = new Map(currentComments.map((comment) => [comment.id, comment]));
    for (const comment of comments) {
      const current = currentById.get(comment.id);
      if (
        !current ||
        this.projectCommentPreflightIdentity(current) !== this.projectCommentPreflightIdentity(comment)
      ) {
        throw new Error("The selected comments changed during preflight. Refresh the queue and confirm the batch again.");
      }
    }

    const entriesById = new Map<string, StateEntry[]>();
    for (const entries of Object.values(state)) {
      for (const entry of entries) {
        if (!entry.id || !selectedIds.has(entry.id)) continue;
        const matches = entriesById.get(entry.id) ?? [];
        matches.push(entry);
        entriesById.set(entry.id, matches);
      }
    }
    const targets = new Map<string, { request: ReviewRequest; comments: ProjectReviewComment[] }>();
    for (const comment of currentComments) {
      const request: ReviewRequest = {
        cwd: identity.directory,
        scope: comment.scope,
        ...(comment.baseRef !== undefined ? { baseRef: comment.baseRef } : {}),
        ...(comment.headRef !== undefined ? { headRef: comment.headRef } : {}),
      };
      const key = canonicalJson([request.cwd, request.scope, request.baseRef ?? null, request.headRef ?? null]);
      const target = targets.get(key) ?? { request, comments: [] };
      target.comments.push(comment);
      targets.set(key, target);
    }

    const preflighted = new Map<string, ProjectReviewComment>();
    const constraints: OwnershipConstraints = {
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      cwd: identity.directory,
    };
    for (const { request, comments: targetComments } of targets.values()) {
      const snapshot = await this.createSnapshot(request);
      const currentHunks: ReviewStateCurrentHunk[] = snapshot.files.flatMap((file) =>
        file.hunks.map((hunk) => ({
          hunkId: hunk.id,
          filePath: hunk.filePath,
          ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
          hunkHeader: hunk.header,
          hunkPatch: hunk.patch,
        })),
      );
      const descriptors = currentHunkDescriptors(snapshot.targetFingerprint, currentHunks);
      const fileViews = await this.loadAnchorFileViews({
        targetFingerprint: snapshot.targetFingerprint,
        currentHunks,
        request,
        projectId: identity.projectId,
        workspaceId: identity.workspaceId,
      });
      for (const comment of targetComments) {
        const entries = entriesById.get(comment.id) ?? [];
        if (entries.length !== 1) {
          throw new Error(`Comment ${comment.id} no longer has one unambiguous stored record. Refresh the queue.`);
        }
        const entry = entries[0]!;
        if (entry.decision !== "commented" || ownershipMismatch(entry, { ...constraints, scope: comment.scope }) !== null) {
          throw new Error(`Comment ${comment.id} no longer belongs to the selected workspace and review scope.`);
        }
        const resolution = resolveAnchor({
          entry,
          descriptors,
          sameTarget: entry.targetFingerprint === snapshot.targetFingerprint,
          fullDrift: true,
          fileViews,
        });
        if ((resolution.state !== "exact" && resolution.state !== "relocated") || !resolution.descriptor) {
          throw new Error(`Comment ${comment.id} is stale or ambiguous at the current target. Re-anchor it before submission.`);
        }
        const descriptor = resolution.descriptor;
        preflighted.set(comment.id, {
          ...comment,
          targetFingerprint: snapshot.targetFingerprint,
          hunkId: descriptor.hunk.hunkId,
          hunkFingerprint: descriptor.fingerprint,
          filePath: descriptor.hunk.filePath,
          hunkHeader: descriptor.hunk.hunkHeader,
          hunkPatch: descriptor.hunk.hunkPatch,
          anchor: resolution.anchor ?? entry.anchor ?? {
            kind: "hunk",
            filePath: descriptor.hunk.filePath,
            hunkId: descriptor.hunk.hunkId,
            hunkFingerprint: descriptor.fingerprint,
            contentId: descriptor.contentId,
          },
          anchorState: resolution.state,
        });
      }
    }
    const finalState = await this.store.load();
    const finalComments = sortProjectComments(this.projectComments(finalState, identity.projectId))
      .filter((comment) => selectedIds.has(comment.id));
    const finalIds = new Set(finalComments.map((comment) => comment.id));
    if (
      finalComments.length !== selectedIds.size ||
      finalIds.size !== selectedIds.size ||
      finalComments.some((comment, index) => comment.id !== currentComments[index]?.id)
    ) {
      throw new Error("The selected comments changed during preflight. Refresh the queue and confirm the batch again.");
    }
    const finalById = new Map(finalComments.map((comment) => [comment.id, comment]));
    for (const comment of currentComments) {
      const final = finalById.get(comment.id);
      if (!final || this.projectCommentPreflightIdentity(final) !== this.projectCommentPreflightIdentity(comment)) {
        throw new Error("The selected comments changed during preflight. Refresh the queue and confirm the batch again.");
      }
    }
    return currentComments.map((comment) => {
      const current = preflighted.get(comment.id);
      if (!current) throw new Error(`Comment ${comment.id} did not resolve during preflight.`);
      return current;
    });
  }

  /**
   * Submit exactly one workspace's selected comments. Their records remain in
   * the queue until the matching Agent turn explicitly reports COMPLETED.
   */
  async processProjectReview(
    input: {
      projectId: string;
      agentId: string;
      workspaceId: string;
      workspaceCwd: string;
      commentIds: string[];
    },
    context: PluginHandlerContext,
  ): Promise<ProcessProjectReviewResult> {
    const requestedIds = new Set(input.commentIds);
    if (requestedIds.size !== input.commentIds.length) {
      throw new Error("A ReviewBatch cannot contain duplicate comment ids.");
    }
    const identity = await this.resolveWorkspaceIdentity(input.workspaceId, context);
    if (identity.projectId !== input.projectId) {
      throw new Error(`Project ${input.projectId} does not belong to workspace ${input.workspaceId}.`);
    }
    if (!(await this.directoriesMatch(identity.directory, input.workspaceCwd))) {
      throw new Error(`Workspace ${input.workspaceId} does not own directory ${input.workspaceCwd}.`);
    }


    const file = await this.store.load();
    let comments = sortProjectComments(this.projectComments(file, input.projectId))
      .filter((comment) => requestedIds.has(comment.id));
    if (comments.length !== requestedIds.size) {
      throw new Error("One or more selected project comments are no longer in the queue. Refresh the queue and retry.");
    }
    const hasLegacyComments = comments.some((comment) => comment.workspaceId === undefined);
    if (hasLegacyComments && !(await this.legacyCommentsBelongToWorkspace(identity, context))) {
      throw new Error("Legacy comment workspace ownership is ambiguous; refusing to submit this batch.");
    }
    for (const comment of comments) {
      if (comment.workspaceId !== undefined && comment.workspaceId !== input.workspaceId) {
        throw new Error(`Comment ${comment.id} belongs to another workspace; refusing to include it in this batch.`);
      }
      if (!(await this.directoriesMatch(comment.cwd, input.workspaceCwd))) {
        throw new Error(`Comment ${comment.id} does not belong to the selected workspace directory; refusing to include it.`);
      }
    }
    const selectedComments = comments;
    comments = await this.preflightProjectReviewComments(comments, requestedIds, identity);


    const batchId = randomUUID();
    const createdAt = new Date().toISOString();
    const messageId = `review-deck-batch:${batchId}`;
    const batch: ReviewBatch = {
      id: batchId,
      createdAt,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      commentIds: comments.map((comment) => comment.id),
      status: "draft",
      outcomes: {},
      delivery: { messageId, phase: "prepared", attempts: 0, updatedAt: createdAt },
    };
    const { projectName } = this.projectCommentIdentity(comments);
    const prompt = buildReviewBatchPrompt({
      batchId: batch.id,
      projectId: input.projectId,
      ...(projectName !== undefined ? { projectName } : {}),
      workspaceId: input.workspaceId,
      workspaceCwd: input.workspaceCwd,
      comments,
    });

    const currentIdentity = await this.resolveWorkspaceIdentity(input.workspaceId, context);
    if (
      currentIdentity.projectId !== identity.projectId ||
      !(await this.directoriesMatch(currentIdentity.directory, identity.directory)) ||
      !(await this.directoriesMatch(currentIdentity.directory, input.workspaceCwd))
    ) {
      throw new Error("Workspace identity changed during preflight. Refresh Review Deck and confirm the batch again.");
    }
    // Recheck the Agent after Git and anchor preflight so only a freshly idle,
    // still-bound Agent can receive the message. The SDK has no atomic
    // send-if-idle operation; the final status check remains best-effort.
    const handle = context.paseo.agents.ref(input.agentId);
    const refreshed = await handle.refresh().catch(() => null);
    const agent = refreshed?.agent ?? null;
    if (!agent) {
      throw new Error(`Could not verify the status of Agent ${input.agentId}; no ReviewBatch was sent.`);
    }
    if (agent.id !== input.agentId) {
      throw new Error(`Processing agent ${input.agentId} could not be verified. No ReviewBatch was sent.`);
    }
    if (agent.archivedAt) {
      throw new Error(`Processing agent ${input.agentId} is archived. Select an active Agent and retry.`);
    }
    if (agent.status !== "idle") {
      throw new Error(`Processing agent ${input.agentId} is busy (${agent.status}); only an idle Agent can receive Review Deck comments.`);
    }
    if (agent.workspaceId !== input.workspaceId) {
      throw new Error(
        `Processing agent ${input.agentId} belongs to workspace ${agent.workspaceId ?? "(none)"}, not ${input.workspaceId}. No other Agent was substituted.`,
      );
    }
    if (!(await this.directoriesMatch(agent.cwd ?? "", currentIdentity.directory))) {
      throw new Error(
        `Processing agent ${input.agentId} does not run in the selected workspace directory ${currentIdentity.directory}. Refusing to process outside that workspace.`,
      );
    }
    await this.store.runExclusive(async () => {
      const latestState = await this.store.load();
      const latestComments = sortProjectComments(this.projectComments(latestState, input.projectId))
        .filter((comment) => requestedIds.has(comment.id));
      if (
        latestComments.length !== selectedComments.length ||
        latestComments.some((comment, index) =>
          comment.id !== selectedComments[index]?.id ||
          this.projectCommentPreflightIdentity(comment) !==
            this.projectCommentPreflightIdentity(selectedComments[index]!),
        )
      ) {
        throw new Error("The selected comments changed before dispatch. Refresh the queue and confirm the batch again.");
      }
      await this.reviewBatchStore.create(batch);
    });

    this.sendingReviewBatchIds.add(batch.id);
    try {
      const sending = await this.reviewBatchStore.update(batch.id, (current) => {
        if (!isActiveReviewBatch(current.status) || current.delivery?.phase !== "prepared") return current;
        return {
          ...current,
          delivery: {
            ...current.delivery,
            phase: "sending",
            attempts: current.delivery.attempts + 1,
            updatedAt: new Date().toISOString(),
          },
        };
      });
      if (!sending || sending.delivery?.phase !== "sending") {
        throw new Error(`ReviewBatch ${batch.id} could not persist its send intent; no message was sent.`);
      }
      await handle.send(prompt, { messageId });
    } catch (error) {
      const unknown = await this.reviewBatchStore.update(batch.id, (current) => {
        if (current.delivery?.phase !== "sending") return current;
        return {
          ...current,
          delivery: {
            ...current.delivery,
            phase: "unknown",
            updatedAt: new Date().toISOString(),
            lastErrorCode: "send_outcome_unknown",
          },
        };
      });
      if (unknown?.submittedAt) await this.appendReviewBatchTimeline(unknown, context);
      throw error;
    } finally {
      this.sendingReviewBatchIds.delete(batch.id);
    }

    const acceptedAt = new Date().toISOString();
    const accepted = await this.reviewBatchStore.update(batch.id, (current) => {
      if (!current.delivery) return current;
      const delivery = { ...current.delivery, phase: "accepted" as const, updatedAt: acceptedAt };
      if (current.status !== "draft") return { ...current, delivery };
      return {
        ...current,
        status: "submitted",
        submittedAt: current.submittedAt ?? acceptedAt,
        delivery,
      };
    });
    if (!accepted) throw new Error(`ReviewBatch ${batch.id} disappeared after the Agent accepted its message.`);
    await this.appendReviewBatchTimeline(accepted, context);
    return accepted;
  }
  async releaseUnknownReviewBatch(
    input: { projectId: string; workspaceId: string; batchId: string; confirmDuplicateRisk: true },
    context: PluginHandlerContext,
  ): Promise<{ batchId: string; released: true }> {
    const identity = await this.resolveWorkspaceIdentity(input.workspaceId, context);
    if (identity.projectId !== input.projectId) {
      throw new Error(`Project ${input.projectId} does not belong to workspace ${input.workspaceId}.`);
    }
    const batch = (await this.reviewBatchStore.listByProject(input.projectId))
      .find((entry) => entry.id === input.batchId);
    if (!batch || batch.workspaceId !== input.workspaceId) {
      throw new Error("The ReviewBatch is no longer available in this workspace.");
    }
    if (
      !isActiveReviewBatch(batch.status) ||
      (batch.delivery !== undefined &&
        batch.delivery.phase !== "sending" &&
        batch.delivery.phase !== "unknown" &&
        batch.delivery.phase !== "accepted")
    ) {
      throw new Error("Only an active ReviewBatch with an ambiguous delivery can be released.");
    }
    if (this.sendingReviewBatchIds.has(batch.id)) {
      throw new Error("The ReviewBatch send is still in progress; wait for its result before releasing it.");
    }

    const completedAt = new Date().toISOString();
    let released = false;
    const updated = await this.reviewBatchStore.update(batch.id, (current) => {
      if (
        !isActiveReviewBatch(current.status) ||
        (current.delivery !== undefined &&
          current.delivery.phase !== "sending" &&
          current.delivery.phase !== "unknown" &&
          current.delivery.phase !== "accepted")
      ) return current;
      released = true;
      return {
        ...current,
        status: "failed",
        outcomes: Object.fromEntries(
          current.commentIds.map((commentId): [string, ReviewCommentOutcome] => [commentId, "unresolved"]),
        ),
        completedAt,
      };
    });
    if (!released || !updated) {
      throw new Error("The ReviewBatch changed before it could be released. Refresh the queue and retry.");
    }
    if (updated.submittedAt) await this.appendReviewBatchTimeline(updated, context);
    return { batchId: updated.id, released: true };
  }


  /** Find a Batch's exact message in a public Agent timeline page. */
  private async findReviewBatchTimelineMessage(
    batch: ReviewBatch,
    context: PluginHandlerContext | PluginHookContext,
  ): Promise<{ found: boolean; turnId: string | null }> {
    const delivery = batch.delivery;
    if (!delivery) return { found: false, turnId: null };
    try {
      const timeline = await context.paseo.agents.ref(batch.agentId).timeline.refetch({
        direction: "tail",
        limit: 100,
        projection: "canonical",
      });
      const marker = `REVIEW DECK BATCH: ${batch.id}`;
      let markerWithoutIdentityTurnId: string | null | undefined;
      let sawDifferentMessageIdentity = false;
      for (const entry of timeline.entries) {
        if (
          entry.item.type !== "user_message" ||
          !entry.item.text.split(/\r?\n/).some((line) => line.trim() === marker)
        ) continue;
        const hasMessageIdentity = entry.item.messageId !== undefined || entry.item.clientMessageId !== undefined;
        if (!hasMessageIdentity) {
          if (markerWithoutIdentityTurnId === undefined) markerWithoutIdentityTurnId = entry.turnId ?? null;
          continue;
        }
        sawDifferentMessageIdentity = true;
        if (
          entry.item.messageId === delivery.messageId ||
          entry.item.clientMessageId === delivery.messageId
        ) return { found: true, turnId: entry.turnId ?? null };
      }
      if (!sawDifferentMessageIdentity && markerWithoutIdentityTurnId !== undefined) {
        return { found: true, turnId: markerWithoutIdentityTurnId };
      }
    } catch {
      return { found: false, turnId: null };
    }
    return { found: false, turnId: null };
  }

  async handleAgentTurnStarted(
    event: PluginLifecycleEvents["agent.turn_started"],
    context: PluginHookContext,
  ): Promise<void> {
    const batch = await this.reviewBatchStore.findActiveForAgent(event.agent.id);
    const turnId = event.turnId;
    if (
      !batch ||
      !batch.delivery ||
      turnId === null ||
      batch.delivery.phase === "prepared" ||
      batch.delivery.phase === "rejected"
    ) return;
    const message = await this.findReviewBatchTimelineMessage(batch, context);
    if (!message.found || message.turnId !== turnId) return;
    if (batch.status === "running" && batch.turnId !== undefined) return;

    const startedAt = new Date().toISOString();
    const updated = await this.reviewBatchStore.update(batch.id, (current) => {
      if (
        current.delivery?.phase === "prepared" ||
        current.delivery?.phase === "rejected" ||
        (current.turnId !== undefined && current.turnId !== turnId) ||
        (current.status !== "draft" && current.status !== "submitted" &&
          !(current.status === "running" && current.turnId === undefined))
      ) return current;
      return {
        ...current,
        status: "running",
        submittedAt: current.submittedAt ?? startedAt,
        turnId,
        ...(current.delivery ? {
          delivery: { ...current.delivery, phase: "accepted" as const, updatedAt: startedAt },
        } : {}),
      };
    });
    if (updated?.status === "running" && updated.turnId === turnId) {
      await this.appendReviewBatchTimeline(updated, context);
    }
  }

  async handleAgentArchived(
    event: PluginLifecycleEvents["agent.archived"],
    context: PluginHookContext,
  ): Promise<void> {
    const batch = await this.reviewBatchStore.findActiveForAgent(event.agent.id);
    if (batch?.delivery) {
      const deliveryMayStillExecute =
        batch.delivery.phase === "sending" ||
        batch.delivery.phase === "unknown" ||
        batch.delivery.phase === "accepted";
      if (!deliveryMayStillExecute || batch.turnId !== undefined) {
        await this.failActiveBatchAsUnresolved(batch.id, context);
      }
    }

    const runs = await this.reviewRunStore.list();
    for (const run of runs) {
      if (run.parentAgentId !== event.agent.id || run.status !== "running") continue;
      await this.reviewRunStore.update(run.requestId, (current) =>
        current.status === "running" ? { ...current, status: "abandoned" } : current,
      );
      this.transientReviewAgents.delete(run.requestId);
    }
  }

  async handleAgentTurnEnded(
    event: PluginLifecycleEvents["agent.turn_ended"],
    context: PluginHookContext,
  ): Promise<void> {
    const storedBatches = await this.reviewBatchStore.list();
    const candidates = storedBatches.filter((batch) =>
      batch.agentId === event.agent.id &&
      (isActiveReviewBatch(batch.status) || isOrphanedReviewBatch(batch)),
    );

    for (const batch of candidates) {
      if (!batch.delivery) continue;
      const eventTurnId = event.turnId;
      if (eventTurnId === null) continue;
      const response = extractReviewBatchAssistantResponse(event.timeline, batch.id, batch.delivery?.messageId);
      if (batch.turnId !== undefined && batch.turnId !== eventTurnId) continue;
      if (batch.turnId === undefined || batch.delivery === undefined) {
        const observed = await this.findReviewBatchTimelineMessage(batch, context);
        if (!observed.found || observed.turnId !== eventTurnId) continue;
      }
      const acceptedAt = new Date().toISOString();
      const linked = await this.reviewBatchStore.update(batch.id, (current) => {
        if (!isActiveReviewBatch(current.status) && !isOrphanedReviewBatch(current)) return current;
        if (current.turnId !== undefined && current.turnId !== eventTurnId) return current;
        return {
          ...current,
          turnId: current.turnId ?? eventTurnId,
          ...(response.found && current.delivery && current.delivery.phase !== "accepted" &&
          current.delivery.phase !== "rejected" ? {
            delivery: { ...current.delivery, phase: "accepted" as const, updatedAt: acceptedAt },
          } : {}),
        };
      });
      if (!linked || linked.turnId !== eventTurnId) continue;
      if (!response.found || !response.hasAssistantMessage || !response.hasOutcomesSection) {
        if (isActiveReviewBatch(batch.status)) {
          await this.failActiveBatchAsUnresolved(batch.id, context);
        }
        continue;
      }
      if (event.outcome.kind !== "completed") {
        if (isActiveReviewBatch(batch.status)) {
          await this.failActiveBatchAsUnresolved(batch.id, context);
        }
        continue;
      }

      const outcomes = parseReviewCommentOutcomes(response.text, batch.commentIds);
      const values = batch.commentIds.map((commentId) => outcomes[commentId]);
      const status: ReviewBatch["status"] = values.every((outcome) => outcome === "completed")
        ? "completed"
        : values.every((outcome) => outcome === "failed" || outcome === "unresolved")
          ? "failed"
          : "partial";
      const completedAt = new Date().toISOString();
      let finalized = false;
      const updated = await this.reviewBatchStore.update(batch.id, (current) => {
        if (!isActiveReviewBatch(current.status) && !isOrphanedReviewBatch(current)) return current;
        if (current.turnId !== event.turnId) return current;
        finalized = true;
        return {
          ...current,
          status,
          outcomes,
          submittedAt: current.submittedAt ?? completedAt,
          completedAt,
          ...(current.delivery ? {
            delivery: { ...current.delivery, phase: "accepted" as const, updatedAt: completedAt },
          } : {}),
        };
      });
      if (!finalized || !updated) continue;

      const completedCommentIds = batch.commentIds.filter((commentId) => updated.outcomes[commentId] === "completed");
      await this.appendReviewBatchTimeline(updated, context);
      if (completedCommentIds.length > 0) {
        await this.clearProjectReviewComments(updated.projectId, completedCommentIds);
      }
    }
  }
  private async appendReviewBatchTimeline(
    batch: ReviewBatch,
    context: PluginHandlerContext | PluginHookContext,
  ): Promise<void> {
    await this.reviewBatchTimelineMutex.run(async () => {
      const current = (await this.reviewBatchStore.list()).find((entry) => entry.id === batch.id);
      if (!current || current.agentId !== batch.agentId || !current.submittedAt) return;
      try {
        await context.paseo.agents.ref(current.agentId).timeline.append({
          type: "plugin",
          id: `review-deck-batch:${current.id}`,
          kind: reviewBatchTimelineKind,
          version: reviewBatchTimelineVersion,
          data: reviewBatchTimelineData(current),
        });
      } catch (error) {
        console.error(`review-deck: could not update the timeline row for ReviewBatch ${current.id}`, error);
      }
    });
  }

  /**
   * Remove only the named completed comments. A comment edited while its batch
   * ran receives a new id and therefore remains queued for the next batch.
   */
  async clearProjectReviewComments(projectId: string, commentIds: readonly string[]): Promise<number> {
    const completedIds = new Set(commentIds);
    if (completedIds.size === 0) return 0;
    return this.store.runExclusive(async () => {
      const file = await this.store.load();
      let cleared = 0;
      for (const [targetFingerprint, entries] of Object.entries(file)) {
        const next = entries.filter((entry) => {
          if (
            entry.projectId !== projectId ||
            !entry.id ||
            !completedIds.has(entry.id) ||
            this.projectCommentBody(entry, projectId) === null
          ) return true;
          cleared++;
          return false;
        });
        if (next.length === entries.length) continue;
        if (next.length === 0) delete file[targetFingerprint];
        else file[targetFingerprint] = next;
      }
      if (cleared === 0) return 0;
      await this.store.save(file);
      return cleared;
    });
  }

  async reverseHunk(request: ReviewRequest, expectedTargetFingerprint: string, hunkId: string, expectedHunkFingerprint: string): Promise<{ targetFingerprint: string; removedHunkId: string }> {
    if (request.scope !== "working" && request.scope !== "staged") {
      throw new Error("Rejecting a hunk is only available for working-tree or staged review targets.");
    }
    const target = await this.resolveReviewTarget(request);
    return this.repoMutexes.run(target.gitDir, () =>
      this.reverseHunkUnlocked(request, expectedTargetFingerprint, hunkId, expectedHunkFingerprint),
    );
  }

  /**
   * The single-hunk revert core. revertFile drives the whole file loop under
   * one repo-mutex acquisition and calls this unlocked core per hunk; the
   * public reverseHunk wraps the same core with its own mutex acquisition so
   * the mutex is never nested (which would self-deadlock).
   */
  private async reverseHunkUnlocked(request: ReviewRequest, expectedTargetFingerprint: string, hunkId: string, expectedHunkFingerprint: string): Promise<{ targetFingerprint: string; removedHunkId: string }> {
    if (request.scope !== "working" && request.scope !== "staged") {
      throw new Error("Rejecting a hunk is only available for working-tree or staged review targets.");
    }
    const snapshot = await this.createSnapshot(request);
    if (snapshot.targetFingerprint !== expectedTargetFingerprint) {
      throw new Error("Review snapshot is stale: the Git target changed after this hunk was analyzed. Refresh before rejecting it.");
    }
    const hunk = this.findHunk(snapshot, hunkId);
    if (hunk.fingerprint !== expectedHunkFingerprint) {
      throw new Error("Hunk is stale: its exact patch no longer matches the reviewed change.");
    }
    if (hunk.patch.includes("GIT binary patch")) {
      throw new Error("Binary hunk rejection is not supported. Review and revert the file manually.");
    }
    const cachedArgs = request.scope === "staged" ? ["--cached"] : [];
    await this.gitFactory(snapshot.repositoryPath).run(["apply", "--check", "--reverse", "--binary", ...cachedArgs, "-"], { stdin: hunk.patch });
    await this.gitFactory(snapshot.repositoryPath).run(["apply", "--reverse", "--binary", ...cachedArgs, "-"], { stdin: hunk.patch });
    const refreshed = await this.createSnapshot(request);
    const remainingExactPatch = refreshed.files.some((file) =>
      file.hunks.some((candidate) => candidate.patch === hunk.patch),
    );
    if (refreshed.targetFingerprint === snapshot.targetFingerprint || remainingExactPatch) {
      throw new Error("Git accepted the patch but Review Deck could not verify that the reviewed hunk was removed. Refresh and inspect manually.");
    }
    return { targetFingerprint: refreshed.targetFingerprint, removedHunkId: hunk.id };
  }

  /**
   * Revert every hunk of one file, one round per hunk with a fresh snapshot
   * each round: reverting a hunk changes the target fingerprint, so later
   * hunks are re-validated against the refreshed state. Only the first round
   * validates expectedTargetFingerprint. skipPatches (exact patches of hunks
   * anchored to file comments; the client cannot hash them itself because the
   * change-id derivation is server-side) and hunks that failed to revert are
   * matched by their changed lines (the "+"/"-" body lines), which survive
   * fingerprint drift and git's re-derived context windows. The whole loop
   * runs under the repo mutex.
   */
  async revertFile(input: ReviewRequest & { filePath: string; expectedTargetFingerprint: string; skipPatches: string[] }): Promise<{ reverted: number; skipped: number; failed: number }> {
    if (input.scope !== "working" && input.scope !== "staged") {
      throw new Error("Rejecting a hunk is only available for working-tree or staged review targets.");
    }
    const target = await this.resolveReviewTarget(input);
    return this.repoMutexes.run(target.gitDir, async () => {
      // The round-1 snapshot also validates the expected fingerprint and sizes
      // the loop (initial hunks + 1) before any revert happens.
      let snapshot = await this.createSnapshot(input);
      if (snapshot.targetFingerprint !== input.expectedTargetFingerprint) {
        throw new Error("Review snapshot is stale: the Git target changed after this review was analyzed. Refresh before reverting it.");
      }
      const initialFile = snapshot.files.find((candidate) => candidate.path === input.filePath);
      const skipChangeIds = new Set(input.skipPatches.map((patch) => hunkChangeId(input.filePath, patch)));
      const rounds = (initialFile?.hunks.length ?? 0) + 1;
      const failedChangeIds = new Set<string>();
      let reverted = 0;
      let failed = 0;
      for (let round = 0; round < rounds; round++) {
        snapshot = await this.createSnapshot(input);
        const file = snapshot.files.find((candidate) => candidate.path === input.filePath);
        if (!file) break;
        const candidates = file.hunks.filter((hunk) => {
          const changeId = hunkChangeId(hunk.filePath, hunk.patch);
          return !skipChangeIds.has(changeId) && !failedChangeIds.has(changeId);
        });
        if (candidates.length === 0) break;
        const hunk = candidates[0];
        try {
          await this.reverseHunkUnlocked(input, snapshot.targetFingerprint, hunk.id, hunk.fingerprint);
          reverted++;
        } catch {
          failed++;
          failedChangeIds.add(hunkChangeId(hunk.filePath, hunk.patch));
        }
      }
      const finalSnapshot = await this.createSnapshot(input);
      const finalFile = finalSnapshot.files.find((candidate) => candidate.path === input.filePath);
      const remaining = finalFile ? finalFile.hunks.length : 0;
      const skipped = Math.max(0, remaining - failedChangeIds.size);
      return { reverted, skipped, failed };
    });
  }

  explain(_snapshot: ReviewSnapshot, hunk: Hunk, locale: ReviewLocale = "en"): {
    hunkId: string;
    verifiedFacts: string[];
    aiInference: string[];
    humanVerificationRecommended: string[];
  } {
    const copy = deterministicCopy(locale);
    const addedLines = hunk.lines.filter((line) => line.startsWith("+")).length;
    const removedLines = hunk.lines.filter((line) => line.startsWith("-")).length;
    const facts = [
      copy.formatLabel(copy.file, hunk.filePath),
      ...(hunk.functionHint ? [copy.formatLabel(copy.enclosingSymbol, hunk.functionHint)] : []),
      ...(hunk.language ? [copy.formatLabel(copy.language, displayLanguage(hunk.language))] : []),
      copy.formatLabel(copy.changedRange, hunk.header),
      copy.changedLines(addedLines, removedLines),
      ...hunk.findings.filter((finding) => finding.evidenceKind === "verified_fact").map((finding) => finding.detail),
    ];
    const highRisk = hunk.findings.filter((finding) => severityRank(finding.severity) >= 4);
    const humanChecks = highRisk.length > 0
      ? highRisk.map((finding) => finding.suggestedCheck ?? copy.fallbackCategoryCheck(finding.category))
      : [copy.fallbackHumanCheck];
    const inference = locale === "zh"
      ? ["仅凭 diff 无法证明确切动机；在接受此变更前，请检查任务上下文和周边调用方。"]
      : ["The exact motivation is not proven by the diff alone; inspect the task context and surrounding call sites before accepting this change."];
    return { hunkId: hunk.id, verifiedFacts: facts, aiInference: inference, humanVerificationRecommended: humanChecks };
  }
  /**
   * Rule-level explanation of a whole file: per-hunk explain() output merged
   * into sections by hunk header, aggregating every hunk's findings. hunkId
   * carries the file path so the client's findings pipeline can render it.
   */
  async explainFile(input: ReviewRequest & { filePath: string }): Promise<ExplainHunkResult> {
    const locale = input.locale ?? "en";
    const copy = deterministicCopy(locale);
    const snapshot = await this.createSnapshot(input);
    const file = snapshot.files.find((candidate) => candidate.path === input.filePath);
    if (!file) {
      throw new Error(`File ${input.filePath} is no longer present in this review snapshot.`);
    }
    const sections = file.hunks.map((hunk) => this.explain(snapshot, hunk, locale));
    const verifiedFacts = file.hunks.flatMap((hunk, index) => [
      copy.fileHunk(hunk.header),
      ...sections[index].verifiedFacts.map((fact) => `- ${fact}`),
    ]);
    const aiInference = file.hunks.flatMap((hunk, index) => [
      copy.fileHunk(hunk.header),
      ...sections[index].aiInference.map((item) => `- ${item}`),
    ]);
    const humanVerificationRecommended = file.hunks.flatMap((hunk, index) => [
      copy.fileHunk(hunk.header),
      ...sections[index].humanVerificationRecommended.map((item) => `- ${item}`),
    ]);
    return {
      hunkId: input.filePath,
      verifiedFacts,
      aiInference,
      humanVerificationRecommended,
    };
  }

  private async readReviewerSettings(locale: ReviewLocale | undefined): Promise<ReviewDeckSettingsValues> {
    if (!this.settings) return reviewDeckSettingsSchema.parse({});
    const state = await this.settings.read();
    if (state.status !== "ready") {
      throw new Error(
        locale === "zh"
          ? `Review Deck 设置无效：${state.error}。请先在设置中修复。`
          : `Review Deck settings are invalid: ${state.error}. Repair them in Settings before starting an AI review.`,
      );
    }
    return state.values;
  }

  /**
   * Starts one file- or target-scoped AI review. Settings, workspace binding,
   * provider/model availability, and the selected permission mode are resolved before any
   * cache lookup or child creation.
   */
  async startRunReview(
    input: ReviewRequest & { reviewMode: "file" | "target"; reviewDepthOverride?: AiReviewDepth; agentId: string; workspaceId: string },
    context: PluginHandlerContext,
  ): Promise<{ requestId: string }> {
    const snapshot = await this.createSnapshot(input);
    const settings = await this.readReviewerSettings(input.locale);
    const reviewPreset = settings.defaultReviewPreset;
    const depth = input.reviewDepthOverride ?? aiReviewPresetDefaultDepth[reviewPreset];
    const prompt = this.buildAiReviewPrompt(
      snapshot,
      input.reviewMode,
      depth,
      input.locale ?? "en",
      reviewPreset,
      undefined,
      input.filePath,
    );
    const reviewer = await this.resolveReviewerConfiguration(
      { agentId: input.agentId, workspaceId: input.workspaceId, worktreePath: snapshot.worktreePath, locale: input.locale },
      settings,
      context,
    );
    return {
      requestId: await this.startAiReviewRequest({
        snapshot,
        prompt,
        reviewer,
        settings,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        locale: input.locale,
      }, context),
    };
  }

  private buildAiReviewPrompt(
    snapshot: ReviewSnapshot,
    mode: AiReviewMode,
    depth: AiReviewDepth,
    locale: ReviewLocale,
    preset: AiReviewBudgetPreset,
    selectedHunk?: Hunk,
    filePath?: string,
  ): ReturnType<typeof buildAiReviewPrompt> {
    const toPromptFile = (file: ReviewSnapshot["files"][number]): AiReviewPromptFile => ({
      path: file.path,
      hunks: file.hunks.map((hunk) => promptHunk({
        path: hunk.filePath,
        header: hunk.header,
        patch: hunk.patch,
        context: hunk.functionHint ?? hunk.header,
        findings: hunk.findings.map(({ severity, category }) => ({ severity, category })),
      })),
    });
    let files: AiReviewPromptFile[];
    if (mode === "hunk") {
      if (!selectedHunk) throw new Error("A selected hunk is required for a hunk review.");
      const file = snapshot.files.find((candidate) => candidate.hunks.some((hunk) => hunk.id === selectedHunk.id));
      if (!file) throw new Error("The selected hunk is not part of the current review snapshot.");
      const promptFile = toPromptFile({ ...file, hunks: [selectedHunk] });
      files = [promptFile];
    } else if (mode === "file") {
      const file = snapshot.files.find((candidate) => candidate.path === filePath);
      if (!file) {
        throw new Error(
          locale === "zh"
            ? `文件 ${filePath ?? "（未选择）"} 不在当前评审目标中。`
            : `File ${filePath ?? "(not selected)"} is not part of the current review target.`,
        );
      }
      files = [toPromptFile(file)];
    } else {
      files = snapshot.files.map(toPromptFile);
    }
    return buildAiReviewPrompt({
      mode,
      depth,
      preset,
      locale,
      scope: snapshot.scope,
      workspace: snapshot.worktreePath,
      targetFingerprint: snapshot.targetFingerprint,
      files,
    });
  }

  private async startAiReviewRequest(
    input: {
      snapshot: ReviewSnapshot;
      prompt: ReturnType<typeof buildAiReviewPrompt>;
      reviewer: { provider: string; model: string | null; thinkingOptionId: string | null; modeId: string; reviewerPermissionMode: AiReviewPermissionMode; configProvider: string };
      settings: ReviewDeckSettingsValues;
      agentId: string;
      workspaceId: string;
      locale: ReviewLocale | undefined;
    },
    context: PluginHandlerContext,
  ): Promise<string> {
    const { prompt, reviewer, settings } = input;
    const depth = prompt.mode === "hunk" ? undefined : prompt.depth;
    const reviewPreset = prompt.mode === "hunk" ? undefined : prompt.preset;
    const cacheKey = sha256(canonicalJson({
      workspaceId: input.workspaceId,
      mode: prompt.mode,
      depth: prompt.depth,
      reviewPreset: reviewPreset ?? null,
      inputFingerprint: prompt.inputFingerprint,
      provider: reviewer.provider,
      model: reviewer.model,
      thinkingOptionId: reviewer.thinkingOptionId,
      modeId: reviewer.modeId,
      locale: prompt.locale,
      promptVersion: prompt.promptVersion,
      schemaVersion: prompt.schemaVersion,
    }));

    await this.sweepTransientReviewAgents();
    if (settings.aiReviewCacheEnabled) {
      let cached: AiReviewCacheEntry | null = null;
      try {
        cached = await this.aiReviewCacheStore.get(cacheKey);
      } catch {
        // Cache corruption/unavailability cannot block a fresh review.
      }
      if (
        cached
        && cached.key === cacheKey
        && cached.mode === prompt.mode
        && cached.provider === reviewer.provider
        && cached.model === reviewer.model
        && cached.thinking === reviewer.thinkingOptionId
        && cached.promptVersion === prompt.promptVersion
        && cached.schemaVersion === prompt.schemaVersion
        && cached.inputFingerprint === prompt.inputFingerprint
        && cached.depth === depth
      ) {
        const requestId = randomUUID();
        const entry: TransientReviewEntry = {
          handle: null,
          cachedResult: { review: cached.review, sections: cached.sections, usage: cached.usage },
          locale: input.locale,
          provider: reviewer.provider,
          model: reviewer.model,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          startedAt: Date.now(),
          mode: prompt.mode,
          reviewerPermissionMode: reviewer.reviewerPermissionMode,
          depth,
          ...(reviewPreset ? { reviewPreset } : {}),
          resultSource: "cached",
          cacheEnabled: true,
          cacheKey,
          inputFingerprint: prompt.inputFingerprint,
          thinkingOptionId: reviewer.thinkingOptionId,
        };
        await this.reviewRunStore.create(this.toReviewRun(requestId, entry, null, "completed"));
        this.transientReviewAgents.set(requestId, entry);
        return requestId;
      }
    }

    return this.startTransientReviewAgent({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      worktreePath: input.snapshot.worktreePath,
      locale: input.locale,
      prompt: prompt.prompt,
      reviewer,
      mode: prompt.mode,
      depth,
      ...(reviewPreset ? { reviewPreset } : {}),
      cacheEnabled: settings.aiReviewCacheEnabled,
      cacheKey,
      inputFingerprint: prompt.inputFingerprint,
    }, context);
  }

  private async resolveParentAgentConfig(
    input: { agentId: string; workspaceId: string; worktreePath: string; locale: ReviewLocale | undefined },
    context: PluginHandlerContext,
  ): Promise<{
    agentProvider: string;
    agentModel: string | null;
    thinkingOptionId: string | null;
    availableModes: Array<{ id: string; label: string; description?: string }>;
  }> {
    const handle = context.paseo.agents.ref(input.agentId);
    let agent: {
      workspaceId?: string | null;
      cwd?: string | null;
      provider?: string;
      model?: string | null;
      thinkingOptionId?: string | null;
      effectiveThinkingOptionId?: string | null;
      availableModes?: Array<{ id: string; label: string; description?: string }> | null;
    } | null | undefined;
    try {
      const fresh = await handle.refresh();
      agent = fresh?.agent ?? handle.current();
    } catch {
      agent = handle.current();
    }
    if (!agent || !agent.provider) {
      throw new Error(
        input.locale === "zh"
          ? `无法解析所选工作区 Agent（${input.agentId}）的配置，不能创建评审子 Agent。评审未在所选工作区 Agent 的会话流中运行。`
          : `Could not resolve the selected workspace Agent (${input.agentId}) configuration, so the review child agent could not be created. The review did not run on the selected workspace Agent's stream.`,
      );
    }
    if (agent.workspaceId !== input.workspaceId) {
      throw new Error(
        input.locale === "zh"
          ? `所选 Agent（${input.agentId}）属于工作区 ${agent.workspaceId ?? "（无）"}，不是所选工作区 ${input.workspaceId}。不能创建评审子 Agent，也未使用其他 Agent 代替。`
          : `Selected agent ${input.agentId} belongs to workspace ${agent.workspaceId ?? "(none)"}, not the selected workspace ${input.workspaceId}. The review child agent was not created and no other agent was substituted.`,
      );
    }
    const workspaceHandle = context.paseo.workspaces.ref(input.workspaceId);
    let workspace: { workspaceDirectory?: string | null } | null | undefined;
    try {
      const fresh = await workspaceHandle.refresh();
      workspace = fresh ?? workspaceHandle.current();
    } catch {
      workspace = workspaceHandle.current();
    }
    const workspaceDirectory = workspace?.workspaceDirectory;
    if (!workspaceDirectory) {
      throw new Error(
        input.locale === "zh"
          ? `无法解析所选工作区 ${input.workspaceId} 的目录，不能创建评审子 Agent。`
          : `Could not resolve the directory of workspace ${input.workspaceId}, so the review child agent could not be created.`,
      );
    }
    if (!(await this.directoriesMatch(workspaceDirectory, input.worktreePath))) {
      throw new Error(
        input.locale === "zh"
          ? `评审目录 ${input.worktreePath} 不是所选工作区 ${input.workspaceId}（${workspaceDirectory}）的目录。不能创建评审子 Agent。`
          : `The reviewed worktree ${input.worktreePath} is not the directory of the selected workspace ${input.workspaceId} (${workspaceDirectory}). The review child agent was not created.`,
      );
    }
    if (!agent.cwd || !(await this.directoriesMatch(agent.cwd, input.worktreePath))) {
      throw new Error(
        input.locale === "zh"
          ? `所选 Agent（${input.agentId}）运行于 ${agent.cwd ?? "（未知）"}，不是评审目录 ${input.worktreePath}。不能创建评审子 Agent，也未使用其他 Agent 代替。`
          : `Selected agent ${input.agentId} runs in ${agent.cwd ?? "(unknown)"}, not the reviewed worktree ${input.worktreePath}. The review child agent was not created and no other agent was substituted.`,
      );
    }
    return {
      agentProvider: agent.provider,
      agentModel: agent.model ?? null,
      thinkingOptionId: agent.thinkingOptionId ?? agent.effectiveThinkingOptionId ?? null,
      availableModes: agent.availableModes ?? [],
    };
  }

  private async resolveReviewerConfiguration(
    input: { agentId: string; workspaceId: string; worktreePath: string; locale: ReviewLocale | undefined },
    settings: ReviewDeckSettingsValues,
    context: PluginHandlerContext,
  ): Promise<{
    provider: string;
    model: string | null;
    thinkingOptionId: string | null;
    modeId: string;
    reviewerPermissionMode: AiReviewPermissionMode;
    providerOptions?: CodexReadOnlyProviderOptions;
    configProvider: string;
  }> {
    const parent = await this.resolveParentAgentConfig(input, context);
    let provider = parent.agentProvider;
    let model = parent.agentModel;
    let thinkingOptionId = parent.thinkingOptionId;
    let modes = parent.availableModes;

    if (settings.reviewerStrategy === "custom") {
      const configuredProvider = settings.reviewerProvider;
      const configuredModel = settings.reviewerModel;
      const unavailable = input.locale === "zh"
        ? `设置的评审模型 ${configuredProvider || "（未选择 Provider）"}/${configuredModel || "（未选择 Model）"} 当前不可用。请在 Review Deck 设置中选择可用模型；没有回退到工作区 Agent。`
        : `The configured reviewer model ${configuredProvider || "(provider not selected)"}/${configuredModel || "(model not selected)"} is unavailable. Choose an available model in Review Deck settings; no fallback to the workspace Agent was made.`;
      if (!configuredProvider || !configuredModel) throw new Error(unavailable);

      let providerEntry;
      try {
        const catalog = await context.paseo.providers.snapshot({ cwd: input.worktreePath });
        providerEntry = catalog.entries.find((entry) => entry.provider === configuredProvider);
      } catch {
        throw new Error(unavailable);
      }
      if (!providerEntry || providerEntry.enabled === false || providerEntry.status !== "ready") {
        throw new Error(unavailable);
      }
      const selectedModel = providerEntry.models?.find(
        (candidate) => candidate.provider === configuredProvider && candidate.id === configuredModel && candidate.isSelectable !== false,
      );
      if (!selectedModel) throw new Error(unavailable);

      provider = configuredProvider;
      model = selectedModel.id;
      if (settings.reviewerThinkingOptionId) {
        const selectedThinking = selectedModel.thinkingOptions?.some(
          (option) => option.id === settings.reviewerThinkingOptionId,
        );
        if (!selectedThinking) {
          throw new Error(
            input.locale === "zh"
              ? `设置的思考选项 ${settings.reviewerThinkingOptionId} 对评审模型 ${provider}/${model} 不可用。请更新 Review Deck 设置。`
              : `The configured thinking option ${settings.reviewerThinkingOptionId} is unavailable for reviewer model ${provider}/${model}. Update Review Deck settings.`,
          );
        }
        thinkingOptionId = settings.reviewerThinkingOptionId;
      } else {
        thinkingOptionId = selectedModel.defaultThinkingOptionId ?? null;
      }
      modes = providerEntry.modes ?? [];
    } else {
      const parentMode = resolveReviewerMode(provider, modes);
      if (!parentMode || parentMode.permissionMode === "ask") {
        let providerEntry;
        try {
          const catalog = await context.paseo.providers.snapshot({ cwd: input.worktreePath });
          providerEntry = catalog.entries.find((entry) => entry.provider === provider);
        } catch {
          providerEntry = null;
        }
        if (!providerEntry || providerEntry.enabled === false || providerEntry.status !== "ready") {
          if (!parentMode) {
            throw new Error(
              input.locale === "zh"
                ? `无法验证 Provider ${provider} 的只读或审批门控评审模式；评审未启动。`
                : `Could not verify a read-only or approval-gated review mode for provider ${provider}; the review was not started.`,
            );
          }
        } else {
          const providerModes = providerEntry.modes ?? [];
          const providerMode = resolveReviewerMode(provider, providerModes);
          if (!parentMode || providerMode?.permissionMode === "read-only") modes = providerModes;
        }
      }
    }

    const reviewerMode = resolveReviewerMode(provider, modes);
    if (!reviewerMode) {
      throw new Error(
        input.locale === "zh"
          ? `Provider ${provider} 没有可用的只读/Plan 或 Ask 审批门控模式；评审未启动。`
          : `Provider ${provider} has no read-only/plan or approval-gated Ask mode; the review was not started.`,
      );
    }
    return {
      provider,
      model,
      thinkingOptionId,
      modeId: reviewerMode.id,
      reviewerPermissionMode: reviewerMode.permissionMode,
      ...(reviewerMode.providerOptions ? { providerOptions: reviewerMode.providerOptions } : {}),
      configProvider: model ? `${provider}/${model}` : provider,
    };
  }

  /**
   * Creates the configured transient reviewer and stores a request capability
   * for polling. Its child ID is never exposed.
   */
  private async startTransientReviewAgent(
    input: {
      agentId: string;
      workspaceId: string;
      worktreePath: string;
      locale: ReviewLocale | undefined;
      prompt: string;
      reviewer: {
        provider: string;
        model: string | null;
        thinkingOptionId: string | null;
        modeId: string;
        reviewerPermissionMode: AiReviewPermissionMode;
        configProvider: string;
        providerOptions?: CodexReadOnlyProviderOptions;
      };
      mode: AiReviewMode;
      depth?: AiReviewDepth;
      reviewPreset?: AiReviewBudgetPreset;
      cacheEnabled: boolean;
      cacheKey: string;
      inputFingerprint: string;
    },
    context: PluginHandlerContext,
  ): Promise<string> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const entry: TransientReviewEntry = {
      handle: null,
      locale: input.locale,
      provider: input.reviewer.provider,
      model: input.reviewer.model,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      startedAt,
      mode: input.mode,
      reviewerPermissionMode: input.reviewer.reviewerPermissionMode,
      depth: input.depth,
      ...(input.reviewPreset ? { reviewPreset: input.reviewPreset } : {}),
      resultSource: "fresh",
      cacheEnabled: input.cacheEnabled,
      cacheKey: input.cacheKey,
      inputFingerprint: input.inputFingerprint,
      thinkingOptionId: input.reviewer.thinkingOptionId,
    };
    await this.reviewRunStore.create(this.toReviewRun(requestId, entry, null, "running"));

    const agentConfig = {
      provider: input.reviewer.configProvider,
      modeId: input.reviewer.modeId,
      ...(input.reviewer.thinkingOptionId ? { thinkingOptionId: input.reviewer.thinkingOptionId } : {}),
      ...(input.reviewer.providerOptions ? { options: input.reviewer.providerOptions } : {}),
    };
    let child: TransientReviewChildHandle;
    try {
      child = await context.paseo.agents.create({
        idempotencyKey: requestId,
        config: agentConfig,
        cwd: input.worktreePath,
        parent: input.agentId,
        title: input.locale === "zh" ? "Review Deck AI 评审" : "Review Deck AI review",
        autoArchive: true,
        ...(supportsStructuredReviewOutput(input.reviewer.provider)
          ? { outputSchema: AI_REVIEW_OUTPUT_SCHEMA }
          : {}),
        labels: {
          "review-deck.kind": "ai-review",
          "review-deck.request": requestId,
          "review-deck.mode": input.mode,
        },
        prompt: input.prompt,
      });
    } catch (error) {
      await this.reviewRunStore.update(requestId, (current) =>
        current.status === "running" ? { ...current, status: "failed" } : current,
      ).catch(() => null);
      throw new Error(
        input.locale === "zh"
          ? `评审子 Agent 创建失败：${error instanceof Error ? error.message : String(error)}。评审未在所选工作区 Agent 的会话流中运行。`
          : `Failed to create the review child agent: ${error instanceof Error ? error.message : String(error)}. The review did not run on the selected workspace Agent's stream.`,
      );
    }

    let stored: ReviewRun | null;
    try {
      stored = await this.reviewRunStore.update(requestId, (current) =>
        current.status === "running" ? { ...current, childAgentId: child.id } : current,
      );
    } catch (error) {
      await context.paseo.agents.ref(child.id).archive().catch(() => undefined);
      throw new Error("The review Agent was created, but its recovery record could not be saved.", { cause: error });
    }
    if (!stored || stored.status !== "running" || stored.childAgentId !== child.id) {
      await context.paseo.agents.ref(child.id).archive().catch(() => undefined);
      throw new Error(`ReviewRun ${requestId} stopped before its child Agent was recorded.`);
    }

    entry.handle = child;
    this.transientReviewAgents.set(requestId, entry);
    return requestId;
  }

  /**
   * Recovers the last assistant text from a transient child's timeline when
   * waitForFinish settles without a final lastMessage (the turn ended after a
   * tool call, with the actual reply earlier in the timeline). Walks the
   * timeline entries in reverse and returns the newest assistant text content;
   * null when the timeline is unavailable, has no assistant message, or the
   * text is empty. Read-only — never touches the selected workspace Agent's
   * stream.
   */
  private async extractLastAssistantText(handle: TransientReviewChildHandle): Promise<string | null> {
    if (!handle.timeline) return null;
    let payload: TransientTimelinePayload | null = null;
    try {
      payload = (await handle.timeline.refetch({ limit: 50 })) as TransientTimelinePayload | null;
    } catch {
      return null;
    }
    const entries = payload?.entries;
    if (!Array.isArray(entries)) return null;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const item = entries[index]?.item;
      if (!item || item.type !== "assistant_message") continue;
      // Normalize the assistant text: the daemon's AgentTimelineItem carries a
      // plain `text` string; a content-block array ({ type: "text", text }) is
      // accepted defensively and joined.
      let text = "";
      if (typeof item.text === "string") {
        text = item.text;
      } else if (Array.isArray(item.content)) {
        const blocks: string[] = [];
        for (const block of item.content) {
          if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") blocks.push(block.text);
        }
        text = blocks.join("");
      }
      const trimmed = text.trim();
      if (trimmed) return trimmed;
    }
    return null;
  }

  /**
   * Stamp a terminal AI review result onto its stored run in one
   * ReviewRunStore update: the terminal status, the completion time, and — for
   * a completed file or target review — the finding tally. A hunk explanation
   * is an inline answer rather than a review result, so it keeps the status and
   * completion time but never a tally; that is what keeps it out of unread
   * findings. A cached run is already completed and is stamped once on its
   * first poll; a run that already carries its completion time is returned
   * unchanged, so repeated polls can never move the timestamp. Returns null
   * when the store cannot be written — the polled result is returned either
   * way, so a damaged store never hides a finished review.
   */
  private async recordReviewRunCompletion(
    requestId: string,
    completion: { status: "completed" | "failed" } & AiReviewFindingCounts & { completedAt: string },
  ): Promise<ReviewRun | null> {
    try {
      return await this.reviewRunStore.update(requestId, (current) => {
        const tally: Partial<AiReviewFindingCounts> =
          completion.status === "completed" && current.mode !== "hunk"
            ? { findingCount: completion.findingCount, highRiskFindingCount: completion.highRiskFindingCount }
            : {};
        if (current.status === "running") {
          return { ...current, status: completion.status, completedAt: completion.completedAt, ...tally };
        }
        if (current.status === completion.status && current.completedAt === undefined) {
          return { ...current, completedAt: completion.completedAt, ...tally };
        }
        return current;
      });
    } catch (error) {
      console.error(`[Review Deck] Could not persist terminal ReviewRun ${requestId}; returning its result.`, error);
      return null;
    }
  }

  /**
   * Append or update the stable v1.7 AI review row on the parent Agent's
   * timeline. The payload is counts, status, usage, mode/depth, the workspace
   * id, and the completion time — never the review text, findings, file paths,
   * patches, or comment ids. The row id is keyed by request id, so a repeated
   * poll (or a recovered run) re-appends the same row in place, and hunk
   * explanations are skipped because the row's contract covers whole file and
   * target reviews. An append failure is logged and swallowed: the AI result
   * itself is already persisted and is about to be returned.
   */
  private async appendAiReviewTimeline(
    input: {
      requestId: string;
      workspaceId: string;
      parentAgentId: string;
      mode: AiReviewMode;
      status: "completed" | "failed";
      resultSource: AiReviewResultSource;
      depth?: AiReviewDepth;
      usage?: AiReviewUsage;
      completedAt: string;
    } & AiReviewFindingCounts,
    context: PluginHandlerContext,
  ): Promise<void> {
    const mode = input.mode;
    if (mode === "hunk") return;
    const data = reviewAiTimelineSchema.safeParse({
      workspaceId: input.workspaceId,
      mode,
      status: input.status,
      findingCount: input.findingCount,
      highRiskFindingCount: input.highRiskFindingCount,
      resultSource: input.resultSource,
      ...(input.depth !== undefined ? { depth: input.depth } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      completedAt: input.completedAt,
    });
    if (!data.success) return;
    try {
      await context.paseo.agents.ref(input.parentAgentId).timeline.append({
        type: "plugin",
        id: `${reviewAiTimelineKind}:${input.requestId}`,
        kind: reviewAiTimelineKind,
        version: reviewAiTimelineVersion,
        data: data.data,
      });
    } catch (error) {
      console.error(`review-deck: could not update the timeline row for AI review ${input.requestId}`, error);
    }
  }

  /**
   * Polls a one-shot reviewer. Cache hits use the same request capability and
   * result contract as fresh runs; fresh runs preserve status and token usage.
   */
  async pollAiReview(
    input: { requestId: string; workspaceId: string; agentId: string },
    context: PluginHandlerContext,
  ): Promise<PollAiReviewResult> {
    await this.sweepTransientReviewAgents();
    let entry = this.transientReviewAgents.get(input.requestId);
    if (!entry) {
      const recovery = await this.restoreTransientReviewEntry(input, context);
      if (recovery.kind === "retry") {
        const run = recovery.run;
        return {
          status: "running",
          review: "",
          sections: emptyReviewSections(),
          provider: run.provider,
          model: run.model ?? "unknown",
          thinkingOptionId: run.thinkingOptionId,
          reviewerPermissionMode: run.reviewerPermissionMode,
          resultSource: run.resultSource,
          mode: run.mode,
          ...(run.depth ? { depth: run.depth } : {}),
          ...(run.reviewPreset ? { reviewPreset: run.reviewPreset } : {}),
        };
      }
      if (recovery.kind === "unavailable") {
        const run = recovery.run;
        const bindingMatches = run &&
          run.workspaceId === input.workspaceId &&
          run.parentAgentId === input.agentId;
        const locale = bindingMatches ? run.locale ?? "en" : "en";
        const statusMessage = bindingMatches && run.status === "abandoned"
          ? locale === "zh" ? "AI 评审运行已放弃，请重新开始。" : "The AI review run was abandoned; start it again."
          : bindingMatches && run.status === "failed"
            ? locale === "zh" ? "AI 评审运行失败，请重新开始。" : "The AI review run failed; start it again."
            : locale === "zh"
              ? "AI 评审请求已不可用。"
              : "The AI review request is no longer available.";
        return {
          status: "error",
          review: statusMessage,
          sections: emptyReviewSections(),
          provider: bindingMatches ? run.provider : "",
          model: bindingMatches ? run.model ?? "unknown" : "",
          ...(bindingMatches ? {
            thinkingOptionId: run.thinkingOptionId,
            reviewerPermissionMode: run.reviewerPermissionMode,
            resultSource: run.resultSource,
            mode: run.mode,
            ...(run.depth ? { depth: run.depth } : {}),
            ...(run.reviewPreset ? { reviewPreset: run.reviewPreset } : {}),
          } : {}),
        };
      }
      entry = recovery.entry;
    }
    if (entry.workspaceId !== input.workspaceId || entry.agentId !== input.agentId) {
      return {
        status: "error",
        review: "The AI review request is no longer available.",
        sections: emptyReviewSections(),
        provider: "",
        model: "",
      };
    }
    if (entry.cachedResult) {
      const findingCounts = countSectionFindings(entry.cachedResult.sections);
      const completedAt = new Date().toISOString();
      const stored = await this.recordReviewRunCompletion(input.requestId, {
        status: "completed",
        completedAt,
        ...findingCounts,
      });
      await this.appendAiReviewTimeline({
        requestId: input.requestId,
        workspaceId: entry.workspaceId,
        parentAgentId: entry.agentId,
        mode: entry.mode,
        status: "completed",
        resultSource: entry.resultSource,
        ...(entry.depth ? { depth: entry.depth } : {}),
        ...(entry.cachedResult.usage ? { usage: entry.cachedResult.usage } : {}),
        completedAt: stored?.completedAt ?? completedAt,
        ...findingCounts,
      }, context);
      return {
        status: "idle",
        review: entry.cachedResult.review,
        sections: entry.cachedResult.sections,
        provider: entry.provider,
        model: entry.model ?? "unknown",
        thinkingOptionId: entry.thinkingOptionId,
        reviewerPermissionMode: entry.reviewerPermissionMode,
        resultSource: entry.resultSource,
        mode: entry.mode,
        ...(entry.depth ? { depth: entry.depth } : {}),
        ...(entry.reviewPreset ? { reviewPreset: entry.reviewPreset } : {}),
        ...(entry.cachedResult.usage ? { usage: entry.cachedResult.usage } : {}),
      };
    }
    if (!entry.handle) {
      return {
        status: "error",
        review: "The AI review request has no active reviewer.",
        sections: emptyReviewSections(),
        provider: entry.provider,
        model: entry.model ?? "unknown",
        thinkingOptionId: entry.thinkingOptionId,
        reviewerPermissionMode: entry.reviewerPermissionMode,
        resultSource: entry.resultSource,
        mode: entry.mode,
        ...(entry.depth ? { depth: entry.depth } : {}),
        ...(entry.reviewPreset ? { reviewPreset: entry.reviewPreset } : {}),
      };
    }
    let result: Awaited<ReturnType<TransientReviewChildHandle["waitForFinish"]>>;
    try {
      result = await entry.handle.waitForFinish(READONLY_REVIEW_POLL_WAIT_MS);
    } catch {
      return {
        status: "running",
        review: "",
        sections: emptyReviewSections(),
        provider: entry.provider,
        model: entry.model ?? "unknown",
        thinkingOptionId: entry.thinkingOptionId,
        reviewerPermissionMode: entry.reviewerPermissionMode,
        resultSource: entry.resultSource,
        mode: entry.mode,
        ...(entry.depth ? { depth: entry.depth } : {}),
        ...(entry.reviewPreset ? { reviewPreset: entry.reviewPreset } : {}),
      };
    }
    const usage = toAiReviewUsage(result.final?.lastUsage);
    if (result.status === "timeout") {
      return {
        status: "running",
        review: "",
        sections: emptyReviewSections(),
        provider: entry.provider,
        model: entry.model ?? "unknown",
        thinkingOptionId: entry.thinkingOptionId,
        reviewerPermissionMode: entry.reviewerPermissionMode,
        resultSource: entry.resultSource,
        mode: entry.mode,
        ...(entry.depth ? { depth: entry.depth } : {}),
        ...(entry.reviewPreset ? { reviewPreset: entry.reviewPreset } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    if (result.status === "permission") {
      return {
        status: "permission",
        review: result.error ?? "",
        sections: emptyReviewSections(),
        provider: entry.provider,
        model: entry.model ?? "unknown",
        thinkingOptionId: entry.thinkingOptionId,
        reviewerPermissionMode: entry.reviewerPermissionMode,
        resultSource: entry.resultSource,
        mode: entry.mode,
        ...(entry.depth ? { depth: entry.depth } : {}),
        ...(entry.reviewPreset ? { reviewPreset: entry.reviewPreset } : {}),
        ...(usage ? { usage } : {}),
      };
    }

    const locale = entry.locale ?? "en";
    const assistantText =
      result.lastMessage?.trim()
        ? result.lastMessage
        : await this.extractLastAssistantText(entry.handle);
    const structured = result.status === "idle" && assistantText
      ? parseStructuredReviewResult(assistantText)
      : null;
    const normalizedStructured = structured ? normalizeStructuredReviewResult(structured) : null;
    const review = normalizedStructured?.review ??
      assistantText ??
      result.error ??
      (locale === "zh" ? "评审 Agent 未返回文本。" : "The review agent returned no text.");
    const sections = normalizedStructured?.sections ?? reviewSectionsFromMarkdown(review);
    if (result.status === "idle" && assistantText && entry.cacheEnabled && entry.cacheKey && entry.inputFingerprint) {
      try {
        await this.aiReviewCacheStore.put({
          key: entry.cacheKey,
          mode: entry.mode,
          provider: entry.provider,
          model: entry.model,
          thinking: entry.thinkingOptionId,
          promptVersion: AI_REVIEW_PROMPT_VERSION,
          schemaVersion: AI_REVIEW_SCHEMA_VERSION,
          inputFingerprint: entry.inputFingerprint,
          review,
          sections,
          ...(entry.depth ? { depth: entry.depth } : {}),
          ...(usage ? { usage } : {}),
        });
      } catch {
        // A successful review remains usable even when the optional cache is unavailable.
      }
    }
    const nextStatus: "completed" | "failed" = result.status === "idle" ? "completed" : "failed";
    const findingCounts = nextStatus === "completed"
      ? countSectionFindings(sections)
      : { findingCount: 0, highRiskFindingCount: 0 };
    const completedAt = new Date().toISOString();
    const stored = await this.recordReviewRunCompletion(input.requestId, {
      status: nextStatus,
      completedAt,
      ...findingCounts,
    });
    await this.appendAiReviewTimeline({
      requestId: input.requestId,
      workspaceId: entry.workspaceId,
      parentAgentId: entry.agentId,
      mode: entry.mode,
      status: nextStatus,
      resultSource: entry.resultSource,
      ...(entry.depth ? { depth: entry.depth } : {}),
      ...(usage ? { usage } : {}),
      completedAt: stored?.completedAt ?? completedAt,
      ...findingCounts,
    }, context);
    if (result.status === "idle") {
      entry.cachedResult = {
        review,
        sections,
        ...(usage ? { usage } : {}),
      };
    } else {
      this.transientReviewAgents.delete(input.requestId);
    }
    return {
      status: result.status,
      review,
      sections,
      provider: entry.provider,
      model: entry.model ?? "unknown",
      thinkingOptionId: entry.thinkingOptionId,
      reviewerPermissionMode: entry.reviewerPermissionMode,
      resultSource: entry.resultSource,
      mode: entry.mode,
      ...(entry.depth ? { depth: entry.depth } : {}),
      ...(entry.reviewPreset ? { reviewPreset: entry.reviewPreset } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  async clearAiReviewCache(): Promise<boolean> {
    await this.aiReviewCacheStore.clear();
    return true;
  }

  /**
   * Starts a cached review of one selected hunk and returns the same
   * per-request capability used by file and target reviews.
   */
  async startExplainHunkAi(
    input: ReviewRequest & { hunkId: string; agentId: string; workspaceId: string },
    context: PluginHandlerContext,
  ): Promise<{ requestId: string }> {
    const snapshot = await this.createSnapshot(input);
    const hunk = this.findHunk(snapshot, input.hunkId);
    const settings = await this.readReviewerSettings(input.locale);
    const prompt = this.buildAiReviewPrompt(
      snapshot,
      "hunk",
      "targeted",
      input.locale ?? "en",
      settings.defaultReviewPreset,
      hunk,
    );
    const reviewer = await this.resolveReviewerConfiguration(
      { agentId: input.agentId, workspaceId: input.workspaceId, worktreePath: snapshot.worktreePath, locale: input.locale },
      settings,
      context,
    );
    return {
      requestId: await this.startAiReviewRequest({
        snapshot,
        prompt,
        reviewer,
        settings,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        locale: input.locale,
      }, context),
    };
  }

  private async resolveReviewTarget(request: ReviewRequest): Promise<ReviewTarget> {
    const git = this.gitFactory(request.cwd);
    git.validatePathSpec(request.filePath);
    const [repositoryPath, gitDir] = await Promise.all([
      git.run(["rev-parse", "--show-toplevel"]),
      git.run(["rev-parse", "--absolute-git-dir"]),
    ]);
    const worktreePath = await realpath(repositoryPath.trim());
    const worktreeGit = this.gitFactory(worktreePath);
    const baseRef = request.scope === "working" || request.scope === "staged"
      ? "HEAD"
      : await worktreeGit.resolveBaseRef(request.baseRef);
    const headRef = request.scope === "commits" ? request.headRef ?? "HEAD" : "HEAD";
    const [baseSha, headSha] = await Promise.all([
      baseRef ? worktreeGit.optional(["rev-parse", "--verify", baseRef]) : Promise.resolve(null),
      worktreeGit.optional(["rev-parse", "--verify", headRef]),
    ]);
    return { repositoryPath: worktreePath, worktreePath, gitDir: gitDir.trim(), baseRef, headRef, baseSha, headSha };
  }

  private async collectUntrackedPatches(repositoryPath: string, request: ReviewRequest): Promise<string[]> {
    const git = this.gitFactory(repositoryPath);
    const pathspec = request.filePath ? ["--", request.filePath] : [];
    const listed = await git.run(["ls-files", "--others", "--exclude-standard", "-z", ...pathspec]);
    const paths = listed.split("\u0000").filter((path) => path.length > 0);
    const patches = await Promise.all(
      paths.map((path) =>
        git.run(["diff", "--binary", "--no-index", "--", "/dev/null", path], {
          acceptableExitCodes: [0, 1],
        }),
      ),
    );
    return patches.filter((patch) => patch.includes("\n@@ ") || patch.includes("GIT binary patch"));
  }

  private async diffFor(request: ReviewRequest, target: ReviewTarget, untracked: readonly string[]): Promise<string> {
    const git = this.gitFactory(target.repositoryPath);
    const pathspec = request.filePath ? ["--", request.filePath] : [];
    switch (request.scope) {
      case "working": {
        const tracked = await git.run(["diff", "--binary", "--no-ext-diff", "HEAD", ...pathspec]);
        return `${tracked}${untracked.join("")}`;
      }
      case "staged":
        return git.run(["diff", "--cached", "--binary", "--no-ext-diff", "HEAD", ...pathspec]);
      case "branch": {
        if (!target.baseRef) throw new Error("Review Deck could not determine a base branch. Select one explicitly.");
        const base = await git.run(["merge-base", target.baseRef, "HEAD"]);
        return git.run(["diff", "--binary", "--no-ext-diff", base.trim(), "HEAD", ...pathspec]);
      }
      case "commits": {
        if (!request.baseRef || !request.headRef) throw new Error("Commit comparison requires baseRef and headRef.");
        return git.run(["diff", "--binary", "--no-ext-diff", request.baseRef, request.headRef, ...pathspec]);
      }
    }
  }
  /**
   * Assemble the file-view rows: hunks sorted by newStart, each producing its
   * add/del/context rows (del rows placed before the context/add row that
   * follows them), with the untouched target lines filled in as unmarked
   * context rows. A hunk whose context/add lines no longer match the target
   * content byte-for-byte is skipped as stale; overlapping windows are won by
   * the later hunk.
   */
  private assembleFileView(fileLines: string[], hunks: readonly ReviewStateCurrentHunk[]): FileViewRow[] {
    const sorted = hunks
      .map((hunk) => ({ hunk, range: parseRange(hunk.hunkHeader) }))
      .sort((left, right) => left.range.newStart - right.range.newStart);
    // Each emitted entry snapshots the old/new line counters as they stood
    // right after it, so overlap truncation and stale rollback can restore the
    // counters exactly and re-emitted rows keep the numbering continuous.
    const emitted: Array<{ pos: number; row: FileViewRow; oldNo: number; newNo: number }> = [];
    let cursor = 0;
    let oldNo = 1;
    let newNo = 1;
    const flushDels = (pendingDels: string[], hunkId: string | null, atPos: number) => {
      for (const del of pendingDels) {
        emitted.push({
          pos: atPos,
          oldNo: oldNo + 1,
          newNo,
          row: { kind: "del", text: del, hunkId, oldLine: oldNo, newLine: null },
        });
        oldNo++;
      }
    };
    for (const { hunk, range } of sorted) {
      const startIdx = range.newStart - 1;
      if (startIdx < cursor) {
        // Overlapping window: the later hunk wins, so drop every previously
        // emitted row positioned inside the later window.
        let cut = emitted.length;
        while (cut > 0 && emitted[cut - 1].pos >= startIdx) cut--;
        if (cut < emitted.length) emitted.splice(cut);
        if (cut > 0) {
          oldNo = emitted[cut - 1].oldNo;
          newNo = emitted[cut - 1].newNo;
        } else {
          oldNo = 1;
          newNo = 1;
        }
        cursor = startIdx;
      }
      for (let i = cursor; i < startIdx; i++) {
        emitted.push({
          pos: i,
          oldNo: oldNo + 1,
          newNo: newNo + 1,
          row: { kind: "context", text: fileLines[i], hunkId: null, oldLine: oldNo, newLine: newNo },
        });
        oldNo++;
        newNo++;
      }
      cursor = startIdx;
      const bodyLines = hunkBodyLines(hunk.hunkPatch);
      const pendingDels: string[] = [];
      let targetIdx = startIdx;
      let stale = false;
      for (const line of bodyLines) {
        const prefix = line[0];
        if (prefix === "-") {
          pendingDels.push(line.slice(1));
          continue;
        }
        const text = line.slice(1);
        if (fileLines[targetIdx] !== text) {
          stale = true;
          break;
        }
        flushDels(pendingDels, hunk.hunkId, targetIdx);
        pendingDels.length = 0;
        if (prefix === "+") {
          emitted.push({
            pos: targetIdx,
            oldNo,
            newNo: newNo + 1,
            row: { kind: "add", text, hunkId: hunk.hunkId, oldLine: null, newLine: newNo },
          });
          newNo++;
        } else {
          emitted.push({
            pos: targetIdx,
            oldNo: oldNo + 1,
            newNo: newNo + 1,
            row: { kind: "context", text, hunkId: hunk.hunkId, oldLine: oldNo, newLine: newNo },
          });
          oldNo++;
          newNo++;
        }
        targetIdx++;
      }
      if (stale) {
        // The hunk no longer aligns with the target content: drop its rows
        // and leave the window to be filled as plain context.
        while (emitted.length > 0 && emitted[emitted.length - 1].pos >= startIdx) emitted.pop();
        if (emitted.length > 0) {
          oldNo = emitted[emitted.length - 1].oldNo;
          newNo = emitted[emitted.length - 1].newNo;
        } else {
          oldNo = 1;
          newNo = 1;
        }
        cursor = startIdx;
        continue;
      }
      flushDels(pendingDels, hunk.hunkId, targetIdx);
      pendingDels.length = 0;
      cursor = targetIdx;
    }
    for (let i = cursor; i < fileLines.length; i++) {
      emitted.push({
        pos: i,
        oldNo: oldNo + 1,
        newNo: newNo + 1,
        row: { kind: "context", text: fileLines[i], hunkId: null, oldLine: oldNo, newLine: newNo },
      });
      oldNo++;
      newNo++;
    }
    return emitted.map((entry) => entry.row);
  }
  /**
   * Patch-only assembly for targets whose content is unavailable (a fully
   * deleted file, or a path missing from the index/revision): hunks sorted by
   * oldStart, every body line becomes a row, no gap fill. The old/new line
   * counters advance across hunks, so numbering stays continuous.
   */
  private assemblePatchOnly(hunks: readonly ReviewStateCurrentHunk[]): FileViewRow[] {
    const sorted = hunks
      .map((hunk) => ({ hunk, oldStart: parseRange(hunk.hunkHeader).oldStart }))
      .sort((left, right) => left.oldStart - right.oldStart);
    const rows: FileViewRow[] = [];
    let oldNo = 1;
    let newNo = 1;
    for (const { hunk } of sorted) {
      const bodyLines = hunkBodyLines(hunk.hunkPatch);
      for (const line of bodyLines) {
        const prefix = line[0];
        const text = line.slice(1);
        if (prefix === "-") {
          rows.push({ kind: "del", text, hunkId: hunk.hunkId, oldLine: oldNo, newLine: null });
          oldNo++;
        } else if (prefix === "+") {
          rows.push({ kind: "add", text, hunkId: hunk.hunkId, oldLine: null, newLine: newNo });
          newNo++;
        } else if (prefix === " ") {
          rows.push({ kind: "context", text, hunkId: hunk.hunkId, oldLine: oldNo, newLine: newNo });
          oldNo++;
          newNo++;
        }
      }
    }
    return rows;
  }

  /**
   * One eligibility predicate for both the project list and its count-only
   * badge. It returns a body only inside the server; the count RPC never
   * includes it in its response.
   */
  private projectCommentBody(
    entry: StateEntry,
    projectId: string,
  ): { entry: CompleteProjectCommentEntry; body: string } | null {
    if (
      entry.projectId !== projectId ||
      entry.decision !== "commented" ||
      !entry.id ||
      !entry.filePath ||
      !entry.hunkFingerprint ||
      !entry.hunkHeader ||
      !entry.hunkPatch ||
      !entry.cwd ||
      entry.scope === undefined
    ) return null;
    const body = entry.comment?.trim();
    return body ? { entry: entry as CompleteProjectCommentEntry, body } : null;
  }

  private projectCommentFromEntry(entry: StateEntry, targetFingerprint: string, projectId: string): ProjectReviewComment | null {
    const eligible = this.projectCommentBody(entry, projectId);
    if (!eligible) return null;
    const source = eligible.entry;
    return {
      id: source.id,
      projectId,
      ...(source.projectName ? { projectName: source.projectName } : {}),
      ...(source.projectRootPath ? { projectRootPath: source.projectRootPath } : {}),
      ...(source.workspaceId ? { workspaceId: source.workspaceId } : {}),
      targetFingerprint: source.targetFingerprint ?? targetFingerprint,
      hunkId: source.hunkId,
      hunkFingerprint: source.hunkFingerprint,
      filePath: source.filePath,
      hunkHeader: source.hunkHeader,
      hunkPatch: source.hunkPatch,
      cwd: source.cwd,
      scope: source.scope,
      ...(source.baseRef ? { baseRef: source.baseRef } : {}),
      ...(source.headRef ? { headRef: source.headRef } : {}),
      comment: eligible.body,
      savedAt: source.savedAt,
      ...(source.anchor ? { anchor: source.anchor } : {}),
      ...(source.anchorState ? { anchorState: source.anchorState } : {}),
    };
  }

  private projectComments(file: StateFile, projectId: string): ProjectReviewComment[] {
    const comments: ProjectReviewComment[] = [];
    for (const [targetFingerprint, entries] of Object.entries(file)) {
      for (const entry of entries) {
        const comment = this.projectCommentFromEntry(entry, targetFingerprint, projectId);
        if (comment) comments.push(comment);
      }
    }
    return comments;
  }

  private projectCommentIdentity(comments: readonly ProjectReviewComment[]): { projectName?: string; projectRootPath?: string } {
    let projectName: string | undefined;
    let projectRootPath: string | undefined;
    for (const comment of [...comments].sort((left, right) => left.savedAt.localeCompare(right.savedAt))) {
      if (comment.projectName !== undefined) projectName = comment.projectName;
      if (comment.projectRootPath !== undefined) projectRootPath = comment.projectRootPath;
    }
    return {
      ...(projectName !== undefined ? { projectName } : {}),
      ...(projectRootPath !== undefined ? { projectRootPath } : {}),
    };
  }

  /**
   * Prune whole decision buckets whose newest savedAt is older than 30 days,
   * except the bucket of keepKey. Returns the number of buckets removed.
   */
  private pruneStaleBuckets(file: StateFile, keepKey: string): number {
    const cutoff = new Date(Date.now() - STATE_BUCKET_TTL_MS).toISOString();
    let removed = 0;
    for (const key of Object.keys(file)) {
      if (key === keepKey) continue;
      const newest = file[key].reduce((latest, entry) => (entry.savedAt > latest ? entry.savedAt : latest), "");
      if (newest < cutoff) {
        delete file[key];
        removed++;
      }
    }
    return removed;
  }

  /**
   * Fail-closed directory equality for the workspace-bound agent gate. Accepts
   * safe normalization differences (relative segments, duplicate separators,
   * trailing separators) and real-path equivalence (symlinks resolved on both
   * sides); anything that cannot be resolved is never accepted as equal, so a
   * different workspace can never pass as the selected one.
   */
  private async directoriesMatch(left: string, right: string): Promise<boolean> {
    const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
    const normalize = (value: string) => {
      const resolved = resolve(value);
      return resolved.length > 1 && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved;
    };
    const normalizedLeft = normalize(left);
    const normalizedRight = normalize(right);
    if (fold(normalizedLeft) === fold(normalizedRight)) return true;
    try {
      return fold(await realpath(normalizedLeft)) === fold(await realpath(normalizedRight));
    } catch {
      // Fail closed: an unresolvable path never matches.
      return false;
    }
  }

}

function sortProjectComments(comments: ProjectReviewComment[]): ProjectReviewComment[] {
  return comments.sort(
    (left, right) => left.filePath.localeCompare(right.filePath) || left.savedAt.localeCompare(right.savedAt),
  );
}

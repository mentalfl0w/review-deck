import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type {
  AnchorState,
  ExplainHunkResult,
  LineRangeSelection,
  PollAiReviewResult,
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
  FileViewRow,
} from "../shared/review";
import type { ReviewDeckSettingsHandle } from "../shared/review-settings";
import {
  reviewHandoffTimelineKind,
  reviewHandoffTimelineSchema,
  reviewHandoffTimelineVersion,
} from "../shared/review-handoff";
import { canonicalJson, hunkChangeId, hunkContentId, sha256 } from "./util/crypto";
import {
  buildLineRangeAnchor,
  currentHunkDescriptors,
  ownershipMismatch,
  resolveAnchor,
  type AnchorResolution,
  type OwnershipConstraints,
} from "./AnchorEngine";
import { RepoMutexRegistry } from "./util/mutex";
import { displayLanguage } from "./lang/languages";
import { severityRank } from "./diff/FindingDetector";
import { DiffParser, hunkBodyLines, parseRange, type Hunk } from "./diff/DiffParser";
import { GitRunner } from "./git/GitRunner";
import { StateStore, type StateEntry, type StateFile } from "./persistence/StateStore";
import type { ReviewAnchorFileView } from "./AnchorEngine";


export interface ReviewServiceDependencies {
  settings?: ReviewDeckSettingsHandle;
  store?: StateStore;
  diffParser?: DiffParser;
  repoMutexes?: RepoMutexRegistry;
  gitFactory?: (cwd: string) => GitRunner;
}

/** Short wait window per poll; the daemon reports "timeout" while the turn is
 * still running, so a poll never blocks the plugin RPC layer. */
const READONLY_REVIEW_POLL_WAIT_MS = 2_000;
/** Abandoned review entries (client gave up polling) are evicted after this. */
const READONLY_REVIEW_ENTRY_TTL_MS = 10 * 60_000;

function emptyReviewSections(): ReviewSections {
  return { verifiedFacts: [], aiInference: [], humanVerificationRecommended: [] };
}
/** The transient child handle surface pollAiReview needs: waitForFinish plus
 * timeline access for the last-assistant-text recovery fallback. */
type TransientReviewChildHandle = {
  id: string;
  waitForFinish(timeoutMs?: number): Promise<{ status: "idle" | "error" | "permission" | "timeout"; error: string | null; lastMessage: string | null }>;
  timeline?: { refetch(options?: { limit?: number }): Promise<unknown> };
};
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

function agentInstructions(locale: ReviewLocale | undefined, mode: "review" | "explain"): string[] {
  if (locale === "zh") {
    return mode === "review"
      ? [
        "请为人工评审者审查当前 Git 变更。",
        "不要修改文件。使用只读工具检查调用方、被调用方、相关测试和当前文件。",
        "请使用简体中文回答；代码、文件路径、函数名、Git 标头和命令输出保持原文。",
        "请严格使用以下标题：已确认事实、AI 推断、建议人工确认。",
        "仅报告直接由提供的快照或你实际执行的命令支持的已确认事实。",
        "除非实际运行过，否则不要声称测试或构建已通过。",
        "每条发现必须包含对应的变更块 ID。",
      ]
      : [
        "请用简体中文向人工评审者评审这一个变更块。",
        "不要修改文件。使用只读工具检查调用方、被调用方、相关测试和当前文件。",
        "请严格使用以下标题：已确认事实、AI 推断、建议人工确认。",
        "仅报告直接由提供的 diff 或你实际执行的命令支持的已确认事实。",
        "除非实际运行过，否则不要声称测试或构建已通过。",
        "每条发现必须包含对应的变更块 ID。",
        "代码、文件路径、函数名、Git 标头和命令输出保持原文。",
      ];
  }
  return mode === "review"
    ? [
      "Review the current Git changeset for a human reviewer.",
      "Do not edit files. Inspect callers, callees, related tests, and the current files with your read-only tools.",
      "Respond in English. Keep code, file paths, symbol names, Git headers, and command output unchanged.",
      "Use exactly these headings: VERIFIED FACTS, AI INFERENCE, HUMAN VERIFICATION RECOMMENDED.",
      "Only report VERIFIED FACTS that are directly supported by the supplied snapshot or commands you actually ran.",
      "Every finding must include a hunk id. Never claim that tests or builds passed unless you ran them.",
    ]
    : [
      "Review this single change block for a human reviewer.",
      "Do not edit files. Inspect callers, callees, related tests, and the current files with your read-only tools.",
      "Respond in English. Keep code, file paths, symbol names, Git headers, and command output unchanged.",
      "Use exactly these headings: VERIFIED FACTS, AI INFERENCE, HUMAN VERIFICATION RECOMMENDED.",
      "Only report VERIFIED FACTS that are directly supported by the supplied diff or commands you actually ran.",
      "Every finding must include the hunk id. Never claim that tests or builds passed unless you ran them.",
    ];
}


/**
 * Composes the Git runner, diff parser, language heuristics, and state store
 * behind Review Deck's RPC surface. Every git invocation goes through a
 * GitRunner bound to the request's cwd; repository-level mutual exclusion and
 * the decision state file are injected dependencies rather than module globals.
 */
export class ReviewService {
  /** Retain the server settings capability for server-side settings consumers. */
  private readonly settings: ReviewDeckSettingsHandle | undefined;
  private readonly store: StateStore;
  private readonly diffParser: DiffParser;
  private readonly repoMutexes: RepoMutexRegistry;
  private readonly gitFactory: (cwd: string) => GitRunner;
  private readonly anchorFileViewCache = new Map<string, ReviewAnchorFileView>();
  // Read-only reviews started by startRunReview/startExplainHunkAi, keyed by
  // a per-request capability (randomUUID) that is NEVER the child agent id —
  // the child id is globally discoverable through the agent registry, the
  // capability is not. Each entry records the workspace/agent binding the
  // review was started under, and pollAiReview refuses any poll whose
  // workspace/agent does not match it. Entries live until the turn finishes
  // (pollAiReview deletes them) or the TTL sweep evicts abandoned ones.
  // Nothing here ever runs on the selected workspace Agent's stream.
  private readonly transientReviewAgents = new Map<
    string,
    {
      handle: TransientReviewChildHandle;
      locale: ReviewLocale | undefined;
      provider: string;
      model: string | null;
      workspaceId: string;
      agentId: string;
      startedAt: number;
    }
  >();
  private sweepTransientReviewAgents(): void {
    const now = Date.now();
    for (const [id, entry] of this.transientReviewAgents) {
      if (now - entry.startedAt > READONLY_REVIEW_ENTRY_TTL_MS) this.transientReviewAgents.delete(id);
    }
  }

  constructor(dependencies: ReviewServiceDependencies = {}) {
    this.settings = dependencies.settings;
    this.store = dependencies.store ?? new StateStore();
    this.diffParser = dependencies.diffParser ?? new DiffParser();
    this.repoMutexes = dependencies.repoMutexes ?? new RepoMutexRegistry();
    this.gitFactory = dependencies.gitFactory ?? ((cwd) => new GitRunner(cwd));
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
    return this.store.runExclusive(async () => {
      const file = await this.store.load();
      const removed = this.pruneStaleBuckets(file, "");
      if (removed > 0) await this.store.save(file);
      return removed;
    });
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
   * List the saved review comments of one project, ordered by filePath then savedAt.
   * Returns null when the project has no comment records, so listings never expose
   * an empty project. fileCount/targetCount are computed from the comment records.
   */
  async listProjectReviewComments(projectId: string): Promise<ProjectReviewSummary | null> {
    const file = await this.store.load();
    const comments = sortProjectComments(this.projectComments(file, projectId));
    if (comments.length === 0) return null;
    const { projectName, projectRootPath } = this.projectCommentIdentity(comments);
    return {
      projectId,
      ...(projectName !== undefined ? { projectName } : {}),
      ...(projectRootPath !== undefined ? { projectRootPath } : {}),
      commentCount: comments.length,
      fileCount: new Set(comments.map((comment) => comment.filePath)).size,
      targetCount: new Set(comments.map((comment) => comment.targetFingerprint)).size,
      comments,
    };
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
   * Process every saved review comment of one project in a single agent run,
   * strictly bound to the workspace selected in the client UI.
   * The executing agent is refreshed and validated BEFORE anything runs: it must
   * exist, must belong to input.workspaceId, and its cwd must be the selected
   * workspace directory (real-path/normalization differences allowed, a foreign
   * workspace never accepted). Any mismatch throws a clear error — the server
   * never silently substitutes another agent.
   * The prompt embeds the executing agent's workspace id/cwd plus each comment's
   * file path, target/hunk fingerprints, hunk header, exact patch, human comment,
   * and its own worktree context (cwd, scope, refs, workspace id). Project
   * comments may span multiple worktrees; the agent must only touch the listed
   * files/hunks inside the comment's own cwd/worktree, verify fingerprints item by
   * item, and stop (reporting stale) any item whose target drifted.
   * Submit-and-cleanup semantics: the whole prompt is handed to the agent's
   * workflow fire-and-forget (never waited on — processing time is unbounded),
   * then every submitted comment is removed from Review Deck. The returned
   * processedCommentIds/commentCount/submittedAt are the submission
   * confirmation; results appear in the agent's conversation, not here.
   */
  async processProjectReview(
    input: { projectId: string; agentId: string; workspaceId: string; workspaceCwd: string },
    context: PluginHandlerContext,
  ): Promise<ProcessProjectReviewResult> {
    // Workspace-bound agent gate: refresh first so a deleted, replaced, or
    // re-bound agent can never be processed silently under a stale id.
    const handle = context.paseo.agents.ref(input.agentId);
    let agent: { workspaceId?: string; cwd?: string } | null | undefined;
    try {
      const fresh = await handle.refresh();
      agent = fresh?.agent ?? handle.current();
    } catch {
      agent = handle.current();
    }
    if (!agent) {
      throw new Error(
        `Processing agent ${input.agentId} does not exist. Select an agent of workspace ${input.workspaceId} and retry.`,
      );
    }
    if (agent.workspaceId !== input.workspaceId) {
      throw new Error(
        `Processing agent ${input.agentId} belongs to workspace ${agent.workspaceId ?? "(none)"}, not the selected workspace ${input.workspaceId}. Project comments can only be processed by an agent of the selected workspace; no other agent was substituted.`,
      );
    }
    if (!(await this.directoriesMatch(agent.cwd ?? "", input.workspaceCwd))) {
      throw new Error(
        `Processing agent ${input.agentId} runs in ${agent.cwd ?? "(unknown)"}, which is not the selected workspace directory ${input.workspaceCwd}. Refusing to process with an agent outside the selected workspace.`,
      );
    }
    const file = await this.store.load();
    const comments = sortProjectComments(this.projectComments(file, input.projectId));
    if (comments.length === 0) {
      throw new Error(`Project ${input.projectId} has no saved review comments. Save at least one commented hunk before processing.`);
    }
    const processedCommentIds = comments.map((comment) => comment.id);
    const { projectName, projectRootPath } = this.projectCommentIdentity(comments);
    const commentBlocks = comments.map(
      (comment, index) => [
        `[${index + 1}] Comment id: ${comment.id}`,
        `File: ${comment.filePath}`,
        `Comment cwd (worktree): ${comment.cwd}`,
        `Scope: ${comment.scope}`,
        `Base ref: ${comment.baseRef ?? "(repository default)"}`,
        `Head ref: ${comment.headRef ?? "(repository default)"}`,
        ...(comment.workspaceId !== undefined ? [`Workspace id: ${comment.workspaceId}`] : []),
        `Target fingerprint: ${comment.targetFingerprint}`,
        `Hunk fingerprint: ${comment.hunkFingerprint}`,
        `Hunk header: ${comment.hunkHeader}`,
        `Human comment: ${comment.comment}`,
        `Exact hunk patch:\n${comment.hunkPatch}`,
      ].join("\n"),
    );
    const prompt = [
      "Process every saved review comment below as one task.",
      "Each comment block carries its own cwd (the exact working directory of the worktree the comment came from), scope, refs, and workspace id. The project may span multiple worktrees: you MUST validate and modify every comment inside that comment's own cwd/workspace only, and never treat the project root path, the executing agent's own workspace, or any other worktree as the target of a comment. Every comment is validated against its own cwd, even when that cwd differs from the executing agent's workspace.",
      "You may edit the listed files and hunks to address the human comments, but never modify unrelated files or hunks, and never touch anything outside the comment's own cwd/worktree.",
      "Verify each comment against the current state before editing. If the target fingerprint or the exact hunk fingerprint no longer matches the current change (the target drifted), stop work on that comment, do not edit it, and report it as stale.",
      "For each matching comment, apply the requested change to exactly the listed hunk. Focused verification (running the relevant test or build for the code you changed) is allowed, but never claim that tests or builds passed unless you actually ran them.",
      "Use exactly these headings: VERIFIED FACTS, AI INFERENCE, HUMAN VERIFICATION RECOMMENDED.",
      "At the very end of your response, add a strict machine-parseable COMMENT OUTCOMES section with exactly one line per comment id, in this exact format:",
      "- <comment-id> | COMPLETED | optional short detail",
      "- <comment-id> | STALE | optional short detail",
      "- <comment-id> | FAILED | optional short detail",
      "- <comment-id> | UNRESOLVED | optional short detail",
      "Mark COMPLETED only for comments you actually finished editing. Mark STALE when the target drifted, FAILED when you tried but could not complete it, UNRESOLVED when you did not address it. A comment that is not explicitly marked COMPLETED must never be treated as completed.",
      `Project id: ${input.projectId}`,
      ...(projectName !== undefined ? [`Project name: ${projectName}`] : []),
      `Workspace: ${projectRootPath ?? comments[0].cwd}`,
      `Executing agent workspace id: ${input.workspaceId}`,
      `Executing agent workspace cwd: ${input.workspaceCwd}`,
      `Comments (${comments.length}):`,
      commentBlocks.join("\n\n"),
    ].join("\n\n");
    // Fire-and-forget submit: the prompt is handed to the agent's workflow via
    // handle.send (send_agent_message_request — the same RPC the workspace UI
    // uses, so the prompt lands in the selected workspace Agent's message
    // stream). Processing time is unbounded, so we never wait for the agent:
    // results appear in the agent's conversation and the user copies them from
    // there. Only after the daemon accepts the prompt are the submitted
    // comments removed from Review Deck (every commented record of the project;
    // reviewed records are preserved); on send failure the comments are left
    // untouched and the error propagates.
    await handle.send(prompt);
    // Observability-only audit row on the SAME agent's timeline: one
    // version-1 "review-deck-handoff" plugin item recording that this batch
    // of review comments was submitted to the agent's workflow. The row
    // states only the submission (never completion) and carries no review
    // content, file path, cwd, workspace, project, or agent identifiers.
    // The append is best-effort: a failure is logged and swallowed so the
    // established queue-clear path below still runs — an append failure can
    // never surface as an RPC error, so a client retry can never re-send the
    // prompt and duplicate the Agent task.
    try {
      await handle.timeline.append({
        type: "plugin",
        id: randomUUID(),
        kind: reviewHandoffTimelineKind,
        version: reviewHandoffTimelineVersion,
        data: reviewHandoffTimelineSchema.parse({
          commentCount: processedCommentIds.length,
          submittedAt: new Date().toISOString(),
        }),
      });
    } catch (error) {
      console.error(
        `review-deck: could not append a review-deck-handoff timeline row for agent ${input.agentId}; the batch was already sent, continuing with the queue clear`,
        error,
      );
    }
    await this.clearProjectReviewComments(input.projectId);
    return {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      workspaceCwd: input.workspaceCwd,
      processedCommentIds,
      commentCount: processedCommentIds.length,
      submittedAt: new Date().toISOString(),
    };
  }

  /**
   * Remove every commented/has-comment record of the project (used by
   * processProjectReview after the comments were handed to the agent's
   * workflow); reviewed records are preserved. Returns the number of records
   * actually cleared.
   */
  async clearProjectReviewComments(projectId: string): Promise<number> {
    return this.store.runExclusive(async () => {
      const file = await this.store.load();
      let cleared = 0;
      for (const [targetFingerprint, entries] of Object.entries(file)) {
        const next = entries.filter((entry) => {
          if (entry.projectId !== projectId) return true;
          return !(entry.decision === "commented" || (entry.comment?.trim() ?? "") !== "");
        });
        if (next.length === entries.length) continue;
        cleared += entries.length - next.length;
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

  explain(snapshot: ReviewSnapshot, hunk: Hunk, locale: ReviewLocale = "en"): {
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

  parseReviewSections(text: string): ReviewSections {
    const sections: ReviewSections = {
      verifiedFacts: [],
      aiInference: [],
      humanVerificationRecommended: [],
    };
    let active: keyof ReviewSections | null = null;
    for (const line of text.split("\n")) {
      const heading = line.trim().toUpperCase().replace(/^#+\s*/, "").replace(/[:：]$/, "");
      if (heading === "VERIFIED FACTS" || heading === "已确认事实" || heading === "已验证事实") active = "verifiedFacts";
      else if (heading === "AI INFERENCE" || heading === "AI 推断" || heading === "AI推断") active = "aiInference";
      else if (
        heading === "HUMAN VERIFICATION RECOMMENDED"
        || heading === "建议人工确认"
        || heading === "人工验证建议"
      ) active = "humanVerificationRecommended";
      else if (active && line.trim()) sections[active].push(line.trim().replace(/^[-*]\s+/, ""));
    }
    if (sections.verifiedFacts.length === 0 && sections.aiInference.length === 0 && sections.humanVerificationRecommended.length === 0 && text.trim()) {
      sections.aiInference.push(text.trim());
    }
    return sections;
  }

  /**
   * Starts the AI评审文件 (whole-file read-only review) flow: the workspace
   * binding is validated (the parent agent must belong to the claimed
   * workspace and run in the reviewed worktree), then the locale review
   * prompt is built, the transient child agent is created WITHOUT waiting,
   * and a per-request capability (never the child's discoverable agent id) is
   * returned as the requestId the client polls. The result is delivered
   * through pollAiReview so the plugin RPC layer is never blocked past its
   * timeout.
   */
  async startRunReview(
    input: ReviewRequest & { agentId: string; workspaceId: string },
    context: PluginHandlerContext,
  ): Promise<{ requestId: string }> {
    const snapshot = await this.createSnapshot(input);
    const locale = input.locale ?? "en";
    const hunkContext = snapshot.files
      .flatMap((file) => file.hunks)
      .map((hunk) => `${hunk.id} ${hunk.filePath} ${hunk.header}${hunk.functionHint ? ` (enclosing: ${hunk.functionHint})` : ""}\n${hunk.patch}`)
      .join("\n")
      .slice(0, 160_000);
    const prompt = [
      ...agentInstructions(locale, "review"),
      locale === "zh" ? `工作区：${snapshot.worktreePath}` : `Workspace: ${snapshot.worktreePath}`,
      locale === "zh" ? `评审指纹：${snapshot.targetFingerprint}` : `Review fingerprint: ${snapshot.targetFingerprint}`,
      locale === "zh" ? "变更块：" : "Hunks:",
      hunkContext || (locale === "zh" ? "（没有找到文本变更块。）" : "(No text hunks found.)"),
    ].join("\n\n");
    const requestId = await this.startTransientReviewAgent(
      { agentId: input.agentId, workspaceId: input.workspaceId, worktreePath: snapshot.worktreePath, locale: input.locale, prompt },
      context,
    );
    return { requestId };
  }

  /**
   * Resolves the transient review child's create config from the SELECTED
   * workspace Agent's own snapshot, after a fail-closed workspace-bound agent
   * gate (the same shape processProjectReview enforces): the refreshed parent
   * must belong to the claimed workspace, the claimed workspace's directory
   * must be the reviewed worktree, and the parent agent must run in that same
   * worktree. Any mismatch throws a clear locale-aware error BEFORE any
   * child is created or any prompt is sent — a foreign workspace Agent can
   * never be bound to another workspace's diff. The daemon's
   * create_agent_request schema requires config.provider in combined
   * "provider/model" format, so the resolved provider joins the parent's
   * provider and model into a single "<provider>/<model>" string; the
   * parent's own values are returned separately as display labels for Review
   * Deck. Never hardcodes a model and never falls back to running on the
   * parent's stream — when the parent snapshot cannot be resolved a clear
   * locale-aware error is thrown.
   */
  private async resolveParentAgentConfig(
    input: { agentId: string; workspaceId: string; worktreePath: string; locale: ReviewLocale | undefined },
    context: PluginHandlerContext,
  ): Promise<{
    /** Combined "provider/model" string for the daemon create config. */
    provider: string;
    /** Parent provider id reported back to Review Deck. */
    agentProvider: string;
    /** Parent model id (or null when the parent has none) for Review Deck. */
    agentModel: string | null;
    thinkingOptionId: string | null;
  }> {
    const handle = context.paseo.agents.ref(input.agentId);
    let agent: {
      workspaceId?: string | null;
      cwd?: string | null;
      provider?: string;
      model?: string | null;
      thinkingOptionId?: string | null;
      effectiveThinkingOptionId?: string | null;
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
          ? `无法解析所选工作区 Agent（${input.agentId}）的配置，不能创建只读评审子 Agent。评审未运行在所选工作区 Agent 的会话流上。`
          : `Could not resolve the selected workspace Agent (${input.agentId}) configuration, so the read-only review child agent could not be created. The review did not run on the selected workspace Agent's stream.`,
      );
    }
    // Workspace-bound agent gate: the refreshed parent must belong to the
    // claimed workspace. A stale id pointing at a workspace-bound agent of
    // another workspace is refused here, never silently substituted.
    if (agent.workspaceId !== input.workspaceId) {
      throw new Error(
        input.locale === "zh"
          ? `所选 Agent（${input.agentId}）属于工作区 ${agent.workspaceId ?? "（无）"}，不是所选工作区 ${input.workspaceId}。不能创建只读评审子 Agent，也未使用其他 Agent 代替。`
          : `Selected agent ${input.agentId} belongs to workspace ${agent.workspaceId ?? "(none)"}, not the selected workspace ${input.workspaceId}. The read-only review child agent was not created and no other agent was substituted.`,
      );
    }
    // The claimed workspace itself must resolve and its directory must BE the
    // reviewed worktree: a workspace id alone never authorizes a cwd outside
    // that workspace.
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
          ? `无法解析所选工作区 ${input.workspaceId} 的目录，不能创建只读评审子 Agent。`
          : `Could not resolve the directory of workspace ${input.workspaceId}, so the read-only review child agent could not be created.`,
      );
    }
    if (!(await this.directoriesMatch(workspaceDirectory, input.worktreePath))) {
      throw new Error(
        input.locale === "zh"
          ? `评审目录 ${input.worktreePath} 不是所选工作区 ${input.workspaceId}（${workspaceDirectory}）的目录。不能创建只读评审子 Agent。`
          : `The reviewed worktree ${input.worktreePath} is not the directory of the selected workspace ${input.workspaceId} (${workspaceDirectory}). The read-only review child agent was not created.`,
      );
    }
    // The parent agent must actually run in the reviewed worktree.
    if (!agent.cwd || !(await this.directoriesMatch(agent.cwd, input.worktreePath))) {
      throw new Error(
        input.locale === "zh"
          ? `所选 Agent（${input.agentId}）运行于 ${agent.cwd ?? "（未知）"}，不是评审目录 ${input.worktreePath}。不能创建只读评审子 Agent，也未使用其他 Agent 代替。`
          : `Selected agent ${input.agentId} runs in ${agent.cwd ?? "(unknown)"}, not the reviewed worktree ${input.worktreePath}. The read-only review child agent was not created and no other agent was substituted.`,
      );
    }
    return {
      provider: agent.model ? `${agent.provider}/${agent.model}` : agent.provider,
      agentProvider: agent.provider,
      agentModel: agent.model ?? null,
      thinkingOptionId: agent.thinkingOptionId ?? agent.effectiveThinkingOptionId ?? null,
    };
  }

  /**
   * Creates the transient read-only review child agent (combined
   * "provider/model" derived from the selected workspace Agent, no separate
   * model key, optional thinkingOptionId) and registers it in
   * transientReviewAgents under a fresh per-request capability — a randomUUID
   * that is the requestId the client polls. The child's own agent id is
   * globally discoverable through the agent registry, so it is NEVER exposed
   * as the poll credential. Does NOT wait: the wait happens in pollAiReview
   * so the plugin RPC layer is never blocked past its timeout. On create
   * failure a clear locale-aware error is thrown; the review NEVER falls back
   * to running on the selected workspace Agent's stream.
   */
  private async startTransientReviewAgent(
    input: { agentId: string; workspaceId: string; worktreePath: string; locale: ReviewLocale | undefined; prompt: string },
    context: PluginHandlerContext,
  ): Promise<string> {
    this.sweepTransientReviewAgents();
    const resolved = await this.resolveParentAgentConfig(
      { agentId: input.agentId, workspaceId: input.workspaceId, worktreePath: input.worktreePath, locale: input.locale },
      context,
    );
    // config.provider already carries the combined "provider/model" string the
    // daemon requires; a separate model key must NOT be sent.
    const agentConfig = {
      provider: resolved.provider,
      ...(resolved.thinkingOptionId ? { thinkingOptionId: resolved.thinkingOptionId } : {}),
    };
    let child: TransientReviewChildHandle;
    try {
      child = await context.paseo.agents.create({
        config: agentConfig,
        cwd: input.worktreePath,
        parent: input.agentId,
        title: input.locale === "zh" ? "Review Deck 只读评审" : "Review Deck read-only review",
        autoArchive: true,
        prompt: input.prompt,
      });
    } catch (error) {
      throw new Error(
        input.locale === "zh"
          ? `只读评审子 Agent 创建失败：${error instanceof Error ? error.message : String(error)}。评审未运行在所选工作区 Agent 的会话流上。`
          : `Failed to create the read-only review child agent: ${error instanceof Error ? error.message : String(error)}. The review did not run on the selected workspace Agent's stream.`,
      );
    }
    const requestId = randomUUID();
    this.transientReviewAgents.set(requestId, {
      handle: child,
      locale: input.locale,
      provider: resolved.agentProvider,
      model: resolved.agentModel,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      startedAt: Date.now(),
    });
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
   * Polls a running read-only review. Each poll waits on the transient child
   * for a short window; the daemon reports "timeout" while the turn is still
   * running, so only idle/error/permission resolve the final result (review
   * text, sections, status, parent display labels — exactly like the old
   * blocking flow) and delete the entry. The requestId is a per-request
   * capability that is never the child's agent id; it must also match the
   * workspace/agent binding recorded at start time, and any unknown or
   * mismatched request (a foreign workspace's capability, a stale agent
   * reselection) returns a clear error and is never resolved.
   */
  async pollAiReview(input: { requestId: string; workspaceId: string; agentId: string }): Promise<PollAiReviewResult> {
    this.sweepTransientReviewAgents();
    const entry = this.transientReviewAgents.get(input.requestId);
    if (!entry || entry.workspaceId !== input.workspaceId || entry.agentId !== input.agentId) {
      return {
        status: "error",
        review: "The AI review request is no longer available.",
        sections: emptyReviewSections(),
        provider: "",
        model: "",
      };
    }
    let result: { status: "idle" | "error" | "permission" | "timeout"; error: string | null; lastMessage: string | null };
    try {
      result = await entry.handle.waitForFinish(READONLY_REVIEW_POLL_WAIT_MS);
    } catch {
      // Transient wait failure: the child is still alive; keep polling.
      return { status: "running", review: "", sections: emptyReviewSections(), provider: entry.provider, model: entry.model ?? "unknown" };
    }
    if (result.status === "timeout") {
      // The daemon reports "timeout" when the wait window elapsed while the
      // turn was still running — keep polling.
      return { status: "running", review: "", sections: emptyReviewSections(), provider: entry.provider, model: entry.model ?? "unknown" };
    }
    this.transientReviewAgents.delete(input.requestId);
    const locale = entry.locale ?? "en";
    // waitForFinish can settle (idle) with no final lastMessage when the turn
    // ended after a tool call while the actual reply sits earlier in the
    // timeline — recover it before falling back to the wait error/text.
    const review =
      result.lastMessage?.trim()
        ? result.lastMessage
        : ((await this.extractLastAssistantText(entry.handle)) ?? result.error ?? (locale === "zh" ? "评审 Agent 未返回文本。" : "The review agent returned no text."));
    return {
      status: result.status,
      review,
      sections: this.parseReviewSections(review),
      provider: entry.provider,
      model: entry.model ?? "unknown",
    };
  }

  /**
   * Starts the AI评审变更块 (single change block) read-only review: the
   * workspace binding is validated (the parent agent must belong to the
   * claimed workspace and run in the reviewed worktree), then the prompt —
   * which only asks for a read-only review of the given hunk, never to edit
   * files — is composed, the transient child agent is created WITHOUT
   * waiting, and a per-request capability (never the child's discoverable
   * agent id) is returned as the requestId the client polls; the result
   * (including the parent display provider/model) arrives through
   * pollAiReview.
   */
  async startExplainHunkAi(
    input: ReviewRequest & { hunkId: string; agentId: string; workspaceId: string },
    context: PluginHandlerContext,
  ): Promise<{ requestId: string }> {
    const snapshot = await this.createSnapshot(input);
    const locale = input.locale ?? "en";
    const copy = deterministicCopy(locale);
    const hunk = this.findHunk(snapshot, input.hunkId);
    const prompt = [
      ...agentInstructions(locale, "explain"),
      locale === "zh" ? `工作区：${snapshot.worktreePath}` : `Workspace: ${snapshot.worktreePath}`,
      locale === "zh" ? `评审指纹：${snapshot.targetFingerprint}` : `Review fingerprint: ${snapshot.targetFingerprint}`,
      locale === "zh" ? `变更块 ID：${hunk.id}` : `Hunk id: ${hunk.id}`,
      copy.formatLabel(copy.file, hunk.filePath),
      locale === "zh" ? `变更块标头：${hunk.header}` : `Hunk header: ${hunk.header}`,
      locale === "zh" ? `完整变更块 diff：\n${hunk.patch}` : `Exact hunk diff:\n${hunk.patch}`,
      ...(hunk.functionHint ? [copy.formatLabel(copy.enclosingSymbol, hunk.functionHint)] : []),
      ...(hunk.language ? [copy.formatLabel(copy.language, displayLanguage(hunk.language))] : []),
    ].join("\n\n");
    const requestId = await this.startTransientReviewAgent(
      { agentId: input.agentId, workspaceId: input.workspaceId, worktreePath: snapshot.worktreePath, locale: input.locale, prompt },
      context,
    );
    return { requestId };
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

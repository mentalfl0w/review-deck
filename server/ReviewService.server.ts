import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin";
import type {
  ExplainHunkAiResult,
  ExplainHunkResult,
  ProcessProjectReviewResult,
  ProjectReviewComment,
  ProjectReviewCommentOutcome,
  ProjectReviewSummary,
  ReviewRequest,
  ReviewSections,
  ReviewScope,
  ReviewSnapshot,
  ReviewStateCurrentHunk,
  FileViewRow,
} from "../review.shared";
import { canonicalJson, hunkChangeId, hunkContentId, sha256 } from "./util/crypto.server";
import { RepoMutexRegistry } from "./util/mutex.server";
import { displayLanguage } from "./lang/languages.server";
import { severityRank } from "./diff/FindingDetector.server";
import { DiffParser, hunkFingerprint, parseRange, type Hunk } from "./diff/DiffParser.server";
import { GitRunner } from "./git/GitRunner.server";
import { StateStore, type StateEntry, type StateFile } from "./persistence/StateStore.server";

export interface ReviewServiceDependencies {
  store?: StateStore;
  diffParser?: DiffParser;
  repoMutexes?: RepoMutexRegistry;
  gitFactory?: (cwd: string) => GitRunner;
}

export interface AgentReviewResult {
  status: "idle" | "error" | "permission" | "timeout";
  review: string;
  sections: ReviewSections;
}

const COMMENT_OUTCOME_STATUSES: Record<string, true> = {
  completed: true,
  stale: true,
  failed: true,
  unresolved: true,
};
const COMMENT_OUTCOME_STATUS = ["completed", "stale", "failed", "unresolved"] as const;
type CommentOutcomeStatus = (typeof COMMENT_OUTCOME_STATUS)[number];
const FILE_VIEW_MAX_ROWS = 20_000;
const STATE_BUCKET_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface ReviewTarget {
  repositoryPath: string;
  worktreePath: string;
  gitDir: string;
  baseRef: string | null;
  headRef: string;
  baseSha: string | null;
  headSha: string | null;
}

/**
 * Composes the Git runner, diff parser, language heuristics, and state store
 * behind Review Deck's RPC surface. Every git invocation goes through a
 * GitRunner bound to the request's cwd; repository-level mutual exclusion and
 * the decision state file are injected dependencies rather than module globals.
 */
export class ReviewService {
  private readonly store: StateStore;
  private readonly diffParser: DiffParser;
  private readonly repoMutexes: RepoMutexRegistry;
  private readonly gitFactory: (cwd: string) => GitRunner;

  constructor(dependencies: ReviewServiceDependencies = {}) {
    this.store = dependencies.store ?? new StateStore();
    this.diffParser = dependencies.diffParser ?? new DiffParser();
    this.repoMutexes = dependencies.repoMutexes ?? new RepoMutexRegistry();
    this.gitFactory = dependencies.gitFactory ?? ((cwd) => new GitRunner(cwd));
  }

  async createSnapshot(request: ReviewRequest): Promise<ReviewSnapshot> {
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
    const files = this.diffParser.parse(await this.diffFor(request, target, untracked), targetFingerprint);
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
  async fileView(
    input: ReviewRequest & { filePath: string; targetFingerprint: string; hunks: ReviewStateCurrentHunk[] },
  ): Promise<{ binary: boolean; truncated: boolean; rows: FileViewRow[] }> {
    const target = await this.resolveReviewTarget(input);
    let content: string | null = null;
    if (input.scope === "working") {
      try {
        const buffer = await readFile(join(target.repositoryPath, input.filePath));
        if (buffer.includes(0)) return { binary: true, truncated: false, rows: [] };
        content = buffer.toString("utf8");
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
        const shown = await this.gitFactory(target.repositoryPath).run(["show", spec]);
        if (shown.includes("\u0000")) return { binary: true, truncated: false, rows: [] };
        content = shown;
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
    return { binary: false, truncated, rows: truncated ? rows.slice(0, FILE_VIEW_MAX_ROWS) : rows };
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
  }): Promise<string> {
    const contentId = hunkContentId(input.filePath, input.hunkPatch);
    return this.store.runExclusive(async () => {
      const savedAt = new Date().toISOString();
      const file = await this.store.load();
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

  async reviewState(targetFingerprint: string, currentHunks?: readonly ReviewStateCurrentHunk[]): Promise<StateEntry[]> {
    if (!currentHunks) return (await this.store.load())[targetFingerprint] ?? [];
    return this.store.runExclusive(async () => {
      const file = await this.store.load();
      let changed = false;
      // Fallback GC: whole buckets whose newest decision predates the 30-day
      // window are dead; drop everything but the requested target.
      if (this.pruneStaleBuckets(file, targetFingerprint) > 0) changed = true;
      // Content ids of the hunks the client currently shows; inheritance and
      // result filtering both key on them.
      const currentContentIds = new Set(currentHunks.map((hunk) => hunkContentId(hunk.filePath, hunk.hunkPatch)));
      const bucket = file[targetFingerprint] ?? [];
      const presentContentIds = new Set(bucket.flatMap((entry) => (entry.contentId ? [entry.contentId] : [])));
      // Inherit: move the earliest-saved entry per needed content id out of
      // other buckets, fields as-is; a bucket emptied by the move disappears.
      const inherited = new Map<string, StateEntry>();
      for (const [key, entries] of Object.entries(file)) {
        if (key === targetFingerprint) continue;
        for (const entry of entries) {
          if (!entry.contentId || presentContentIds.has(entry.contentId) || !currentContentIds.has(entry.contentId)) continue;
          const existing = inherited.get(entry.contentId);
          if (!existing || entry.savedAt < existing.savedAt) inherited.set(entry.contentId, entry);
        }
      }
      if (inherited.size > 0) {
        const migrated = [...inherited.values()].sort((left, right) => left.savedAt.localeCompare(right.savedAt));
        file[targetFingerprint] = [...bucket, ...migrated];
        // The inherited entry moves out of its source bucket; a bucket emptied
        // by the move disappears.
        for (const entry of migrated) {
          for (const key of Object.keys(file)) {
            if (key === targetFingerprint) continue;
            const source = file[key];
            const index = source.indexOf(entry);
            if (index === -1) continue;
            source.splice(index, 1);
            if (source.length === 0) delete file[key];
            break;
          }
        }
        changed = true;
      }
      for (const key of Object.keys(file)) {
        if (key !== targetFingerprint && file[key].length === 0) {
          delete file[key];
          changed = true;
        }
      }
      if (changed) await this.store.save(file);
      // Match: content-id hits, or legacy id/fingerprint hits against the
      // current hunks; anything else stays out of the result. Content-matched
      // entries may still carry a hunkId from an earlier fingerprint era
      // (inherited or drifted in place), so their identity is rebound to the
      // current hunk — persisted too, keeping clients free of id lookup
      // mismatches and recordDecision's same-id replace coherent.
      const metaByContentId = new Map<string, { id: string; fingerprint: string }>();
      const currentById = new Set(currentHunks.map((hunk) => hunk.hunkId));
      const currentByFingerprint = new Set<string>();
      const ordinalByPath = new Map<string, number>();
      for (const hunk of currentHunks) {
        const ordinal = ordinalByPath.get(hunk.filePath) ?? 0;
        ordinalByPath.set(hunk.filePath, ordinal + 1);
        const fingerprint = hunkFingerprint(targetFingerprint, hunk.filePath, hunk.hunkHeader, hunk.hunkPatch, ordinal);
        currentByFingerprint.add(fingerprint);
        metaByContentId.set(hunkContentId(hunk.filePath, hunk.hunkPatch), {
          id: hunk.hunkId,
          fingerprint,
        });
      }
      const entries = file[targetFingerprint] ?? [];
      // Rebind drifted identities in place (all rows kept — unmatched rows
      // only leave the RESULT, the bucket still owns them), then filter.
      let identityChanged = false;
      const rebound = entries.map((entry) => {
        if (entry.contentId === undefined) return entry;
        const meta = metaByContentId.get(entry.contentId);
        if (!meta || (entry.hunkId === meta.id && entry.hunkFingerprint === meta.fingerprint)) return entry;
        identityChanged = true;
        return { ...entry, hunkId: meta.id, hunkFingerprint: meta.fingerprint };
      });
      if (identityChanged) {
        file[targetFingerprint] = rebound;
        await this.store.save(file);
      }
      return rebound.filter((entry) =>
        entry.contentId !== undefined
          ? currentContentIds.has(entry.contentId)
          : currentById.has(entry.hunkId) || (entry.hunkFingerprint !== undefined && currentByFingerprint.has(entry.hunkFingerprint)),
      );
    });
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
   * item, and stop (reporting stale) any item whose target drifted. The agent must
   * end its response with a strict machine-parseable COMMENT OUTCOMES section.
   * processedCommentIds lists the comment ids actually sent — returned even when
   * the agent exits non-idle so the client can keep the records instead of
   * auto-clearing. completedCommentIds lists only ids the agent explicitly marked
   * COMPLETED and that survived server-side validation (parsed exactly once, known
   * id, agent idle); commentOutcomes covers every sent id in send order, defaulting
   * missing/duplicate/unknown entries to "unresolved". The result carries the
   * validated workspaceId/workspaceCwd so output ownership is unambiguous.
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
    const result = await handle.run(prompt, { timeoutMs: 120_000 });
    const review = result.lastMessage ?? result.error ?? "The processing agent returned no text.";
    const { completedCommentIds, commentOutcomes } = this.parseCommentOutcomes(
      review,
      processedCommentIds,
      result.status === "idle",
      result.status,
    );
    const cleanReview = this.stripCommentOutcomes(review);
    let provider = input.agentId;
    let model = "unknown";
    try {
      const fresh = await handle.refresh();
      const freshAgent = fresh?.agent ?? handle.current();
      if (freshAgent) {
        provider = freshAgent.provider || input.agentId;
        model = freshAgent.model || "unknown";
      }
    } catch {
      // Provider/model keep their fallback values.
    }
    return {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      workspaceCwd: input.workspaceCwd,
      status: result.status,
      processedCommentIds,
      completedCommentIds,
      commentOutcomes,
      commentCount: processedCommentIds.length,
      review: cleanReview,
      sections: this.parseReviewSections(cleanReview),
      provider,
      model,
    };
  }

  /**
   * Remove saved project review comments. With commentIds only the listed comment
   * ids are removed (comments saved while processing keep their own ids and are
   * never touched); without commentIds every commented/has-comment record of the
   * project is removed. Reviewed records are preserved. Returns the number of
   * records actually cleared.
   */
  async clearProjectReviewComments(projectId: string, commentIds?: readonly string[]): Promise<number> {
    return this.store.runExclusive(async () => {
      const file = await this.store.load();
      let cleared = 0;
      for (const [targetFingerprint, entries] of Object.entries(file)) {
        const next = entries.filter((entry) => {
          if (entry.projectId !== projectId) return true;
          if (commentIds !== undefined) return !(entry.id !== undefined && commentIds.includes(entry.id));
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

  explain(snapshot: ReviewSnapshot, hunk: Hunk): {
    hunkId: string;
    verifiedFacts: string[];
    aiInference: string[];
    humanVerificationRecommended: string[];
    revisionPrompt: string;
  } {
    const facts = [
      `File: ${hunk.filePath}.`,
      ...(hunk.functionHint ? [`Enclosing symbol: ${hunk.functionHint}.`] : []),
      ...(hunk.language ? [`Language: ${displayLanguage(hunk.language)}.`] : []),
      `Changed range: ${hunk.header}.`,
      `The hunk adds ${hunk.lines.filter((line) => line.startsWith("+")).length} lines and removes ${hunk.lines.filter((line) => line.startsWith("-")).length} lines.`,
      ...hunk.findings.filter((finding) => finding.evidenceKind === "verified_fact").map((finding) => finding.detail),
    ];
    const highRisk = hunk.findings.filter((finding) => severityRank(finding.severity) >= 4);
    const humanChecks = highRisk.length > 0
      ? highRisk.map((finding) => finding.suggestedCheck ?? `Confirm the ${finding.category} implications.`)
      : ["Confirm the changed behavior against its callers and its nearest focused test."];
    const inference = ["The exact motivation is not proven by the diff alone; inspect the task context and surrounding call sites before accepting this change."];
    const revisionPrompt = [
      `Revise only ${hunk.id} in ${hunk.filePath}.`,
      ...(hunk.functionHint ? [`Enclosing symbol: ${hunk.functionHint}.`] : []),
      ...(hunk.language ? [`Language: ${displayLanguage(hunk.language)}.`] : []),
      `Review snapshot fingerprint: ${snapshot.targetFingerprint}.`,
      `Hunk fingerprint: ${hunk.fingerprint}.`,
      "Do not modify unrelated files or hunks.",
      "Before editing, stop and report if the current target fingerprint differs.",
      "Human checks:",
      ...humanChecks.map((check) => `- ${check}`),
    ].join("\n");
    return { hunkId: hunk.id, verifiedFacts: facts, aiInference: inference, humanVerificationRecommended: humanChecks, revisionPrompt };
  }
  /**
   * Rule-level explanation of a whole file: per-hunk explain() output merged
   * into sections by hunk header, aggregating every hunk's findings. hunkId
   * carries the file path so the client's findings pipeline can render it.
   */
  async explainFile(input: ReviewRequest & { filePath: string }): Promise<ExplainHunkResult> {
    const snapshot = await this.createSnapshot(input);
    const file = snapshot.files.find((candidate) => candidate.path === input.filePath);
    if (!file) {
      throw new Error(`File ${input.filePath} is no longer present in this review snapshot.`);
    }
    const sections = file.hunks.map((hunk) => this.explain(snapshot, hunk));
    const verifiedFacts = file.hunks.flatMap((hunk, index) => [
      `Hunk ${hunk.header}:`,
      ...sections[index].verifiedFacts.map((fact) => `- ${fact}`),
    ]);
    const aiInference = file.hunks.flatMap((hunk, index) => [
      `Hunk ${hunk.header}:`,
      ...sections[index].aiInference.map((item) => `- ${item}`),
    ]);
    const humanVerificationRecommended = file.hunks.flatMap((hunk, index) => [
      `Hunk ${hunk.header}:`,
      ...sections[index].humanVerificationRecommended.map((item) => `- ${item}`),
    ]);
    const revisionPrompt = [
      `Revise only ${input.filePath} according to the review above.`,
      `Review snapshot fingerprint: ${snapshot.targetFingerprint}.`,
      ...file.hunks.map((hunk) => `Hunk ${hunk.id} (${hunk.header}): fingerprint ${hunk.fingerprint}.`),
      "Do not modify unrelated files or hunks.",
      "Before editing, stop and report if the current target fingerprint differs.",
    ].join("\n");
    return {
      hunkId: input.filePath,
      verifiedFacts,
      aiInference,
      humanVerificationRecommended,
      revisionPrompt,
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
      const heading = line.trim().toUpperCase().replace(/^#+\s*/, "").replace(/:$/, "");
      if (heading === "VERIFIED FACTS") active = "verifiedFacts";
      else if (heading === "AI INFERENCE") active = "aiInference";
      else if (heading === "HUMAN VERIFICATION RECOMMENDED") active = "humanVerificationRecommended";
      else if (active && line.trim()) sections[active].push(line.trim().replace(/^[-*]\s+/, ""));
    }
    if (sections.verifiedFacts.length === 0 && sections.aiInference.length === 0 && sections.humanVerificationRecommended.length === 0 && text.trim()) {
      sections.aiInference.push(text.trim());
    }
    return sections;
  }

  async runAgentReview(
    input: ReviewRequest & { agentId: string },
    context: PluginHandlerContext,
  ): Promise<AgentReviewResult> {
    const snapshot = await this.createSnapshot(input);
    const hunkContext = snapshot.files
      .flatMap((file) => file.hunks)
      .map((hunk) => `${hunk.id} ${hunk.filePath} ${hunk.header}${hunk.functionHint ? ` (enclosing: ${hunk.functionHint})` : ""}\n${hunk.patch}`)
      .join("\n")
      .slice(0, 160_000);
    const prompt = [
      "Review the current Git changeset for a human reviewer.",
      "Do not edit files. Inspect callers, callees, related tests, and the current files with your read-only tools.",
      "Use exactly these headings: VERIFIED FACTS, AI INFERENCE, HUMAN VERIFICATION RECOMMENDED.",
      "Only report VERIFIED FACTS that are directly supported by the supplied snapshot or commands you actually ran.",
      "Every finding must include a hunk id. Never claim that tests or builds passed unless you ran them.",
      `Workspace: ${snapshot.worktreePath}`,
      `Review fingerprint: ${snapshot.targetFingerprint}`,
      "Hunks:",
      hunkContext || "(No text hunks found.)",
    ].join("\n\n");
    const result = await context.paseo.agents.ref(input.agentId).run(prompt, { timeoutMs: 120_000 });
    const review = result.lastMessage ?? result.error ?? "The review agent returned no text.";
    return {
      status: result.status,
      review,
      sections: this.parseReviewSections(review),
    };
  }

  /**
   * AI-powered explanation of a single hunk, delegated to a concrete agent.
   * The prompt only asks for analysis of the given hunk — never to edit files.
   * Provider/model are read back from the agent handle; when unavailable the
   * provider falls back to the agent id and the model to "unknown".
   */
  async explainHunkWithAgent(
    input: ReviewRequest & { hunkId: string; agentId: string },
    context: PluginHandlerContext,
  ): Promise<ExplainHunkAiResult> {
    const snapshot = await this.createSnapshot(input);
    const hunk = this.findHunk(snapshot, input.hunkId);
    const prompt = [
      "Explain this single hunk for a human reviewer.",
      "Do not edit any files.",
      "Use exactly these headings: VERIFIED FACTS, AI INFERENCE, HUMAN VERIFICATION RECOMMENDED.",
      "Only report VERIFIED FACTS that are directly supported by the supplied diff or commands you actually ran.",
      "Never claim that tests or builds passed unless you ran them.",
      `Workspace: ${snapshot.worktreePath}`,
      `Review fingerprint: ${snapshot.targetFingerprint}`,
      `Hunk id: ${hunk.id}`,
      `File: ${hunk.filePath}`,
      `Hunk header: ${hunk.header}`,
      `Exact hunk diff:\n${hunk.patch}`,
      ...(hunk.functionHint ? [`Enclosing symbol: ${hunk.functionHint}.`] : []),
      ...(hunk.language ? [`Language: ${displayLanguage(hunk.language)}.`] : []),
    ].join("\n\n");
    const result = await context.paseo.agents.ref(input.agentId).run(prompt, { timeoutMs: 120_000 });
    const review = result.lastMessage ?? result.error ?? "The explain agent returned no text.";
    let provider = input.agentId;
    let model = "unknown";
    try {
      const handle = context.paseo.agents.ref(input.agentId);
      const fresh = await handle.refresh();
      const agent = fresh?.agent ?? handle.current();
      if (agent) {
        provider = agent.provider || input.agentId;
        model = agent.model || "unknown";
      }
    } catch {
      // Provider/model keep their fallback values.
    }
    return {
      hunkId: hunk.id,
      ...this.parseReviewSections(review),
      revisionPrompt: [
        `Revise only ${hunk.id} in ${hunk.filePath} according to the AI explanation above.`,
        `Review snapshot fingerprint: ${snapshot.targetFingerprint}.`,
        `Hunk fingerprint: ${hunk.fingerprint}.`,
        "Do not modify unrelated files or hunks.",
        "Before editing, stop and report if the current target fingerprint differs.",
      ].join("\n"),
      status: result.status,
      provider,
      model,
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
      const bodyLines = hunk.hunkPatch.split("\n");
      const headerAt = bodyLines.findIndex((line) => line.startsWith("@@ "));
      if (headerAt === -1) continue; // no hunk header: cannot classify, treat as stale
      const pendingDels: string[] = [];
      let targetIdx = startIdx;
      let stale = false;
      for (let i = headerAt + 1; i < bodyLines.length; i++) {
        const line = bodyLines[i];
        if (line === "") continue; // trailing artifact of the patch's final newline
        const prefix = line[0];
        if (prefix === "\\") continue; // "\ No newline at end of file" marker
        if (prefix === "-") {
          pendingDels.push(line.slice(1));
          continue;
        }
        if (prefix !== "+" && prefix !== " ") continue; // unknown line: best-effort ignore
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
      const bodyLines = hunk.hunkPatch.split("\n");
      const headerAt = bodyLines.findIndex((line) => line.startsWith("@@ "));
      if (headerAt === -1) continue; // no hunk header: cannot classify, treat as stale
      for (let i = headerAt + 1; i < bodyLines.length; i++) {
        const line = bodyLines[i];
        if (line === "") continue; // trailing artifact of the patch's final newline
        const prefix = line[0];
        if (prefix === "\\") continue; // "\ No newline at end of file" marker
        if (prefix === "-") {
          rows.push({ kind: "del", text: line.slice(1), hunkId: hunk.hunkId, oldLine: oldNo, newLine: null });
          oldNo++;
        } else if (prefix === "+") {
          rows.push({ kind: "add", text: line.slice(1), hunkId: hunk.hunkId, oldLine: null, newLine: newNo });
          newNo++;
        } else if (prefix === " ") {
          rows.push({ kind: "context", text: line.slice(1), hunkId: hunk.hunkId, oldLine: oldNo, newLine: newNo });
          oldNo++;
          newNo++;
        }
        // Unknown lines are ignored (best effort).
      }
    }
    return rows;
  }

  private projectCommentFromEntry(entry: StateEntry, targetFingerprint: string, projectId: string): ProjectReviewComment | null {
    if (entry.projectId !== projectId || entry.decision !== "commented") return null;
    const comment = entry.comment?.trim();
    if (!comment) return null;
    if (!entry.id || !entry.filePath || !entry.hunkFingerprint || !entry.hunkHeader || !entry.hunkPatch || !entry.cwd || entry.scope === undefined) return null;
    return {
      id: entry.id,
      projectId,
      ...(entry.projectName ? { projectName: entry.projectName } : {}),
      ...(entry.projectRootPath ? { projectRootPath: entry.projectRootPath } : {}),
      ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
      targetFingerprint: entry.targetFingerprint ?? targetFingerprint,
      hunkId: entry.hunkId,
      hunkFingerprint: entry.hunkFingerprint,
      filePath: entry.filePath,
      hunkHeader: entry.hunkHeader,
      hunkPatch: entry.hunkPatch,
      cwd: entry.cwd,
      scope: entry.scope,
      ...(entry.baseRef ? { baseRef: entry.baseRef } : {}),
      ...(entry.headRef ? { headRef: entry.headRef } : {}),
      comment,
      savedAt: entry.savedAt,
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

  private parseCommentOutcomes(
    text: string,
    knownIds: readonly string[],
    agentIdle: boolean,
    agentStatus: string,
  ): { completedCommentIds: string[]; commentOutcomes: ProjectReviewCommentOutcome[] } {
    const known = new Set(knownIds);
    const parsed = new Map<string, Array<{ status: CommentOutcomeStatus; detail?: string }>>();
    let inOutcomes = false;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      const heading = normalizedHeading(trimmed);
      if (heading === "COMMENT OUTCOMES") {
        inOutcomes = true;
        continue;
      }
      if (!inOutcomes) continue;
      if (heading === "VERIFIED FACTS" || heading === "AI INFERENCE" || heading === "HUMAN VERIFICATION RECOMMENDED") {
        inOutcomes = false;
        continue;
      }
      const match = /^[-*]\s*(\S+)\s*\|\s*(\w+)(?:\s*\|\s*(.*))?$/.exec(trimmed);
      if (!match) continue;
      const id = match[1];
      const status = match[2].toLowerCase();
      if (!known.has(id) || COMMENT_OUTCOME_STATUSES[status] !== true) continue;
      const detail = match[3]?.trim() || undefined;
      const entries = parsed.get(id);
      if (entries) entries.push({ status: status as CommentOutcomeStatus, detail });
      else parsed.set(id, [{ status: status as CommentOutcomeStatus, detail }]);
    }
    const completedCommentIds: string[] = [];
    const commentOutcomes: ProjectReviewCommentOutcome[] = knownIds.map((id) => {
      const entries = parsed.get(id);
      if (!entries) return { id, status: "unresolved", detail: "No COMMENT OUTCOMES entry" };
      if (entries.length > 1) {
        return { id, status: "unresolved", detail: `Duplicate COMMENT OUTCOMES entry (${entries.length} lines); ignored` };
      }
      const entry = entries[0];
      if (entry.status === "completed" && !agentIdle) {
        return { id, status: "unresolved", detail: `Agent did not finish (status: ${agentStatus}); completed claim ignored` };
      }
      return { id, status: entry.status, ...(entry.detail ? { detail: entry.detail } : {}) };
    });
    for (const outcome of commentOutcomes) {
      if (outcome.status === "completed") completedCommentIds.push(outcome.id);
    }
    return { completedCommentIds, commentOutcomes };
  }

  /**
   * Remove the COMMENT OUTCOMES section from an agent response so the returned
   * review stays human-readable prose; the section is machine output consumed by
   * parseCommentOutcomes and never shown in the UI.
   */
  private stripCommentOutcomes(text: string): string {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => normalizedHeading(line) === "COMMENT OUTCOMES");
    if (start === -1) return text;
    return lines.slice(0, start).join("\n").trimEnd();
  }
}

function normalizedHeading(line: string): string {
  return line.trim().toUpperCase().replace(/^#+\s*/, "").replace(/:$/, "");
}

function sortProjectComments(comments: ProjectReviewComment[]): ProjectReviewComment[] {
  return comments.sort(
    (left, right) => left.filePath.localeCompare(right.filePath) || left.savedAt.localeCompare(right.savedAt),
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  getReviewState,
  getSnapshot,
  getTargetFingerprint,
  type ReviewAnchorIssue,
  type ReviewLocale,
  type ReviewRequest,
  type ReviewScope,
  type ReviewSnapshot,
  type ReviewStateCurrentHunk,
  type ReviewStateResult,
} from "../../shared/review";
import type { ReviewDecision } from "../tools";

/**
 * The watcher's fallback cadence: even without an observable workspace-activity
 * signal, the target fingerprint is probed at least this often, so a silent Git
 * change (same diff stat, different content) still loads without a manual
 * refresh.
 */
const FINGERPRINT_FALLBACK_MS = 60_000;

/**
 * The state read's current-hunk view: every parsed hunk of the snapshot, with
 * the file's pre-change path so a re-anchored comment can follow a rename.
 */
function currentHunksOf(snapshot: ReviewSnapshot): ReviewStateCurrentHunk[] {
  return snapshot.files.flatMap((file) => file.hunks.map((hunk) => ({
    hunkId: hunk.id,
    filePath: file.path,
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    hunkHeader: hunk.header,
    hunkPatch: hunk.patch,
  })));
}

/**
 * The panel's snapshot binding: the review request inputs plus the workspace
 * activity signals the watcher compares for change.
 */
export interface ReviewSnapshotWatcherParams {
  reviewCwd: string | null;
  scope: ReviewScope;
  baseRef: string;
  headRef: string;
  filePath: string;
  locale: ReviewLocale;
  /** Identity of the reviewed project/workspace: the state read resolves
   * cross-target anchor issues through it. */
  projectId: string;
  workspaceId: string;
  /** Opaque workspace-activity signals compared for change only, never
   * interpreted: the workspace's diff stat, its status, and the agent-registry
   * revision. Undefined simply means "no such signal to watch". */
  workspaceDiffStat?: unknown;
  workspaceStatus?: unknown;
  agentRevision?: unknown;
  setActionError: (message: string | null) => void;
}

/**
 * Snapshot pipeline: owns the review snapshot, the current selection, the
 * saved decisions loaded with it, the stale/loading flags, and the watcher that
 * keeps them in sync with Git. Also owns the shared stateRpc instance and
 * exposes readReviewState, the reconciliation read the comment actions use.
 *
 * Refresh model: the initial load, every manual refresh, and every
 * cwd/scope/ref/file change run a FULL snapshot (diff + parse + state read).
 * The watcher never parses on its own — when a workspace-activity signal
 * (workspaceDiffStat / workspaceStatus / agentRevision) changes, and on its
 * FINGERPRINT_FALLBACK_MS fallback, it probes the cheap target fingerprint and
 * requests a full snapshot only when the probe reports a target different from
 * the one on screen. A target change the diff stat cannot show (same line
 * counts, different content) is therefore still caught, while Git reads happen
 * at workspace-activity pace instead of a fixed full-parse poll.
 */
export function useReviewSnapshot(params: ReviewSnapshotWatcherParams) {
  const { reviewCwd, scope, baseRef, headRef, filePath, locale, projectId, workspaceId, workspaceDiffStat, workspaceStatus, agentRevision, setActionError } = params;
  const snapshotRpc = useRpc(getSnapshot);
  const fingerprintRpc = useRpc(getTargetFingerprint);
  const stateRpc = useRpc(getReviewState);
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  const [selectedHunkId, setSelectedHunkId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<ReviewDecision[]>([]);
  const [anchorIssues, setAnchorIssues] = useState<ReviewAnchorIssue[]>([]);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(false);
  const targetFingerprintRef = useRef<string | null>(null);
  // Monotonic guard for the snapshot pipeline: any refresh that starts later
  // supersedes earlier in-flight responses, so a slow response from a previous
  // project/workspace can never overwrite the current one.
  const snapshotRunRef = useRef(0);
  // Landing guard for the whole pipeline: a response that arrives after this
  // hook instance unmounted lands nowhere.
  const mountedRef = useRef(false);
  // Last observed workspace-activity signature, paired with the request it was
  // observed under: an activity change probes the fingerprint, a request change
  // is owned by the full-refresh effect instead.
  const seenActivityRef = useRef<{ request: ReviewRequest; activity: string } | null>(null);

  // The one request shape shared by the full snapshot, the fingerprint probe
  // and the state read: the probe must ask for exactly the target the snapshot
  // pipeline asks for, or the fingerprints could never match.
  const request = useMemo((): ReviewRequest | null => reviewCwd === null ? null : {
    cwd: reviewCwd,
    scope,
    locale,
    ...(scope === "commits" ? { baseRef, headRef } : {}),
    ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
  }, [baseRef, filePath, headRef, locale, reviewCwd, scope]);
  // Workspace-activity bursts share one probe and at most one queued follow-up.
  // Keep the request with the lock so a scope/workspace switch cannot let an old
  // probe launch a snapshot that supersedes the new request.
  const backgroundProbeRef = useRef<{
    request: ReviewRequest | null;
    inFlight: boolean;
    queued: boolean;
  }>({ request, inFlight: false, queued: false });
  if (backgroundProbeRef.current.request !== request) {
    backgroundProbeRef.current = { request, inFlight: false, queued: false };
  }

  /** Full snapshot + saved decisions. Manual/initial refreshes are foreground
   * (loading + surfaced errors); probe-armed refreshes are background (no
   * loading state, a transient Git read keeps the shown snapshot, and a result
   * that matches the shown target is not re-landed). */
  const refresh = useCallback(async (options?: { background?: boolean }) => {
    if (!request) return;
    const background = options?.background === true;
    const run = ++snapshotRunRef.current;
    if (!background) {
      setLoading(true);
      setActionError(null);
    }
    try {
      const next = await snapshotRpc(request);
      if (!mountedRef.current || run !== snapshotRunRef.current) return;
      // The probe raced a revert or another refresh: the target on screen is
      // already the requested one, so there is nothing to land (and no state
      // read to pay for).
      if (background && next.targetFingerprint === targetFingerprintRef.current) return;
      const nextState = await stateRpc({
        targetFingerprint: next.targetFingerprint,
        request,
        ...(projectId ? { projectId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        currentHunks: currentHunksOf(next),
      });
      if (!mountedRef.current || run !== snapshotRunRef.current) return;
      const previousFingerprint = targetFingerprintRef.current;
      targetFingerprintRef.current = next.targetFingerprint;
      // Keep the previous explanation/AI review visible, but flag it when the
      // Git target changed underneath it (scope, worktree, file, or refs).
      setStale(previousFingerprint !== null && previousFingerprint !== next.targetFingerprint);
      setSnapshot(next);
      setDecisions(nextState.decisions);
      setAnchorIssues(nextState.anchorIssues);
      setSelectedHunkId((current) => next.files.flatMap((file) => file.hunks).some((hunk) => hunk.id === current)
        ? current
        : next.files[0]?.hunks[0]?.id ?? null);
    } catch (error) {
      if (!mountedRef.current || run !== snapshotRunRef.current) return;
      // A background probe must never tear down the snapshot the user is
      // reading; manual refresh remains available when a Git read fails.
      if (background) return;
      setSnapshot(null);
      setDecisions([]);
      setAnchorIssues([]);
      setSelectedHunkId(null);
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!background) setLoading(false);
    }
  }, [projectId, request, snapshotRpc, stateRpc, setActionError, workspaceId]);

  /**
   * Read-back of the persisted decisions and anchor issues of one target,
   * under the same request/project/workspace binding the snapshot pipeline
   * used. The comment actions reconcile through this after a failed save or a
   * successful re-anchor, so what is shown always comes from what is stored.
   */
  const readReviewState = useCallback(async (targetFingerprint: string): Promise<ReviewStateResult> => {
    if (!request) return { decisions: [], anchorIssues: [] };
    const currentHunks = snapshot && snapshot.targetFingerprint === targetFingerprint ? currentHunksOf(snapshot) : [];
    return stateRpc({
      targetFingerprint,
      request,
      ...(projectId ? { projectId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      currentHunks,
    });
  }, [projectId, request, snapshot, stateRpc, workspaceId]);

  /** Fingerprint-only probe: when it reports a target different from the one
   * on screen, a background full snapshot follows; a failed probe (transient
   * Git read) leaves everything to the next probe or a manual refresh. */
  const probeAndRefresh = useCallback(async () => {
    if (!request) return;
    const probe = backgroundProbeRef.current;
    if (probe.inFlight) {
      probe.queued = true;
      return;
    }
    probe.inFlight = true;
    try {
      do {
        probe.queued = false;
        let targetFingerprint: string;
        try {
          ({ targetFingerprint } = await fingerprintRpc(request));
        } catch {
          continue;
        }
        if (backgroundProbeRef.current !== probe || !mountedRef.current) return;
        if (targetFingerprint === targetFingerprintRef.current) continue;
        await refresh({ background: true });
      } while (
        backgroundProbeRef.current === probe &&
        probe.queued &&
        mountedRef.current
      );
    } finally {
      if (backgroundProbeRef.current === probe) probe.inFlight = false;
    }
  }, [fingerprintRpc, refresh, request]);

  // Mount guard arm: paired with the cleanup below so a response arriving
  // after unmount lands nowhere (StrictMode's mount/unmount/remount included).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Workspace-activity arm: once the initial load has run, a change of any
  // workspace-activity signal probes the target fingerprint — never a parse.
  // cwd/scope/ref/file changes are deliberately excluded: those already run a
  // full refresh through the effect above.
  const activityKey = JSON.stringify([workspaceDiffStat ?? null, workspaceStatus ?? null, agentRevision ?? null]);
  useEffect(() => {
    const previous = seenActivityRef.current;
    seenActivityRef.current = request ? { request, activity: activityKey } : null;
    if (!request || previous === null) return;   // first observation: the full-refresh effect owns the initial load
    if (previous.request !== request) return;    // a new request runs a full refresh on its own
    if (previous.activity === activityKey) return;
    void probeAndRefresh();
  }, [activityKey, probeAndRefresh, request]);

  // Fallback arm: the workspace-activity signals cannot show every change
  // (same diff stat, different content; edits made outside the registry), so
  // probe at least once per FINGERPRINT_FALLBACK_MS and let a differing
  // fingerprint load the full snapshot.
  useEffect(() => {
    if (!request) return;
    const timer = setInterval(() => {
      void probeAndRefresh();
    }, FINGERPRINT_FALLBACK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [probeAndRefresh, request]);

  const selected = useMemo(() => {
    if (!snapshot || !selectedHunkId) return null;
    return snapshot.files.flatMap((file) => file.hunks).find((hunk) => hunk.id === selectedHunkId) ?? null;
  }, [selectedHunkId, snapshot]);
  const selectedFile = useMemo(() => {
    if (!snapshot || !selected) return null;
    return snapshot.files.find((file) => file.hunks.some((hunk) => hunk.id === selected.id)) ?? null;
  }, [selected, snapshot]);
  // Raw selection change; the cross-cutting analysis/comment resets that used
  // to ride along live in the panel's composed selectHunk glue.
  const selectHunk = useCallback((hunkId: string) => {
    setSelectedHunkId(hunkId);
  }, []);

  return {
    snapshot,
    selectedHunkId,
    decisions,
    setDecisions,
    anchorIssues,
    setAnchorIssues,
    stale,
    setStale,
    loading,
    refresh,
    selected,
    selectedFile,
    selectHunk,
    readReviewState,
  };
}

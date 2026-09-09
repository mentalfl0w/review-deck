import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  getReviewState,
  getSnapshot,
  type ReviewLocale,
  type ReviewScope,
  type ReviewSnapshot,
} from "../../shared/review";
import type { ReviewDecision } from "../tools";

/**
 * Snapshot pipeline: owns the review snapshot, the current selection, the
 * saved decisions loaded with it, the stale/loading flags and the refresh +
 * polling watcher that keep them in sync with Git. Also owns the shared
 * stateRpc instance consumed by the comment actions for reconciliation.
 */
export function useReviewSnapshot(params: {
  reviewCwd: string | null;
  scope: ReviewScope;
  baseRef: string;
  headRef: string;
  filePath: string;
  locale: ReviewLocale;
  setActionError: (message: string | null) => void;
}) {
  const { reviewCwd, scope, baseRef, headRef, filePath, locale, setActionError } = params;
  const snapshotRpc = useRpc(getSnapshot);
  const stateRpc = useRpc(getReviewState);
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  const [selectedHunkId, setSelectedHunkId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<ReviewDecision[]>([]);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(false);
  const targetFingerprintRef = useRef<string | null>(null);
  // Monotonic guard for the snapshot pipeline: any refresh or watcher that
  // starts later supersedes earlier in-flight responses, so a slow response
  // from a previous project/workspace can never overwrite the current one.
  const snapshotRunRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!reviewCwd) return;
    const run = ++snapshotRunRef.current;
    setLoading(true);
    setActionError(null);
    try {
      const next = await snapshotRpc({
        cwd: reviewCwd,
        scope,
        locale,
        ...(scope === "commits" ? { baseRef, headRef } : {}),
        ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
      });
      const nextState = await stateRpc({
        targetFingerprint: next.targetFingerprint,
        currentHunks: next.files.flatMap((file) => file.hunks.map((hunk) => ({
          hunkId: hunk.id,
          filePath: file.path,
          hunkHeader: hunk.header,
          hunkPatch: hunk.patch,
        }))),
      });
      // A newer refresh or the polling watcher superseded this response
      // (project/workspace switch): never land another target's snapshot.
      if (run !== snapshotRunRef.current) return;
      const previousFingerprint = targetFingerprintRef.current;
      targetFingerprintRef.current = next.targetFingerprint;
      // Keep the previous explanation/AI review visible, but flag it when the
      // Git target changed underneath it (scope, worktree, file, or refs).
      setStale(previousFingerprint !== null && previousFingerprint !== next.targetFingerprint);
      setSnapshot(next);
      setDecisions(nextState.decisions);
      setSelectedHunkId((current) => next.files.flatMap((file) => file.hunks).some((hunk) => hunk.id === current)
        ? current
        : next.files[0]?.hunks[0]?.id ?? null);
    } catch (error) {
      if (run !== snapshotRunRef.current) return;
      setSnapshot(null);
      setDecisions([]);
      setSelectedHunkId(null);
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [baseRef, filePath, headRef, locale, reviewCwd, scope, snapshotRpc, stateRpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!reviewCwd || !snapshot) return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const next = await snapshotRpc({
          cwd: reviewCwd,
          scope,
          locale,
          ...(scope === "commits" ? { baseRef, headRef } : {}),
          ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
        });
        if (!active || next.targetFingerprint === snapshot.targetFingerprint) return;
        const nextState = await stateRpc({
          targetFingerprint: next.targetFingerprint,
          currentHunks: next.files.flatMap((file) => file.hunks.map((hunk) => ({
            hunkId: hunk.id,
            filePath: file.path,
            hunkHeader: hunk.header,
            hunkPatch: hunk.patch,
          }))),
        });
        if (!active) return;
        // The watcher just observed newer state: supersede any in-flight
        // manual refresh so its older response cannot overwrite this snapshot.
        snapshotRunRef.current += 1;
        targetFingerprintRef.current = next.targetFingerprint;
        setSnapshot(next);
        setDecisions(nextState.decisions);
        setSelectedHunkId((current) => next.files.flatMap((file) => file.hunks).some((hunk) => hunk.id === current)
          ? current
          : next.files[0]?.hunks[0]?.id ?? null);
        setStale(true);
      } catch {
        // Manual refresh remains available when a transient Git read fails.
      }
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [baseRef, filePath, headRef, locale, reviewCwd, scope, snapshot, snapshotRpc, stateRpc]);

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
    stale,
    setStale,
    loading,
    refresh,
    selected,
    selectedFile,
    selectHunk,
    stateRpc,
  };
}

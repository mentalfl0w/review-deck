import { useCallback, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  clearAllReviewStates,
  clearHunkState,
  clearReviewState,
  hunkDecision,
  listReviewStates,
  rejectHunk,
  revertFile,
  type ReviewScope,
  type ReviewSnapshot,
} from "../../shared/review";
import type {
  FileCommentDraft,
  ProjectIdentity,
  ReviewDecision,
  ReviewFile,
  SavedReviewSummary,
  SelectedHunk,
} from "../tools";
import type { TFunc } from "../i18n";

/** RPC contract of getReviewState as consumed by the comment reconciliation. */
type StateRpc = (input: { targetFingerprint: string }) => Promise<{ decisions: ReviewDecision[] }>;

/**
 * Human review actions: mark-reviewed / save-comment / reject and every clear
 * flow (current hunk, current review, saved targets, all saved), plus the
 * file-comment draft model (body + anchor bookkeeping) and the saved-review
 * management modal state. Snapshot refresh linkage arrives as `refresh`;
 * decisions live in the snapshot hook and are written here through its setter.
 */
export function useReviewActions(params: {
  reviewCwd: string | null;
  scope: ReviewScope;
  baseRef: string;
  headRef: string;
  filePath: string;
  effectiveProjectId: string;
  projectIdentity: ProjectIdentity | null;
  selectedWorkspaceId: string;
  t: TFunc;
  setActionError: (message: string | null) => void;
  snapshot: ReviewSnapshot | null;
  selected: SelectedHunk | null;
  selectedFile: ReviewFile | null;
  decisions: ReviewDecision[];
  setDecisions: Dispatch<SetStateAction<ReviewDecision[]>>;
  stateRpc: StateRpc;
  refresh: () => Promise<void>;
  refreshProjectComments: (projectId?: string) => Promise<void>;
}) {
  const {
    reviewCwd,
    scope,
    baseRef,
    headRef,
  filePath,
    effectiveProjectId,
    projectIdentity,
    selectedWorkspaceId,
    t,
    setActionError,
    snapshot,
    selected,
    selectedFile,
    decisions,
    setDecisions,
    stateRpc,
    refresh,
    refreshProjectComments,
  } = params;
  const decisionRpc = useRpc(hunkDecision);
  const rejectRpc = useRpc(rejectHunk);
  const clearHunkRpc = useRpc(clearHunkState);
  const clearReviewRpc = useRpc(clearReviewState);
  const listStatesRpc = useRpc(listReviewStates);
  const clearAllRpc = useRpc(clearAllReviewStates);
  const revertFileRpc = useRpc(revertFile);
  const [revertNotice, setRevertNotice] = useState<string | null>(null);
  const [fileCommentDrafts, setFileCommentDrafts] = useState<Record<string, FileCommentDraft>>({});
  const [commentSaving, setCommentSaving] = useState(false);
  const [commentNotice, setCommentNotice] = useState<string | null>(null);
  const [otherCommentsOpen, setOtherCommentsOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [savedReviews, setSavedReviews] = useState<SavedReviewSummary[] | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);

  const selectedFileComments = useMemo(() => {
    if (!selectedFile) return [];
    return selectedFile.hunks.flatMap((hunk) => {
      const decision = decisions.find((candidate) => candidate.hunkId === hunk.id && Boolean(candidate.comment));
      return decision?.comment ? [{ hunk, decision }] : [];
    }).sort((left, right) => right.decision.savedAt.localeCompare(left.decision.savedAt));
  }, [decisions, selectedFile]);
  const mainFileComment = selectedFileComments[0] ?? null;
  const activeCommentKey = snapshot && selectedFile ? `${snapshot.targetFingerprint}\u0000${selectedFile.path}` : null;
  const defaultCommentBody = mainFileComment?.decision.comment ?? "";
  const defaultCommentAnchorId = mainFileComment?.hunk.id ?? selected?.id ?? "";
  const activeCommentDraft = activeCommentKey ? fileCommentDrafts[activeCommentKey] : undefined;
  const commentBody = activeCommentDraft?.body ?? defaultCommentBody;
  const commentAnchorHunkId = activeCommentDraft?.anchorHunkId ?? defaultCommentAnchorId;
  const originalCommentHunkId = activeCommentDraft?.originalHunkId ?? mainFileComment?.hunk.id ?? null;
  const commentAnchorHunk = selectedFile?.hunks.find((hunk) => hunk.id === commentAnchorHunkId) ?? null;
  const activeSavedComment = selectedFileComments.find((comment) => comment.hunk.id === originalCommentHunkId) ?? mainFileComment;
  const otherSavedComments = selectedFileComments.filter((comment) => comment.hunk.id !== activeSavedComment?.hunk.id);
  const commentAnchorIsCurrent = Boolean(selected && commentAnchorHunkId === selected.id);
  const commentAnchorMoveArmed = Boolean(
    selected &&
    originalCommentHunkId &&
    originalCommentHunkId !== selected.id &&
    commentAnchorHunkId === selected.id,
  );
  const currentHunkHasComment = Boolean(selected && selectedFileComments.some((comment) => comment.hunk.id === selected.id));

  const setCommentBody = useCallback((body: string) => {
    if (!activeCommentKey || !defaultCommentAnchorId) return;
    setFileCommentDrafts((current) => ({
      ...current,
      [activeCommentKey]: {
        body,
        anchorHunkId: current[activeCommentKey]?.anchorHunkId ?? defaultCommentAnchorId,
        originalHunkId: current[activeCommentKey]?.originalHunkId ?? mainFileComment?.hunk.id ?? null,
        dirty: true,
      },
    }));
    setCommentNotice(null);
  }, [activeCommentKey, defaultCommentAnchorId, mainFileComment?.hunk.id]);

  const markReviewed = useCallback(async () => {
    if (!reviewCwd || !snapshot || !selected || !effectiveProjectId || selectedFileComments.some((comment) => comment.hunk.id === selected.id)) return;
    try {
      const result = await decisionRpc({
        projectId: effectiveProjectId,
        cwd: reviewCwd,
        targetFingerprint: snapshot.targetFingerprint,
        hunkId: selected.id,
        hunkFingerprint: selected.fingerprint,
        filePath: selected.filePath,
        hunkHeader: selected.header,
        hunkPatch: selected.patch,
        decision: "reviewed",
        scope,
        ...(projectIdentity?.displayName ? { projectName: projectIdentity.displayName } : {}),
        ...(projectIdentity?.rootPath ? { projectRootPath: projectIdentity.rootPath } : {}),
        ...(selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}),
        ...(scope === "commits" ? { baseRef, headRef } : {}),
      });
      setDecisions((current) => [
        ...current.filter((decision) => decision.hunkId !== selected.id),
        { hunkId: selected.id, decision: "reviewed", savedAt: result.savedAt },
      ]);
      void refreshProjectComments();
      // Re-pull persisted decisions so cross-target inherited/rebound entries
      // land immediately and the left navigator re-groups without waiting for
      // the next snapshot change.
      void refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [baseRef, decisionRpc, effectiveProjectId, headRef, projectIdentity, refresh, refreshProjectComments, reviewCwd, scope, selected, selectedFileComments, selectedWorkspaceId, snapshot]);

  /** File-level review: one decision record per hunk of the selected file so
   * the navigator's all-hunks-reviewed grouping flips immediately. Hunks that
   * anchor a saved file comment are skipped — their "commented" decision must
   * survive. */
  const markFileReviewed = useCallback(async () => {
    if (!reviewCwd || !snapshot || !selectedFile || !effectiveProjectId) return;
    const targets = selectedFile.hunks.filter((hunk) => !selectedFileComments.some((comment) => comment.hunk.id === hunk.id));
    if (targets.length === 0) return;
    try {
      const saved: ReviewDecision[] = [];
      for (const hunk of targets) {
        const result = await decisionRpc({
          projectId: effectiveProjectId,
          cwd: reviewCwd,
          targetFingerprint: snapshot.targetFingerprint,
          hunkId: hunk.id,
          hunkFingerprint: hunk.fingerprint,
          filePath: selectedFile.path,
          hunkHeader: hunk.header,
          hunkPatch: hunk.patch,
          decision: "reviewed",
          scope,
          ...(projectIdentity?.displayName ? { projectName: projectIdentity.displayName } : {}),
          ...(projectIdentity?.rootPath ? { projectRootPath: projectIdentity.rootPath } : {}),
          ...(selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}),
          ...(scope === "commits" ? { baseRef, headRef } : {}),
        });
        saved.push({ hunkId: hunk.id, decision: "reviewed", savedAt: result.savedAt });
      }
      const targetIds = new Set(targets.map((hunk) => hunk.id));
      setDecisions((current) => [...current.filter((decision) => !targetIds.has(decision.hunkId)), ...saved]);
      void refreshProjectComments();
      void refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [baseRef, decisionRpc, effectiveProjectId, headRef, projectIdentity, refresh, refreshProjectComments, reviewCwd, scope, selectedFile, selectedFileComments, selectedWorkspaceId, snapshot]);

  /** Whole-file revert through the batch server RPC; comment-anchored hunks
   * are skipped server-side. Refreshes the snapshot so reverted hunks leave
   * the diff immediately. */
  const revertFileReview = useCallback(async () => {
    if (!reviewCwd || !snapshot || !selectedFile || !effectiveProjectId) return;
    try {
      const result = await revertFileRpc({
        cwd: reviewCwd,
        scope,
        ...(scope === "commits" ? { baseRef, headRef } : {}),
        filePath: selectedFile.path,
        skipPatches: selectedFileComments.map((comment) => comment.hunk.patch),
        expectedTargetFingerprint: snapshot.targetFingerprint,
      });
      setRevertNotice(t("revertFileDone", { reverted: result.reverted, skipped: result.skipped }));
      void refresh();
      void refreshProjectComments();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [baseRef, effectiveProjectId, headRef, refresh, refreshProjectComments, reviewCwd, revertFileRpc, scope, selectedFile, selectedFileComments, snapshot, t]);

  const saveComment = useCallback(async () => {
    const comment = commentBody.trim();
    if (!reviewCwd || !snapshot || !selected || !activeCommentKey || comment.length === 0 || !effectiveProjectId) return;
    // Browsing another change block never silently rebinds a file comment.
    // The user must either return to its anchor or explicitly arm a move.
    if (commentAnchorHunkId !== selected.id) return;
    setCommentSaving(true);
    setActionError(null);
    setCommentNotice(null);
    try {
      const result = await decisionRpc({
        projectId: effectiveProjectId,
        cwd: reviewCwd,
        targetFingerprint: snapshot.targetFingerprint,
        hunkId: selected.id,
        hunkFingerprint: selected.fingerprint,
        filePath: selected.filePath,
        hunkHeader: selected.header,
        hunkPatch: selected.patch,
        decision: "commented",
        comment,
        scope,
        ...(projectIdentity?.displayName ? { projectName: projectIdentity.displayName } : {}),
        ...(projectIdentity?.rootPath ? { projectRootPath: projectIdentity.rootPath } : {}),
        ...(selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}),
        ...(scope === "commits" ? { baseRef, headRef } : {}),
      });
      // Moving an anchor is an explicit two-step cutover: persist the new exact
      // anchor first, then clear only the old anchored decision. A failed clear
      // leaves both recoverable and is reconciled from persisted state below.
      if (originalCommentHunkId && originalCommentHunkId !== selected.id) {
        await clearHunkRpc({
          targetFingerprint: snapshot.targetFingerprint,
          hunkId: originalCommentHunkId,
        });
      }
      setDecisions((current) => [
        ...current.filter((decision) => decision.hunkId !== selected.id && decision.hunkId !== originalCommentHunkId),
        { hunkId: selected.id, decision: "commented", comment, savedAt: result.savedAt },
      ]);
      setFileCommentDrafts((current) => ({
        ...current,
        [activeCommentKey]: {
          body: comment,
          anchorHunkId: selected.id,
          originalHunkId: selected.id,
          dirty: false,
        },
      }));
      setCommentNotice(t("fileCommentSaved"));
      void refreshProjectComments();
    } catch (error) {
      try {
        const persisted = await stateRpc({ targetFingerprint: snapshot.targetFingerprint });
        setDecisions(persisted.decisions);
      } catch {
        // Keep the recoverable draft when persisted-state reconciliation fails.
      }
      void refreshProjectComments();
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setCommentSaving(false);
    }
  }, [activeCommentKey, baseRef, clearHunkRpc, commentAnchorHunkId, commentBody, decisionRpc, effectiveProjectId, headRef, originalCommentHunkId, projectIdentity, refreshProjectComments, reviewCwd, scope, selected, selectedWorkspaceId, snapshot, stateRpc, t]);

  /**
   * Clears the saved comment/decision of one hunk (saved record, local
   * decisions mirror, and the draft when it belongs to that hunk), then
   * refreshes the project comments. Shared by the clear-hunk action and the
   * revise flows after a comment has been handed to the agent's workflow.
   */
  const clearHunkComment = useCallback(async (hunkId: string) => {
    if (!snapshot) return;
    try {
      setActionError(null);
      await clearHunkRpc({ targetFingerprint: snapshot.targetFingerprint, hunkId });
      setDecisions((current) => current.filter((decision) => decision.hunkId !== hunkId));
      if (activeCommentKey && (commentAnchorHunkId === hunkId || originalCommentHunkId === hunkId)) {
        setFileCommentDrafts((current) => {
          const next = { ...current };
          delete next[activeCommentKey];
          return next;
        });
        setCommentNotice(null);
      }
      void refreshProjectComments();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [activeCommentKey, clearHunkRpc, commentAnchorHunkId, originalCommentHunkId, refreshProjectComments, snapshot]);

  const clearCurrentHunk = useCallback(() => {
    if (!snapshot || !selected) return;
    return clearHunkComment(selected.id);
  }, [clearHunkComment, selected, snapshot]);

  const clearCurrentReview = useCallback(async () => {
    if (!snapshot) return;
    try {
      setActionError(null);
      await clearReviewRpc({ targetFingerprint: snapshot.targetFingerprint });
      setDecisions([]);
      setFileCommentDrafts((current) => Object.fromEntries(
        Object.entries(current).filter(([key, draft]) =>
          !key.startsWith(`${snapshot.targetFingerprint}\u0000`) || draft.dirty),
      ));
      setCommentNotice(null);
      void refreshProjectComments();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [clearReviewRpc, refreshProjectComments, snapshot]);

  const reloadSavedReviews = useCallback(async () => {
    try {
      const result = await listStatesRpc({});
      setSavedReviews(result.reviews);
      setStateError(null);
    } catch (error) {
      setStateError(error instanceof Error ? error.message : String(error));
    }
  }, [listStatesRpc]);

  const openManage = useCallback(() => {
    setManageOpen(true);
    setConfirmClearAll(false);
    setStateError(null);
    void reloadSavedReviews();
  }, [reloadSavedReviews]);

  const clearSavedTarget = useCallback(async (targetFingerprint: string) => {
    try {
      await clearReviewRpc({ targetFingerprint });
      setSavedReviews((current) => (current ?? []).filter((review) => review.targetFingerprint !== targetFingerprint));
      setFileCommentDrafts((current) => Object.fromEntries(
        Object.entries(current).filter(([key, draft]) =>
          !key.startsWith(`${targetFingerprint}\u0000`) || draft.dirty),
      ));
      if (snapshot?.targetFingerprint === targetFingerprint) {
        setDecisions([]);
        setCommentNotice(null);
      }
      void refreshProjectComments();
    } catch (error) {
      setStateError(error instanceof Error ? error.message : String(error));
    }
  }, [clearReviewRpc, refreshProjectComments, snapshot?.targetFingerprint]);

  const clearAllSaved = useCallback(async () => {
    try {
      await clearAllRpc({});
      setSavedReviews([]);
      setConfirmClearAll(false);
      setStateError(null);
      setDecisions([]);
      setFileCommentDrafts((current) => Object.fromEntries(
        Object.entries(current).filter(([, draft]) => draft.dirty),
      ));
      setCommentNotice(null);
      void refreshProjectComments();
    } catch (error) {
      setStateError(error instanceof Error ? error.message : String(error));
    }
  }, [clearAllRpc, refreshProjectComments]);

  const rejectSelected = useCallback(async () => {
    if (!reviewCwd || !snapshot || !selected) return;
    try {
      setActionError(null);
      await rejectRpc({
        cwd: reviewCwd,
        scope,
        ...(scope === "commits" ? { baseRef, headRef } : {}),
        ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
        expectedTargetFingerprint: snapshot.targetFingerprint,
        hunkId: selected.id,
        expectedHunkFingerprint: selected.fingerprint,
      });
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [baseRef, filePath, headRef, refresh, rejectRpc, reviewCwd, scope, selected, snapshot]);

  const moveCommentAnchorToSelected = useCallback(() => {
    if (!activeCommentKey || !selected) return;
    setFileCommentDrafts((current) => ({
      ...current,
      [activeCommentKey]: {
        body: current[activeCommentKey]?.body ?? defaultCommentBody,
        anchorHunkId: selected.id,
        originalHunkId: current[activeCommentKey]?.originalHunkId ?? mainFileComment?.hunk.id ?? null,
        dirty: true,
      },
    }));
    setCommentNotice(null);
  }, [activeCommentKey, defaultCommentBody, mainFileComment?.hunk.id, selected]);

  // Write a saved comment's body/anchor into the draft map (used by the
  // panel's editSavedFileComment glue, which also selects the hunk first).
  const stageSavedCommentDraft = useCallback((key: string, hunkId: string, comment: string) => {
    setFileCommentDrafts((current) => ({
      ...current,
      [key]: {
        body: comment,
        anchorHunkId: hunkId,
        originalHunkId: hunkId,
        dirty: false,
      },
    }));
  }, []);

  // Comment-sheet UI reset that rides along with hunk selection.
  const resetCommentUi = useCallback(() => {
    setOtherCommentsOpen(false);
    setCommentNotice(null);
  }, []);

  return {
    fileCommentDrafts,
    commentSaving,
    commentNotice,
    otherCommentsOpen,
    setOtherCommentsOpen,
    manageOpen,
    setManageOpen,
    savedReviews,
    confirmClearAll,
    setConfirmClearAll,
    stateError,
    selectedFileComments,
    mainFileComment,
    activeCommentKey,
    activeCommentDraft,
    commentBody,
    setCommentBody,
    commentAnchorHunkId,
    commentAnchorHunk,
    originalCommentHunkId,
    activeSavedComment,
    otherSavedComments,
    commentAnchorIsCurrent,
    commentAnchorMoveArmed,
    currentHunkHasComment,
    markReviewed,
    markFileReviewed,
    revertFileReview,
    revertNotice,
    saveComment,
    clearCurrentHunk,
    clearHunkComment,
    clearCurrentReview,
    clearSavedTarget,
    clearAllSaved,
    openManage,
    moveCommentAnchorToSelected,
    stageSavedCommentDraft,
    resetCommentUi,
    rejectSelected,
  };
}

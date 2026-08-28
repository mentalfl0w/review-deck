import { useCallback, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { usePaseo, useRpc } from "@getpaseo/plugin";
import {
  explainHunk,
  explainFile,
  pollAiReview,
  startExplainHunkAi,
  startRunReview,
  type ExplainHunkAiResult,
  type ExplainHunkResult,
  type PollAiReviewResult,
  type ReviewLocale,
  type ReviewScope,
  type ReviewSections,
  type ReviewSnapshot,
} from "../../review.shared";
import type { AgentFeedbackMap, FileCommentEntry, ReviewFile, SelectedHunk } from "../tools.client";
import type { TFunc } from "../i18n.client";

/** Total cap for polling a started read-only review before surfacing an error. */
const READONLY_REVIEW_POLL_CAP_MS = 300_000;
/** Interval between polls of a started read-only review. */
const READONLY_REVIEW_POLL_INTERVAL_MS = 3_000;
/** A poll result that is no longer running — the only kind `apply` receives. */
type SettledPollResult = PollAiReviewResult & { status: "idle" | "error" | "permission" | "timeout" };

/**
 * Agent-driven analysis: deterministic explain / AI explain / file or
 * whole-diff review runs and the feedback send to a workspace agent (always
 * carrying an explicit user comment), plus the analysis UI state (open/closed
 * findings, per-agent feedback phases). resetAnalysis clears every analysis
 * state for a hunk switch; the panel composes it into selectHunk.
 */
export function useAgentReview(params: {
  reviewCwd: string | null;
  scope: ReviewScope;
  baseRef: string;
  headRef: string;
  filePath: string;
  locale: ReviewLocale;
  selectedFile: ReviewFile | null;
  setActionError: (message: string | null) => void;
  t: TFunc;
  selected: SelectedHunk | null;
  snapshot: ReviewSnapshot | null;
  commentBody: string;
  setStale: Dispatch<SetStateAction<boolean>>;
  activeSavedComment: FileCommentEntry | null;
  clearHunkComment: (hunkId: string) => Promise<void>;
  refreshProjectComments: () => void | Promise<void>;
}) {
  const {
    reviewCwd,
    scope,
    baseRef,
    headRef,
    filePath,
    locale,
    selectedFile,
    setActionError,
    t,
    selected,
    snapshot,
    commentBody,
    setStale,
    activeSavedComment,
    clearHunkComment,
    refreshProjectComments,
  } = params;
  const paseo = usePaseo();
  const explainRpc = useRpc(explainHunk);
  const startExplainHunkAiRpc = useRpc(startExplainHunkAi);
  const startRunReviewRpc = useRpc(startRunReview);
  const pollAiReviewRpc = useRpc(pollAiReview);
  const explainFileRpc = useRpc(explainFile);
  const [explanation, setExplanation] = useState<ExplainHunkResult | null>(null);
  const [aiExplanation, setAiExplanation] = useState<ExplainHunkAiResult | null>(null);
  const [aiExplainBusy, setAiExplainBusy] = useState<string | null>(null);
  const [agentReview, setAgentReview] = useState<string | null>(null);
  const [agentSections, setAgentSections] = useState<ReviewSections | null>(null);
  const [agentFeedback, setAgentFeedback] = useState<AgentFeedbackMap>({});
  const [findingsOpen, setFindingsOpen] = useState(true);
  // Feedback for the file-scoped revision action (`reviseFileFromComment`),
  // kept separate from the current-block revision map so the two scopes
  // never clobber each other's sending/sent/error state.
  const [fileReviseFeedback, setFileReviseFeedback] = useState<AgentFeedbackMap>({});
  // Monotonic guard for analysis requests, mirroring the snapshot pipeline's
  // snapshotRunRef: every request bumps the counter and resetAnalysis
  // invalidates it, so a slow response from an earlier hunk or an earlier
  // locale can never overwrite state that a newer request owns or that the
  // locale toggle cleared. localeRef carries the latest locale so a response
  // can be dropped when it no longer matches the active language.
  const analysisRunRef = useRef(0);
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const explainSelected = useCallback(async () => {
    if (!reviewCwd || !selected) return;
    const run = ++analysisRunRef.current;
    const requestedLocale = localeRef.current;
    try {
      setActionError(null);
      const result = await explainRpc({
        cwd: reviewCwd,
        scope,
        locale: requestedLocale,
        ...(scope === "commits" ? { baseRef, headRef } : {}),
        ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
        hunkId: selected.id,
      });
      if (run !== analysisRunRef.current || localeRef.current !== requestedLocale) return;
      setExplanation(result);
      setFindingsOpen(true);
      setStale(false);
    } catch (error) {
      if (run !== analysisRunRef.current || localeRef.current !== requestedLocale) return;
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [baseRef, explainRpc, filePath, headRef, locale, reviewCwd, scope, selected]);

  /** Whole-file deterministic explain: mirrors explainSelected but targets
   * every hunk of the file; the result reuses the explanation pipeline. */
  const explainWholeFile = useCallback(async () => {
    if (!reviewCwd || !selectedFile) return;
    const run = ++analysisRunRef.current;
    const requestedLocale = localeRef.current;
    try {
      setActionError(null);
      const result = await explainFileRpc({
        cwd: reviewCwd,
        scope,
        locale: requestedLocale,
        ...(scope === "commits" ? { baseRef, headRef } : {}),
        ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
        filePath: selectedFile.path,
      });
      if (run !== analysisRunRef.current || localeRef.current !== requestedLocale) return;
      setExplanation(result);
      setFindingsOpen(true);
      setStale(false);
    } catch (error) {
      if (run !== analysisRunRef.current || localeRef.current !== requestedLocale) return;
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [baseRef, explainFileRpc, filePath, headRef, locale, reviewCwd, scope, selectedFile]);
  /**
   * Polls a started read-only review (startExplainHunkAi / startRunReview)
   * every few seconds until a non-"running" status arrives, capped at
   * READONLY_REVIEW_POLL_CAP_MS. Each poll landing re-checks the monotonic
   * analysis run and the active locale so a superseded or locale-cleared
   * request never applies stale state; on cap expiry a clear error is thrown
   * for the caller to surface.
   */
  const pollUntilDone = useCallback(async (
    requestId: string,
    run: number,
    requestedLocale: ReviewLocale,
    apply: (result: SettledPollResult) => void,
  ) => {
    const deadline = Date.now() + READONLY_REVIEW_POLL_CAP_MS;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await pollAiReviewRpc({ requestId });
      if (run !== analysisRunRef.current || localeRef.current !== requestedLocale) return;
      if (result.status !== "running") {
        // Narrowed here: this is the only place the non-running invariant is known.
        apply(result as SettledPollResult);
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(t("aiReviewPollTimeout"));
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, READONLY_REVIEW_POLL_INTERVAL_MS);
      await promise;
    }
  }, [pollAiReviewRpc, t]);

  const explainWithAgent = useCallback(async (agentId: string) => {
    if (!reviewCwd || !selected) return;
    const run = ++analysisRunRef.current;
    const requestedLocale = localeRef.current;
    setActionError(null);
    setAiExplainBusy(agentId);
    try {
      const { requestId } = await startExplainHunkAiRpc({
        cwd: reviewCwd,
        scope,
        locale: requestedLocale,
        ...(scope === "commits" ? { baseRef, headRef } : {}),
        ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
        hunkId: selected.id,
        agentId,
      });
      if (run !== analysisRunRef.current || localeRef.current !== requestedLocale) return;
      await pollUntilDone(requestId, run, requestedLocale, (result) => {
        setAiExplanation({
          hunkId: selected.id,
          ...result.sections,
          status: result.status,
          provider: result.provider,
          model: result.model,
        });
        setFindingsOpen(true);
        setStale(false);
        if (result.status !== "idle") setActionError(t("agentFinishedStatus", { status: result.status }));
      });
    } catch (error) {
      if (run !== analysisRunRef.current || localeRef.current !== requestedLocale) return;
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      // Only the latest request owns the busy indicator; a superseded slow
      // response must not clear the newer request's busy state.
      if (run === analysisRunRef.current) setAiExplainBusy(null);
    }
  }, [baseRef, filePath, headRef, locale, pollUntilDone, reviewCwd, scope, selected, startExplainHunkAiRpc, t]);

  const runAgentReview = useCallback(async (agentId: string, requestFilePath?: string) => {
    if (!reviewCwd) return;
    const run = ++analysisRunRef.current;
    const requestedLocale = localeRef.current;
    const targetPath = (requestFilePath ?? filePath).trim();
    setActionError(null);
    try {
      const { requestId } = await startRunReviewRpc({
        cwd: reviewCwd,
        scope,
        locale: requestedLocale,
        ...(scope === "commits" ? { baseRef, headRef } : {}),
        ...(targetPath ? { filePath: targetPath } : {}),
        agentId,
      });
      if (run !== analysisRunRef.current || localeRef.current !== requestedLocale) return;
      await pollUntilDone(requestId, run, requestedLocale, (result) => {
        setAgentReview(result.review);
        setAgentSections(result.sections);
        setFindingsOpen(true);
        setStale(false);
        if (result.status !== "idle") setActionError(t("agentFinishedStatus", { status: result.status }));
      });
    } catch (error) {
      if (run !== analysisRunRef.current || localeRef.current !== requestedLocale) return;
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [baseRef, filePath, headRef, locale, pollUntilDone, reviewCwd, scope, startRunReviewRpc, t]);

  /**
   * Current-block revision driven by the comment dock: sends the user's
   * current comment to the selected workspace agent together with the selected
   * change block (id/path/header/patch/fingerprint) and the snapshot
   * fingerprint, explicitly limiting the revision to that block. The prompt is
   * posted to the agent's own message stream (send_agent_message_request); the
   * agent's reply is visible there, and the phase feedback below is the local
   * mirror Review Deck shows. Requires a non-empty comment and the agent id
   * selected in More; empty comments and arbitrary agent ids are rejected by
   * the caller's disabled state and this guard.
   */
  const reviseCurrentFromComment = useCallback(async (agentId: string) => {
    if (!reviewCwd || !selected || !snapshot) return;
    const comment = commentBody.trim();
    if (!comment) return;
    const prompt = [
      "Revise only the selected change block according to the review feedback below.",
      `File path: ${selected.filePath}`,
      `Change block: ${selected.id} ${selected.filePath} ${selected.header} (fingerprint: ${selected.fingerprint})`,
      `Patch of the change block:\n${selected.patch}`,
      `Review snapshot fingerprint: ${snapshot.targetFingerprint}.`,
      "Check the snapshot fingerprint before modifying; stop and report if it no longer matches.",
      "Apply the review feedback to this change block only; do not modify other hunks or files.",
      `Review feedback:\n${comment}`,
    ].join("\n");
    setAgentFeedback((current) => ({ ...current, [agentId]: { phase: "sending" } }));
    try {
      await paseo.agents.ref(agentId).send(prompt);
      setAgentFeedback((current) => ({ ...current, [agentId]: { phase: "sent" } }));
      // The comment was handed to the agent's workflow: remove it from Review
      // Deck (saved record, draft, local mirror) so the queue reflects that.
      await clearHunkComment(selected.id);
      void refreshProjectComments();
    } catch (error) {
      setAgentFeedback((current) => ({
        ...current,
        [agentId]: { phase: "error", message: error instanceof Error ? error.message : String(error) },
      }));
    }
  }, [clearHunkComment, commentBody, paseo.agents, refreshProjectComments, reviewCwd, selected, snapshot]);

  /**
   * File-scoped revision driven by the file comment: sends the current file
   * comment to the selected workspace agent together with the file path and ALL
   * current change hunks of that file, explicitly limiting the revision to the
   * user's comment and that file. The anchor hunk stays internal metadata on
   * the comment — this action never narrows back to a single hunk. The prompt
   * is posted to the agent's own message stream (send_agent_message_request);
   * the agent's reply is visible there, and the phase feedback below is the
   * local mirror Review Deck shows. Requires a non-empty comment and the agent
   * id selected in More; empty comments and arbitrary agent ids are rejected
   * by the caller's disabled state and this guard.
   */
  const reviseFileFromComment = useCallback(async (agentId: string) => {
    if (!reviewCwd || !selectedFile || !snapshot) return;
    const comment = commentBody.trim();
    if (!comment) return;
    const hunks = selectedFile.hunks
      .map((hunk) => `${hunk.id} ${hunk.filePath} ${hunk.header} (fingerprint: ${hunk.fingerprint})\n${hunk.patch}`)
      .join("\n\n");
    const prompt = [
      `Revise only ${selectedFile.path} according to the review feedback below.`,
      `File path: ${selectedFile.path}`,
      `All current change hunks of this file:\n${hunks}`,
      `Review snapshot fingerprint: ${snapshot.targetFingerprint}.`,
      "Check the snapshot fingerprint before modifying; stop and report if it no longer matches.",
      "Apply the review feedback to this file only; do not modify unrelated files or hunks.",
      `Review feedback:\n${comment}`,
    ].join("\n");
    setFileReviseFeedback((current) => ({ ...current, [agentId]: { phase: "sending" } }));
    try {
      await paseo.agents.ref(agentId).send(prompt);
      setFileReviseFeedback((current) => ({ ...current, [agentId]: { phase: "sent" } }));
      // The file comment was handed to the agent's workflow: remove the sent
      // comment (its anchor hunk record and the draft) from Review Deck.
      const sentHunkId = activeSavedComment?.hunk.id;
      if (sentHunkId) await clearHunkComment(sentHunkId);
      void refreshProjectComments();
    } catch (error) {
      setFileReviseFeedback((current) => ({
        ...current,
        [agentId]: { phase: "error", message: error instanceof Error ? error.message : String(error) },
      }));
    }
  }, [activeSavedComment, clearHunkComment, commentBody, paseo.agents, refreshProjectComments, reviewCwd, selectedFile, snapshot]);

  // Everything analysis-related that a hunk switch discards. Called by the
  // panel's composed selectHunk; the findings disclosure stays expanded.
  const resetAnalysis = useCallback(() => {
    // Supersede every in-flight analysis request (hunk switch, locale
    // toggle): a slow old-language response must not repopulate the cleared
    // explanation/AI/review state.
    analysisRunRef.current += 1;
    setExplanation(null);
    setAiExplanation(null);
    setAgentReview(null);
    setAgentSections(null);
    setStale(false);
    setAgentFeedback({});
    setFileReviseFeedback({});
    setAiExplainBusy(null);
    setFindingsOpen(true);
  }, [setStale]);

  return {
    explanation,
    aiExplanation,
    aiExplainBusy,
    agentReview,
    agentSections,
    agentFeedback,
    fileReviseFeedback,
    findingsOpen,
    setFindingsOpen,
    explainSelected,
    explainWholeFile,
    explainWithAgent,
    runAgentReview,
    reviseCurrentFromComment,
    reviseFileFromComment,
    resetAnalysis,
  };
}

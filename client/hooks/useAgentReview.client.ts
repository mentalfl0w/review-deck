import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { usePaseo, useRpc } from "@getpaseo/plugin";
import {
  explainHunk,
  explainFile,
  explainHunkAi,
  runReview,
  type ExplainHunkAiResult,
  type ExplainHunkResult,
  type ReviewScope,
  type ReviewSections,
  type ReviewSnapshot,
} from "../../review.shared";
import type { AgentFeedbackMap, AgentInfo, ReviewFile, SelectedHunk } from "../tools.client";
import type { TFunc } from "../i18n.client";

/**
 * Agent-driven analysis: deterministic explain / AI explain / whole-diff
 * review runs and the revision/feedback sends to a workspace agent, plus the
 * analysis UI state (open/closed findings, agent-actions visibility, per-agent
 * feedback phases). resetAnalysis clears every analysis state for a hunk
 * switch; the panel composes it into selectHunk.
 */
export function useAgentReview(params: {
  reviewCwd: string | null;
  scope: ReviewScope;
  baseRef: string;
  headRef: string;
  filePath: string;
  selectedFile: ReviewFile | null;
  setActionError: (message: string | null) => void;
  t: TFunc;
  selected: SelectedHunk | null;
  snapshot: ReviewSnapshot | null;
  commentBody: string;
  setStale: Dispatch<SetStateAction<boolean>>;
}) {
  const {
    reviewCwd,
    scope,
    baseRef,
    headRef,
    filePath,
    selectedFile,
    setActionError,
    t,
    selected,
    snapshot,
    commentBody,
    setStale,
  } = params;
  const paseo = usePaseo();
  const explainRpc = useRpc(explainHunk);
  const explainHunkAiRpc = useRpc(explainHunkAi);
  const runReviewRpc = useRpc(runReview);
  const explainFileRpc = useRpc(explainFile);
  const [explanation, setExplanation] = useState<ExplainHunkResult | null>(null);
  const [aiExplanation, setAiExplanation] = useState<ExplainHunkAiResult | null>(null);
  const [aiExplainBusy, setAiExplainBusy] = useState<string | null>(null);
  const [agentReview, setAgentReview] = useState<string | null>(null);
  const [agentSections, setAgentSections] = useState<ReviewSections | null>(null);
  const [agentFeedback, setAgentFeedback] = useState<AgentFeedbackMap>({});
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [findingsOpen, setFindingsOpen] = useState(true);

  const explainSelected = useCallback(async () => {
    if (!reviewCwd || !selected) return;
    try {
      setActionError(null);
      const result = await explainRpc({
        cwd: reviewCwd,
        scope,
        ...(scope === "commits" ? { baseRef, headRef } : {}),
        ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
        hunkId: selected.id,
      });
      setExplanation(result);
      setFindingsOpen(true);
      setStale(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [baseRef, explainRpc, filePath, headRef, reviewCwd, scope, selected]);

  /** Whole-file deterministic explain: mirrors explainSelected but targets
   * every hunk of the file; the result reuses the explanation pipeline. */
  const explainWholeFile = useCallback(async () => {
    if (!reviewCwd || !selectedFile) return;
    try {
      setActionError(null);
      const result = await explainFileRpc({
        cwd: reviewCwd,
        scope,
        ...(scope === "commits" ? { baseRef, headRef } : {}),
        ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
        filePath: selectedFile.path,
      });
      setExplanation(result);
      setFindingsOpen(true);
      setStale(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [baseRef, explainFileRpc, filePath, headRef, reviewCwd, scope, selectedFile]);
  const explainWithAgent = useCallback(async (agentId: string) => {
    if (!reviewCwd || !selected) return;
    setActionError(null);
    setAiExplainBusy(agentId);
    try {
      const result = await explainHunkAiRpc({
        cwd: reviewCwd,
        scope,
        ...(scope === "commits" ? { baseRef, headRef } : {}),
        ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
        hunkId: selected.id,
        agentId,
      });
      setAiExplanation(result);
      setFindingsOpen(true);
      setStale(false);
      if (result.status !== "idle") setActionError(t("agentFinishedStatus", { status: result.status }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAiExplainBusy(null);
    }
  }, [baseRef, explainHunkAiRpc, filePath, headRef, reviewCwd, scope, selected, t]);

  const runAgentReview = useCallback(async (agentId: string) => {
    if (!reviewCwd) return;
    try {
      setActionError(null);
      const result = await runReviewRpc({
        cwd: reviewCwd,
        scope,
        ...(scope === "commits" ? { baseRef, headRef } : {}),
        ...(filePath.trim() ? { filePath: filePath.trim() } : {}),
        agentId,
      });
      setAgentReview(result.review);
      setAgentSections(result.sections);
      setFindingsOpen(true);
      setStale(false);
      if (result.status !== "idle") setActionError(t("agentFinishedStatus", { status: result.status }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [baseRef, filePath, headRef, reviewCwd, runReviewRpc, scope, t]);

  const sendRevision = useCallback(async (agentId: string) => {
    if (!selected) return;
    const prompt = explanation?.revisionPrompt ?? [
      `Revise only ${selected.id} in ${selected.filePath}.`,
      `Review snapshot fingerprint: ${snapshot?.targetFingerprint ?? "unknown"}.`,
      `Hunk fingerprint: ${selected.fingerprint}.`,
      "Do not modify unrelated files or hunks.",
      "Stop and report if the current target no longer matches the fingerprint.",
    ].join("\n");
    try {
      setActionError(null);
      await paseo.agents.ref(agentId).send(prompt);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [explanation?.revisionPrompt, paseo.agents, selected, snapshot?.targetFingerprint]);
  const sendFeedbackToAgent = useCallback(async (agent: AgentInfo) => {
    if (!selected || !snapshot) return;
    const comment = commentBody.trim();
    if (!comment) return;
    const diff = `${selected.header}\n${selected.lines.join("\n")}`;
    const prompt = [
      `Revise only ${selected.id} in ${selected.filePath} according to the review feedback below.`,
      `Hunk header: ${selected.header}`,
      `Exact hunk diff:\n${diff}`,
      `Review snapshot fingerprint: ${snapshot.targetFingerprint}.`,
      `Hunk fingerprint: ${selected.fingerprint}.`,
      "Check both fingerprints before modifying; stop and report if they no longer match.",
      "Do not modify unrelated files or hunks.",
      "Do not change code outside this hunk.",
      `Review feedback:\n${comment}`,
    ].join("\n");
    setAgentFeedback((current) => ({ ...current, [agent.id]: { phase: "sending" } }));
    try {
      await paseo.agents.ref(agent.id).send(prompt);
      setAgentFeedback((current) => ({ ...current, [agent.id]: { phase: "sent" } }));
    } catch (error) {
      setAgentFeedback((current) => ({
        ...current,
        [agent.id]: { phase: "error", message: error instanceof Error ? error.message : String(error) },
      }));
    }
  }, [commentBody, paseo.agents, selected, snapshot]);

  // Everything analysis-related that a hunk switch discards. Called by the
  // panel's composed selectHunk; also clears the findings disclosure.
  const resetAnalysis = useCallback(() => {
    setExplanation(null);
    setAiExplanation(null);
    setAgentReview(null);
    setAgentSections(null);
    setStale(false);
    setAgentFeedback({});
    setAiExplainBusy(null);
    setFindingsOpen(false);
  }, [setStale]);

  return {
    explanation,
    aiExplanation,
    aiExplainBusy,
    agentReview,
    agentSections,
    agentFeedback,
    agentsOpen,
    setAgentsOpen,
    findingsOpen,
    setFindingsOpen,
    explainSelected,
    explainWholeFile,
    explainWithAgent,
    runAgentReview,
    sendRevision,
    sendFeedbackToAgent,
    resetAnalysis,
  };
}

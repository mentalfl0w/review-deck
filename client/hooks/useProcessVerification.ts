import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  cancelCapturedVerification,
  decideCapturedVerificationEvidence,
  listCapturedVerifications,
  pollCapturedVerification,
  startCapturedVerification,
  type ActionableReviewFinding,
  type ProcessVerificationHumanDecision,
  type ProcessVerificationResult,
} from "../../shared/review";

type CapturedRuns = Readonly<Record<string, ProcessVerificationResult>>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Workspace-bound process evidence. Commands are never started by this hook;
 * `start` is called only from the finding's explicit confirmation modal. */
export function useProcessVerification(input: {
  workspaceId: string | null;
  targetFingerprint: string | null;
  enabled: boolean;
  onError: (message: string) => void;
}): {
  runs: CapturedRuns;
  supported: boolean | null;
  start: (finding: ActionableReviewFinding) => Promise<ProcessVerificationResult>;
  refresh: (runId: string) => Promise<ProcessVerificationResult>;
  cancel: (runId: string) => Promise<ProcessVerificationResult>;
  decide: (runId: string, decision: ProcessVerificationHumanDecision) => Promise<ProcessVerificationResult>;
} {
  const listRunsRpc = useRpc(listCapturedVerifications);
  const startRpc = useRpc(startCapturedVerification);
  const pollRpc = useRpc(pollCapturedVerification);
  const cancelRpc = useRpc(cancelCapturedVerification);
  const decideRpc = useRpc(decideCapturedVerificationEvidence);
  const [runs, setRuns] = useState<CapturedRuns>({});
  const [supported, setSupported] = useState<boolean | null>(null);
  const bindingRef = useRef("");
  const binding = useMemo(() => JSON.stringify([
    input.enabled,
    input.workspaceId,
    input.targetFingerprint,
  ]), [input.enabled, input.targetFingerprint, input.workspaceId]);

  const remember = useCallback((run: ProcessVerificationResult) => {
    const key = run.findingId ?? run.runId;
    setRuns((current) => {
      const previous = current[key];
      if (previous?.runId === run.runId) return { ...current, [key]: run };
      const previousAt = Date.parse(previous?.startedAt ?? previous?.completedAt ?? "") || 0;
      const nextAt = Date.parse(run.startedAt ?? run.completedAt ?? "") || 0;
      if (previous && previousAt > nextAt) return current;
      return { ...current, [key]: run };
    });
  }, []);

  useEffect(() => {
    bindingRef.current = binding;
    if (!input.enabled || !input.workspaceId) {
      setRuns({});
      setSupported(false);
      return;
    }
    let cancelled = false;
    setRuns({});
    void listRunsRpc({ workspaceId: input.workspaceId }).then((result) => {
      if (cancelled || bindingRef.current !== binding) return;
      setSupported(result.supported);
      const latest: Record<string, ProcessVerificationResult> = {};
      for (const run of result.runs) {
        const key = run.findingId ?? run.runId;
        const previous = latest[key];
        if (!previous || Date.parse(previous.startedAt ?? previous.completedAt ?? "") <= Date.parse(run.startedAt ?? run.completedAt ?? "")) {
          latest[key] = run;
        }
      }
      setRuns(latest);
    }).catch((error: unknown) => {
      if (!cancelled && bindingRef.current === binding) input.onError(errorMessage(error));
    });
    return () => {
      cancelled = true;
      if (bindingRef.current === binding) bindingRef.current = "";
    };
  }, [binding, input.enabled, input.onError, input.targetFingerprint, input.workspaceId, listRunsRpc]);

  const start = useCallback(async (finding: ActionableReviewFinding) => {
    if (!input.enabled || !input.workspaceId || supported !== true) {
      throw new Error("Captured verification is unavailable for this workspace host.");
    }
    if (finding.anchorStatus !== "resolved" || !finding.verificationCommandHash) {
      throw new Error("This Finding has no current, confirmed command and unique anchor.");
    }
    const run = await startRpc({
      workspaceId: input.workspaceId,
      agentId: finding.agentId,
      reviewRunId: finding.reviewRunId,
      findingId: finding.id,
      expectedTargetFingerprint: finding.targetFingerprint,
      expectedCommandHash: finding.verificationCommandHash,
      confirmed: true,
    });
    remember(run);
    return run;
  }, [input.enabled, input.workspaceId, remember, startRpc, supported]);

  const refresh = useCallback(async (runId: string) => {
    if (!input.workspaceId) throw new Error("No workspace is selected.");
    const run = await pollRpc({ runId, workspaceId: input.workspaceId });
    remember(run);
    return run;
  }, [input.workspaceId, pollRpc, remember]);

  const cancel = useCallback(async (runId: string) => {
    if (!input.workspaceId) throw new Error("No workspace is selected.");
    const run = await cancelRpc({ runId, workspaceId: input.workspaceId });
    remember(run);
    return run;
  }, [cancelRpc, input.workspaceId, remember]);

  const decide = useCallback(async (runId: string, decision: ProcessVerificationHumanDecision) => {
    if (!input.workspaceId) throw new Error("No workspace is selected.");
    const current = Object.values(runs).find((candidate) => candidate.runId === runId);
    if (!current || current.targetChanged) throw new Error("Stale or unavailable evidence cannot be used for a current review decision.");
    const run = await decideRpc({
      runId,
      workspaceId: input.workspaceId,
      expectedTargetFingerprint: current.targetFingerprint,
      decision,
      confirmed: true,
    });
    remember(run);
    return run;
  }, [decideRpc, input.workspaceId, remember, runs]);

  return { runs, supported, start, refresh, cancel, decide };
}

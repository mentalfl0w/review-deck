import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  listVerificationRuns,
  pollVerificationRun,
  startVerificationRun,
  type PollVerificationRunResult,
  type ReviewRequest,
  type ReviewVerificationSuggestion,
} from "../../shared/review";

type VerificationRuns = Readonly<Record<string, PollVerificationRunResult>>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Loads terminal-session metadata for the active target. v2.0 displays
 * captured output but does not infer whether a command passed or failed. */
export function useVerification(input: {
  workspaceId: string | null;
  request: ReviewRequest | null;
  targetFingerprint: string | null;
  enabled: boolean;
  onError: (message: string) => void;
}): {
  runs: VerificationRuns;
  start: (suggestion: ReviewVerificationSuggestion) => Promise<void>;
  refresh: (runId: string) => Promise<void>;
} {
  const startRunRpc = useRpc(startVerificationRun);
  const pollRunRpc = useRpc(pollVerificationRun);
  const listRunsRpc = useRpc(listVerificationRuns);
  const [runs, setRuns] = useState<VerificationRuns>({});
  const bindingRef = useRef("");
  const binding = useMemo(() => {
    if (!input.enabled || !input.workspaceId || !input.request || !input.targetFingerprint) return "";
    return JSON.stringify([input.workspaceId, input.targetFingerprint, input.request]);
  }, [input.enabled, input.request, input.targetFingerprint, input.workspaceId]);

  const rememberRun = useCallback((run: PollVerificationRunResult) => {
    setRuns((current) => {
      const previous = current[run.suggestionId];
      if (previous && previous.startedAt > run.startedAt) return current;
      return { ...current, [run.suggestionId]: run };
    });
  }, []);

  useEffect(() => {
    bindingRef.current = binding;
    if (!binding || !input.workspaceId || !input.request || !input.targetFingerprint) {
      setRuns({});
      return;
    }
    let cancelled = false;
    setRuns({});
    void listRunsRpc({
      workspaceId: input.workspaceId,
      request: input.request,
      expectedTargetFingerprint: input.targetFingerprint,
    }).then(({ runs: storedRuns }) => {
      if (cancelled || bindingRef.current !== binding) return;
      const latest: Record<string, PollVerificationRunResult> = {};
      for (const run of storedRuns) {
        const previous = latest[run.suggestionId];
        if (!previous || previous.startedAt < run.startedAt) latest[run.suggestionId] = run;
      }
      setRuns(latest);
    }).catch((error: unknown) => {
      if (!cancelled && bindingRef.current === binding) input.onError(errorMessage(error));
    });
    return () => {
      cancelled = true;
      if (bindingRef.current === binding) bindingRef.current = "";
    };
  }, [binding, input.onError, input.request, input.targetFingerprint, input.workspaceId, listRunsRpc]);

  const start = useCallback(async (suggestion: ReviewVerificationSuggestion) => {
    const workspaceId = input.workspaceId;
    const request = input.request;
    const targetFingerprint = input.targetFingerprint;
    const expectedBinding = binding;
    if (!input.enabled || !workspaceId || !request || !targetFingerprint || !expectedBinding) return;
    bindingRef.current = expectedBinding;
    try {
      const started = await startRunRpc({
        workspaceId,
        request,
        expectedTargetFingerprint: targetFingerprint,
        suggestion,
        confirmed: true,
      });
      if (bindingRef.current === expectedBinding) rememberRun(started);
    } catch (error) {
      if (bindingRef.current === expectedBinding) input.onError(errorMessage(error));
    }
  }, [binding, input.enabled, input.onError, input.request, input.targetFingerprint, input.workspaceId, rememberRun, startRunRpc]);

  const refresh = useCallback(async (runId: string) => {
    const workspaceId = input.workspaceId;
    const expectedBinding = binding;
    if (!workspaceId || !expectedBinding || bindingRef.current !== expectedBinding) return;
    try {
      const run = await pollRunRpc({ runId, workspaceId });
      if (bindingRef.current === expectedBinding) rememberRun(run);
    } catch (error) {
      if (bindingRef.current === expectedBinding) input.onError(errorMessage(error));
    }
  }, [binding, input.onError, input.workspaceId, pollRunRpc, rememberRun]);

  return { runs, start, refresh };
}

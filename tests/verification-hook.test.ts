import assert from "node:assert/strict";
import { flushMicrotasks, mountWatcher, registerRpcStub, rpcCallCount } from "./harness/review-hook-harness";
import { useVerification } from "../client/hooks/useVerification";

async function main(): Promise<void> {
  const listRunsRpc = "review-deck.list-verification-runs";
  registerRpcStub(listRunsRpc, async () => ({ runs: [], targetChanged: true }));

  const errors: string[] = [];
  const staleSignals: boolean[] = [];
  const request = { cwd: "/repo", scope: "working" as const, locale: "en" as const };
  const hook = mountWatcher(useVerification, {
    workspaceId: "workspace-1",
    request,
    targetFingerprint: "fingerprint-1",
    enabled: true,
    onError: (message) => errors.push(message),
    onTargetChanged: (stale) => staleSignals.push(stale),
  });

  await flushMicrotasks();
  assert.equal(rpcCallCount(listRunsRpc), 1);
  assert.deepEqual(errors, [], "a stale run-list response is not a panel-wide RPC error");
  assert.deepEqual(staleSignals, [true], "the current snapshot is marked stale");
  assert.deepEqual(hook.value.runs, {}, "runs from an outdated target are never restored");
  hook.unmount();

  console.log("verification hook stale-target: all assertions passed");
}

void main();

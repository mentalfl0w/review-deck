import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import type { ReviewWorkspaceIndicators } from "../shared/review-activity";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && extname(specifier) === "") return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const { createReviewEntryStatusStore } = await import("../client/review-entry-status-store");

const status = (workspaceId: string, overrides: Partial<ReviewWorkspaceIndicators> = {}): ReviewWorkspaceIndicators => ({
  workspaceId,
  projectId: `project-${workspaceId}`,
  projectPendingCommentCount: 0,
  projectStaleCommentCount: 0,
  workspacePendingCommentCount: 0,
  workspaceStaleCommentCount: 0,
  activeBatchCount: 0,
  deliveryUnknownBatchCount: 0,
  runningAiReviewCount: 0,
  unreadAiFindingCount: 0,
  ...overrides,
});

async function run(): Promise<void> {
  const store = createReviewEntryStatusStore();
  const firstFetch = Promise.withResolvers<ReviewWorkspaceIndicators>();
  let fetchCount = 0;
  store.bindFetcher((workspaceId) => {
    fetchCount++;
    assert.equal(workspaceId, "ws-1");
    return firstFetch.promise;
  });

  const refreshA = store.refresh("ws-1");
  const refreshB = store.refresh("ws-1");
  assert.equal(fetchCount, 1, "concurrent consumers share one workspace status request");
  firstFetch.resolve(status("ws-1", { projectPendingCommentCount: 3, workspacePendingCommentCount: 2 }));
  await Promise.all([refreshA, refreshB]);
  assert.equal(store.getStatus("ws-1")?.workspacePendingCommentCount, 2);

  const staleFetch = Promise.withResolvers<ReviewWorkspaceIndicators>();
  store.bindFetcher(() => staleFetch.promise);
  const staleRequest = store.refresh("ws-1");
  const local = status("ws-1", { projectStaleCommentCount: 2, unreadAiFindingCount: 1 });
  store.setStatus("ws-1", local);
  staleFetch.resolve(status("ws-1", { projectPendingCommentCount: 99 }));
  await staleRequest;
  assert.deepEqual(store.getStatus("ws-1"), local, "an older fetch cannot overwrite a local panel update");

  const previousFetch = Promise.withResolvers<ReviewWorkspaceIndicators>();
  const currentFetch = Promise.withResolvers<ReviewWorkspaceIndicators>();
  store.bindFetcher(() => previousFetch.promise);
  const previousRequest = store.refresh("ws-1");
  store.bindFetcher(() => currentFetch.promise);
  const currentRequest = store.refresh("ws-1");
  currentFetch.resolve(status("ws-1", { runningAiReviewCount: 1 }));
  await currentRequest;
  previousFetch.resolve(status("ws-1", { runningAiReviewCount: 9 }));
  await previousRequest;
  assert.equal(store.getStatus("ws-1")?.runningAiReviewCount, 1, "a prior plugin binding cannot publish into the new one");
  const revisionBeforeUnknown = store.getSnapshot().revision;
  store.setStatus("ws-1", status("ws-1", { runningAiReviewCount: 1, deliveryUnknownBatchCount: 1 }));
  assert.equal(store.getStatus("ws-1")?.deliveryUnknownBatchCount, 1);
  assert.equal(store.getSnapshot().revision, revisionBeforeUnknown + 1, "delivery state changes republish the metadata used by Pills and Header");

  const beforeFailure = store.getStatus("ws-1");
  store.bindFetcher(async () => { throw new Error("temporary RPC failure"); });
  await store.refresh("ws-1");
  assert.equal(store.getStatus("ws-1"), beforeFailure, "a failed refresh retains the last known status");

  const calls: string[] = [];
  store.bindFetcher(async (workspaceId) => {
    calls.push(workspaceId);
    return status(workspaceId);
  });
  await store.refreshMany(["ws-2", "ws-1", "ws-2"]);
  assert.deepEqual(calls.sort(), ["ws-1", "ws-2"], "refreshMany deduplicates workspace ids");

  const beforeMismatched = store.getStatus("ws-1");
  store.bindFetcher(async () => status("wrong-workspace", { unreadAiFindingCount: 42 }));
  await store.refresh("ws-1");
  assert.equal(store.getStatus("ws-1"), beforeMismatched, "a mismatched server response is never assigned to another workspace");

  console.log("review-entry-status-store: all assertions passed");
}

await run();

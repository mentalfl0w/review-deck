import type { PluginContext } from "@getpaseo/plugin";
import { ReviewDeckPanel } from "./client/ReviewDeckPanel.client";
import {
  clearAllReviewStates as clearAllReviewStatesRpc,
  clearHunkState as clearHunkStateRpc,
  clearReviewState as clearReviewStateRpc,
  explainHunk,
  explainFile,
  getReviewState,
  getFileView,
  getSnapshot,
  hunkDecision,
  listProjectReviewComments as listProjectReviewCommentsRpc,
  listReviewStates as listReviewStatesRpc,
  processProjectReview as processProjectReviewRpc,
  rejectHunk,
  revertFile,
  pollAiReview,
  startExplainHunkAi,
  startRunReview,
} from "./review.shared";
 import { reviewService } from "./server/index.server";

export default function contribute(plugin: PluginContext) {
  plugin.handle(getSnapshot, async (input) => reviewService.createSnapshot(input));
  plugin.handle(getFileView, async (input) => reviewService.fileView(input));
  plugin.handle(explainHunk, async (input) => {
    const snapshot = await reviewService.createSnapshot(input);
    return reviewService.explain(snapshot, reviewService.findHunk(snapshot, input.hunkId), input.locale ?? "en");
  });
  plugin.handle(explainFile, async (input) => reviewService.explainFile(input));
  plugin.handle(revertFile, async (input) => reviewService.revertFile(input));
  plugin.handle(startExplainHunkAi, async (input, context) => reviewService.startExplainHunkAi(input, context));
  plugin.handle(startRunReview, async (input, context) => reviewService.startRunReview(input, context));
  plugin.handle(pollAiReview, async ({ requestId }) => reviewService.pollAiReview({ requestId }));
  plugin.handle(hunkDecision, async (input) => ({
    savedAt: await reviewService.recordDecision(input),
  }));
  plugin.handle(getReviewState, async ({ targetFingerprint, currentHunks }) => ({
    decisions: await reviewService.reviewState(targetFingerprint, currentHunks),
  }));
  plugin.handle(clearHunkStateRpc, async ({ targetFingerprint, hunkId }) => ({
    cleared: await reviewService.clearHunkState(targetFingerprint, hunkId),
  }));
  plugin.handle(clearReviewStateRpc, async ({ targetFingerprint }) => ({
    cleared: await reviewService.clearReviewState(targetFingerprint),
  }));
  plugin.handle(listReviewStatesRpc, async () => ({
    reviews: await reviewService.listReviewStates(),
  }));
  plugin.handle(clearAllReviewStatesRpc, async () => ({
    cleared: await reviewService.clearAllReviewStates(),
  }));
  plugin.handle(listProjectReviewCommentsRpc, async ({ projectId }) => ({
    project: await reviewService.listProjectReviewComments(projectId),
  }));
  plugin.handle(processProjectReviewRpc, async (input, context) => reviewService.processProjectReview(input, context));
  plugin.handle(rejectHunk, async (input) =>
    reviewService.reverseHunk(input, input.expectedTargetFingerprint, input.hunkId, input.expectedHunkFingerprint),
  );
  plugin.addWorkspacePanel({
    id: "review-deck",
    title: "Review Deck",
    icon: "ScanSearch",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: ReviewDeckPanel,
  });
  plugin.addCommandCenterItem({
    id: "open-review-deck",
    title: "Open Review Deck",
    icon: "ScanSearch",
    keywords: ["review", "diff", "risk", "hunk"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("review-deck");
    },
  });
  return () => {};
}

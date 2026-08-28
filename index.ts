import type { PluginContext } from "@getpaseo/plugin";
import { ReviewDeckPanel } from "./client/ReviewDeckPanel.client";
import {
  clearAllReviewStates as clearAllReviewStatesRpc,
  clearHunkState as clearHunkStateRpc,
  clearProjectReviewComments as clearProjectReviewCommentsRpc,
  clearReviewState as clearReviewStateRpc,
  explainHunk,
  explainFile,
  explainHunkAi,
  getReviewState,
  getFileView,
  getSnapshot,
  hunkDecision,
  listProjectReviewComments as listProjectReviewCommentsRpc,
  listReviewStates as listReviewStatesRpc,
  processProjectReview as processProjectReviewRpc,
  rejectHunk,
  revertFile,
  runReview,
} from "./review.shared";
 import { reviewService } from "./server/index.server";

export default function contribute(plugin: PluginContext) {
  plugin.handle(getSnapshot, async (input) => reviewService.createSnapshot(input));
  plugin.handle(getFileView, async (input) => reviewService.fileView(input));
  plugin.handle(explainHunk, async (input) => {
    const snapshot = await reviewService.createSnapshot(input);
    return reviewService.explain(snapshot, reviewService.findHunk(snapshot, input.hunkId), input.locale ?? "en");
  });
  plugin.handle(explainHunkAi, async (input, context) => reviewService.explainHunkWithAgent(input, context));
  plugin.handle(explainFile, async (input) => reviewService.explainFile(input));
  plugin.handle(revertFile, async (input) => reviewService.revertFile(input));
  plugin.handle(runReview, async (input, context) => reviewService.runAgentReview(input, context));
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
  plugin.handle(clearProjectReviewCommentsRpc, async ({ projectId, commentIds }) => ({
    cleared: await reviewService.clearProjectReviewComments(projectId, commentIds),
  }));
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

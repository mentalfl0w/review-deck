import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ReviewService } from "./server/ReviewService";
import {
  clearAllReviewStates,
  clearHunkState,
  clearReviewState,
  explainFile,
  explainHunk,
  getFileView,
  getReviewState,
  getSnapshot,
  hunkDecision,
  listProjectReviewComments,
  listReviewStates,
  pollAiReview,
  processProjectReview,
  rejectHunk,
  revertFile,
  startExplainHunkAi,
  startRunReview,
} from "./shared/review";
import { reviewDeckSettings } from "./shared/review-settings";

const MAINTENANCE_INTERVAL_MS = 60_000;

export default function contribute(server: PluginServerContext) {
  const reviewService = new ReviewService();
  server.registerSettings(reviewDeckSettings);

  server.handle(getSnapshot, async (input) => reviewService.createSnapshot(input));
  server.handle(getFileView, async (input) => reviewService.fileView(input));
  server.handle(explainHunk, async (input) => {
    const snapshot = await reviewService.createSnapshot(input);
    return reviewService.explain(snapshot, reviewService.findHunk(snapshot, input.hunkId), input.locale ?? "en");
  });
  server.handle(explainFile, async (input) => reviewService.explainFile(input));
  server.handle(revertFile, async (input) => reviewService.revertFile(input));
  server.handle(startExplainHunkAi, async (input, context) => reviewService.startExplainHunkAi(input, context));
  server.handle(startRunReview, async (input, context) => reviewService.startRunReview(input, context));
  server.handle(pollAiReview, async ({ requestId, workspaceId, agentId }) => reviewService.pollAiReview({ requestId, workspaceId, agentId }));
  server.handle(hunkDecision, async (input) => ({
    savedAt: await reviewService.recordDecision(input),
  }));
  server.handle(getReviewState, async ({ targetFingerprint, currentHunks }) => ({
    decisions: await reviewService.reviewState(targetFingerprint, currentHunks),
  }));
  server.handle(clearHunkState, async ({ targetFingerprint, hunkId }) => ({
    cleared: await reviewService.clearHunkState(targetFingerprint, hunkId),
  }));
  server.handle(clearReviewState, async ({ targetFingerprint }) => ({
    cleared: await reviewService.clearReviewState(targetFingerprint),
  }));
  server.handle(listReviewStates, async () => ({
    reviews: await reviewService.listReviewStates(),
  }));
  server.handle(clearAllReviewStates, async () => ({
    cleared: await reviewService.clearAllReviewStates(),
  }));
  server.handle(listProjectReviewComments, async ({ projectId }) => ({
    project: await reviewService.listProjectReviewComments(projectId),
  }));
  server.handle(processProjectReview, async (input, context) => reviewService.processProjectReview(input, context));
  server.handle(rejectHunk, async (input) =>
    reviewService.reverseHunk(input, input.expectedTargetFingerprint, input.hunkId, input.expectedHunkFingerprint),
  );

  const stopMaintenance = reviewService.startMaintenance(MAINTENANCE_INTERVAL_MS);
  return stopMaintenance;
}

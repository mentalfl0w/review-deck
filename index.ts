import type { PluginContext } from "@getpaseo/plugin";
import { ReviewDeckPanel } from "./main.client";
import {
  clearAllReviewStates as clearAllReviewStatesRpc,
  clearHunkState as clearHunkStateRpc,
  clearProjectReviewComments as clearProjectReviewCommentsRpc,
  clearReviewState as clearReviewStateRpc,
  explainHunk,
  explainHunkAi,
  getReviewState,
  getSnapshot,
  hunkDecision,
  listProjectReviewComments as listProjectReviewCommentsRpc,
  listReviewStates as listReviewStatesRpc,
  processProjectReview as processProjectReviewRpc,
  rejectHunk,
  runReview,
} from "./review.shared";
import {
  clearAllReviewStates,
  clearHunkState,
  clearProjectReviewComments,
  clearReviewState,
  createSnapshot,
  explain,
  explainHunkWithAgent,
  findHunk,
  listProjectReviewComments,
  listReviewStates,
  processProjectReview,
  recordDecision,
  reverseHunk,
  reviewState,
  runAgentReview,
} from "./review.server";

type WorkspaceListEntry = {
  workspaceDirectory?: string;
  projectRootPath: string;
  archivingAt: string | null;
};
export default function contribute(plugin: PluginContext) {
  plugin.handle(getSnapshot, async (input) => createSnapshot(input));
  plugin.handle(explainHunk, async (input) => {
    const snapshot = await createSnapshot(input);
    return explain(snapshot, findHunk(snapshot, input.hunkId));
  });
  plugin.handle(explainHunkAi, async (input, context) => explainHunkWithAgent(input, context));
  plugin.handle(runReview, async (input, context) => runAgentReview(input, context));
  plugin.handle(hunkDecision, async (input) => ({
    savedAt: await recordDecision(input),
  }));
  plugin.handle(getReviewState, async ({ targetFingerprint }) => ({
    decisions: await reviewState(targetFingerprint),
  }));
  plugin.handle(clearHunkStateRpc, async ({ targetFingerprint, hunkId }) => ({
    cleared: await clearHunkState(targetFingerprint, hunkId),
  }));
  plugin.handle(clearReviewStateRpc, async ({ targetFingerprint }) => ({
    cleared: await clearReviewState(targetFingerprint),
  }));
  plugin.handle(listReviewStatesRpc, async () => ({
    reviews: await listReviewStates(),
  }));
  plugin.handle(clearAllReviewStatesRpc, async () => ({
    cleared: await clearAllReviewStates(),
  }));
  plugin.handle(listProjectReviewCommentsRpc, async ({ projectId }) => ({
    project: await listProjectReviewComments(projectId),
  }));
  plugin.handle(processProjectReviewRpc, async (input, context) => processProjectReview(input, context));
  plugin.handle(clearProjectReviewCommentsRpc, async ({ projectId, commentIds }) => ({
    cleared: await clearProjectReviewComments(projectId, commentIds),
  }));
  plugin.handle(rejectHunk, async (input) =>
    reverseHunk(input, input.expectedTargetFingerprint, input.hunkId, input.expectedHunkFingerprint),
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
  plugin.addCommandCenterItem({
    id: "review-active-agent-changes",
    title: "Review active agent changes",
    icon: "ScanSearch",
    keywords: ["review", "agent", "diff", "hunk", "risk"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("review-deck");
    },
  });
  plugin.addCommandCenterItem({
    id: "choose-workspace-for-review-deck",
    title: "Choose workspace for Review Deck",
    icon: "ScanSearch",
    keywords: ["review", "workspace", "diff", "hunk", "risk"],
    context: "global",
    async onSelect({ paseo }) {
      // The global command context exposes no openPanel, so the workspace-scoped
      // Review Deck panel cannot be opened from here. Safe fallback: enumerate
      // real workspaces and bring the most recently active one to the front via
      // its actual directory. Never synthesize a workspace id.
      try {
        const { entries } = await paseo.workspaces.list({
          sort: [{ key: "activity_at", direction: "desc" }],
        });
        const candidate =
          entries.find(
            (ws: WorkspaceListEntry) => ws.archivingAt == null && Boolean(ws.workspaceDirectory ?? ws.projectRootPath),
          ) ?? entries.find((ws: WorkspaceListEntry) => ws.archivingAt == null);
        if (!candidate) return;
        await paseo.workspaces.open({ cwd: candidate.workspaceDirectory ?? candidate.projectRootPath });
      } catch {
        // Best-effort convenience: opening a workspace is optional, and the
        // workspace-scoped "Open Review Deck" command stays reachable in any
        // open workspace.
      }
    },
  });
  return () => {};
}

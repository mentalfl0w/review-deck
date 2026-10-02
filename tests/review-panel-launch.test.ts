import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && extname(specifier) === "") {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  clearReviewPanelLaunches,
  consumeReviewPanelLaunch,
  getReviewPanelLaunch,
  openReviewPanelInWorkspace,
} = await import("../client/review-panel-launch");

const opened: Array<{ id: string; options?: { location?: string } }> = [];
const openPanel = (id: string, options?: { location?: string }) => opened.push({ id, options });

const queueLaunch = openReviewPanelInWorkspace({
  workspaceId: "wks_workspace_a",
  action: "queue",
  preferredAgentId: "agent_a",
}, openPanel);
const targetedLaunch = openReviewPanelInWorkspace({
  workspaceId: "wks_workspace_a",
  action: "targeted",
  preferredAgentId: "agent_a",
}, openPanel);
const otherWorkspaceLaunch = openReviewPanelInWorkspace({
  workspaceId: "wks_workspace_b",
  action: "deck",
}, openPanel);

assert.deepEqual(opened.map(({ id }) => id), ["review-deck", "review-deck", "review-deck"]);
assert.ok(opened.every(({ options }) => options?.location === "workspace"));
assert.equal(getReviewPanelLaunch("wks_workspace_a")?.requestId, targetedLaunch.requestId);
assert.equal(getReviewPanelLaunch("wks_workspace_a")?.action, "targeted");
assert.equal(getReviewPanelLaunch("wks_workspace_a")?.preferredAgentId, "agent_a");
assert.equal(getReviewPanelLaunch("wks_workspace_b")?.requestId, otherWorkspaceLaunch.requestId);

consumeReviewPanelLaunch("wks_workspace_a", queueLaunch.requestId);
assert.equal(getReviewPanelLaunch("wks_workspace_a")?.requestId, targetedLaunch.requestId, "a stale action cannot erase a newer in-panel request");
consumeReviewPanelLaunch("wks_workspace_a", targetedLaunch.requestId);
assert.equal(getReviewPanelLaunch("wks_workspace_a"), null);
assert.equal(getReviewPanelLaunch("wks_workspace_b")?.requestId, otherWorkspaceLaunch.requestId, "consuming one workspace leaves another workspace's launch intact");
clearReviewPanelLaunches();
console.log("Review panel launch: actions reuse the same workspace panel target and keep launch state workspace-scoped");

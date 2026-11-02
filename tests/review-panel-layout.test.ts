import assert from "node:assert/strict";
import { createRequire } from "node:module";

const requireFromRepo = createRequire(import.meta.url);
const { resolveReviewPanelLayoutMode } = requireFromRepo("../client/review-panel-layout.ts") as {
  resolveReviewPanelLayoutMode: (hostCompact: boolean, shellWidth: number, shellHeight: number) => "compact" | "narrow" | "wide";
};

assert.equal(resolveReviewPanelLayoutMode(false, 974, 651), "compact", "short 900–1080px panels use the scrollable drill-down layout");
assert.equal(resolveReviewPanelLayoutMode(false, 974, 900), "narrow", "tall medium-width panels retain the stacked workbench");
assert.equal(resolveReviewPanelLayoutMode(false, 1280, 500), "compact", "very short wide panels use the scrollable drill-down layout");
assert.equal(resolveReviewPanelLayoutMode(false, 1280, 800), "wide", "wide desktop panels retain the three-column workbench");
assert.equal(resolveReviewPanelLayoutMode(true, 1280, 1000), "compact", "the host compact layout takes precedence");

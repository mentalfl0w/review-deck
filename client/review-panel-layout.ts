export type ReviewPanelLayoutMode = "compact" | "narrow" | "wide";

export function resolveReviewPanelLayoutMode(
  hostCompact: boolean,
  shellWidth: number,
  shellHeight: number,
): ReviewPanelLayoutMode {
  if (hostCompact || (shellWidth > 0 && shellWidth < 900) || (shellHeight > 0 && shellHeight < 600)) return "compact";
  if (shellWidth > 0 && shellWidth < 1080) {
    return shellHeight > 0 && shellHeight < 900 ? "compact" : "narrow";
  }
  return "wide";
}

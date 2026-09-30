import { Text, View } from "react-native";
import type { AiReviewBudgetPreset, AiReviewDepth, AiReviewMode, PollAiReviewResult } from "../../shared/review";
import type { TFunc, StringKey } from "../i18n";
import type { PanelStyles } from "../styles";

type AiReviewDetails = Pick<PollAiReviewResult, "provider" | "model" | "thinkingOptionId" | "reviewerPermissionMode" | "resultSource" | "mode" | "depth" | "reviewPreset" | "usage">;

const MODE_LABELS: Record<AiReviewMode, StringKey> = {
  hunk: "aiReviewModeHunk",
  file: "aiReviewModeFile",
  target: "aiReviewModeTarget",
};
const DEPTH_LABELS: Record<AiReviewDepth, StringKey> = {
  targeted: "aiReviewDepthTargeted",
  full: "aiReviewDepthFull",
};
const PRESET_LABELS: Record<AiReviewBudgetPreset, StringKey> = {
  economical: "aiReviewPresetEconomical",
  balanced: "aiReviewPresetBalanced",
  deep: "aiReviewPresetDeep",
};

function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  const precision = tokens < 100_000 ? 1 : 0;
  return `${Number((tokens / 1_000).toFixed(precision))}K`;
}

export function AiReviewMeta({ details, showUsage, t, styles }: {
  details: AiReviewDetails;
  showUsage: boolean;
  t: TFunc;
  styles: PanelStyles;
}) {
  const labels: string[] = [];
  if (details.resultSource) {
    labels.push(t(details.resultSource === "cached" ? "aiReviewSourceCached" : "aiReviewSourceFresh"));
  }
  if (details.mode) labels.push(t(MODE_LABELS[details.mode]));
  if (details.thinkingOptionId) labels.push(t("aiReviewThinking", { thinking: details.thinkingOptionId }));
  if (details.reviewerPermissionMode) {
    labels.push(t(details.reviewerPermissionMode === "ask" ? "aiReviewAccessAsk" : "aiReviewAccessReadOnly"));
  }
  if (details.depth) labels.push(t(DEPTH_LABELS[details.depth]));
  if (details.reviewPreset) labels.push(t(PRESET_LABELS[details.reviewPreset]));

  const usage = details.usage;
  const usageLabels: string[] = [];
  if (showUsage && usage?.inputTokens !== undefined) usageLabels.push(t("aiReviewUsageInput", { tokens: formatTokenCount(usage.inputTokens) }));
  if (showUsage && usage?.outputTokens !== undefined) usageLabels.push(t("aiReviewUsageOutput", { tokens: formatTokenCount(usage.outputTokens) }));
  if (showUsage && usage?.cachedTokens !== undefined) usageLabels.push(t("aiReviewUsageCached", { tokens: formatTokenCount(usage.cachedTokens) }));
  if (showUsage && usage?.contextTokens !== undefined) usageLabels.push(t("aiReviewUsageContext", { tokens: formatTokenCount(usage.contextTokens) }));

  return (
    <View>
      {labels.length > 0 ? <Text style={styles.routeMeta}>{t("aiReviewMeta", { details: labels.join(" · ") })}</Text> : null}
      {usageLabels.length > 0 ? <Text style={styles.routeMeta}>{t("aiReviewUsageLabel", { usage: usageLabels.join(" · ") })}</Text> : null}
      {showUsage && details.resultSource === "cached" && usageLabels.length > 0 ? <Text style={styles.routeMeta}>{t("aiReviewCacheNote")}</Text> : null}
    </View>
  );
}

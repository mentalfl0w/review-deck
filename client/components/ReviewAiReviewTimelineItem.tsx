import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { reviewAiTimelineSchema, type ReviewAiTimelineData } from "../../shared/review-activity";
import { detectLocale, makeT } from "../i18n";
import { getReviewEntryStatusStore } from "../review-entry-status-store";
import { withAlpha } from "../tools";

export interface ReviewAiReviewTimelineItemProps extends PluginTimelineItemProps<ReviewAiTimelineData> {
  onOpenReviewDeck?: (workspaceId: string) => void;
}

/** Minimal completion summary; review text and individual findings stay in Review Deck. */
export function ReviewAiReviewTimelineItem(props: ReviewAiReviewTimelineItemProps) {
  const parsed = reviewAiTimelineSchema.safeParse(props.item.data);
  if (!parsed.success) return null;
  return <ReviewAiReviewTimelineContent {...props} data={parsed.data} />;
}

type ReviewAiReviewTimelineContentProps = Omit<ReviewAiReviewTimelineItemProps, "item"> & {
  data: ReviewAiTimelineData;
};

function ReviewAiReviewTimelineContent({
  theme,
  layout,
  data,
  onOpenReviewDeck,
}: ReviewAiReviewTimelineContentProps) {
  useEffect(() => {
    void getReviewEntryStatusStore().refresh(data.workspaceId);
  }, [data.completedAt, data.workspaceId]);
  const t = makeT(detectLocale());
  const compact = layout.compact;
  const statusColor = data.status === "completed" ? theme.colors.statusSuccess : theme.colors.statusDanger;
  const usage = data.usage && (data.usage.inputTokens !== undefined || data.usage.outputTokens !== undefined)
    ? t("reviewAiTimelineUsage", {
      input: Math.trunc(data.usage.inputTokens ?? 0).toLocaleString(),
      output: Math.trunc(data.usage.outputTokens ?? 0).toLocaleString(),
    })
    : null;
  const message = data.status === "completed" ? t("reviewAiTimelineCompleted") : t("reviewAiTimelineFailed");

  return (
    <View style={{ flexShrink: 1, gap: compact ? 4 : 6, paddingLeft: compact ? 6 : 8, borderLeftWidth: 2, borderLeftColor: statusColor }}>
      <Text
        accessibilityRole="text"
        accessibilityLabel={message}
        style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: compact ? 12 : 13, lineHeight: compact ? 17 : 19 }}
      >
        {message}
      </Text>
      {data.findingCount > 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: compact ? 11 : 12, lineHeight: compact ? 16 : 18 }}>
          {t("reviewAiTimelineFindings", { count: data.findingCount })}
        </Text>
      ) : null}
      {data.highRiskFindingCount > 0 ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: compact ? 11 : 12, lineHeight: compact ? 16 : 18 }}>
          {t("reviewAiTimelineHighRisk", { count: data.highRiskFindingCount })}
        </Text>
      ) : null}
      {usage ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: compact ? 11 : 12, lineHeight: compact ? 16 : 18 }}>
          {usage}
        </Text>
      ) : null}
      {onOpenReviewDeck ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("reviewAiTimelineOpenDeck")}
          onPress={() => onOpenReviewDeck(data.workspaceId)}
          style={({ pressed }) => ({
            alignSelf: "flex-start",
            borderRadius: 7,
            borderWidth: 1,
            borderColor: withAlpha(theme.colors.accent, pressed ? 0.6 : 0.35),
            backgroundColor: withAlpha(theme.colors.accent, pressed ? 0.2 : 0.1),
            paddingHorizontal: compact ? 8 : 10,
            paddingVertical: compact ? 3 : 4,
          })}
        >
          <Text style={{ color: theme.colors.accent, fontSize: compact ? 11 : 12, fontWeight: "600", lineHeight: compact ? 15 : 16 }}>
            {t("reviewAiTimelineOpenDeck")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

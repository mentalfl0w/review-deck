import { Pressable, Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { detectLocale, makeT } from "../i18n";
import { withAlpha } from "../tools";
import {
  reviewBatchTimelineSchema,
  type ReviewBatchTimelineData,
} from "../../shared/review-batch";

export interface ReviewBatchTimelineItemProps extends PluginTimelineItemProps<ReviewBatchTimelineData> {
  /** Opens the agent-scoped Review Deck panel. Receives the workspace id
   * from the schema-validated timeline data — never from unparsed props. */
  onOpenReviewDeck?: (workspaceId: string) => void;
}

/** Timeline renderer for version-1 "review-deck-batch" plugin rows: the count
 * and lifecycle state of one ReviewBatch (submitted / running / completed /
 * partial / failed). The payload carries no review content — no comment ids,
 * text, file paths or cwd — and this component adds none; it only reports
 * progress and the outcome tally, plus the entry point into Review Deck.
 * Pure component: no state, no effects, no subscriptions, so a re-append with
 * the same top-level id just re-renders the same row in place. */
export function ReviewBatchTimelineItem({
  theme,
  layout,
  item,
  onOpenReviewDeck,
}: ReviewBatchTimelineItemProps) {
  // The host passes schema-validated data; re-parse defensively so a
  // malformed or forward-versioned row degrades to nothing instead of a
  // broken message — and so the Open action only ever sees validated ids.
  const parsed = reviewBatchTimelineSchema.safeParse(item.data);
  if (!parsed.success) return null;
  const data = parsed.data;
  const t = makeT(detectLocale());
  const compact = layout.compact;

  // Status drives one color and one message; the message comes from the
  // existing i18n keys, so the row never invents reviewer-facing copy.
  const statusColor = (() => {
    switch (data.status) {
      case "submitted": return theme.colors.foregroundMuted;
      case "running": return theme.colors.accent;
      case "completed": return theme.colors.statusSuccess;
      case "partial": return theme.colors.statusWarning;
      case "failed": return theme.colors.statusDanger;
    }
  })();

  const message = (() => {
    switch (data.status) {
      case "submitted": return t("reviewBatchSubmitted", { count: data.commentCount });
      case "running": return t("reviewBatchRunning", { count: data.commentCount });
      case "completed": return t("reviewBatchCompleted", { count: data.completedCount });
      case "partial":
        return t("reviewBatchPartial", {
          completed: data.completedCount,
          stale: data.staleCount,
          failed: data.failedCount,
          unresolved: data.unresolvedCount,
        });
      case "failed": return t("reviewBatchFailed", { count: data.commentCount });
    }
  })();

  return (
    <View
      style={{
        flexShrink: 1,
        gap: compact ? 4 : 6,
        paddingLeft: compact ? 6 : 8,
        borderLeftWidth: 2,
        borderLeftColor: statusColor,
      }}
    >
      <Text
        accessibilityRole="text"
        accessibilityLabel={message}
        style={{
          flexShrink: 1,
          color: theme.colors.foreground,
          fontSize: compact ? 12 : 13,
          lineHeight: compact ? 17 : 19,
        }}
      >
        {message}
      </Text>
      {onOpenReviewDeck ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("reviewBatchOpenReviewDeck")}
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
          <Text
            style={{
              color: theme.colors.accent,
              fontSize: compact ? 11 : 12,
              fontWeight: "600",
              lineHeight: compact ? 15 : 16,
            }}
          >
            {t("reviewBatchOpenReviewDeck")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

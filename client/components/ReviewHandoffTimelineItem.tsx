import { Text } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { detectLocale, makeT } from "../i18n";
import {
  reviewHandoffTimelineSchema,
  type ReviewHandoffTimelineData,
} from "../../shared/review-handoff";

/** Timeline renderer for version-1 "review-deck-handoff" plugin rows: a
 * factual, accessible submission notice — N review comments were submitted to
 * the selected agent's workflow. The copy states only that the submission
 * happened (never that the agent's work completed) and carries no review
 * content. Pure component: no state, no effects. */
export function ReviewHandoffTimelineItem({
  theme,
  layout,
  item,
}: PluginTimelineItemProps<ReviewHandoffTimelineData>) {
  // The host passes schema-validated data; re-parse defensively so a
  // malformed row degrades to nothing instead of a broken message.
  const parsed = reviewHandoffTimelineSchema.safeParse(item.data);
  if (!parsed.success) return null;
  const t = makeT(detectLocale());
  const message = parsed.data.commentCount === 1
    ? t("handoffTimelineSubmittedOne")
    : t("handoffTimelineSubmitted", { count: parsed.data.commentCount });
  return (
    <Text
      accessibilityLabel={message}
      accessibilityRole="text"
      style={{
        flexShrink: 1,
        color: theme.colors.foreground,
        fontSize: layout.compact ? 12 : 13,
        lineHeight: layout.compact ? 17 : 19,
        paddingLeft: layout.compact ? 6 : 8,
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.accent,
      }}
    >
      {message}
    </Text>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, useSettings, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { getWorkspaceReviewSummary, type WorkspaceReviewSummary } from "../../shared/review-activity";
import { reviewDeckSettings } from "../../shared/review-settings";
import { detectLocale, makeT } from "../i18n";
import { resolveConfiguredLocale } from "../locale";
import { getReviewCountStore } from "../review-count-store";
import { getReviewEntryStatusStore } from "../review-entry-status-store";

export type ReviewHeaderPopoverProps = PluginButtonContentProps & {
  onOpenReviewDeck(): void;
  onOpenQueue(): void;
};

/** Compact status summary for a workspace-scoped native Header button. */
export function ReviewHeaderPopover({
  theme,
  layout,
  workspaceId,
  onOpenReviewDeck,
  onOpenQueue,
}: ReviewHeaderPopoverProps) {
  const settings = useSettings(reviewDeckSettings);
  const automaticLocale = useMemo(() => detectLocale(), []);
  const configuredLocale = settings.status === "ready" ? settings.values.locale : "auto";
  const locale = resolveConfiguredLocale(configuredLocale, automaticLocale);
  const t = useMemo(() => makeT(locale), [locale]);
  const summaryRpc = useRpc(getWorkspaceReviewSummary);
  const [summary, setSummary] = useState<WorkspaceReviewSummary | null>(null);
  const [error, setError] = useState(false);
  const requestRef = useRef(0);
  const compact = layout.compact;

  const styles = useMemo(() => ({
    root: { gap: compact ? 10 : 12 },
    title: { color: theme.colors.foreground, fontSize: compact ? 16 : 18, fontWeight: "700" as const },
    status: { color: theme.colors.foreground, fontSize: compact ? 13 : 14, lineHeight: compact ? 18 : 20 },
    muted: { color: theme.colors.foregroundMuted, fontSize: compact ? 12 : 13, lineHeight: compact ? 17 : 19 },
    warning: { color: theme.colors.statusWarning, fontSize: compact ? 12 : 13, lineHeight: compact ? 17 : 19 },
    actions: { flexDirection: "row" as const, gap: compact ? 8 : 10, flexWrap: "wrap" as const },
    button: { borderColor: theme.colors.border, borderRadius: 8, borderWidth: 1, paddingHorizontal: compact ? 10 : 12, paddingVertical: compact ? 7 : 8 },
    primaryButton: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent, borderRadius: 8, paddingHorizontal: compact ? 10 : 12, paddingVertical: compact ? 7 : 8 },
    buttonText: { color: theme.colors.foreground, fontSize: compact ? 12 : 13, fontWeight: "600" as const },
    primaryButtonText: { color: theme.colors.accentForeground, fontSize: compact ? 12 : 13, fontWeight: "600" as const },
  }), [compact, theme.colors.accent, theme.colors.accentForeground, theme.colors.border, theme.colors.foreground, theme.colors.foregroundMuted, theme.colors.statusWarning]);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setError(false);
    try {
      const result = await summaryRpc({ workspaceId });
      if (request !== requestRef.current || result.workspaceId !== workspaceId) return;
      setSummary(result);
      getReviewEntryStatusStore().setStatus(workspaceId, result);
      getReviewCountStore().setCount(
        result.projectId,
        result.projectPendingCommentCount + result.projectStaleCommentCount,
      );
    } catch {
      if (request === requestRef.current) setError(true);
    }
  }, [summaryRpc, workspaceId]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current++;
    };
  }, [load]);

  return (
    <View style={styles.root}>
      <Text style={styles.title}>{t("panelTitle")}</Text>
      {summary ? (
        <>
          <Text style={styles.status}>{t("reviewEntryBlocksReviewed", {
            reviewed: summary.reviewedBlockCount,
            total: summary.totalBlockCount,
          })}</Text>
          {summary.projectPendingCommentCount > 0 ? (
            <Text style={styles.status}>{t("reviewEntryPendingComments", { count: summary.projectPendingCommentCount })}</Text>
          ) : null}
          {summary.projectStaleCommentCount > 0 ? (
            <Text style={styles.warning}>{t("reviewEntryStaleComments", { count: summary.projectStaleCommentCount })}</Text>
          ) : null}
          {summary.deliveryUnknownBatchCount > 0 ? (
            <Text style={styles.warning}>{t("reviewEntryDeliveryUnknown", { count: summary.deliveryUnknownBatchCount })}</Text>
          ) : null}
          {summary.runningAiReviewCount > 0 ? (
            <Text style={styles.status}>{t("reviewEntryRunningAi", { count: summary.runningAiReviewCount })}</Text>
          ) : null}
          {summary.unreadAiFindingCount > 0 ? (
            <Text style={styles.status}>{t("reviewEntryUnreadAi", { count: summary.unreadAiFindingCount })}</Text>
          ) : null}
        </>
      ) : error ? (
        <Text style={styles.warning}>{t("reviewEntrySummaryError")}</Text>
      ) : (
        <Text style={styles.muted}>{t("reviewEntrySummaryLoading")}</Text>
      )}
      {error ? (
        <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.button}>
          <Text style={styles.buttonText}>{t("reviewEntryRetry")}</Text>
        </Pressable>
      ) : null}
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" onPress={onOpenReviewDeck} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>{t("reviewBatchOpenReviewDeck")}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onOpenQueue} style={styles.button}>
          <Text style={styles.buttonText}>{t("reviewEntryOpenQueue")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

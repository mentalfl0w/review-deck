import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import type { ReviewScope } from "../../shared/review";
import { derivePairs, deriveUnifiedRows, hunkHeaderParts } from "../diffView";
import {
  diffModeKeys,
  type DiffMode,
  type FileViewResult,
  type PanelLayout,
  type PanelTheme,
  type PendingCommentReview,
  type ReviewFile,
  type SelectedHunk,
  type ViewMode,
} from "../tools";
import type { TFunc } from "../i18n";
import type { PanelStyles } from "../styles";
import { ActionButton, Segmented } from "./ui";
import { DiffView } from "./DiffView";
import { FileView } from "./FileView";
import { lineSelectionLocationText, lineSelectionRange, type LineSelectionState, type LineSide } from "../lineRange";

/**
 * The change-block card: navigation, the review actions that belong to the
 * block, the exact diff, and the live line-selection strip. It is the
 * dominant canvas — analysis and verification live in the inspector so the
 * diff is never pushed below explanatory text.
 */
export function HunkCard({ theme, layout, t, styles, file, hunk, onSelectHunk, diffMode, onDiffModeChange, viewMode, fileViewResult, fileViewLoading, fileViewError, scope, currentHunkHasComment, reviewed, onMarkReviewed, onExplain, onReject, agentsLoading, selectedAgentId, aiExplainBusy, onExplainWithAgent, onOpenMore, selection, onLinePress, onLineTap, onClearSelection, onCommentSelection, pendingCommentReviews, acceptingCommentReviewId, onAcceptCommentReview }: {
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  styles: PanelStyles;
  file: ReviewFile;
  hunk: SelectedHunk;
  onSelectHunk: (hunkId: string) => void;
  diffMode: DiffMode;
  onDiffModeChange: (mode: DiffMode) => void;
  viewMode: ViewMode;
  fileViewResult: FileViewResult | null;
  fileViewLoading: boolean;
  fileViewError: string | null;
  scope: ReviewScope;
  currentHunkHasComment: boolean;
  reviewed: boolean;
  onMarkReviewed: () => void;
  onExplain: () => void;
  onReject: () => void;
  agentsLoading: boolean;
  selectedAgentId: string | null;
  aiExplainBusy: string | null;
  onExplainWithAgent: (agentId: string) => void;
  onOpenMore: () => void;
  selection: LineSelectionState;
  onLinePress: (side: LineSide, line: number, extend: boolean) => void;
  onLineTap: (side: LineSide, line: number) => void;
  onClearSelection: () => void;
  onCommentSelection: () => void;
  /** Agent-reported completions of this file awaiting a human decision. */
  pendingCommentReviews: readonly PendingCommentReview[];
  acceptingCommentReviewId: string | null;
  onAcceptCommentReview: (review: PendingCommentReview) => void;
}) {
  const selectedHeader = hunkHeaderParts(hunk.header);
  const selectedHunkIndex = file.hunks.findIndex((candidate) => candidate.id === hunk.id);
  const diffModeOptions = useMemo(() => diffModeKeys.map((option) => ({
    value: option.value,
    label: t(option.key),
    tooltip: t(option.value === "split" ? "diffModeSplitHint" : "diffModeUnifiedHint"),
  })), [t]);
  const selectedPairs = useMemo(() => derivePairs(hunk), [hunk]);
  const unifiedRows = useMemo(() => deriveUnifiedRows(selectedPairs), [selectedPairs]);
  const effectiveDiffMode: DiffMode = layout.compact ? "unified" : diffMode;
  // The submit-ready range of the live selection: null while the user has
  // selected nothing (or the machine dropped the selection), a single-line
  // range while the compact pairing still awaits its end tap.
  const selectionRange = lineSelectionRange(selection);
  // A pending acceptance is offered only on a block that overlaps the change
  // window the comment was dispatched against. An unrelated hunk in the same
  // file proves nothing, and the server enforces the same overlap rule.
  const hunkPendingReviews = pendingCommentReviews.filter((review) => {
    const baselineEnd = review.baseline.oldStart + Math.max(review.baseline.oldCount, 1) - 1;
    const blockEnd = hunk.oldStart + Math.max(hunk.oldCount, 1) - 1;
    return review.baseline.oldStart <= blockEnd && hunk.oldStart <= baselineEnd;
  });
  const diffContent = viewMode === "blockFile" ? (
    <FileView
      t={t}
      styles={styles}
      result={fileViewResult}
      loading={fileViewLoading}
      error={fileViewError}
      selectedHunkId={hunk.id}
    />
  ) : (
    <DiffView t={t} styles={styles} mode={effectiveDiffMode} pairs={selectedPairs} rows={unifiedRows} selection={lineSelectionRange(selection)} compact={layout.compact} onLinePress={onLinePress} onLineTap={onLineTap} />
  );
  return (
    <View style={styles.blockCard}>
      <View style={styles.blockToolbar}>
        <View style={styles.blockNavigation}>
          <ActionButton
            variant="ghost"
            label="‹"
            tooltip={t("previousChangeBlock")}
            disabled={selectedHunkIndex <= 0}
            onPress={() => {
              const previous = file.hunks[selectedHunkIndex - 1];
              if (previous) onSelectHunk(previous.id);
            }}
            theme={theme}
            layout={layout}
          />
          <View style={styles.blockPosition}>
            <Text style={styles.blockPositionText}>
              {t("currentChangeBlock", { current: selectedHunkIndex + 1, total: file.hunks.length })}
            </Text>
            {selectedHeader ? <Text selectable numberOfLines={1} style={styles.blockRangeText}>{selectedHeader.range}</Text> : null}
          </View>
          <ActionButton
            variant="ghost"
            label="›"
            tooltip={t("nextChangeBlock")}
            disabled={selectedHunkIndex < 0 || selectedHunkIndex >= file.hunks.length - 1}
            onPress={() => {
              const next = file.hunks[selectedHunkIndex + 1];
              if (next) onSelectHunk(next.id);
            }}
            theme={theme}
            layout={layout}
          />
        </View>
        <Text style={styles.toolbarLabel}>{t("changeBlockActions")}</Text>
        <View style={styles.actionRow}>
          <ActionButton
            variant="secondary"
            label={reviewed ? t("markReviewedDone") : t("markReviewed")}
            tooltip={currentHunkHasComment ? t("markReviewedUnavailable") : t("markReviewedHint")}
            disabled={reviewed || currentHunkHasComment}
            onPress={onMarkReviewed}
            theme={theme}
            layout={layout}
          />
          <ActionButton
            variant="secondary"
            label={t("ruleAnalyzeBlock")}
            tooltip={t("ruleAnalyzeBlockHint")}
            onPress={onExplain}
            theme={theme}
            layout={layout}
          />
          <ActionButton
            variant="secondary"
            label={aiExplainBusy !== null && aiExplainBusy === selectedAgentId ? t("aiReviewBlockBusyLabel") : t("aiReviewBlockLabel")}
            tooltip={agentsLoading ? t("agentsLoading") : selectedAgentId ? t("aiReviewBlockHint") : t("agentActionNoAgentHint")}
            disabled={agentsLoading || aiExplainBusy !== null}
            onPress={() => {
              if (selectedAgentId) void onExplainWithAgent(selectedAgentId);
              else onOpenMore();
            }}
            theme={theme}
            layout={layout}
          />
          <View style={styles.blockActionPush} />
          {scope === "working" || scope === "staged" ? (
            <ActionButton
              variant="danger"
              label={t("rejectHunk")}
              tooltip={t("rejectHunkHint")}
              onPress={onReject}
              theme={theme}
              layout={layout}
            />
          ) : null}
        </View>
        {currentHunkHasComment && !reviewed ? (
          <Text style={styles.blockActionReason}>{t("markReviewedUnavailable")}</Text>
        ) : null}
        {hunkPendingReviews.length > 0 ? (
          <View style={styles.group}>
            <Text style={styles.groupLabel}>{t("pendingCommentReviews")}</Text>
            <Text style={styles.scopeDesc}>{t("pendingCommentReviewsHint")}</Text>
            {hunkPendingReviews.map((review) => (
              <View key={review.commentId} style={styles.queueComment}>
                <Text selectable numberOfLines={4} style={styles.body}>{review.comment}</Text>
                <View style={styles.actionRow}>
                  <ActionButton
                    variant="primary"
                    label={acceptingCommentReviewId === review.commentId ? t("acceptCommentReviewBusy") : t("acceptCommentReview")}
                    tooltip={t("acceptCommentReviewHint")}
                    disabled={acceptingCommentReviewId !== null}
                    onPress={() => onAcceptCommentReview(review)}
                    theme={theme}
                    layout={layout}
                  />
                </View>
              </View>
            ))}
          </View>
        ) : null}
        {viewMode === "diff" ? (
          <View style={styles.diffHeaderStrip}>
            {selectedHeader ? <Text selectable style={styles.diffHeaderRange}>{selectedHeader.range}</Text> : null}
            {selectedHeader?.context ? <Text selectable style={styles.diffHeaderContext}>{selectedHeader.context}</Text> : null}
            {!layout.compact ? (
              <View style={[styles.toolbarGroup, styles.diffPresentationGroup]}>
                <Text style={styles.toolbarLabel}>{t("lineLayoutLabel")}</Text>
                <Segmented options={diffModeOptions} value={effectiveDiffMode} onChange={onDiffModeChange} theme={theme} layout={layout} />
              </View>
            ) : null}
          </View>
        ) : null}
      </View>

      <ScrollView
        style={styles.diffScroll}
        contentContainerStyle={styles.diffScrollContent}
        nestedScrollEnabled
        scrollEnabled
        showsVerticalScrollIndicator
      >
        {diffContent}
      </ScrollView>

      {selection ? (
        <View style={[styles.lineSelectionStrip, selection.awaitingEnd ? styles.lineSelectionStripAwaiting : null]}>
          <Text style={styles.lineSelectionStripText}>
            {selectionRange && !selection.awaitingEnd
              ? `${t("lineSelectionLabel")} ${lineSelectionLocationText(t, selectionRange)}`
              : t("lineSelectionLabel")}
          </Text>
          {/* The awaiting first tap has no end line yet: the pending start is
              named in the hint instead of a range, and the range hint (which
              promises an exact saved range) only appears once completed. */}
          {selection.awaitingEnd ? (
            <Text style={styles.lineSelectionStripHint}>{t("lineSelectionAwaitingEnd", { line: selection.anchorLine })}</Text>
          ) : null}
          <Text style={styles.lineSelectionStripHint}>{selection.awaitingEnd ? t("lineSelectionHint") : t("lineSelectionRangeHint")}</Text>
          <ActionButton
            variant="ghost"
            label={t("clearLineSelection")}
            tooltip={t("clearLineSelectionHint")}
            onPress={onClearSelection}
            theme={theme}
            layout={layout}
          />
          <ActionButton
            variant="primary"
            label={t("commentLineSelection")}
            tooltip={t("commentLineSelectionHint")}
            disabled={selection.awaitingEnd}
            onPress={onCommentSelection}
            theme={theme}
            layout={layout}
          />
        </View>
      ) : null}
    </View>
  );
}

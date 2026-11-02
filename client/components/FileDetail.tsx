import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { ReviewScope } from "../../shared/review";
import {
  maxSeverity,
  severityLabelKeys,
  severityOrder,
  viewModeKeys,
  type AgentFeedbackMap,
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
import { ActionButton, Segmented, SeverityBadge } from "./ui";
import { HunkCard } from "./HunkCard";
import { FileView } from "./FileView";
import type { LineSelectionState, LineSide } from "../lineRange";

/**
 * The diff canvas: the selected file's identity and file-level review actions
 * stay pinned at the top, then the display toolbar, then the change-block card
 * that owns the remaining height. Analysis, verification and the comment
 * editor live in the inspector; this zone is the diff.
 */
export function FileDetail({ theme, layout, t, styles, selected, selectedFile, diffMode, onDiffModeChange, viewMode, onViewModeChange, fileViewResult, fileViewLoading, fileViewError, onBack, onSelectHunk, scope, currentHunkHasComment, reviewed, fileReviewed, onMarkReviewed, onMarkFileReviewed, onExplainFile, onRunAgentReview, onRevertFile, revertNotice, onExplain, onReject, agentsLoading, selectedAgentId, onOpenMore, aiExplainBusy, onExplainWithAgent, fileReviseFeedback, commentBody, onReviseFileFromComment, agentReviewBusy, lineSelection, onLinePress, onLineTap, onClearLineSelection, onCommentLineSelection, pendingCommentReviews, acceptingCommentReviewId, onAcceptCommentReview }: {
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  styles: PanelStyles;
  selected: SelectedHunk | null;
  selectedFile: ReviewFile | null;
  diffMode: DiffMode;
  onDiffModeChange: (mode: DiffMode) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  fileViewResult: FileViewResult | null;
  fileViewLoading: boolean;
  fileViewError: string | null;
  onBack: () => void;
  onSelectHunk: (hunkId: string) => void;
  scope: ReviewScope;
  currentHunkHasComment: boolean;
  reviewed: boolean;
  fileReviewed: boolean;
  onMarkReviewed: () => void;
  onMarkFileReviewed: () => void;
  onExplainFile: () => void;
  onRunAgentReview: (agentId: string, filePath: string) => void;
  onRevertFile: () => void;
  revertNotice: string | null;
  onExplain: () => void;
  onReject: () => void;
  agentsLoading: boolean;
  selectedAgentId: string | null;
  onOpenMore: () => void;
  aiExplainBusy: string | null;
  onExplainWithAgent: (agentId: string) => void;
  fileReviseFeedback: AgentFeedbackMap;
  commentBody: string;
  onReviseFileFromComment: (agentId: string) => void;
  agentReviewBusy: boolean;
  /** The live line-range selection of the current change block, its press
   * handlers and the strip actions. */
  lineSelection: LineSelectionState;
  onLinePress: (side: LineSide, line: number, extend: boolean) => void;
  onLineTap: (side: LineSide, line: number) => void;
  onClearLineSelection: () => void;
  onCommentLineSelection: () => void;
  /** Agent-reported completions of this file awaiting a human decision. */
  pendingCommentReviews: PendingCommentReview[];
  acceptingCommentReviewId: string | null;
  onAcceptCommentReview: (review: PendingCommentReview) => void;
}) {
  const [confirmRevert, setConfirmRevert] = useState(false);
  useEffect(() => {
    setConfirmRevert(false);
  }, [selectedFile?.path]);
  if (!selected || !selectedFile) {
    return (
      <View style={styles.detailCanvas}>
        <Text style={styles.empty}>{t("noReviewableHunk")}</Text>
      </View>
    );
  }
  const selectedFileSeverity = severityOrder.find((candidate) => selectedFile.hunks.some((hunk) => maxSeverity(hunk) === candidate)) ?? "informational";
  const selectedMeta = {
    language: selected.language ?? selectedFile.language,
    functionHint: selected.functionHint,
  };
  const viewModeOptions = viewModeKeys.map((option) => ({
    value: option.value,
    label: t(option.key),
    tooltip: t(option.value === "diff" ? "viewModeDiffHint" : option.value === "blockFile" ? "viewModeBlockFileHint" : "viewModeFullChangesHint"),
  }));
  return (
    <View style={styles.detailCanvas}>
      {layout.compact ? (
        <View style={[styles.backRow, styles.compactBackRow]}>
          <Pressable accessibilityRole="button" onPress={onBack} style={styles.topButton}>
            <Text style={styles.topButtonText}>‹ {t("backToFiles")}</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.canvasHeader}>
        <View style={styles.fileHeaderTop}>
          <View style={styles.fileHeaderTitle}>
            <Text style={styles.sectionEyebrow}>{t("fileDetail")}</Text>
            <Text selectable numberOfLines={layout.compact ? 2 : 1} ellipsizeMode="middle" style={styles.fileHeaderPath}>{selectedFile.path}</Text>
          </View>
          <SeverityBadge
            severity={selectedFileSeverity}
            label={t(severityLabelKeys[selectedFileSeverity])}
            theme={theme}
            compact={layout.compact}
          />
        </View>
        <Text numberOfLines={1} style={styles.sectionSummary}>
          {t("fileChangeSummary", {
            hunks: selectedFile.hunks.length,
            additions: selectedFile.additions,
            deletions: selectedFile.deletions,
          })}
        </Text>
        {selectedMeta?.functionHint || selectedMeta?.language || selectedFile.language ? (
          <View style={styles.tagRow}>
            {selectedMeta?.language || selectedFile.language ? <Text style={styles.tagPill}>{selectedMeta?.language ?? selectedFile.language}</Text> : null}
            {selectedMeta?.functionHint ? <Text style={styles.tagPill} numberOfLines={1}>{selectedMeta.functionHint}</Text> : null}
          </View>
        ) : null}
        <View style={styles.fileActionRow}>
          <Text style={styles.label}>{t("fileActionsLabel")}</Text>
          <ActionButton
            variant="secondary"
            label={fileReviewed ? t("markFileReviewedDone") : t("markFileReviewed")}
            tooltip={fileReviewed ? t("markFileReviewedDoneHint") : t("markFileReviewedHint")}
            disabled={fileReviewed}
            onPress={onMarkFileReviewed}
            theme={theme}
            layout={layout}
          />
          <ActionButton
            variant="secondary"
            label={t("ruleAnalyzeFile")}
            tooltip={t("ruleAnalyzeFileHint")}
            onPress={onExplainFile}
            theme={theme}
            layout={layout}
          />
          <ActionButton
            variant="secondary"
            label={agentReviewBusy ? t("aiReviewRunning") : t("agentFileReviewLabel")}
            tooltip={agentsLoading ? t("agentsLoading") : selectedAgentId ? t("agentFileReviewHint") : t("agentActionNoAgentHint")}
            disabled={agentsLoading || !selectedAgentId || agentReviewBusy}
            onPress={() => { if (selectedAgentId) void onRunAgentReview(selectedAgentId, selectedFile.path); }}
            theme={theme}
            layout={layout}
          />
          <ActionButton
            variant="secondary"
            disabled={agentsLoading || !selectedAgentId || fileReviseFeedback[selectedAgentId]?.phase === "sending" || commentBody.trim().length === 0}
            label={fileReviseFeedback[selectedAgentId ?? ""]?.phase === "sending" ? t("reviseFileCommentBusyLabel") : t("reviseFileCommentLabel")}
            tooltip={agentsLoading ? t("agentsLoading") : !selectedAgentId ? t("agentActionNoAgentHint") : commentBody.trim().length === 0 ? t("reviseFileCommentNoCommentHint") : t("reviseFileCommentHint")}
            onPress={() => { if (selectedAgentId) void onReviseFileFromComment(selectedAgentId); }}
            theme={theme}
            layout={layout}
          />
          <View style={styles.blockActionPush} />
          <ActionButton
            variant={confirmRevert ? "danger" : "ghost"}
            label={confirmRevert ? t("revertFileConfirm") : t("revertFile")}
            tooltip={confirmRevert ? t("revertFileConfirmHint") : t("revertFileHint")}
            onPress={() => {
              if (confirmRevert) {
                setConfirmRevert(false);
                onRevertFile();
              } else {
                setConfirmRevert(true);
              }
            }}
            theme={theme}
            layout={layout}
          />
        </View>
        {!agentsLoading && !selectedAgentId ? (
          <Text style={styles.blockActionReason}>{t("agentActionNoAgentHint")}</Text>
        ) : null}
        {revertNotice ? <Text style={styles.fileStatusAccent}>{revertNotice}</Text> : null}
        {fileReviseFeedback[selectedAgentId ?? ""]?.phase === "sent" ? <Text style={styles.feedbackSent}>✓ {t("reviseFileSent")}</Text> : null}
        {fileReviseFeedback[selectedAgentId ?? ""]?.phase === "error" ? (
          <Text style={styles.feedbackError}>{fileReviseFeedback[selectedAgentId ?? ""]?.message ?? t("reviseFileSendFailed")}</Text>
        ) : null}
      </View>
      <View style={styles.canvasToolbar}>
        <View style={styles.toolbarGroup}>
          <Text style={styles.toolbarLabel}>{t("viewRangeLabel")}</Text>
          <Segmented
            options={viewModeOptions}
            value={viewMode}
            onChange={onViewModeChange}
            theme={theme}
            layout={layout}
          />
        </View>
      </View>

      {viewMode === "fullChanges" ? (
        <ScrollView style={styles.canvasScroll} contentContainerStyle={styles.canvasScrollContent} nestedScrollEnabled showsVerticalScrollIndicator>
          <FileView t={t} styles={styles} result={fileViewResult} loading={fileViewLoading} error={fileViewError} selectedHunkId={selected.id} />
        </ScrollView>
      ) : (
        <HunkCard
          theme={theme}
          layout={layout}
          t={t}
          styles={styles}
          file={selectedFile}
          hunk={selected}
          onSelectHunk={onSelectHunk}
          diffMode={diffMode}
          onDiffModeChange={onDiffModeChange}
          viewMode={viewMode}
          fileViewResult={fileViewResult}
          fileViewLoading={fileViewLoading}
          fileViewError={fileViewError}
          scope={scope}
          currentHunkHasComment={currentHunkHasComment}
          reviewed={reviewed}
          onMarkReviewed={onMarkReviewed}
          onExplain={onExplain}
          onReject={onReject}
          agentsLoading={agentsLoading}
          selectedAgentId={selectedAgentId}
          aiExplainBusy={aiExplainBusy}
          onExplainWithAgent={onExplainWithAgent}
          onOpenMore={onOpenMore}
          selection={lineSelection}
          onLinePress={onLinePress}
          onLineTap={onLineTap}
          onClearSelection={onClearLineSelection}
          onCommentSelection={onCommentLineSelection}
          pendingCommentReviews={pendingCommentReviews}
          acceptingCommentReviewId={acceptingCommentReviewId}
          onAcceptCommentReview={onAcceptCommentReview}
        />
      )}
    </View>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type {
  ExplainHunkAiResult,
  ExplainHunkResult,
  ReviewScope,
  ReviewSections,
} from "../../shared/review";
import {
  maxSeverity,
  severityLabelKeys,
  severityOrder,
  type AgentFeedbackMap,
  type AgentInfo,
  type DiffMode,
  type FileCommentDraft,
  type FileCommentEntry,
  type FileViewResult,
  type PanelLayout,
  type PanelTheme,
  type ReviewFile,
  type SelectedHunk,
  type ViewMode,
} from "../tools";
import { viewModeKeys } from "../tools";
import type { TFunc } from "../i18n";
import type { PanelStyles } from "../styles";
import { ActionButton, Segmented, SeverityBadge } from "./ui";
import { HunkCard } from "./HunkCard";
import { FileView } from "./FileView";
import { CommentSheet } from "./CommentSheet";

/** Right-hand canvas: the file header, the change-block card and the comment
 * dock. Renders the no-reviewable-hunk placeholder when nothing is selected. */
export function FileDetail({ theme, layout, t, styles, onHeightChange, selected, selectedFile, diffMode, onDiffModeChange, viewMode, onViewModeChange, fileViewResult, fileViewLoading, fileViewError, onBack, onSelectHunk, scope, currentHunkHasComment, reviewed, fileReviewed, onMarkReviewed, onMarkFileReviewed, onExplainFile, onRunAgentReview, onRevertFile, revertNotice, onExplain, onReject, agentsLoading, selectedAgentId, onOpenMore, aiExplainBusy, commentBody, onExplainWithAgent, findingsOpen, onToggleFindingsOpen, analysisStale, explanation, aiExplanation, agentReview, agentSections, activeCommentDraft, activeSavedComment, onCommentBodyChange, commentSaving, commentNotice, commentAnchorHunk, commentAnchorHunkId, commentAnchorIsCurrent, commentAnchorMoveArmed, onReturnToAnchor, onMoveAnchor, otherSavedComments, otherCommentsOpen, onToggleOtherComments, onEditSavedComment, onSaveComment, agentFeedback, fileReviseFeedback, onReviseCurrentFromComment, onReviseFileFromComment }: {
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  styles: PanelStyles;
  onHeightChange?: (height: number) => void;
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
  commentBody: string;
  aiExplainBusy: string | null;
  onExplainWithAgent: (agentId: string) => void;
  findingsOpen: boolean;
  onToggleFindingsOpen: () => void;
  analysisStale: boolean;
  explanation: ExplainHunkResult | null;
  aiExplanation: ExplainHunkAiResult | null;
  agentReview: string | null;
  agentSections: ReviewSections | null;
  activeCommentDraft: FileCommentDraft | undefined;
  activeSavedComment: FileCommentEntry | null;
  onCommentBodyChange: (body: string) => void;
  commentSaving: boolean;
  commentNotice: string | null;
  commentAnchorHunk: SelectedHunk | null;
  commentAnchorHunkId: string;
  commentAnchorIsCurrent: boolean;
  commentAnchorMoveArmed: boolean;
  onReturnToAnchor: (hunkId: string) => void;
  onMoveAnchor: () => void;
  otherSavedComments: FileCommentEntry[];
  otherCommentsOpen: boolean;
  onToggleOtherComments: () => void;
  onEditSavedComment: (hunkId: string) => void;
  onSaveComment: () => void;
  agentFeedback: AgentFeedbackMap;
  fileReviseFeedback: AgentFeedbackMap;
  onReviseCurrentFromComment: (agentId: string) => void;
  onReviseFileFromComment: (agentId: string) => void;
}) {
  const [confirmRevert, setConfirmRevert] = useState(false);
  useEffect(() => {
    setConfirmRevert(false);
  }, [selectedFile?.path]);
  if (!selected || !selectedFile) {
    return <Text style={styles.empty}>{t("noReviewableHunk")}</Text>;
  }
  const selectedFileSeverity = severityOrder.find((candidate) => selectedFile.hunks.some((hunk) => maxSeverity(hunk) === candidate)) ?? "informational";
  const selectedMeta = {
    language: selected.language ?? selectedFile.language,
    functionHint: selected.functionHint,
  };
  return (
    <View style={styles.detailCanvas}>
      <View style={styles.detailInner} onLayout={(event) => onHeightChange?.(event.nativeEvent.layout.height)}>
        {layout.compact ? (
          <View style={styles.backRow}>
          <Pressable accessibilityRole="button" onPress={onBack} style={styles.topButton}>
            <Text style={styles.topButtonText}>‹ {t("backToFiles")}</Text>
          </Pressable>
        </View>
      ) : null}

        <View style={styles.fileHeader}>
          <View style={styles.fileHeaderTop}>
            <View style={{ flex: 1, minWidth: 180, gap: 3 }}>
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
          <View style={styles.fileActionRow}>
            <ActionButton
              variant="secondary"
              label={fileReviewed ? t("markFileReviewedDone") : t("markFileReviewed")}
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
              label={t("agentFileReviewLabel")}
              tooltip={agentsLoading ? t("agentsLoading") : selectedAgentId ? t("agentFileReviewHint") : t("agentActionNoAgentHint")}
              disabled={agentsLoading || !selectedAgentId}
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
            <ActionButton
              variant={confirmRevert ? "danger" : "ghost"}
              label={confirmRevert ? t("revertFileConfirm") : t("revertFile")}
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
          {revertNotice ? <Text style={styles.fileStatusAccent}>{revertNotice}</Text> : null}
          {fileReviseFeedback[selectedAgentId ?? ""]?.phase === "sent" ? <Text style={styles.feedbackSent}>✓ {t("reviseFileSent")}</Text> : null}
          {fileReviseFeedback[selectedAgentId ?? ""]?.phase === "error" ? (
            <Text style={styles.feedbackError}>{fileReviseFeedback[selectedAgentId ?? ""]?.message ?? t("reviseFileSendFailed")}</Text>
          ) : null}
          {selectedMeta?.functionHint || selectedMeta?.language || selectedFile.language ? (
            <View style={styles.tagRow}>
              {selectedMeta?.language || selectedFile.language ? <Text style={styles.tagPill}>{selectedMeta?.language ?? selectedFile.language}</Text> : null}
              {selectedMeta?.functionHint ? <Text style={styles.tagPill} numberOfLines={1}>{selectedMeta.functionHint}</Text> : null}
            </View>
          ) : null}
        </View>
        <View style={styles.diffLayoutRow}>
          <Text style={styles.label}>{t("diffLayout")}</Text>
          <Segmented
            options={viewModeKeys.map((option) => ({
              value: option.value,
              label: t(option.key),
              tooltip: t(option.value === "diff" ? "viewModeDiffHint" : option.value === "blockFile" ? "viewModeBlockFileHint" : "viewModeFullChangesHint"),
            }))}
            value={viewMode}
            onChange={onViewModeChange}
            theme={theme}
            layout={layout}
          />
        </View>

        {viewMode === "fullChanges" ? (
          <ScrollView style={styles.diffScroll} contentContainerStyle={styles.diffScrollContent} nestedScrollEnabled showsVerticalScrollIndicator>
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
            findingsOpen={findingsOpen}
            onToggleFindingsOpen={onToggleFindingsOpen}
            analysisStale={analysisStale}
            explanation={explanation}
            aiExplanation={aiExplanation}
            agentReview={agentReview}
            agentSections={agentSections}
          />
        )}

        <View style={styles.commentArea}>
        <CommentSheet
          theme={theme}
          layout={layout}
          t={t}
          styles={styles}
          selected={selected}
          activeCommentDraft={activeCommentDraft}
          activeSavedComment={activeSavedComment}
          commentBody={commentBody}
          onCommentBodyChange={onCommentBodyChange}
          commentSaving={commentSaving}
          commentNotice={commentNotice}
          commentAnchorHunk={commentAnchorHunk}
          commentAnchorHunkId={commentAnchorHunkId}
          commentAnchorIsCurrent={commentAnchorIsCurrent}
          commentAnchorMoveArmed={commentAnchorMoveArmed}
          onReturnToAnchor={onReturnToAnchor}
          onMoveAnchor={onMoveAnchor}
          otherSavedComments={otherSavedComments}
          otherCommentsOpen={otherCommentsOpen}
          onToggleOtherComments={onToggleOtherComments}
          onEditSavedComment={onEditSavedComment}
          onSaveComment={onSaveComment}
          agentsLoading={agentsLoading}
          selectedAgentId={selectedAgentId}
          agentFeedback={agentFeedback}
          onReviseCurrentFromComment={onReviseCurrentFromComment}
          />
        </View>
      </View>
    </View>
  );
}

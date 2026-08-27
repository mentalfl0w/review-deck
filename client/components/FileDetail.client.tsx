import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type {
  ExplainHunkAiResult,
  ExplainHunkResult,
  ReviewScope,
  ReviewSections,
} from "../../review.shared";
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
  type Severity,
  type ViewMode,
} from "../tools.client";
import type { TFunc } from "../i18n.client";
import type { PanelStyles } from "../styles.client";
import { ActionButton, SeverityBadge } from "./ui.client";
import { HunkCard } from "./HunkCard.client";
import { CommentSheet } from "./CommentSheet.client";

/** Right-hand canvas: the file header, the change-block card and the comment
 * dock. Renders the no-reviewable-hunk placeholder when nothing is selected. */
export function FileDetail({ theme, layout, t, styles, onHeightChange, selected, selectedFile, diffMode, onDiffModeChange, viewMode, onViewModeChange, fileViewResult, fileViewLoading, fileViewError, onBack, onSelectHunk, scope, currentHunkHasComment, reviewed, fileReviewed, onMarkReviewed, onMarkFileReviewed, onExplainFile, onRevertFile, revertNotice, onExplain, onReject, agentsOpen, onToggleAgentsOpen, agents, agentFeedback, aiExplainBusy, commentBody, commentAnchorIsCurrent, onExplainWithAgent, onSendRevision, onSendFeedback, findingsOpen, onToggleFindingsOpen, analysisStale, explanation, aiExplanation, agentReview, agentSections, activeCommentDraft, activeSavedComment, onCommentBodyChange, commentSaving, commentNotice, commentAnchorHunk, commentAnchorHunkId, commentAnchorMoveArmed, onReturnToAnchor, onMoveAnchor, otherSavedComments, otherCommentsOpen, onToggleOtherComments, onEditSavedComment, onSaveComment }: {
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
  onRevertFile: () => void;
  revertNotice: string | null;
  onExplain: () => void;
  onReject: () => void;
  agentsOpen: boolean;
  onToggleAgentsOpen: () => void;
  agents: AgentInfo[];
  agentFeedback: AgentFeedbackMap;
  aiExplainBusy: string | null;
  commentBody: string;
  commentAnchorIsCurrent: boolean;
  onExplainWithAgent: (agentId: string) => void;
  onSendRevision: (agentId: string) => void;
  onSendFeedback: (agent: AgentInfo) => void;
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
  commentAnchorMoveArmed: boolean;
  onReturnToAnchor: (hunkId: string) => void;
  onMoveAnchor: () => void;
  otherSavedComments: FileCommentEntry[];
  otherCommentsOpen: boolean;
  onToggleOtherComments: () => void;
  onEditSavedComment: (hunkId: string) => void;
  onSaveComment: () => void;
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
              label={t("explainFile")}
              onPress={onExplainFile}
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
          {selectedMeta?.functionHint || selectedMeta?.language || selectedFile.language ? (
            <View style={styles.tagRow}>
              {selectedMeta?.language || selectedFile.language ? <Text style={styles.tagPill}>{selectedMeta?.language ?? selectedFile.language}</Text> : null}
              {selectedMeta?.functionHint ? <Text style={styles.tagPill} numberOfLines={1}>{selectedMeta.functionHint}</Text> : null}
            </View>
          ) : null}
        </View>

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
          onViewModeChange={onViewModeChange}
          fileViewResult={fileViewResult}
          fileViewLoading={fileViewLoading}
          fileViewError={fileViewError}
          scope={scope}
          currentHunkHasComment={currentHunkHasComment}
          reviewed={reviewed}
          onMarkReviewed={onMarkReviewed}
          onExplain={onExplain}
          onReject={onReject}
          agents={agents}
          agentsOpen={agentsOpen}
          onToggleAgentsOpen={onToggleAgentsOpen}
          agentFeedback={agentFeedback}
          aiExplainBusy={aiExplainBusy}
          commentBody={commentBody}
          commentAnchorIsCurrent={commentAnchorIsCurrent}
          onExplainWithAgent={onExplainWithAgent}
          onSendRevision={onSendRevision}
          onSendFeedback={onSendFeedback}
          findingsOpen={findingsOpen}
          onToggleFindingsOpen={onToggleFindingsOpen}
          analysisStale={analysisStale}
          explanation={explanation}
          aiExplanation={aiExplanation}
          agentReview={agentReview}
          agentSections={agentSections}
        />

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
        />
        </View>
      </View>
    </View>
  );
}

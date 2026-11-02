import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type {
  ActionableReviewFinding,
  ExplainHunkAiResult,
  ExplainHunkResult,
  LineRangeSelection,
  PollAiReviewResult,
  PollVerificationRunResult,
  ReviewAnchor,
  ReviewAnchorIssue,
  ReviewSections,
  ReviewVerificationSuggestion,
} from "../../shared/review";
import { anchorLineRange, lineSelectionLocationText, lineSelectionRange, type LineSelectionState } from "../lineRange";
import { hunkHeaderParts } from "../diffView";
import type {
  AgentFeedbackMap,
  FileCommentDraft,
  FileCommentEntry,
  PanelLayout,
  PanelTheme,
  ReviewFile,
  SelectedHunk,
} from "../tools";
import type { TFunc } from "../i18n";
import type { PanelStyles } from "../styles";
import {
  FindingGroup,
  HoverTooltip,
  Segmented,
  StringGroup,
  type CapturedVerificationUi,
  type FindingGroupEntry,
  type FindingPromotionResult,
} from "./ui";
import { CommentSheet } from "./CommentSheet";
import { AnchorIssues } from "./AnchorIssues";
import { AiReviewMeta } from "./AiReviewMeta";
import { VerificationCommands } from "./VerificationCommands";

export type InspectorTab = "comment" | "analysis" | "verification";

/** One file with unresolved anchors, reduced to the navigation the rail cannot
 * do on its own: the file's first change block (`null` when the current
 * snapshot no longer contains that file). */
export type AnchorIssueTarget = { path: string; hunkId: string | null };

/**
 * The contextual inspector: the second half of the review surface, kept out of
 * the diff's reading path. Tabs split the three jobs that used to stack below
 * the diff — writing/re-anchoring the comment, reading findings and AI review
 * evidence, and running verification — so none of them competes with the
 * change block for attention.
 */
export function ReviewInspector({
  theme,
  layout,
  t,
  styles,
  tab,
  onTabChange,
  narrow,
  selected,
  selectedFile,
  analysisStale,
  explanation,
  aiExplanation,
  agentReview,
  agentSections,
  agentFindings,
  agentReviewMeta,
  showAiReviewUsage,
  onPromoteFinding,
  capturedVerification,
  verificationRuns,
  verificationEnabled,
  onRunVerification,
  onRefreshVerification,
  onVerificationError,
  lineSelection,
  activeCommentDraft,
  activeSavedComment,
  commentBody,
  onCommentBodyChange,
  commentSaving,
  commentNotice,
  commentAnchorHunk,
  commentAnchorHunkId,
  commentAnchorIsCurrent,
  commentAnchorMoveArmed,
  onReturnToAnchor,
  onMoveAnchor,
  otherSavedComments,
  otherCommentsOpen,
  onToggleOtherComments,
  onEditSavedComment,
  onSaveComment,
  agentsLoading,
  selectedAgentId,
  agentFeedback,
  onReviseCurrentFromComment,
  commentRequestNonce,
  anchorIssues,
  reanchorBusyIssueId,
  reanchorNotice,
  onReanchorIssue,
  onSelectHunk,
  anchorIssueTargets,
}: {
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  styles: PanelStyles;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  /** Narrow desktop: the inspector sits under the canvas instead of beside it. */
  narrow: boolean;
  selected: SelectedHunk | null;
  selectedFile: ReviewFile | null;
  analysisStale: boolean;
  explanation: ExplainHunkResult | null;
  aiExplanation: ExplainHunkAiResult | null;
  agentReview: string | null;
  agentSections: ReviewSections | null;
  agentFindings: ActionableReviewFinding[] | undefined;
  agentReviewMeta: Pick<PollAiReviewResult, "provider" | "model" | "thinkingOptionId" | "reviewerPermissionMode" | "resultSource" | "mode" | "depth" | "reviewPreset" | "usage"> | null;
  showAiReviewUsage: boolean;
  onPromoteFinding?: (finding: FindingGroupEntry, comment: string) => Promise<FindingPromotionResult>;
  capturedVerification?: CapturedVerificationUi;
  verificationRuns: Readonly<Record<string, PollVerificationRunResult>>;
  verificationEnabled: boolean;
  onRunVerification: (suggestion: ReviewVerificationSuggestion) => Promise<void>;
  onRefreshVerification: (runId: string) => Promise<void>;
  onVerificationError: (message: string) => void;
  lineSelection: LineSelectionState;
  activeCommentDraft: FileCommentDraft | undefined;
  activeSavedComment: FileCommentEntry | null;
  commentBody: string;
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
  agentsLoading: boolean;
  selectedAgentId: string | null;
  agentFeedback: AgentFeedbackMap;
  onReviseCurrentFromComment: (agentId: string) => void;
  commentRequestNonce: number;
  anchorIssues: ReviewAnchorIssue[];
  reanchorBusyIssueId: string | null;
  reanchorNotice: string | null;
  onReanchorIssue: (issue: ReviewAnchorIssue, target: SelectedHunk, lineRange: LineRangeSelection | null) => void;
  onSelectHunk: (hunkId: string) => void;
  anchorIssueTargets: AnchorIssueTarget[];
}) {
  const selectedLineRange = lineSelectionRange(lineSelection);
  const selectionLabel = selectedLineRange ? lineSelectionLocationText(t, selectedLineRange) : null;
  const hunkLabels = useMemo<Record<string, string>>(
    () => Object.fromEntries((selectedFile?.hunks ?? []).map((hunk): [string, string] => [hunk.id, hunkHeaderParts(hunk.header).range])),
    [selectedFile],
  );
  if (!selected || !selectedFile) return null;
  // Anchor issues are shown for the file being reviewed, and their candidates
  // are resolved against THIS file's hunks: a candidate the current snapshot no
  // longer contains is presented as unavailable instead of being re-anchored
  // onto stale geometry.
  const issuesForFile = anchorIssues.filter((issue) =>
    issue.filePath === selectedFile.path ||
    issue.filePath === selectedFile.oldPath ||
    issue.candidates.some((candidate) => candidate.filePath === selectedFile.path));
  const visibleAgentFindings = agentFindings?.filter((finding) => finding.filePath === selectedFile.path) ?? [];
  const verificationCommands = agentSections?.verificationCommands ?? [];
  const hasAgentSections = Boolean(agentSections) && (
    Boolean(agentSections?.summary) ||
    agentFindings !== undefined ||
    (agentSections?.verifiedFacts.length ?? 0) > 0 ||
    (agentSections?.aiInference.length ?? 0) > 0 ||
    (agentSections?.humanVerificationRecommended.length ?? 0) > 0 ||
    verificationCommands.length > 0
  );
  const findingCount = selected.findings.length;
  const reanchorTo = (issue: ReviewAnchorIssue, candidate: ReviewAnchor | null) => {
    // No candidate: the manual path, anchored to what the user selected in the
    // diff right now (the card only offers it for the same file).
    if (!candidate) {
      onReanchorIssue(issue, selected, selectedLineRange);
      return;
    }
    const target = candidate.kind === "file"
      ? undefined
      : selectedFile.hunks.find((hunk) => hunk.id === candidate.hunkId);
    if (target) onReanchorIssue(issue, target, anchorLineRange(candidate));
  };
  const tabOptions: Array<{ value: InspectorTab; label: string; tooltip: string }> = [
    {
      value: "comment",
      label: t("inspectorTabComment"),
      tooltip: t("inspectorTabCommentHint"),
    },
    {
      value: "analysis",
      label: findingCount > 0 ? `${t("inspectorTabAnalysis")} ${findingCount}` : t("inspectorTabAnalysis"),
      tooltip: t("inspectorTabAnalysisHint"),
    },
    {
      value: "verification",
      label: verificationCommands.length > 0
        ? `${t("inspectorTabVerification")} ${verificationCommands.length}`
        : t("inspectorTabVerification"),
      tooltip: t("inspectorTabVerificationHint"),
    },
  ];
  const commentContent = (
    <>
      {anchorIssueTargets.length > 0 ? (
        <View style={styles.inspectorSection}>
          <Text style={styles.inspectorSectionTitle}>{t("anchorIssueFilesTitle")}</Text>
          <Text style={styles.inspectorSectionHint}>{t("anchorIssuesSummary", { count: anchorIssues.length })}</Text>
          <View style={styles.actionRow}>
            {anchorIssueTargets.map((target) => target.hunkId ? (
              <HoverTooltip key={target.path} text={t("anchorIssueFileOpenHint")} theme={theme} layout={layout}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityHint={t("anchorIssueFileOpenHint")}
                  onPress={() => {
                    if (target.hunkId) onSelectHunk(target.hunkId);
                  }}
                  style={styles.topButton}
                >
                  <Text numberOfLines={1} ellipsizeMode="middle" style={styles.topButtonText}>{target.path}</Text>
                </Pressable>
              </HoverTooltip>
            ) : (
              <Text key={target.path} numberOfLines={1} ellipsizeMode="middle" style={styles.muted}>
                {target.path} · {t("anchorIssueFileMissing")}
              </Text>
            ))}
          </View>
        </View>
      ) : null}
      <AnchorIssues
        theme={theme}
        layout={layout}
        t={t}
        styles={styles}
        issues={issuesForFile}
        hunkLabels={hunkLabels}
        selectedFilePath={selectedFile.path}
        selectionHunkId={selected.id}
        selectionLabel={selectionLabel}
        selectionPending={lineSelection?.awaitingEnd ?? false}
        busyIssueId={reanchorBusyIssueId}
        notice={reanchorNotice}
        onSelectCandidate={(_issue, candidate) => {
          // Candidates are hunk or range anchors by construction; a file
          // anchor carries no change block to jump to.
          if (candidate.kind !== "file") onSelectHunk(candidate.hunkId);
        }}
        onReanchor={reanchorTo}
      />
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
        selection={selectedLineRange}
        selectionPending={lineSelection?.awaitingEnd ?? false}
        selectionText={selectionLabel}
        commentRequestNonce={commentRequestNonce}
      />
    </>
  );
  const analysisContent = (
    <>
      {analysisStale ? (
        <View style={styles.analysisStale}>
          <Text style={styles.analysisStaleText}>{t("analysisStaleText")}</Text>
        </View>
      ) : null}
      <View style={[styles.analysis, analysisStale ? { opacity: 0.55 } : null]}>
        <View style={styles.inspectorSection}>
          <Text style={styles.inspectorSectionHint}>{t("findingsSummary", { count: findingCount })}</Text>
          {selected.findings.length === 0 ? (
            <Text style={styles.muted}>{t("noFindings")}</Text>
          ) : (
            <>
              <FindingGroup label={t("findingsRuleSignals")} findings={selected.findings.filter((finding) => finding.source === "deterministic_rule")} t={t} theme={theme} layout={layout} styles={styles} onPromote={onPromoteFinding} promotionEnabled={verificationEnabled && !analysisStale} />
              <FindingGroup label={t("findingsVerified")} findings={selected.findings.filter((finding) => finding.source !== "deterministic_rule" && finding.evidenceKind === "verified_fact")} t={t} theme={theme} layout={layout} styles={styles} />
              <FindingGroup label={t("findingsInference")} findings={selected.findings.filter((finding) => finding.evidenceKind === "ai_inference")} t={t} theme={theme} layout={layout} styles={styles} />
              <FindingGroup label={t("findingsHuman")} findings={selected.findings.filter((finding) => finding.evidenceKind === "human_verification_recommended")} t={t} theme={theme} layout={layout} styles={styles} />
            </>
          )}
        </View>
        {explanation ? (
          <View style={styles.analysisBlock}>
            <Text style={styles.label}>{t("ruleAnalysisLabel")}</Text>
            <StringGroup label={t("ruleAnalysisFacts")} items={explanation.verifiedFacts} t={t} styles={styles} />
            <StringGroup label={t("findingsUnproven")} items={explanation.aiInference} t={t} styles={styles} />
            <StringGroup label={t("findingsHuman")} items={explanation.humanVerificationRecommended} t={t} styles={styles} />
            {explanation.verifiedFacts.length === 0 && explanation.aiInference.length === 0 && explanation.humanVerificationRecommended.length === 0 ? (
              <Text style={styles.muted}>{t("noAdditionalAnalysis")}</Text>
            ) : null}
          </View>
        ) : null}
        {aiExplanation ? (
          <View style={styles.analysisBlock}>
            <Text style={styles.label}>{t("aiReviewLabel", { provider: aiExplanation.provider, model: aiExplanation.model })}</Text>
            <AiReviewMeta details={aiExplanation} showUsage={showAiReviewUsage} t={t} styles={styles} />
            {aiExplanation.summary ? <Text selectable style={styles.scopeDesc}>{aiExplanation.summary}</Text> : null}
            {aiExplanation.findings !== undefined ? (
              <>
                <FindingGroup label={t("findingsVerified")} findings={aiExplanation.findings.filter((finding) => finding.evidenceKind === "verified_fact")} t={t} theme={theme} layout={layout} styles={styles} onPromote={onPromoteFinding} promotionEnabled={verificationEnabled && aiExplanation.status === "idle" && !analysisStale} capturedVerification={capturedVerification} />
                <FindingGroup label={t("findingsInference")} findings={aiExplanation.findings.filter((finding) => finding.evidenceKind === "ai_inference")} t={t} theme={theme} layout={layout} styles={styles} onPromote={onPromoteFinding} promotionEnabled={verificationEnabled && aiExplanation.status === "idle" && !analysisStale} capturedVerification={capturedVerification} />
                <FindingGroup label={t("findingsHuman")} findings={aiExplanation.findings.filter((finding) => finding.evidenceKind === "human_verification_recommended")} t={t} theme={theme} layout={layout} styles={styles} onPromote={onPromoteFinding} promotionEnabled={verificationEnabled && aiExplanation.status === "idle" && !analysisStale} capturedVerification={capturedVerification} />
              </>
            ) : (
              <>
                <StringGroup label={t("findingsVerified")} items={aiExplanation.verifiedFacts} t={t} styles={styles} />
                <StringGroup label={t("findingsInference")} items={aiExplanation.aiInference} t={t} styles={styles} />
                <StringGroup label={t("findingsHuman")} items={aiExplanation.humanVerificationRecommended} t={t} styles={styles} />
              </>
            )}
            {!aiExplanation.summary &&
            aiExplanation.verifiedFacts.length === 0 &&
            aiExplanation.aiInference.length === 0 &&
            aiExplanation.humanVerificationRecommended.length === 0 ? (
              <Text style={styles.muted}>{t("noAdditionalAnalysis")}</Text>
            ) : null}
          </View>
        ) : null}
        {agentReview ? (
          <View style={styles.analysisBlock}>
            <Text style={styles.label}>
              {agentReviewMeta
                ? t("aiReviewLabel", { provider: agentReviewMeta.provider, model: agentReviewMeta.model })
                : t("aiReview")}
            </Text>
            {agentReviewMeta ? <AiReviewMeta details={agentReviewMeta} showUsage={showAiReviewUsage} t={t} styles={styles} /> : null}
            {hasAgentSections ? (
              <>
                {agentSections?.summary ? <Text selectable style={styles.scopeDesc}>{agentSections.summary}</Text> : null}
                {agentFindings !== undefined ? (
                  visibleAgentFindings.length > 0 ? (
                    <>
                      <FindingGroup label={t("findingsVerified")} findings={visibleAgentFindings.filter((finding) => finding.evidenceKind === "verified_fact")} t={t} theme={theme} layout={layout} styles={styles} onPromote={onPromoteFinding} promotionEnabled={verificationEnabled} capturedVerification={capturedVerification} />
                      <FindingGroup label={t("findingsInference")} findings={visibleAgentFindings.filter((finding) => finding.evidenceKind === "ai_inference")} t={t} theme={theme} layout={layout} styles={styles} onPromote={onPromoteFinding} promotionEnabled={verificationEnabled} capturedVerification={capturedVerification} />
                      <FindingGroup label={t("findingsHuman")} findings={visibleAgentFindings.filter((finding) => finding.evidenceKind === "human_verification_recommended")} t={t} theme={theme} layout={layout} styles={styles} onPromote={onPromoteFinding} promotionEnabled={verificationEnabled} capturedVerification={capturedVerification} />
                    </>
                  ) : <Text style={styles.muted}>{t("noFindings")}</Text>
                ) : (
                  <>
                    <StringGroup label={t("findingsVerified")} items={agentSections?.verifiedFacts ?? []} t={t} styles={styles} />
                    <StringGroup label={t("findingsInference")} items={agentSections?.aiInference ?? []} t={t} styles={styles} />
                    <StringGroup label={t("findingsHuman")} items={agentSections?.humanVerificationRecommended ?? []} t={t} styles={styles} />
                  </>
                )}
              </>
            ) : <Text selectable style={styles.rawReview}>{agentReview}</Text>}
          </View>
        ) : null}
        {!explanation && !aiExplanation && !agentReview && findingCount === 0 ? (
          <Text style={styles.muted}>{t("analysisHint")}</Text>
        ) : null}
      </View>
    </>
  );
  const verificationContent = (
    <View style={styles.inspectorSection}>
      {!verificationEnabled ? <Text style={styles.muted}>{t("inspectorVerificationUnavailable")}</Text> : null}
      {verificationCommands.length > 0 ? (
        <VerificationCommands
          theme={theme}
          layout={layout}
          t={t}
          styles={styles}
          commands={verificationCommands}
          runs={verificationRuns}
          enabled={verificationEnabled}
          onRun={onRunVerification}
          onError={onVerificationError}
          onRefresh={onRefreshVerification}
        />
      ) : agentSections ? (
        <Text style={styles.muted}>{t("verificationNoStructuredCommand")}</Text>
      ) : (
        <Text style={styles.muted}>{t("inspectorVerificationEmpty")}</Text>
      )}
    </View>
  );
  const content = (
    <>
      <View style={tab === "comment" ? undefined : styles.inspectorHidden}>{commentContent}</View>
      {tab === "analysis" ? analysisContent : tab === "verification" ? verificationContent : null}
    </>
  );
  return (
    <View style={[styles.inspector, narrow ? styles.inspectorNarrow : null]}>
      <View style={styles.inspectorHeader}>
        <View style={styles.inspectorStatusRow}>
          <Text style={styles.sectionEyebrow}>{t("inspectorTitle")}</Text>
          <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.routeMeta, styles.inspectorPath]}>{selected.filePath}</Text>
        </View>
        <Segmented<InspectorTab> options={tabOptions} value={tab} onChange={onTabChange} theme={theme} layout={layout} stretch />
      </View>
      {layout.compact ? (
        <View style={styles.inspectorContent}>{content}</View>
      ) : (
        <ScrollView style={styles.inspectorScroll} contentContainerStyle={styles.inspectorContent} nestedScrollEnabled showsVerticalScrollIndicator>
          {content}
        </ScrollView>
      )}
    </View>
  );
}

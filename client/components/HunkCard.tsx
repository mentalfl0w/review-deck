import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type {
  ExplainHunkAiResult,
  ExplainHunkResult,
  ReviewScope,
  ReviewSections,
} from "../../shared/review";
import {
  derivePairs,
  deriveUnifiedRows,
  hunkHeaderParts,
} from "../diffView";
import {
  diffModeKeys,
  type DiffMode,
  type FileViewResult,
  type PanelLayout,
  type PanelTheme,
  type ReviewFile,
  type SelectedHunk,
  type ViewMode,
} from "../tools";
import type { TFunc } from "../i18n";
import type { PanelStyles } from "../styles";
import { ActionButton, FindingGroup, HoverTooltip, Segmented, StringGroup } from "./ui";
import { DiffView } from "./DiffView";
import { FileView } from "./FileView";

/** A single change block: navigation, diff mode, review/reject/explain
 * actions, the diff or file-context body and the findings disclosure. */
export function HunkCard({ theme, layout, t, styles, file, hunk, onSelectHunk, diffMode, onDiffModeChange, viewMode, fileViewResult, fileViewLoading, fileViewError, scope, currentHunkHasComment, reviewed, onMarkReviewed, onExplain, onReject, agentsLoading, selectedAgentId, aiExplainBusy, onExplainWithAgent, onOpenMore, findingsOpen, onToggleFindingsOpen, analysisStale, explanation, aiExplanation, agentReview, agentSections }: {
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
  findingsOpen: boolean;
  onToggleFindingsOpen: () => void;
  analysisStale: boolean;
  explanation: ExplainHunkResult | null;
  aiExplanation: ExplainHunkAiResult | null;
  agentReview: string | null;
  agentSections: ReviewSections | null;
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
  const selectedFindings = hunk.findings;
  const verifiedFindings = selectedFindings.filter((finding) => finding.evidenceKind === "verified_fact");
  const inferenceFindings = selectedFindings.filter((finding) => finding.evidenceKind === "ai_inference");
  const humanFindings = selectedFindings.filter((finding) => finding.evidenceKind === "human_verification_recommended");
  // The block-level agent actions always target the agent selected in More;
  // there is no per-block agent list and no arbitrary array fallback.
  const agentHasSections = Boolean(
    agentSections &&
    (agentSections.verifiedFacts.length > 0 ||
      agentSections.aiInference.length > 0 ||
      agentSections.humanVerificationRecommended.length > 0),
  );
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
    <DiffView t={t} styles={styles} mode={effectiveDiffMode} pairs={selectedPairs} rows={unifiedRows} />
  );
  return (
    <View>
      <View style={styles.blockToolbar}>
        <View style={styles.fileHeaderTop}>
          <Text style={styles.sectionEyebrow}>{t("currentDiff")}</Text>
        </View>
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
        <View style={styles.group}>
          <Text style={styles.groupLabel}>{t("changeBlockActions")}</Text>
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
        </View>
        {viewMode === "diff" && !layout.compact ? (
          <View style={styles.diffLayoutRow}>
            <Text style={styles.label}>{t("diffLayout")}</Text>
            <Segmented options={diffModeOptions} value={effectiveDiffMode} onChange={onDiffModeChange} theme={theme} layout={layout} />
          </View>
        ) : null}
        {selectedHeader ? (
          <View style={styles.diffHeaderStrip}>
            <Text selectable style={styles.diffHeaderRange}>{selectedHeader.range}</Text>
            {selectedHeader.context ? <Text selectable style={styles.diffHeaderContext}>{selectedHeader.context}</Text> : null}
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

      <HoverTooltip text={t("findingsToggleHint")} theme={theme} layout={layout}>
        <Pressable accessibilityRole="button" onPress={onToggleFindingsOpen} style={styles.findingsDisclosure}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.sectionTitle}>{t("analysis")}</Text>
            <Text style={styles.sectionSummary}>{t("findingsSummary", { count: selectedFindings.length })}</Text>
          </View>
          <Text style={styles.topButtonText}>{findingsOpen ? t("hideFindings") : t("showFindings")} {findingsOpen ? "▴" : "▾"}</Text>
        </Pressable>
      </HoverTooltip>
      {findingsOpen ? (
        <View style={styles.findingsContent}>
          {analysisStale ? (
            <View style={styles.analysisStale}>
              <Text style={styles.analysisStaleText}>{t("analysisStaleText")}</Text>
            </View>
          ) : null}
          <View style={[styles.analysis, analysisStale ? { opacity: 0.55 } : null]}>
            {selectedFindings.length === 0 ? (
              <Text style={styles.muted}>{t("noFindings")}</Text>
            ) : (
              <>
                <FindingGroup label={t("findingsVerified")} findings={verifiedFindings} t={t} theme={theme} styles={styles} />
                <FindingGroup label={t("findingsInference")} findings={inferenceFindings} t={t} theme={theme} styles={styles} />
                <FindingGroup label={t("findingsHuman")} findings={humanFindings} t={t} theme={theme} styles={styles} />
              </>
            )}
            {explanation ? (
              <View style={styles.analysisBlock}>
                <Text style={styles.label}>{t("ruleAnalysisLabel")}</Text>
                <StringGroup label={t("findingsVerified")} items={explanation.verifiedFacts} t={t} styles={styles} />
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
                <StringGroup label={t("findingsVerified")} items={aiExplanation.verifiedFacts} t={t} styles={styles} />
                <StringGroup label={t("findingsInference")} items={aiExplanation.aiInference} t={t} styles={styles} />
                <StringGroup label={t("findingsHuman")} items={aiExplanation.humanVerificationRecommended} t={t} styles={styles} />
                {aiExplanation.verifiedFacts.length === 0 && aiExplanation.aiInference.length === 0 && aiExplanation.humanVerificationRecommended.length === 0 ? (
                  <Text style={styles.muted}>{t("noAdditionalAnalysis")}</Text>
                ) : null}
              </View>
            ) : null}
            {agentReview ? (
              <View style={styles.analysisBlock}>
                <Text style={styles.label}>{t("aiReview")}</Text>
                {agentHasSections && agentSections ? (
                  <>
                    <StringGroup label={t("findingsVerified")} items={agentSections.verifiedFacts} t={t} styles={styles} />
                    <StringGroup label={t("findingsInference")} items={agentSections.aiInference} t={t} styles={styles} />
                    <StringGroup label={t("findingsHuman")} items={agentSections.humanVerificationRecommended} t={t} styles={styles} />
                  </>
                ) : <Text selectable style={styles.rawReview}>{agentReview}</Text>}
              </View>
            ) : null}
            {!explanation && !aiExplanation && !agentReview && selectedFindings.length === 0 ? (
              <Text style={styles.muted}>{t("analysisHint")}</Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

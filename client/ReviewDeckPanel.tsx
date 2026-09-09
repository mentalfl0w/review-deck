import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettings, type PluginAgentPanelProps, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ScrollView, Text, View } from "react-native";
import { detectLocale, makeT, type Locale } from "./i18n";
import { scopeKeys, type DiffMode, type ViewMode } from "./tools";
import { buildPanelStyles } from "./styles";
import { useReviewScope } from "./hooks/useReviewScope";
import { useReviewSnapshot } from "./hooks/useReviewSnapshot";
import { useAgents } from "./hooks/useAgents";
import { useProjectComments } from "./hooks/useProjectComments";
import { useReviewActions } from "./hooks/useReviewActions";
import { useAgentReview } from "./hooks/useAgentReview";
import { useFileView } from "./hooks/useFileView";
import { ContextBar } from "./components/ContextBar";
import { FileNavigator } from "./components/FileNavigator";
import { FileDetail } from "./components/FileDetail";
import { QueueModal } from "./components/QueueModal";
import { MoreModal } from "./components/MoreModal";
import { ManageModal } from "./components/ManageModal";
import { reviewDeckSettings } from "../shared/review-settings";

/** The host surface the deck consumes, shared by the workspace and agent
 * panel contexts, plus the optional preferred agent target. Both host prop
 * shapes ({@link PluginWorkspacePanelProps} and {@link PluginAgentPanelProps})
 * satisfy it; workspace registrations stay byte-for-byte compatible. */
export type ReviewDeckPanelProps = Pick<PluginWorkspacePanelProps, "theme" | "layout" | "workspaceId"> & {
  /** Agent-context panels preselect the hosting agent: selected once the
   * registry settles, and only when the workspace scope admits it. Absent in
   * workspace panels, where the selection policy is unchanged. */
  preferredAgentId?: string | null;
};

/** Review Deck panel: a minimal composition layer wiring the domain hooks to
 * the presentational components. */
export function ReviewDeckPanel({ theme, layout, workspaceId, preferredAgentId }: ReviewDeckPanelProps) {
  const settings = useSettings(reviewDeckSettings);
  const [manualLocale, setManualLocale] = useState<Locale | null>(null);
  const configuredLocale = settings.status === "ready" ? settings.values.locale : "auto";
  const locale = manualLocale ?? (configuredLocale === "auto" ? detectLocale() : configuredLocale);
  const t = useMemo(() => makeT(locale), [locale]);
  const [actionError, setActionError] = useState<string | null>(null);
  const configuredDiffMode = settings.status === "ready" ? settings.values.diffMode : "auto";
  const defaultDiffMode: DiffMode = configuredDiffMode === "auto"
    ? (layout.compact ? "unified" : "split")
    : configuredDiffMode;
  const diffModeManuallySelected = useRef(false);
  const [diffMode, setDiffMode] = useState<DiffMode>(defaultDiffMode);
  useEffect(() => {
    if (!diffModeManuallySelected.current) setDiffMode(defaultDiffMode);
  }, [defaultDiffMode]);
  const selectDiffMode = useCallback((mode: DiffMode) => {
    diffModeManuallySelected.current = true;
    setDiffMode(mode);
  }, []);
  const [viewMode, setViewMode] = useState<ViewMode>("diff");
  const [compactFilesOpen, setCompactFilesOpen] = useState(layout.compact);
  const [moreOpen, setMoreOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const appliedPreferredAgentId = useRef<string | null>(null);
  const hasAppliedPreferredAgent = useRef(false);
  const [detailHeight, setDetailHeight] = useState(0);
  const handleDetailHeightChange = useCallback((height: number) => {
    setDetailHeight((currentHeight) => Math.abs(currentHeight - height) > 1 ? height : currentHeight);
  }, []);
  const scopeApi = useReviewScope(workspaceId);
  const snapshotApi = useReviewSnapshot({
    reviewCwd: scopeApi.reviewCwd,
    scope: scopeApi.scope,
    baseRef: scopeApi.baseRef,
    headRef: scopeApi.headRef,
    filePath: scopeApi.filePath,
    locale,
    setActionError,
  });
  const agentsApi = useAgents({
    selectedWorkspaceId: scopeApi.selectedWorkspaceId,
    reviewCwd: scopeApi.reviewCwd,
  });
  const commentsApi = useProjectComments({
    effectiveProjectId: scopeApi.effectiveProjectId,
    selectedWorkspaceId: scopeApi.selectedWorkspaceId,
    reviewCwd: scopeApi.reviewCwd,
    projectAgents: agentsApi.projectAgents,
    preferredAgentId,
    t,
  });
  const actionsApi = useReviewActions({
    reviewCwd: scopeApi.reviewCwd,
    scope: scopeApi.scope,
    baseRef: scopeApi.baseRef,
    headRef: scopeApi.headRef,
    filePath: scopeApi.filePath,
    effectiveProjectId: scopeApi.effectiveProjectId,
    projectIdentity: scopeApi.projectIdentity,
    selectedWorkspaceId: scopeApi.selectedWorkspaceId,
    t,
    setActionError,
    snapshot: snapshotApi.snapshot,
    selected: snapshotApi.selected,
    selectedFile: snapshotApi.selectedFile,
    decisions: snapshotApi.decisions,
    setDecisions: snapshotApi.setDecisions,
    stateRpc: snapshotApi.stateRpc,
    refresh: snapshotApi.refresh,
    refreshProjectComments: commentsApi.refreshProjectComments,
  });
  const agentApi = useAgentReview({
    reviewCwd: scopeApi.reviewCwd,
    workspaceId: scopeApi.selectedWorkspaceId,
    scope: scopeApi.scope,
    baseRef: scopeApi.baseRef,
    headRef: scopeApi.headRef,
    filePath: scopeApi.filePath,
    locale,
    selectedFile: snapshotApi.selectedFile,
    t,
    setActionError,
    selected: snapshotApi.selected,
    snapshot: snapshotApi.snapshot,
    commentBody: actionsApi.commentBody,
    setStale: snapshotApi.setStale,
    activeSavedComment: actionsApi.activeSavedComment,
    clearHunkComment: actionsApi.clearHunkComment,
    refreshProjectComments: commentsApi.refreshProjectComments,
  });
  const fileViewApi = useFileView({
    reviewCwd: scopeApi.reviewCwd,
    scope: scopeApi.scope,
    baseRef: scopeApi.baseRef,
    headRef: scopeApi.headRef,
    snapshot: snapshotApi.snapshot,
    selectedFile: snapshotApi.selectedFile,
    selectedHunkId: snapshotApi.selectedHunkId,
    enabled: viewMode === "blockFile" || viewMode === "fullChanges",
    fullChanges: viewMode === "fullChanges",
  });

  // Selecting a hunk discards analysis and comment UI that belonged to the
  // previous hunk (was one combined callback before the decomposition).
  const selectHunk = useCallback((hunkId: string) => {
    snapshotApi.selectHunk(hunkId);
    agentApi.resetAnalysis();
    actionsApi.resetCommentUi();
  }, [actionsApi.resetCommentUi, agentApi.resetAnalysis, snapshotApi.selectHunk]);

  const editSavedFileComment = useCallback((hunkId: string) => {
    if (!actionsApi.activeCommentKey) return;
    const saved = actionsApi.selectedFileComments.find((comment) => comment.hunk.id === hunkId);
    if (!saved?.decision.comment) return;
    selectHunk(saved.hunk.id);
    actionsApi.stageSavedCommentDraft(actionsApi.activeCommentKey, saved.hunk.id, saved.decision.comment);
  }, [actionsApi.activeCommentKey, actionsApi.selectedFileComments, actionsApi.stageSavedCommentDraft, selectHunk]);

  const styles = useMemo(() => buildPanelStyles(theme, layout), [layout.compact, theme]);
  // Agent selection policy: More is the sole selection surface. A single
  // eligible agent is selected automatically; with several, keep a still-valid
  // prior selection or select none — never silently target the first agent.
  // Agent-context wrappers supply a preferredAgentId. Apply that preference
  // once after a non-empty registry settles, then retain any valid user choice
  // from More rather than reasserting the initial target on every update.
  useEffect(() => {
    if (agentsApi.agentsLoading) return;
    const validIds = new Set(agentsApi.agents.map((agent) => agent.id));
    if (preferredAgentId) {
      const preferredChanged = !hasAppliedPreferredAgent.current ||
        appliedPreferredAgentId.current !== preferredAgentId;
      if (preferredChanged) {
        // Wait for a non-empty settled list: otherwise an initial empty
        // subscription snapshot could permanently suppress preselection.
        if (agentsApi.agents.length === 0) {
          setSelectedAgentId(null);
          return;
        }
        hasAppliedPreferredAgent.current = true;
        appliedPreferredAgentId.current = preferredAgentId;
        setSelectedAgentId(validIds.has(preferredAgentId) ? preferredAgentId : null);
        return;
      }
      setSelectedAgentId((current) => (current !== null && validIds.has(current) ? current : null));
      return;
    }
    hasAppliedPreferredAgent.current = false;
    appliedPreferredAgentId.current = null;
    if (agentsApi.agents.length === 0) {
      setSelectedAgentId(null);
    } else if (agentsApi.agents.length === 1) {
      setSelectedAgentId(agentsApi.agents[0].id);
    } else {
      setSelectedAgentId((current) => (current !== null && validIds.has(current) ? current : null));
    }
  }, [agentsApi.agents, agentsApi.agentsLoading, preferredAgentId]);
  const scopeOptions = useMemo(() => scopeKeys.map((option) => ({ value: option.value, label: t(option.key) })), [t]);

  const activeWorkspaceName = scopeApi.workspace?.name ?? "";
  const activeWorkspaceStatus = scopeApi.workspace?.status ?? "";
  const projectCommentCount = commentsApi.projectComments?.commentCount ?? 0;
  const analysisStale = snapshotApi.stale && (agentApi.explanation !== null || agentApi.aiExplanation !== null || agentApi.agentReview !== null);

  if (!scopeApi.workspace) {
    // No live workspace context for this panel: never fake one and never offer
    // a picker — the panel is bound to its workspaceId, so without the
    // workspace snapshot there is nothing to review.
    return (
      <View style={styles.root}>
        <View style={styles.contextBar}>
          <View style={styles.contextTop}>
            <Text style={styles.title}>{t("panelTitle")}</Text>
          </View>
        </View>
        <View style={styles.emptyState}>
          <Text style={styles.empty}>{t("noWorkspacesAvailable")}</Text>
        </View>
      </View>
    );
  }

  const fileNavigator = snapshotApi.snapshot ? (
    <FileNavigator
      key="file-navigator"
      theme={theme}
      layout={layout}
      t={t}
      styles={styles}
      paneHeight={layout.compact ? undefined : detailHeight}
      snapshot={snapshotApi.snapshot}
      decisions={snapshotApi.decisions}
      fileCommentDrafts={actionsApi.fileCommentDrafts}
      selectedFile={snapshotApi.selectedFile}
      selected={snapshotApi.selected}
      onSelectHunk={selectHunk}
      onClose={() => setCompactFilesOpen(false)}
    />
  ) : null;

  const fileDetail = (
    <FileDetail
      key="file-detail"
      theme={theme}
      layout={layout}
      t={t}
      styles={styles}
      onHeightChange={handleDetailHeightChange}
      selected={snapshotApi.selected}
      selectedFile={snapshotApi.selectedFile}
      diffMode={diffMode}
      onDiffModeChange={selectDiffMode}
      viewMode={viewMode}
      onViewModeChange={setViewMode}
      fileViewResult={fileViewApi.result}
      fileViewLoading={fileViewApi.loading}
      fileViewError={fileViewApi.error}
      onBack={() => setCompactFilesOpen(true)}
      onSelectHunk={selectHunk}
      scope={scopeApi.scope}
      currentHunkHasComment={actionsApi.currentHunkHasComment}
      reviewed={snapshotApi.decisions.some((decision) => decision.hunkId === snapshotApi.selected?.id)}
      fileReviewed={snapshotApi.selectedFile ? snapshotApi.selectedFile.hunks.every((hunk) => snapshotApi.decisions.some((decision) => decision.hunkId === hunk.id)) : false}
      onMarkFileReviewed={() => void actionsApi.markFileReviewed()}
      onExplainFile={() => void agentApi.explainWholeFile()}
      onRunAgentReview={(agentId, filePath) => void agentApi.runAgentReview(agentId, filePath)}
      onRevertFile={() => void actionsApi.revertFileReview()}
      revertNotice={actionsApi.revertNotice}
      onMarkReviewed={() => void actionsApi.markReviewed()}
      onExplain={() => void agentApi.explainSelected()}
      onReject={() => void actionsApi.rejectSelected()}
      agentsLoading={agentsApi.agentsLoading}
      selectedAgentId={selectedAgentId}
      onOpenMore={() => setMoreOpen(true)}
      agentFeedback={agentApi.agentFeedback}
      fileReviseFeedback={agentApi.fileReviseFeedback}
      aiExplainBusy={agentApi.aiExplainBusy}
      commentBody={actionsApi.commentBody}
      commentAnchorIsCurrent={actionsApi.commentAnchorIsCurrent}
      onExplainWithAgent={agentApi.explainWithAgent}
      onReviseCurrentFromComment={agentApi.reviseCurrentFromComment}
      onReviseFileFromComment={agentApi.reviseFileFromComment}
      findingsOpen={agentApi.findingsOpen}
      onToggleFindingsOpen={() => agentApi.setFindingsOpen((open) => !open)}
      analysisStale={analysisStale}
      explanation={agentApi.explanation}
      aiExplanation={agentApi.aiExplanation}
      agentReview={agentApi.agentReview}
      agentSections={agentApi.agentSections}
      activeCommentDraft={actionsApi.activeCommentDraft}
      activeSavedComment={actionsApi.activeSavedComment}
      onCommentBodyChange={actionsApi.setCommentBody}
      commentSaving={actionsApi.commentSaving}
      commentNotice={actionsApi.commentNotice}
      commentAnchorHunk={actionsApi.commentAnchorHunk}
      commentAnchorHunkId={actionsApi.commentAnchorHunkId}
      commentAnchorMoveArmed={actionsApi.commentAnchorMoveArmed}
      onReturnToAnchor={selectHunk}
      onMoveAnchor={actionsApi.moveCommentAnchorToSelected}
      otherSavedComments={actionsApi.otherSavedComments}
      otherCommentsOpen={actionsApi.otherCommentsOpen}
      onToggleOtherComments={() => actionsApi.setOtherCommentsOpen((open) => !open)}
      onEditSavedComment={editSavedFileComment}
      onSaveComment={() => void actionsApi.saveComment()}
    />
  );

  const mainContent = [
    <ContextBar
      key="context"
      theme={theme}
      layout={layout}
      t={t}
      styles={styles}
      onToggleLocale={() => {
        setManualLocale(locale === "zh" ? "en" : "zh");
        agentApi.resetAnalysis();
      }}
      activeWorkspaceStatus={activeWorkspaceStatus}
      projectCommentCount={projectCommentCount}
      onOpenQueue={commentsApi.openProjectQueue}
      onOpenMore={() => setMoreOpen(true)}
      projectIdentity={scopeApi.projectIdentity}
      effectiveProjectId={scopeApi.effectiveProjectId}
      activeWorkspaceName={activeWorkspaceName}
      scope={scopeApi.scope}
      stale={snapshotApi.stale}
      loading={snapshotApi.loading}
      snapshot={snapshotApi.snapshot}
    />,

    snapshotApi.stale ? (
      <View key="stale" style={styles.staleStrip}>
        <Text style={styles.staleStripText}>{t("staleBanner")}</Text>
      </View>
    ) : null,
    actionError ? (
      <View key="action-error" style={styles.errorCard}>
        <Text style={styles.errorText}>{actionError}</Text>
      </View>
    ) : null,

    snapshotApi.snapshot ? (
      layout.compact ? (
        compactFilesOpen ? fileNavigator : fileDetail
      ) : (
        <View key="workbench" style={styles.workbench}>
          {fileNavigator}
          {fileDetail}
        </View>
      )
    ) : (
      <View key="empty" style={styles.emptyState}>
        {snapshotApi.loading ? (
          <View style={styles.loadingTrack}>
            <View style={styles.loadingFill} />
          </View>
        ) : null}
        <Text style={styles.empty}>{snapshotApi.loading ? t("readingGitState") : scopeApi.reviewCwd ? t("noSnapshot") : t("selectWorkspaceToStart")}</Text>
      </View>
    ),
  ];

  return (
    <>
      {layout.compact ? (
        <ScrollView style={styles.root} contentContainerStyle={styles.content} stickyHeaderIndices={[0]}>
          {mainContent}
        </ScrollView>
      ) : (
        <ScrollView style={styles.root} contentContainerStyle={styles.desktopShell}>
          {mainContent}
        </ScrollView>
      )}

      <QueueModal
        theme={theme}
        layout={layout}
        t={t}
        styles={styles}
        open={commentsApi.queueOpen}
        onClose={() => commentsApi.setQueueOpen(false)}
        projectComments={commentsApi.projectComments}
        projectCommentsLoading={commentsApi.projectCommentsLoading}
        projectCommentsError={commentsApi.projectCommentsError}
        onRefresh={() => void commentsApi.refreshProjectComments()}
        commentsByTarget={commentsApi.commentsByTarget}
        projectIdentity={scopeApi.projectIdentity}
        effectiveProjectId={scopeApi.effectiveProjectId}
        activeWorkspaceName={activeWorkspaceName}
        reviewCwd={scopeApi.reviewCwd}
        projectAgentOptions={commentsApi.projectAgentOptions}
        selectedProcessAgent={commentsApi.selectedProcessAgent}
        onSelectProcessAgent={commentsApi.setSelectedProcessAgent}
        projectAgentCount={agentsApi.projectAgents.length}
        agentsLoading={agentsApi.agentsLoading}
        canProcessProject={commentsApi.canProcessProject}
        processingProject={commentsApi.processingProject}
        onProcess={() => void commentsApi.processProject()}
        processResult={commentsApi.processResult}
        processError={commentsApi.processError}
        projectNotice={commentsApi.projectNotice}
      />

      <MoreModal
        theme={theme}
        layout={layout}
        t={t}
        styles={styles}
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        scopeOptions={scopeOptions}
        scope={scopeApi.scope}
        agents={agentsApi.agents}
        agentsLoading={agentsApi.agentsLoading}
        selectedAgentId={selectedAgentId}
        onSelectAgent={setSelectedAgentId}
        onScopeChange={scopeApi.setScope}
        filePath={scopeApi.filePath}
        onFilePathChange={scopeApi.setFilePath}
        baseRef={scopeApi.baseRef}
        onBaseRefChange={scopeApi.setBaseRef}
        headRef={scopeApi.headRef}
        onHeadRefChange={scopeApi.setHeadRef}
        loading={snapshotApi.loading}
        onRefresh={() => void snapshotApi.refresh()}
        selected={snapshotApi.selected}
        decisions={snapshotApi.decisions}
        snapshot={snapshotApi.snapshot}
        onClearCurrentHunk={() => void actionsApi.clearCurrentHunk()}
        onClearCurrentReview={() => void actionsApi.clearCurrentReview()}
        onManage={actionsApi.openManage}
      />

      <ManageModal
        theme={theme}
        layout={layout}
        t={t}
        styles={styles}
        open={actionsApi.manageOpen}
        onClose={() => actionsApi.setManageOpen(false)}
        stateError={actionsApi.stateError}
        savedReviews={actionsApi.savedReviews}
        onClearTarget={(targetFingerprint) => void actionsApi.clearSavedTarget(targetFingerprint)}
        confirmClearAll={actionsApi.confirmClearAll}
        onRequestClearAll={() => actionsApi.setConfirmClearAll(true)}
        onCancelClearAll={() => actionsApi.setConfirmClearAll(false)}
        onClearAll={() => void actionsApi.clearAllSaved()}
      />
    </>
  );
}

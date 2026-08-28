import { useCallback, useMemo, useState } from "react";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { ScrollView, Text, View } from "react-native";
import { detectLocale, makeT, type Locale } from "./i18n.client";
import { scopeKeys, type DiffMode, type ViewMode } from "./tools.client";
import { buildPanelStyles } from "./styles.client";
import { useReviewScope } from "./hooks/useReviewScope.client";
import { useReviewSnapshot } from "./hooks/useReviewSnapshot.client";
import { useAgents } from "./hooks/useAgents.client";
import { useProjectComments } from "./hooks/useProjectComments.client";
import { useReviewActions } from "./hooks/useReviewActions.client";
import { useAgentReview } from "./hooks/useAgentReview.client";
import { useFileView } from "./hooks/useFileView.client";
import { ActionButton } from "./components/ui.client";
import { ContextBar } from "./components/ContextBar.client";
import { FileNavigator } from "./components/FileNavigator.client";
import { FileDetail } from "./components/FileDetail.client";
import { QueueModal } from "./components/QueueModal.client";
import { MoreModal } from "./components/MoreModal.client";
import { ManageModal } from "./components/ManageModal.client";

/** Review Deck panel: a minimal composition layer wiring the domain hooks to
 * the presentational components. */
export function ReviewDeckPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const [manualLocale, setManualLocale] = useState<Locale | null>(null);
  const locale = manualLocale ?? detectLocale();
  const t = useMemo(() => makeT(locale), [locale]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>(layout.compact ? "unified" : "split");
  const [viewMode, setViewMode] = useState<ViewMode>("diff");
  const [compactFilesOpen, setCompactFilesOpen] = useState(layout.compact);
  const [moreOpen, setMoreOpen] = useState(false);
  const [detailHeight, setDetailHeight] = useState(0);
  const handleDetailHeightChange = useCallback((height: number) => {
    setDetailHeight((currentHeight) => Math.abs(currentHeight - height) > 1 ? height : currentHeight);
  }, []);

  const scopeApi = useReviewScope(workspaceId, setActionError);
  const snapshotApi = useReviewSnapshot({
    reviewCwd: scopeApi.reviewCwd,
    scope: scopeApi.scope,
    baseRef: scopeApi.baseRef,
    locale,
    headRef: scopeApi.headRef,
    filePath: scopeApi.filePath,
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
    scope: scopeApi.scope,
    baseRef: scopeApi.baseRef,
    locale,
    headRef: scopeApi.headRef,
    filePath: scopeApi.filePath,
    selectedFile: snapshotApi.selectedFile,
    t,
    setActionError,
    selected: snapshotApi.selected,
    snapshot: snapshotApi.snapshot,
    commentBody: actionsApi.commentBody,
    setStale: snapshotApi.setStale,
  });
  const fileViewApi = useFileView({
    reviewCwd: scopeApi.reviewCwd,
    scope: scopeApi.scope,
    baseRef: scopeApi.baseRef,
    headRef: scopeApi.headRef,
    snapshot: snapshotApi.snapshot,
    selectedFile: snapshotApi.selectedFile,
    selectedHunkId: snapshotApi.selectedHunkId,
    enabled: viewMode === "file",
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
  const scopeOptions = useMemo(() => scopeKeys.map((option) => ({ value: option.value, label: t(option.key) })), [t]);

  const activeWorkspaceName = scopeApi.selectedWorkspaceEntry?.name ?? scopeApi.workspace?.name ?? "";
  const activeWorkspaceStatus = scopeApi.selectedWorkspaceEntry?.status ?? scopeApi.workspace?.status ?? "";
  const projectCommentCount = commentsApi.projectComments?.commentCount ?? 0;
  const analysisStale = snapshotApi.stale && (agentApi.explanation !== null || agentApi.aiExplanation !== null || agentApi.agentReview !== null);

  if (!scopeApi.workspace) {
    // No live workspace context for this panel: never fake one. While the list
    // is empty (still loading, or loaded and genuinely empty) show an
    // actionable state instead of a dead-end; once entries are available the
    // full deck below renders the project → workspace dropdowns, and an
    // explicit selection opens the workspace in the Paseo foreground and
    // starts the review against it.
    if (scopeApi.workspaceEntries.length === 0) {
      return (
        <View style={styles.root}>
          <View style={styles.contextBar}>
            <View style={styles.contextTop}>
              <Text style={styles.title}>{t("panelTitle")}</Text>
            </View>
          </View>
          <View style={styles.emptyState}>
            {scopeApi.workspacesLoaded ? (
              <>
                <Text style={styles.empty}>{t("noWorkspacesAvailable")}</Text>
                <ActionButton
                  variant="secondary"
                  label={t("retry")}
                  onPress={() => void scopeApi.loadWorkspaces()}
                  theme={theme}
                  layout={layout}
                />
              </>
            ) : (
              <Text style={styles.empty}>{t("loadingWorkspaces")}</Text>
            )}
          </View>
        </View>
      );
    }
    // Entries are available: fall through to the full deck so the user can pick
    // a project/workspace from the dropdowns above; selection opens it.
  }

  const fileNavigator = snapshotApi.snapshot ? (
    <FileNavigator
      key="file-navigator"
      theme={theme}
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
      onDiffModeChange={setDiffMode}
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
      onRevertFile={() => void actionsApi.revertFileReview()}
      revertNotice={actionsApi.revertNotice}
      onMarkReviewed={() => void actionsApi.markReviewed()}
      onExplain={() => void agentApi.explainSelected()}
      onReject={() => void actionsApi.rejectSelected()}
      agentsOpen={agentApi.agentsOpen}
      onToggleAgentsOpen={() => agentApi.setAgentsOpen((open) => !open)}
      agents={agentsApi.agents}
      agentFeedback={agentApi.agentFeedback}
      aiExplainBusy={agentApi.aiExplainBusy}
      commentBody={actionsApi.commentBody}
      commentAnchorIsCurrent={actionsApi.commentAnchorIsCurrent}
      onExplainWithAgent={agentApi.explainWithAgent}
      onSendRevision={agentApi.sendRevision}
      onSendFeedback={agentApi.sendFeedbackToAgent}
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
      workspaceEntries={scopeApi.workspaceEntries}
      projectOptions={scopeApi.projectOptions}
      effectiveProjectId={scopeApi.effectiveProjectId}
      onSelectProject={scopeApi.selectProject}
      workspaceOptions={scopeApi.workspaceOptions}
      workspaceValue={scopeApi.workspaceValue}
      onSelectWorkspace={scopeApi.selectWorkspace}
      projectIdentity={scopeApi.projectIdentity}
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
        canProcessProject={commentsApi.canProcessProject}
        processingProject={commentsApi.processingProject}
        onProcess={() => void commentsApi.processProject()}
        processResult={commentsApi.processResult}
        canDeleteProcessed={commentsApi.canDeleteProcessed}
        deletingProcessed={commentsApi.deletingProcessed}
        onDelete={() => void commentsApi.deleteProcessed()}
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
        onScopeChange={scopeApi.setScope}
        filePath={scopeApi.filePath}
        onFilePathChange={scopeApi.setFilePath}
        baseRef={scopeApi.baseRef}
        onBaseRefChange={scopeApi.setBaseRef}
        headRef={scopeApi.headRef}
        onHeadRefChange={scopeApi.setHeadRef}
        loading={snapshotApi.loading}
        onRefresh={() => void snapshotApi.refresh()}
        agents={agentsApi.agents}
        onRunAgentReview={agentApi.runAgentReview}
        onSendRevision={agentApi.sendRevision}
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc, useSettings, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { detectLocale, makeT, type Locale } from "./i18n";
import { scopeKeys, type DiffMode, type PendingCommentReview, type ViewMode } from "./tools";
import { buildPanelStyles } from "./styles";
import { resolveReviewPanelLayoutMode } from "./review-panel-layout";
import { useReviewScope } from "./hooks/useReviewScope";
import { useReviewSnapshot } from "./hooks/useReviewSnapshot";
import { useLineSelection } from "./hooks/useLineSelection";
import type { LineSide } from "./lineRange";
import { useAgents } from "./hooks/useAgents";
import { useProjectComments } from "./hooks/useProjectComments";
import { useReviewActions } from "./hooks/useReviewActions";
import { currentPathForReviewBaseline } from "./project-review-workspaces";
import { useAgentReview } from "./hooks/useAgentReview";
import { useFileView } from "./hooks/useFileView";
import { useVerification } from "./hooks/useVerification";
import { useProcessVerification } from "./hooks/useProcessVerification";
import { ContextBar } from "./components/ContextBar";
import { FileNavigator } from "./components/FileNavigator";
import { FileDetail } from "./components/FileDetail";
import { ReviewInspector, type AnchorIssueTarget, type InspectorTab } from "./components/ReviewInspector";
import { ActionButton } from "./components/ui";
import { QueueModal } from "./components/QueueModal";
import { MoreModal } from "./components/MoreModal";
import { ManageModal } from "./components/ManageModal";
import { isReviewPreviewUrl, reviewDeckSettings, setProjectPreviewUrl } from "../shared/review-settings";
import type { ReviewPanelLaunchRequest } from "./review-panel-launch";
import { markWorkspaceReviewResultsRead } from "../shared/review-activity";
import { getReviewEntryStatusStore } from "./review-entry-status-store";
import type { AiReviewBudgetPreset, AiReviewDepth, ProjectCommentReview, ReviewRequest } from "../shared/review";

/** Review Deck's single workspace-scoped tab receives transient launch intent
 * from the Header, Command Center, timeline, or Agent Composer. */
export type ReviewDeckPanelProps = Pick<PluginWorkspacePanelProps, "theme" | "layout" | "workspaceId" | "navigation"> & {
  launchRequest?: ReviewPanelLaunchRequest | null;
};

/** Review Deck panel: a minimal composition layer wiring the domain hooks to
 * the presentational components. */
export function ReviewDeckPanel({ theme, layout, workspaceId, navigation, launchRequest = null }: ReviewDeckPanelProps) {
  const settings = useSettings(reviewDeckSettings);
  const preferredAgentId = launchRequest?.preferredAgentId ?? null;
  const initialQueueOpen = launchRequest?.action === "queue";
  const targetedReviewRequestId = launchRequest?.action === "targeted" ? launchRequest.requestId : null;
  const markAiReviewResultsReadOnOpen = launchRequest?.action !== "queue";
  const [manualLocale, setManualLocale] = useState<Locale | null>(null);
  const configuredLocale = settings.status === "ready" ? settings.values.locale : "auto";
  const locale = manualLocale ?? (configuredLocale === "auto" ? detectLocale() : configuredLocale);
  const t = useMemo(() => makeT(locale), [locale]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [shellSize, setShellSize] = useState({ width: 0, height: 0 });
  const panelMode = resolveReviewPanelLayoutMode(layout.compact, shellSize.width, shellSize.height);
  const compact = panelMode === "compact";
  const panelLayout = useMemo(
    () => (compact && !layout.compact ? { ...layout, compact: true } : layout),
    [compact, layout],
  );
  const handleShellLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setShellSize((current) =>
      Math.abs(current.width - width) > 1 || Math.abs(current.height - height) > 1
        ? { width, height }
        : current,
    );
  }, []);
  const configuredDiffMode = settings.status === "ready" ? settings.values.diffMode : "auto";
  const showAiReviewUsage = settings.status === "ready" ? settings.values.showAiReviewUsage : true;
  const defaultReviewPreset: AiReviewBudgetPreset =
    settings.status === "ready" ? settings.values.defaultReviewPreset : "balanced";
  const defaultDiffMode: DiffMode = configuredDiffMode === "auto"
    ? (compact ? "unified" : "split")
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
  const [compactFilesOpen, setCompactFilesOpen] = useState(compact);
  useEffect(() => {
    if (compact) setCompactFilesOpen(true);
  }, [compact]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [previewUrlDraft, setPreviewUrlDraft] = useState("");
  const previewUrlProjectRef = useRef<string | null>(null);
  const previewUrlDraftDirtyRef = useRef(false);
  const [reviewDepthOverride, setReviewDepthOverride] = useState<AiReviewDepth | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const appliedPreferredAgentId = useRef<string | null>(null);
  const appliedPreferredAgentRequestId = useRef<number | null>(null);
  const hasAppliedPreferredAgent = useRef(false);
  const initialQueueOpenedForRef = useRef<number | null>(null);
  const autoRunTargetedStartedRef = useRef<number | null>(null);
  const markReadRpc = useRpc(markWorkspaceReviewResultsRead);
  // Contextual inspector tab and the measured shell width that decides whether
  // the inspector can sit beside the canvas without starving it.
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("comment");
  const scopeApi = useReviewScope(workspaceId);
  const previewProjectId = scopeApi.effectiveProjectId;
  const configuredPreviewUrl = settings.status === "ready" && previewProjectId
    ? settings.values.projectPreviewUrls[previewProjectId] ?? ""
    : "";
  useEffect(() => {
    if (previewUrlProjectRef.current !== previewProjectId) {
      previewUrlProjectRef.current = previewProjectId;
      previewUrlDraftDirtyRef.current = false;
    }
    if (!previewUrlDraftDirtyRef.current && settings.status === "ready") {
      setPreviewUrlDraft(configuredPreviewUrl);
    }
  }, [configuredPreviewUrl, previewProjectId, settings.status]);
  const updatePreviewUrlDraft = useCallback((url: string) => {
    previewUrlDraftDirtyRef.current = true;
    setPreviewUrlDraft(url);
  }, []);
  const commitPreviewUrl = useCallback(() => {
    if (!previewProjectId || settings.status !== "ready") return;
    const url = previewUrlDraft.trim();
    if (url !== "" && !isReviewPreviewUrl(url)) return;
    previewUrlDraftDirtyRef.current = false;
    const next = setProjectPreviewUrl(settings.values, previewProjectId, url);
    if (next !== settings.values) void settings.save(next, settings.revision);
  }, [previewProjectId, previewUrlDraft, settings]);
  const openPreview = useCallback(() => {
    const openBrowser = navigation?.openBrowser;
    const selectedWorkspaceId = scopeApi.selectedWorkspaceId;
    const url = previewUrlDraft.trim();
    if (
      !openBrowser ||
      !previewProjectId ||
      !selectedWorkspaceId ||
      settings.status !== "ready" ||
      !isReviewPreviewUrl(url)
    ) return;
    commitPreviewUrl();
    setMoreOpen(false);
    openBrowser({ url, workspaceId: selectedWorkspaceId });
  }, [commitPreviewUrl, navigation, previewProjectId, previewUrlDraft, scopeApi.selectedWorkspaceId, settings.status]);
  useEffect(() => {
    setReviewDepthOverride(null);
  }, [scopeApi.selectedWorkspaceId]);
  const markedReadWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!markAiReviewResultsReadOnOpen || !scopeApi.workspace || markedReadWorkspaceRef.current === workspaceId) return;
    markedReadWorkspaceRef.current = workspaceId;
    void markReadRpc({ workspaceId })
      .then(() => getReviewEntryStatusStore().refresh(workspaceId))
      .catch(() => {
        // Keep unread state when the read acknowledgement cannot be persisted.
        if (markedReadWorkspaceRef.current === workspaceId) markedReadWorkspaceRef.current = null;
      });
  }, [markAiReviewResultsReadOnOpen, markReadRpc, scopeApi.workspace, workspaceId]);
  const agentsApi = useAgents({
    selectedWorkspaceId: scopeApi.selectedWorkspaceId,
    reviewCwd: scopeApi.reviewCwd,
    projectId: scopeApi.effectiveProjectId,
  });
  const snapshotApi = useReviewSnapshot({
    reviewCwd: scopeApi.reviewCwd,
    scope: scopeApi.scope,
    baseRef: scopeApi.baseRef,
    headRef: scopeApi.headRef,
    filePath: scopeApi.filePath,
    locale,
    projectId: scopeApi.effectiveProjectId,
    workspaceId: scopeApi.selectedWorkspaceId,
    workspaceDiffStat: scopeApi.workspace?.diffStat ?? null,
    workspaceStatus: scopeApi.workspace?.status ?? null,
    agentRevision: agentsApi.agentRevision,
    setActionError,
  });
  const verificationRequest = useMemo<ReviewRequest | null>(() => {
    if (!scopeApi.reviewCwd) return null;
    const filePath = scopeApi.filePath.trim();
    return {
      cwd: scopeApi.reviewCwd,
      scope: scopeApi.scope,
      locale,
      ...(scopeApi.scope === "commits" ? { baseRef: scopeApi.baseRef, headRef: scopeApi.headRef } : {}),
      ...(filePath ? { filePath } : {}),
    };
  }, [locale, scopeApi.baseRef, scopeApi.filePath, scopeApi.headRef, scopeApi.reviewCwd, scopeApi.scope]);
  const verificationApi = useVerification({
    workspaceId: scopeApi.selectedWorkspaceId,
    request: verificationRequest,
    targetFingerprint: snapshotApi.snapshot?.targetFingerprint ?? null,
    enabled: Boolean(snapshotApi.snapshot && !snapshotApi.loading && !snapshotApi.stale),
    onError: setActionError,
    onTargetChanged: snapshotApi.setStale,
  });
  const processVerificationApi = useProcessVerification({
    workspaceId: scopeApi.selectedWorkspaceId,
    targetFingerprint: snapshotApi.snapshot?.targetFingerprint ?? null,
    enabled: Boolean(scopeApi.selectedWorkspaceId),
    onError: setActionError,
  });
  useEffect(() => {
    if (!snapshotApi.snapshot) return;
    void getReviewEntryStatusStore().refresh(workspaceId);
  }, [snapshotApi.anchorIssues, snapshotApi.snapshot, workspaceId]);
  // The v1.3 line-range selection: scoped to the shown target and change block,
  // so it can never describe lines of a hunk that is no longer on screen.
  const lineSelectionApi = useLineSelection({
    targetFingerprint: snapshotApi.snapshot?.targetFingerprint ?? null,
    hunkId: snapshotApi.selectedHunkId,
  });
  const selectLine = useCallback((side: LineSide, line: number, extend: boolean) => {
    lineSelectionApi.dispatch({ type: extend ? "extend" : "click", side, line });
  }, [lineSelectionApi.dispatch]);
  const tapLine = useCallback((side: LineSide, line: number) => {
    lineSelectionApi.dispatch({ type: "tap", side, line });
  }, [lineSelectionApi.dispatch]);
  const clearLineSelection = useCallback(() => {
    lineSelectionApi.dispatch({ type: "clear" });
  }, [lineSelectionApi.dispatch]);
  // Bumped by the diff strip's comment action; the dock focuses its input on
  // every new value.
  const [commentRequestNonce, setCommentRequestNonce] = useState(0);
  const requestCommentOnSelection = useCallback(() => {
    setCommentRequestNonce((current) => current + 1);
    setInspectorTab("comment");
  }, []);
  const commentsApi = useProjectComments({
    effectiveProjectId: scopeApi.effectiveProjectId,
    selectedWorkspaceId: scopeApi.selectedWorkspaceId,
    projectAgents: agentsApi.projectAgents,
    preferredAgentId,
    t,
  });
  useEffect(() => {
    if (!initialQueueOpen || !scopeApi.workspace || !launchRequest ||
      initialQueueOpenedForRef.current === launchRequest.requestId) return;
    initialQueueOpenedForRef.current = launchRequest.requestId;
    commentsApi.openProjectQueue();
  }, [commentsApi.openProjectQueue, initialQueueOpen, launchRequest, scopeApi.workspace, workspaceId]);
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
    setAnchorIssues: snapshotApi.setAnchorIssues,
    lineRange: lineSelectionApi.range,
    lineSelectionPending: lineSelectionApi.state?.awaitingEnd ?? false,
    clearLineSelection,
    readReviewState: snapshotApi.readReviewState,
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
  const runReviewForAgent = useCallback((
    agentId: string,
    filePath?: string,
    requestedDepth?: AiReviewDepth,
  ) => {
    const depthOverride = requestedDepth ?? reviewDepthOverride;
    setReviewDepthOverride(null);
    setInspectorTab("analysis");
    void agentApi.runAgentReview(agentId, filePath, depthOverride ?? undefined);
  }, [agentApi.runAgentReview, reviewDepthOverride]);
  const explainSelected = useCallback(() => {
    setInspectorTab("analysis");
    void agentApi.explainSelected();
  }, [agentApi.explainSelected]);
  const explainFile = useCallback(() => {
    setInspectorTab("analysis");
    void agentApi.explainWholeFile();
  }, [agentApi.explainWholeFile]);
  const explainWithAgent = useCallback((agentId: string) => {
    setInspectorTab("analysis");
    void agentApi.explainWithAgent(agentId);
  }, [agentApi.explainWithAgent]);
  useEffect(() => {
    if (
      targetedReviewRequestId === null ||
      autoRunTargetedStartedRef.current === targetedReviewRequestId ||
      !preferredAgentId ||
      selectedAgentId !== preferredAgentId ||
      agentsApi.agentsLoading ||
      snapshotApi.loading ||
      snapshotApi.stale ||
      !snapshotApi.snapshot ||
      snapshotApi.snapshot.totalHunks === 0 ||
      agentApi.agentReviewBusy
    ) return;
    autoRunTargetedStartedRef.current = targetedReviewRequestId;
    runReviewForAgent(preferredAgentId, undefined, "targeted");
  }, [
    agentApi.agentReviewBusy,
    agentsApi.agentsLoading,
    preferredAgentId,
    runReviewForAgent,
    selectedAgentId,
    snapshotApi.loading,
    snapshotApi.snapshot,
    snapshotApi.stale,
    targetedReviewRequestId,
    workspaceId,
  ]);
  useEffect(() => {
    if (!markAiReviewResultsReadOnOpen || !agentApi.agentReviewMeta || agentApi.agentReviewBusy) return;
    void markReadRpc({ workspaceId })
      .then(() => getReviewEntryStatusStore().refresh(workspaceId))
      .catch(() => undefined);
  }, [agentApi.agentReviewBusy, agentApi.agentReviewMeta, markAiReviewResultsReadOnOpen, markReadRpc, workspaceId]);
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

  /**
   * Agent-reported completions that no human accepted yet, restricted to the
   * review context on screen (same workspace, scope, directory, and file — the
   * baseline's rename alias included). The card only surfaces them on the
   * change block they can plausibly refer to; the server re-proves the exact
   * target, hunk, and changed lines before deleting anything.
   */
  const pendingCommentReviewsByFile = useMemo(() => {
    const grouped = new Map<string, PendingCommentReview[]>();
    const envelope = commentsApi.projectComments;
    if (!envelope || !scopeApi.reviewCwd) return grouped;
    const bodies = new Map<string, string>(envelope.comments.map((comment) => [comment.id, comment.comment]));
    const cwd = scopeApi.reviewCwd.replace(/\\/g, "/").replace(/\/+$/, "");
    for (const review of envelope.reviews) {
      if (review.outcome !== "completed" || review.acceptedAt !== undefined || !review.baseline) continue;
      if (review.baseline.scope !== scopeApi.scope) continue;
      if (review.baseline.cwd.replace(/\\/g, "/").replace(/\/+$/, "") !== cwd) continue;
      if (scopeApi.selectedWorkspaceId && review.workspaceId !== scopeApi.selectedWorkspaceId) continue;
      const body = bodies.get(review.commentId);
      if (body === undefined) continue;
      const pending: PendingCommentReview = {
        commentId: review.commentId,
        batchId: review.batchId,
        comment: body,
        baseline: review.baseline,
      };
      const filePath = currentPathForReviewBaseline(review.baseline, snapshotApi.snapshot?.files ?? []);
      if (filePath === null) continue;
      const list = grouped.get(filePath) ?? [];
      list.push(pending);
      grouped.set(filePath, list);
    }
    return grouped;
  }, [commentsApi.projectComments, scopeApi.reviewCwd, scopeApi.scope, scopeApi.selectedWorkspaceId, snapshotApi.snapshot]);
  const commentReviewsById = useMemo(
    () => new Map<string, ProjectCommentReview>(
      (commentsApi.projectComments?.reviews ?? []).map((review) => [review.commentId, review]),
    ),
    [commentsApi.projectComments],
  );

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

  const styles = useMemo(() => buildPanelStyles(theme, panelLayout), [panelLayout, theme]);
  // A workspace launch request may prefer its originating Agent. Apply that
  // preference once per request after the registry settles, then preserve the
  // user's choice from More until another launch arrives.
  useEffect(() => {
    if (agentsApi.agentsLoading) return;
    const validIds = new Set(agentsApi.agents.map((agent) => agent.id));
    if (preferredAgentId) {
      const preferredChanged = !hasAppliedPreferredAgent.current ||
        appliedPreferredAgentId.current !== preferredAgentId ||
        appliedPreferredAgentRequestId.current !== launchRequest?.requestId;
      if (preferredChanged) {
        // Wait for a non-empty settled list: otherwise an initial empty
        // subscription snapshot could permanently suppress preselection.
        if (agentsApi.agents.length === 0) {
          setSelectedAgentId(null);
          return;
        }
        hasAppliedPreferredAgent.current = true;
        appliedPreferredAgentRequestId.current = launchRequest?.requestId ?? null;
        appliedPreferredAgentId.current = preferredAgentId;
        setSelectedAgentId(validIds.has(preferredAgentId) ? preferredAgentId : null);
        return;
      }
      setSelectedAgentId((current) => (current !== null && validIds.has(current) ? current : null));
      return;
    }
    hasAppliedPreferredAgent.current = false;
    appliedPreferredAgentId.current = null;
    appliedPreferredAgentRequestId.current = null;
    if (agentsApi.agents.length === 0) {
      setSelectedAgentId(null);
    } else if (agentsApi.agents.length === 1) {
      setSelectedAgentId(agentsApi.agents[0].id);
    } else {
      setSelectedAgentId((current) => (current !== null && validIds.has(current) ? current : null));
    }
  }, [agentsApi.agents, agentsApi.agentsLoading, launchRequest?.requestId, preferredAgentId]);
  const scopeOptions = useMemo(() => scopeKeys.map((option) => ({ value: option.value, label: t(option.key) })), [t]);

  const activeWorkspaceName = scopeApi.workspace?.name ?? "";
  const activeWorkspaceStatus = scopeApi.workspace?.status ?? "";
  const projectCommentCount = commentsApi.projectComments?.commentCount ?? 0;
  // Files whose saved comments could not be re-anchored on their own. This is
  // the cross-file entry point: the re-anchor card lives in the inspector's
  // comment tab, so an issue of a file the user is not looking at would
  // otherwise be invisible. Each entry jumps to the file's first change block.
  const anchorIssueTargets = useMemo(() => {
    const files = snapshotApi.snapshot?.files ?? [];
    const targets: AnchorIssueTarget[] = [];
    for (const issue of snapshotApi.anchorIssues) {
      const candidatePath = issue.candidates.find((candidate) =>
        files.some((file) => file.path === candidate.filePath))?.filePath;
      const renamedPath = files.find((file) => file.oldPath === issue.filePath)?.path;
      const path = candidatePath ??
        (files.some((file) => file.path === issue.filePath) ? issue.filePath : undefined) ??
        renamedPath ??
        issue.filePath;
      if (targets.some((target) => target.path === path)) continue;
      targets.push({ path, hunkId: files.find((file) => file.path === path)?.hunks[0]?.id ?? null });
    }
    return targets;
  }, [snapshotApi.anchorIssues, snapshotApi.snapshot]);

  /**
   * Queue navigation: a completed comment of THIS workspace is locatable only
   * while its dispatch-time window still overlaps a change block of the
   * current snapshot. The map is rebuilt from the same reviews the block card
   * offers for acceptance, so the queue can link to that block without ever
   * accepting anything itself.
   */
  const queueJumpTargets = useMemo(() => {
    const targets = new Map<string, string>();
    const files = snapshotApi.snapshot?.files ?? [];
    for (const [filePath, reviews] of pendingCommentReviewsByFile) {
      const file = files.find((candidate) => candidate.path === filePath);
      if (!file) continue;
      for (const review of reviews) {
        const baselineEnd = review.baseline.oldStart + Math.max(review.baseline.oldCount, 1) - 1;
        const hunk = file.hunks.find((candidate) =>
          review.baseline.oldStart <= candidate.oldStart + Math.max(candidate.oldCount, 1) - 1 &&
          candidate.oldStart <= baselineEnd);
        if (hunk) targets.set(review.commentId, hunk.id);
      }
    }
    return targets;
  }, [pendingCommentReviewsByFile, snapshotApi.snapshot]);
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

  const firstAnchorHunkId = anchorIssueTargets.find((target) => target.hunkId !== null)?.hunkId ?? null;
  const narrowDesktop = panelMode === "narrow";
  const contextBar = (
    <ContextBar
      theme={theme}
      layout={panelLayout}
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
    />
  );
  const fileNavigator = snapshotApi.snapshot ? (
    <FileNavigator
      key="file-navigator"
      theme={theme}
      layout={panelLayout}
      t={t}
      styles={styles}
      snapshot={snapshotApi.snapshot}
      decisions={snapshotApi.decisions}
      fileCommentDrafts={actionsApi.fileCommentDrafts}
      selectedFile={snapshotApi.selectedFile}
      selected={snapshotApi.selected}
      onSelectHunk={selectHunk}
      onClose={() => setCompactFilesOpen(false)}
    />
  ) : null;

  const pendingCommentReviews = snapshotApi.selectedFile
    ? pendingCommentReviewsByFile.get(snapshotApi.selectedFile.path) ?? []
    : [];

  const fileDetail = (
    <FileDetail
      key="file-detail"
      theme={theme}
      layout={panelLayout}
      t={t}
      styles={styles}
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
      onExplainFile={explainFile}
      onRunAgentReview={runReviewForAgent}
      onRevertFile={() => void actionsApi.revertFileReview()}
      revertNotice={actionsApi.revertNotice}
      onMarkReviewed={() => void actionsApi.markReviewed()}
      onExplain={explainSelected}
      onReject={() => void actionsApi.rejectSelected()}
      agentsLoading={agentsApi.agentsLoading}
      selectedAgentId={selectedAgentId}
      onOpenMore={() => setMoreOpen(true)}
      aiExplainBusy={agentApi.aiExplainBusy}
      onExplainWithAgent={explainWithAgent}
      fileReviseFeedback={agentApi.fileReviseFeedback}
      commentBody={actionsApi.commentBody}
      onReviseFileFromComment={agentApi.reviseFileFromComment}
      agentReviewBusy={agentApi.agentReviewBusy}
      lineSelection={lineSelectionApi.state}
      onLinePress={selectLine}
      onLineTap={tapLine}
      onClearLineSelection={clearLineSelection}
      onCommentLineSelection={requestCommentOnSelection}
      pendingCommentReviews={pendingCommentReviews}
      acceptingCommentReviewId={actionsApi.acceptingCommentReviewId}
      onAcceptCommentReview={(review) => void actionsApi.acceptCommentReview(review)}
    />
  );

  const inspector = (
    <ReviewInspector
      theme={theme}
      layout={panelLayout}
      t={t}
      styles={styles}
      tab={inspectorTab}
      onTabChange={setInspectorTab}
      narrow={narrowDesktop}
      selected={snapshotApi.selected}
      selectedFile={snapshotApi.selectedFile}
      analysisStale={analysisStale}
      explanation={agentApi.explanation}
      aiExplanation={agentApi.aiExplanation}
      agentReview={agentApi.agentReview}
      agentSections={agentApi.agentSections}
      agentFindings={agentApi.agentReviewFindings}
      agentReviewMeta={agentApi.agentReviewMeta}
      showAiReviewUsage={showAiReviewUsage}
      onPromoteFinding={actionsApi.promoteFinding}
      capturedVerification={processVerificationApi}
      verificationRuns={verificationApi.runs}
      verificationEnabled={Boolean(snapshotApi.snapshot && !snapshotApi.loading && !snapshotApi.stale && !analysisStale)}
      onRunVerification={verificationApi.start}
      onRefreshVerification={verificationApi.refresh}
      onVerificationError={setActionError}
      lineSelection={lineSelectionApi.state}
      activeCommentDraft={actionsApi.activeCommentDraft}
      activeSavedComment={actionsApi.activeSavedComment}
      commentBody={actionsApi.commentBody}
      onCommentBodyChange={actionsApi.setCommentBody}
      commentSaving={actionsApi.commentSaving}
      commentNotice={actionsApi.commentNotice}
      commentAnchorHunk={actionsApi.commentAnchorHunk}
      commentAnchorHunkId={actionsApi.commentAnchorHunkId}
      commentAnchorIsCurrent={actionsApi.commentAnchorIsCurrent}
      commentAnchorMoveArmed={actionsApi.commentAnchorMoveArmed}
      onReturnToAnchor={selectHunk}
      onMoveAnchor={actionsApi.moveCommentAnchorToSelected}
      otherSavedComments={actionsApi.otherSavedComments}
      otherCommentsOpen={actionsApi.otherCommentsOpen}
      onToggleOtherComments={() => actionsApi.setOtherCommentsOpen((open) => !open)}
      onEditSavedComment={editSavedFileComment}
      onSaveComment={() => void actionsApi.saveComment()}
      agentsLoading={agentsApi.agentsLoading}
      selectedAgentId={selectedAgentId}
      agentFeedback={agentApi.agentFeedback}
      onReviseCurrentFromComment={agentApi.reviseCurrentFromComment}
      commentRequestNonce={commentRequestNonce}
      anchorIssues={snapshotApi.anchorIssues}
      reanchorBusyIssueId={actionsApi.reanchorBusyIssueId}
      reanchorNotice={actionsApi.reanchorNotice}
      onReanchorIssue={(issue, target, range) => void actionsApi.reanchorIssue(issue, target, range)}
      onSelectHunk={selectHunk}
      anchorIssueTargets={anchorIssueTargets}
    />
  );

  const statusStrips = (
    <>
      {snapshotApi.stale ? (
        <View style={styles.staleStrip}>
          <Text style={styles.staleStripText}>{t("staleBanner")}</Text>
        </View>
      ) : null}
      {anchorIssueTargets.length > 0 ? (
        <View style={styles.noticeStrip}>
          <Text style={styles.noticeStripText}>{t("anchorIssueWarning")}</Text>
          <Text style={styles.routeMeta}>{t("anchorIssuesSummary", { count: snapshotApi.anchorIssues.length })}</Text>
          {firstAnchorHunkId ? (
            <ActionButton
              variant="ghost"
              label={t("anchorIssueFileOpen")}
              tooltip={t("anchorIssueFileOpenHint")}
              onPress={() => {
                if (!firstAnchorHunkId) return;
                selectHunk(firstAnchorHunkId);
                setCompactFilesOpen(false);
              }}
              theme={theme}
              layout={panelLayout}
            />
          ) : null}
        </View>
      ) : null}
      {actionError ? (
        <View style={[styles.errorCard, styles.statusError]}>
          <Text style={styles.errorText}>{actionError}</Text>
        </View>
      ) : null}
    </>
  );

  const emptyContent = (
    <View style={styles.emptyState}>
      {snapshotApi.loading ? (
        <View style={styles.loadingTrack}>
          <View style={styles.loadingFill} />
        </View>
      ) : null}
      <Text style={styles.empty}>{snapshotApi.loading ? t("readingGitState") : scopeApi.reviewCwd ? t("noSnapshot") : t("selectWorkspaceToStart")}</Text>
    </View>
  );

  return (
    <>
      {compact ? (
        <ScrollView style={styles.root} contentContainerStyle={styles.content} stickyHeaderIndices={[0]} onLayout={handleShellLayout}>
          {contextBar}
          {statusStrips}
          {snapshotApi.snapshot
            ? compactFilesOpen
              ? fileNavigator
              : (
                <>
                  {fileDetail}
                  {inspector}
                </>
              )
            : emptyContent}
        </ScrollView>
      ) : (
        <View style={styles.shell} onLayout={handleShellLayout}>
          {contextBar}
          {statusStrips}
          {snapshotApi.snapshot ? (
            narrowDesktop ? (
              <View style={styles.workbenchNarrow}>
                <View style={styles.workbenchRow}>
                  {fileNavigator}
                  {fileDetail}
                </View>
                {inspector}
              </View>
            ) : (
              <View style={styles.workbenchRow}>
                {fileNavigator}
                {fileDetail}
                {inspector}
              </View>
            )
          ) : emptyContent}
        </View>
      )}

      <QueueModal
        theme={theme}
        layout={panelLayout}
        t={t}
        styles={styles}
        open={commentsApi.queueOpen}
        onClose={() => commentsApi.setQueueOpen(false)}
        projectComments={commentsApi.projectComments}
        projectCommentsLoading={commentsApi.projectCommentsLoading}
        projectCommentsError={commentsApi.projectCommentsError}
        onRefresh={() => void commentsApi.refreshProjectComments()}
        commentReviewsById={commentReviewsById}
        projectIdentity={scopeApi.projectIdentity}
        effectiveProjectId={scopeApi.effectiveProjectId}
        workspaceGroups={commentsApi.workspaceGroups}
        onSelectWorkspaceAgent={commentsApi.selectWorkspaceAgent}
        agentsLoading={agentsApi.agentsLoading}
        canProcessProject={commentsApi.canProcessProject}
        processingProject={commentsApi.processingProject}
        onProcess={() => void commentsApi.processProject()}
        onReleaseUnknownBatch={commentsApi.releaseUnknownBatch}
        processResult={commentsApi.processResult}
        processError={commentsApi.processError}
        projectNotice={commentsApi.projectNotice}
        currentWorkspaceId={scopeApi.selectedWorkspaceId}
        jumpTargetsByCommentId={queueJumpTargets}
        onJumpToComment={(commentId) => {
          const hunkId = queueJumpTargets.get(commentId);
          if (!hunkId) return;
          selectHunk(hunkId);
          setCompactFilesOpen(false);
          commentsApi.setQueueOpen(false);
        }}
      />

      <MoreModal
        theme={theme}
        layout={panelLayout}
        t={t}
        styles={styles}
        open={moreOpen}
        onClose={() => {
          commitPreviewUrl();
          setMoreOpen(false);
        }}
        scopeOptions={scopeOptions}
        scope={scopeApi.scope}
        agents={agentsApi.agents}
        agentsLoading={agentsApi.agentsLoading}
        selectedAgentId={selectedAgentId}
        onSelectAgent={setSelectedAgentId}
        onRunTargetReview={() => {
          if (selectedAgentId) runReviewForAgent(selectedAgentId);
        }}
        agentReviewBusy={agentApi.agentReviewBusy}
        defaultReviewPreset={defaultReviewPreset}
        reviewDepthOverride={reviewDepthOverride}
        onReviewDepthOverrideChange={setReviewDepthOverride}
        onScopeChange={scopeApi.setScope}
        filePath={scopeApi.filePath}
        onFilePathChange={scopeApi.setFilePath}
        baseRef={scopeApi.baseRef}
        onBaseRefChange={scopeApi.setBaseRef}
        headRef={scopeApi.headRef}
        onHeadRefChange={scopeApi.setHeadRef}
        loading={snapshotApi.loading}
        onRefresh={() => void snapshotApi.refresh()}
        previewUrl={previewUrlDraft}
        previewUrlSaveError={settings.status === "ready" ? settings.saveError : null}
        previewProjectAvailable={Boolean(previewProjectId)}
        browserPreviewAvailable={Boolean(navigation?.openBrowser && previewProjectId && scopeApi.selectedWorkspaceId && settings.status === "ready")}
        onPreviewUrlChange={updatePreviewUrlDraft}
        onPreviewUrlCommit={commitPreviewUrl}
        onOpenPreview={openPreview}
        selected={snapshotApi.selected}
        decisions={snapshotApi.decisions}
        snapshot={snapshotApi.snapshot}
        onClearCurrentHunk={() => void actionsApi.clearCurrentHunk()}
        onClearCurrentReview={() => void actionsApi.clearCurrentReview()}
        onManage={actionsApi.openManage}
      />

      <ManageModal
        theme={theme}
        layout={panelLayout}
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

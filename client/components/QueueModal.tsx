import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { ProcessProjectReviewResult, ProjectCommentReview, ProjectReviewComment, ProjectReviewSummary } from "../../shared/review";
import { anchorLocationText } from "../lineRange";
import {
  anchorStateBadgeKeys,
  anchorStateBadgeTextKeys,
  anchorStateLabelKeys,
  commentReviewOutcomeLabelKeys,
  scopeLabelKeys,
  type PanelLayout,
  type PanelTheme,
  type ProjectIdentity,
  type ProjectReviewWorkspaceGroup,
} from "../tools";
import type { TFunc } from "../i18n";
import type { PanelStyles } from "../styles";
import { ActionButton, DropdownSelect, HoverTooltip } from "./ui";
import { isAgentIdleForReviewDispatch } from "../agent-registry";
import { canSubmitProjectReviewGroup } from "../project-review-workspaces";

/**
 * The project dispatch desk. Workspace is the dispatch unit, so each queued
 * comment is read inside the workspace it will be sent to, and the same
 * workspace appears in the dispatch plan with its Agent and batch readiness.
 * Sending stays project-wide through the existing process action; the desk
 * never accepts, clears or partially selects comments. A completed comment
 * that the current panel can locate gets one navigation affordance back to
 * its change block, where the human acceptance still happens.
 */
export function QueueModal({
  theme,
  layout,
  t,
  styles,
  open,
  onClose,
  projectComments,
  projectCommentsLoading,
  projectCommentsError,
  onRefresh,
  commentReviewsById,
  projectIdentity,
  effectiveProjectId,
  workspaceGroups,
  onSelectWorkspaceAgent,
  agentsLoading,
  canProcessProject,
  processingProject,
  onProcess,
  onReleaseUnknownBatch,
  processResult,
  processError,
  projectNotice,
  currentWorkspaceId,
  jumpTargetsByCommentId,
  onJumpToComment,
}: {
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  styles: PanelStyles;
  open: boolean;
  onClose: () => void;
  projectComments: ProjectReviewSummary | null;
  projectCommentsLoading: boolean;
  projectCommentsError: string | null;
  onRefresh: () => void;
  commentReviewsById: ReadonlyMap<string, ProjectCommentReview>;
  projectIdentity: ProjectIdentity | null;
  effectiveProjectId: string;
  workspaceGroups: ProjectReviewWorkspaceGroup[];
  onSelectWorkspaceAgent: (groupKey: string, agentId: string) => void;
  agentsLoading: boolean;
  canProcessProject: boolean;
  processingProject: boolean;
  onProcess: () => void;
  onReleaseUnknownBatch: (input: { workspaceId: string; batchId: string }) => Promise<void>;
  processResult: ProcessProjectReviewResult[] | null;
  processError: string | null;
  projectNotice: string | null;
  /** The workspace this panel is bound to; only its comments can be located. */
  currentWorkspaceId: string;
  /** Comments of the current workspace whose block is in the current snapshot. */
  jumpTargetsByCommentId: ReadonlyMap<string, string>;
  onJumpToComment: (commentId: string) => void;
}) {
  const [confirmReleaseBatchId, setConfirmReleaseBatchId] = useState<string | null>(null);
  const [releasingBatchId, setReleasingBatchId] = useState<string | null>(null);
  const groupsWithPendingComments = workspaceGroups.filter((group) =>
    group.comments.length > 0 && !group.activeBatch,
  );
  const noEligibleWorkspaceAgent = groupsWithPendingComments.length > 0 &&
    groupsWithPendingComments.every((group) => group.eligibleAgents.length === 0);
  const needsWorkspaceAgentSelection = groupsWithPendingComments.some((group) =>
    group.eligibleAgents.length > 1 && !group.selectedAgentId,
  );
  const noIdleWorkspaceAgent = groupsWithPendingComments.length > 0 &&
    groupsWithPendingComments.every((group) => !group.eligibleAgents.some((agent) => isAgentIdleForReviewDispatch(agent.status)));
  const hasBusySelectedAgent = groupsWithPendingComments.some((group) => {
    const selected = group.eligibleAgents.find((agent) => agent.id === group.selectedAgentId);
    return selected !== undefined && !isAgentIdleForReviewDispatch(selected.status);
  });
  const agentLabel = (agent: ProjectReviewWorkspaceGroup["eligibleAgents"][number]) =>
    `${agent.title ?? agent.id} · ${agent.provider ?? "?"} / ${agent.model ?? t("noAgentModel")} · ${isAgentIdleForReviewDispatch(agent.status) ? t("agentIdle") : t("agentBusy")}`;
  const batchStatusMessage = (batch: ProcessProjectReviewResult): string => {
    const count = batch.commentIds.length;
    if (batch.status === "running") return t("reviewBatchRunning", { count });
    if (batch.status === "completed") return t("reviewBatchCompleted", { count });
    if (batch.status === "partial") {
      const counts = { completed: 0, stale: 0, failed: 0, unresolved: 0 };
      for (const outcome of Object.values(batch.outcomes)) counts[outcome]++;
      return t("reviewBatchPartial", counts);
    }
    if (batch.status === "failed") return t("reviewBatchFailed", { count });
    return t("reviewBatchSubmitted", { count });
  };
  const activeBatchStatusMessage = (batch: NonNullable<ProjectReviewWorkspaceGroup["activeBatch"]>): string => {
    const count = batch.commentIds.length;
    if (!batch.delivery) return t("reviewBatchLegacyDeliveryUnknown");
    if (batch.delivery.phase === "sending") return t("reviewBatchDeliverySending");
    if (batch.delivery.phase === "unknown") return t("reviewBatchDeliveryUnknown");
    if (batch.delivery.phase === "prepared") return t("reviewBatchDraft", { count });
    if (batch.delivery.phase === "rejected") return t("reviewBatchFailed", { count });
    if (batch.status === "running") return t("reviewBatchRunning", { count });
    return t("reviewBatchAcceptedWaiting");
  };
  const workspaceName = (group: ProjectReviewWorkspaceGroup): string => {
    const normalizedPath = group.cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    const directoryName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
    return directoryName || group.workspaceId || t("noWorkspaceDirectory");
  };
  const renderStateChip = (group: ProjectReviewWorkspaceGroup) => {
    const ready = canSubmitProjectReviewGroup(group);
    return (
      <View style={[styles.queueBadge, ready ? styles.queueStateReady : styles.queueStateBlocked]}>
        <Text style={[styles.queueBadgeText, ready ? styles.queueStateReadyText : styles.queueStateBlockedText]}>
          {ready ? t("queueWorkspaceReady") : t("queueWorkspaceBlocked")}
        </Text>
      </View>
    );
  };
  /** Why a workspace's comments cannot be dispatched right now, in one line.
   * The dispatch pane repeats it with the controls; the comment group states
   * it next to the comments so readiness is never a separate lookup. */
  const groupBlocker = (group: ProjectReviewWorkspaceGroup): string | null => {
    if (group.activeBatch) return activeBatchStatusMessage(group.activeBatch);
    if (!group.workspaceId) return t("queueUnresolvedWorkspace");
    if (group.eligibleAgents.length === 0) return t("processProjectNoWorkspaceAgentHint");
    const selected = group.eligibleAgents.find((agent) => agent.id === group.selectedAgentId);
    if (!selected) return group.eligibleAgents.length > 1 ? t("processProjectChooseWorkspaceAgentHint") : t("processProjectNoWorkspaceAgentHint");
    if (!isAgentIdleForReviewDispatch(selected.status)) return t("agentBusyDispatchHint");
    return null;
  };
  const renderComment = (comment: ProjectReviewComment) => {
    const review = commentReviewsById.get(comment.id);
    const reviewText = review === undefined
      ? null
      : review.acceptedAt !== undefined
        ? t("commentReviewAccepted", { acceptedAt: review.acceptedAt })
        : review.outcome === "completed" && review.baseline === null
          ? t("commentReviewAwaitingRedispatch")
          : review.outcome !== undefined
            ? t(commentReviewOutcomeLabelKeys[review.outcome])
            : t("commentReviewInFlight");
    const jumpable = jumpTargetsByCommentId.has(comment.id);
    return (
      <View key={comment.id} style={styles.queueComment}>
        <Text selectable numberOfLines={5} style={styles.body}>{comment.comment}</Text>
        <View style={styles.savedMetaRow}>
          <Text style={styles.routeMeta}>
            {t(comment.findingSource === "deterministic_rule" ? "findingSourceRule" : comment.findingSource === "ai_review" ? "findingSourceAi" : "findingSourceHuman")}
          </Text>
          <Text style={styles.routeMeta}>{t("queueScopeChip", { scope: t(scopeLabelKeys[comment.scope]) })}</Text>
          {comment.anchor ? (
            <Text selectable numberOfLines={1} ellipsizeMode="middle" style={styles.anchorMeta}>
              {anchorLocationText(t, comment.anchor, comment.hunkHeader)}
            </Text>
          ) : null}
          {comment.anchorState ? (
            <View style={[styles.anchorStateBadge, styles[anchorStateBadgeKeys[comment.anchorState]]]}>
              <Text style={[styles.anchorStateBadgeText, styles[anchorStateBadgeTextKeys[comment.anchorState]]]}>
                {t(anchorStateLabelKeys[comment.anchorState])}
              </Text>
            </View>
          ) : null}
          {reviewText ? (
            <Text style={review?.acceptedAt !== undefined || review?.outcome === "completed"
              ? styles.commentReviewAwaitingText
              : styles.routeMeta}>
              {reviewText}
            </Text>
          ) : null}
          <Text style={styles.routeMeta}>{t("projectCommentSavedAt", { savedAt: comment.savedAt })}</Text>
        </View>
        {jumpable ? (
          <View style={styles.actionRow}>
            <ActionButton
              variant="ghost"
              label={t("queueJumpToBlock")}
              tooltip={t("queueJumpToBlockHint")}
              onPress={() => onJumpToComment(comment.id)}
              theme={theme}
              layout={layout}
            />
          </View>
        ) : null}
      </View>
    );
  };
  const renderCommentGroups = (group: ProjectReviewWorkspaceGroup) => {
    const files = new Map<string, ProjectReviewComment[]>();
    for (const comment of group.comments) {
      const list = files.get(comment.filePath) ?? [];
      list.push(comment);
      files.set(comment.filePath, list);
    }
    return Array.from(files, ([filePath, comments]) => (
      <View key={filePath} style={styles.queueFileBlock}>
        <View style={styles.fileRowTop}>
          <Text selectable numberOfLines={2} ellipsizeMode="middle" style={styles.filePath}>{filePath}</Text>
          <Text style={styles.fileMeta}>{t("projectFileComments", { count: comments.length })}</Text>
        </View>
        {comments.map(renderComment)}
      </View>
    ));
  };
  const commentsPane = (
    <>
      <Text style={styles.queuePanesLabel}>{t("queueCommentsPaneTitle")}</Text>
      {projectCommentsLoading ? (
        <Text style={styles.muted}>{t("projectCommentsLoading")}</Text>
      ) : projectCommentsError ? (
        <View style={styles.errorCard}><Text style={styles.errorText}>{projectCommentsError}</Text></View>
      ) : !projectComments || projectComments.commentCount === 0 ? (
        <Text style={styles.muted}>{t("projectCommentsEmpty")}</Text>
      ) : (
        <>
          <Text style={styles.routeMeta}>{t("queueFileGroupHint")}</Text>
          {workspaceGroups.filter((group) => group.comments.length > 0).map((group) => {
            const blocker = groupBlocker(group);
            const selectedAgent = group.eligibleAgents.find((agent) => agent.id === group.selectedAgentId);
            return (
              <View key={group.key} style={styles.queueWorkspaceCard}>
                <View style={styles.queueWorkspaceHeader}>
                  <Text selectable numberOfLines={1} ellipsizeMode="middle" style={styles.queueWorkspaceName}>
                    {workspaceName(group)}
                  </Text>
                  {group.workspaceId && group.workspaceId === currentWorkspaceId ? (
                    <View style={styles.queueBadge}>
                      <Text style={styles.queueBadgeText}>{t("queueCurrentWorkspace")}</Text>
                    </View>
                  ) : null}
                  {renderStateChip(group)}
                  <Text style={styles.routeMeta}>{t("queueCommentsCount", { count: group.comments.length })}</Text>
                </View>
                {selectedAgent ? (
                  <Text numberOfLines={1} style={styles.routeMeta}>
                    {t("projectAgentSelected", { agent: selectedAgent.title ?? selectedAgent.id })}
                  </Text>
                ) : null}
                {blocker ? <Text style={styles.scopeDesc}>{blocker}</Text> : null}
                {renderCommentGroups(group)}
              </View>
            );
          })}
        </>
      )}
    </>
  );
  const planPane = (
    <>
      <Text style={styles.queuePanesLabel}>{t("queueDispatchPaneTitle")}</Text>
      {agentsLoading ? <Text style={styles.muted}>{t("agentsLoading")}</Text> : null}
      {projectCommentsLoading && workspaceGroups.length === 0 ? (
        <Text style={styles.muted}>{t("projectCommentsLoading")}</Text>
      ) : null}
      {!projectCommentsLoading && projectComments !== null && workspaceGroups.length === 0 ? (
        <Text style={styles.muted}>{t("queuePlanEmpty")}</Text>
      ) : null}
      {workspaceGroups.map((group) => {
        const options = group.eligibleAgents.map((agent) => ({
          value: agent.id,
          label: agentLabel(agent),
        }));
        const selectedAgent = group.eligibleAgents.find((agent) => agent.id === group.selectedAgentId);
        const hasIdleAgent = group.eligibleAgents.some((agent) => isAgentIdleForReviewDispatch(agent.status));
        const activeBatch = group.activeBatch;
        const workspaceId = group.workspaceId;
        const ambiguousDelivery = activeBatch !== null && (
          !activeBatch.delivery ||
          activeBatch.delivery.phase === "sending" ||
          activeBatch.delivery.phase === "unknown" ||
          activeBatch.delivery.phase === "accepted"
        );
        const confirmingRelease = activeBatch?.id === confirmReleaseBatchId;
        const releasing = activeBatch?.id === releasingBatchId;
        return (
          <View key={group.key} style={styles.queuePlanCard}>
            <View style={styles.queueWorkspaceHeader}>
              <Text selectable numberOfLines={1} ellipsizeMode="middle" style={styles.queueWorkspaceName}>
                {workspaceName(group)}
              </Text>
              {renderStateChip(group)}
            </View>
            <Text selectable numberOfLines={1} ellipsizeMode="middle" style={styles.routeMeta}>{group.cwd}</Text>
            <Text style={styles.routeMeta}>{t("projectWorkspaceCommentCount", { count: group.comments.length })}</Text>
            {activeBatch ? (
              <View style={styles.group}>
                <Text style={styles.muted}>{activeBatchStatusMessage(activeBatch)}</Text>
                {ambiguousDelivery && workspaceId ? (
                  <View style={styles.group}>
                    <Text style={styles.scopeDesc}>{t("reviewBatchDuplicateRiskHint")}</Text>
                    <ActionButton
                      variant={confirmingRelease ? "danger" : "secondary"}
                      disabled={processingProject || releasing}
                      label={releasing
                        ? t("reviewBatchReleasingClaim")
                        : confirmingRelease
                          ? t("reviewBatchConfirmReleaseClaim")
                          : t("reviewBatchReleaseClaim")}
                      tooltip={t("reviewBatchDuplicateRiskHint")}
                      onPress={() => {
                        if (!activeBatch || releasing) return;
                        if (!confirmingRelease) {
                          setConfirmReleaseBatchId(activeBatch.id);
                          return;
                        }
                        setConfirmReleaseBatchId(null);
                        setReleasingBatchId(activeBatch.id);
                        void onReleaseUnknownBatch({ batchId: activeBatch.id, workspaceId })
                          .finally(() => setReleasingBatchId(null));
                      }}
                      theme={theme}
                      layout={layout}
                    />
                    {confirmingRelease ? (
                      <ActionButton
                        variant="ghost"
                        label={t("reviewBatchCancelRelease")}
                        onPress={() => setConfirmReleaseBatchId(null)}
                        theme={theme}
                        layout={layout}
                      />
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : group.eligibleAgents.length === 0 ? (
              <Text style={styles.muted}>
                {group.workspaceId ? t("processProjectNoWorkspaceAgentHint") : t("queueUnresolvedWorkspace")}
              </Text>
            ) : group.eligibleAgents.length === 1 ? (
              <Text style={styles.routeMeta}>
                {t("projectAgentSelected", { agent: agentLabel(selectedAgent ?? group.eligibleAgents[0]!) })}
              </Text>
            ) : (
              <DropdownSelect
                label={t("projectAgentPlaceholder")}
                value={group.selectedAgentId}
                options={options}
                onChange={(agentId) => onSelectWorkspaceAgent(group.key, agentId)}
                placeholder={t("projectAgentPlaceholder")}
                closeLabel={t("closeDropdown")}
                triggerHint={t("projectAgentSelectHint")}
                closeHint={t("closeHint")}
                theme={theme}
                layout={layout}
              />
            )}
            {group.eligibleAgents.length > 0 &&
            (!hasIdleAgent || (selectedAgent && !isAgentIdleForReviewDispatch(selectedAgent.status))) ? (
              <Text style={styles.scopeDesc}>{t("agentBusyDispatchHint")}</Text>
            ) : null}
          </View>
        );
      })}
      {processResult && processResult.length > 0 ? (
        <View style={styles.analysisBlock}>
          <Text style={styles.inspectorSectionTitle}>{t("processResultTitle")}</Text>
          {processResult.map((batch) => {
            const group = workspaceGroups.find((candidate) => candidate.workspaceId === batch.workspaceId);
            const agent = group?.eligibleAgents.find((candidate) => candidate.id === batch.agentId);
            return (
              <View key={batch.id} style={styles.group}>
                <Text style={styles.routeMeta}>{t("processResultCommentsSent", { count: batch.commentIds.length })}</Text>
                <Text selectable numberOfLines={2} ellipsizeMode="middle" style={styles.routeMeta}>
                  {t("processResultAgent", { agent: agent ? agentLabel(agent) : batch.agentId })}
                </Text>
                <Text selectable numberOfLines={2} ellipsizeMode="middle" style={styles.routeMeta}>
                  {t("executionWorkspaceLine", { name: batch.workspaceId, cwd: group?.cwd ?? "" })}
                </Text>
                <Text style={styles.scopeDesc}>{batchStatusMessage(batch)}</Text>
              </View>
            );
          })}
          <Text selectable style={styles.scopeDesc}>{t("processResultConversationNote")}</Text>
        </View>
      ) : null}
    </>
  );
  const projectIdentityLine = projectIdentity?.displayName ?? effectiveProjectId ?? t("noProjectSelected");
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.queueDeskBackdrop} onPress={onClose}>
        <Pressable onPress={(event) => event.stopPropagation()} style={styles.queueDesk}>
          <View style={styles.queueDeskHeader}>
            <View style={styles.queueDeskIdentity}>
              <Text style={styles.modalTitle}>{t("projectCommentsTitle")}</Text>
              <Text numberOfLines={1} ellipsizeMode="middle" style={styles.routeMeta}>
                {projectComments
                  ? t("projectCommentsSummary", {
                    comments: projectComments.commentCount,
                    files: projectComments.fileCount,
                    targets: projectComments.targetCount,
                  })
                  : t("projectCommentsLoading")}
              </Text>
              <Text numberOfLines={1} ellipsizeMode="middle" style={styles.routeMeta}>{projectIdentityLine}</Text>
            </View>
            <ActionButton
              variant="ghost"
              label={t("projectCommentsRefresh")}
              tooltip={t("projectCommentsRefreshHint")}
              onPress={onRefresh}
              theme={theme}
              layout={layout}
            />
            <HoverTooltip text={t("closeHint")} theme={theme} layout={layout}>
              <Pressable accessibilityRole="button" onPress={onClose} style={styles.topButton}>
                <Text style={styles.topButtonText}>{t("close")}</Text>
              </Pressable>
            </HoverTooltip>
          </View>
          {layout.compact ? (
            <ScrollView style={styles.queueDeskBody} contentContainerStyle={styles.queuePaneContent} nestedScrollEnabled showsVerticalScrollIndicator>
              {commentsPane}
              <View style={styles.queuePlanSeparator} />
              {planPane}
            </ScrollView>
          ) : (
            <View style={styles.queueDeskBody}>
              <ScrollView style={styles.queueCommentsPane} contentContainerStyle={styles.queuePaneContent} nestedScrollEnabled showsVerticalScrollIndicator>
                {commentsPane}
              </ScrollView>
              <ScrollView style={styles.queuePlanPane} contentContainerStyle={styles.queuePaneContent} nestedScrollEnabled showsVerticalScrollIndicator>
                {planPane}
              </ScrollView>
            </View>
          )}
          <View style={styles.queueFooter}>
            <View style={styles.queueFooterStatus}>
              {processError ? <Text style={styles.errorText}>{processError}</Text> : null}
              {projectNotice ? <Text style={styles.feedbackSent}>✓ {projectNotice}</Text> : null}
              {processingProject ? (
                <Text style={styles.muted}>{t("processingProjectHint", { count: projectComments?.commentCount ?? 0 })}</Text>
              ) : null}
              {!projectComments || projectComments.commentCount === 0 ? (
                <Text style={styles.scopeDesc}>{t("processProjectNoCommentsHint")}</Text>
              ) : noEligibleWorkspaceAgent ? (
                <Text style={styles.scopeDesc}>{t("processProjectNoAgentHint")}</Text>
              ) : needsWorkspaceAgentSelection ? (
                <Text style={styles.scopeDesc}>{t("processProjectChooseWorkspaceAgentHint")}</Text>
              ) : !canProcessProject && (noIdleWorkspaceAgent || hasBusySelectedAgent) ? (
                <Text style={styles.scopeDesc}>{t("agentBusyDispatchHint")}</Text>
              ) : null}
              <Text style={styles.scopeDesc}>{t("queueNextRun")}</Text>
            </View>
            <View style={styles.queueFooterAction}>
              <ActionButton
                variant="primary"
                stretch
                disabled={!canProcessProject}
                label={processingProject ? t("processingProject") : t("processProjectLabel")}
                tooltip={
                  processingProject
                    ? t("processingProjectHint", { count: projectComments?.commentCount ?? 0 })
                    : agentsLoading
                      ? t("agentsLoading")
                      : !projectComments || projectComments.commentCount === 0
                        ? t("processProjectNoCommentsHint")
                        : noEligibleWorkspaceAgent
                          ? t("processProjectNoAgentHint")
                          : needsWorkspaceAgentSelection
                            ? t("processProjectChooseWorkspaceAgentHint")
                            : !canProcessProject && (noIdleWorkspaceAgent || hasBusySelectedAgent)
                              ? t("agentBusyDispatchHint")
                              : t("processProjectHint")
                }
                onPress={onProcess}
                theme={theme}
                layout={layout}
              />
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

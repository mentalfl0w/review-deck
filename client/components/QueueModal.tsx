import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { ProcessProjectReviewResult, ProjectReviewSummary } from "../../shared/review";
import { anchorLocationText } from "../lineRange";
import {
  anchorStateBadgeKeys,
  anchorStateBadgeTextKeys,
  anchorStateLabelKeys,
  scopeLabelKeys,
  type PanelLayout,
  type PanelTheme,
  type ProjectCommentsByTarget,
  type ProjectIdentity,
  type ProjectReviewWorkspaceGroup,
} from "../tools";
import type { TFunc } from "../i18n";
import type { PanelStyles } from "../styles";
import { ActionButton, DropdownSelect, HoverTooltip } from "./ui";

/** Project queue with per-workspace Agent selection and batch status. */
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
  commentsByTarget,
  projectIdentity,
  effectiveProjectId,
  workspaceGroups,
  onSelectWorkspaceAgent,
  agentsLoading,
  canProcessProject,
  processingProject,
  onProcess,
  processResult,
  processError,
  projectNotice,
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
  commentsByTarget: ProjectCommentsByTarget;
  projectIdentity: ProjectIdentity | null;
  effectiveProjectId: string;
  workspaceGroups: ProjectReviewWorkspaceGroup[];
  onSelectWorkspaceAgent: (groupKey: string, agentId: string) => void;
  agentsLoading: boolean;
  canProcessProject: boolean;
  processingProject: boolean;
  onProcess: () => void;
  processResult: ProcessProjectReviewResult[] | null;
  processError: string | null;
  projectNotice: string | null;
}) {
  const groupsWithPendingComments = workspaceGroups.filter((group) =>
    group.comments.length > 0 && !group.activeBatch,
  );
  const noEligibleWorkspaceAgent = groupsWithPendingComments.length > 0 &&
    groupsWithPendingComments.every((group) => group.eligibleAgents.length === 0);
  const needsWorkspaceAgentSelection = groupsWithPendingComments.some((group) =>
    group.eligibleAgents.length > 1 && !group.selectedAgentId,
  );
  const agentLabel = (agent: ProjectReviewWorkspaceGroup["eligibleAgents"][number]) =>
    `${agent.title ?? agent.id} · ${agent.provider ?? "?"} / ${agent.model ?? t("noAgentModel")}`;
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
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.drawerBackdrop} onPress={onClose}>
        <Pressable onPress={(event) => event.stopPropagation()} style={styles.drawer}>
          <View style={styles.modalHeader}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.modalTitle}>{t("projectCommentsTitle")}</Text>
              <Text style={styles.routeMeta}>
                {projectComments
                  ? t("projectCommentsSummary", {
                    comments: projectComments.commentCount,
                    files: projectComments.fileCount,
                    targets: projectComments.targetCount,
                  })
                  : t("projectCommentsLoading")}
              </Text>
            </View>
            <HoverTooltip text={t("closeHint")} theme={theme} layout={layout}>
              <Pressable accessibilityRole="button" onPress={onClose} style={styles.topButton}>
                <Text style={styles.topButtonText}>{t("close")}</Text>
              </Pressable>
            </HoverTooltip>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            <View style={styles.queueIdentity}>
              <Text selectable numberOfLines={1} style={styles.sectionTitle}>
                {projectIdentity?.displayName ?? effectiveProjectId ?? t("noProjectSelected")}
              </Text>
              {projectIdentity?.rootPath ? (
                <Text selectable numberOfLines={1} ellipsizeMode="middle" style={styles.routeMeta}>{projectIdentity.rootPath}</Text>
              ) : null}
            </View>
            <ActionButton
              variant="ghost"
              label={t("projectCommentsRefresh")}
              tooltip={t("projectCommentsRefreshHint")}
              onPress={onRefresh}
              theme={theme}
              layout={layout}
            />

            {projectCommentsLoading ? (
              <Text style={styles.muted}>{t("projectCommentsLoading")}</Text>
            ) : projectCommentsError ? (
              <View style={styles.errorCard}><Text style={styles.errorText}>{projectCommentsError}</Text></View>
            ) : !projectComments || projectComments.comments.length === 0 ? (
              <Text style={styles.muted}>{t("projectCommentsEmpty")}</Text>
            ) : (
              <View style={styles.group}>
                {commentsByTarget.map((target) => (
                  <View
                    key={`${target.cwd}\u0000${target.scope}\u0000${target.targetFingerprint}`}
                    style={styles.queueGroup}
                  >
                    <Text selectable numberOfLines={2} ellipsizeMode="middle" style={styles.routeFile}>
                      {t("queueGroupMeta", { cwd: target.cwd, scope: t(scopeLabelKeys[target.scope]) })}
                    </Text>
                    <Text selectable numberOfLines={1} style={styles.routeMeta}>{target.targetFingerprint.slice(0, 10)}</Text>
                    <View style={styles.group}>
                      {target.files.map((file) => (
                        <View key={file.filePath} style={styles.queueFile}>
                          <View style={styles.fileRowTop}>
                            <Text selectable numberOfLines={2} ellipsizeMode="middle" style={styles.filePath}>{file.filePath}</Text>
                            <Text style={styles.fileMeta}>{t("projectFileComments", { count: file.comments.length })}</Text>
                          </View>
                          {file.comments.map((comment) => (
                            <View key={comment.id} style={styles.queueComment}>
                              <Text selectable numberOfLines={4} style={styles.body}>{comment.comment}</Text>
                              <View style={styles.savedMetaRow}>
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
                                <Text style={styles.routeMeta}>{t("projectCommentSavedAt", { savedAt: comment.savedAt })}</Text>
                              </View>
                            </View>
                          ))}
                        </View>
                      ))}
                    </View>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.modalSection}>
              <Text style={styles.sectionTitle}>{t("projectWorkspacesTitle")}</Text>
              {agentsLoading ? <Text style={styles.muted}>{t("agentsLoading")}</Text> : null}
              {workspaceGroups.map((group) => {
                const options = group.eligibleAgents.map((agent) => ({
                  value: agent.id,
                  label: agentLabel(agent),
                }));
                const selectedAgent = group.eligibleAgents.find((agent) => agent.id === group.selectedAgentId);
                return (
                  <View key={group.key} style={styles.queueGroup}>
                    <Text selectable numberOfLines={2} ellipsizeMode="middle" style={styles.routeFile}>
                      {t("executionWorkspaceLine", {
                        name: group.workspaceId ?? t("noWorkspaceDirectory"),
                        cwd: group.cwd,
                      })}
                    </Text>
                    <Text style={styles.routeMeta}>
                      {t("projectWorkspaceCommentCount", { count: group.comments.length })}
                    </Text>
                    {group.activeBatch ? (
                      <Text style={styles.muted}>
                        {t(
                          group.activeBatch.status === "draft"
                            ? "reviewBatchDraft"
                            : group.activeBatch.status === "running"
                              ? "reviewBatchRunning"
                              : "reviewBatchSubmitted",
                          { count: group.activeBatch.commentIds.length },
                        )}
                      </Text>
                    ) : group.eligibleAgents.length === 0 ? (
                      <Text style={styles.muted}>{t("processProjectNoWorkspaceAgentHint")}</Text>
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
                  </View>
                );
              })}
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
                            : t("processProjectHint")
                }
                onPress={onProcess}
                theme={theme}
                layout={layout}
              />
              {!projectComments || projectComments.commentCount === 0 ? (
                <Text style={styles.scopeDesc}>{t("processProjectNoCommentsHint")}</Text>
              ) : noEligibleWorkspaceAgent ? (
                <Text style={styles.scopeDesc}>{t("processProjectNoAgentHint")}</Text>
              ) : needsWorkspaceAgentSelection ? (
                <Text style={styles.scopeDesc}>{t("processProjectChooseWorkspaceAgentHint")}</Text>
              ) : null}
              {processingProject ? (
                <Text style={styles.muted}>{t("processingProjectHint", { count: projectComments?.commentCount ?? 0 })}</Text>
              ) : null}
              <Text style={styles.scopeDesc}>{t("queueNextRun")}</Text>
            </View>

            {processError ? <View style={styles.errorCard}><Text style={styles.errorText}>{processError}</Text></View> : null}
            {projectNotice ? <Text style={styles.feedbackSent}>✓ {projectNotice}</Text> : null}
            {processResult && processResult.length > 0 ? (
              <View style={styles.analysisBlock}>
                <Text style={styles.sectionTitle}>{t("processResultTitle")}</Text>
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
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { ProcessProjectReviewResult, ProjectReviewSummary } from "../../review.shared";
import {
  scopeLabelKeys,
  type PanelLayout,
  type PanelTheme,
  type ProjectCommentsByTarget,
  type ProjectIdentity,
} from "../tools.client";
import type { TFunc } from "../i18n.client";
import type { PanelStyles } from "../styles.client";
import { ActionButton, DropdownSelect, HoverTooltip } from "./ui.client";

/** Drawer with the project's saved comments, the processing agent picker and
 * the batch submit action: comments are handed to the selected agent's
 * workflow (results appear in the agent's conversation) and removed from
 * Review Deck. */
export function QueueModal({ theme, layout, t, styles, open, onClose, projectComments, projectCommentsLoading, projectCommentsError, onRefresh, commentsByTarget, projectIdentity, effectiveProjectId, activeWorkspaceName, reviewCwd, projectAgentOptions, selectedProcessAgent, onSelectProcessAgent, projectAgentCount, agentsLoading, canProcessProject, processingProject, onProcess, processResult, processError, projectNotice }: {
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
  activeWorkspaceName: string;
  reviewCwd: string | null;
  projectAgentOptions: ReadonlyArray<{ value: string; label: string }>;
  selectedProcessAgent: string;
  onSelectProcessAgent: (agentId: string) => void;
  projectAgentCount: number;
  agentsLoading: boolean;
  canProcessProject: boolean;
  processingProject: boolean;
  onProcess: () => void;
  processResult: ProcessProjectReviewResult | null;
  processError: string | null;
  projectNotice: string | null;
}) {
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
                              <Text style={styles.routeMeta}>{t("projectCommentSavedAt", { savedAt: comment.savedAt })}</Text>
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
              <Text style={styles.sectionTitle}>{t("projectAgentLabel")}</Text>
              <Text selectable numberOfLines={2} ellipsizeMode="middle" style={styles.routeMeta}>
                {t("executionWorkspaceLine", { name: activeWorkspaceName || t("noWorkspaceDirectory"), cwd: reviewCwd ?? "" })}
              </Text>
              {projectAgentCount > 0 ? (
                <DropdownSelect
                  label={t("projectAgentPlaceholder")}
                  value={selectedProcessAgent}
                  options={projectAgentOptions}
                  onChange={onSelectProcessAgent}
                  placeholder={t("projectAgentPlaceholder")}
                  closeLabel={t("closeDropdown")}
                  triggerHint={t("projectAgentSelectHint")}
                  closeHint={t("closeHint")}
                  theme={theme}
                  layout={layout}
                />
              ) : agentsLoading ? <Text style={styles.muted}>{t("agentsLoading")}</Text> : <Text style={styles.muted}>{t("processProjectNoAgentHint")}</Text>}
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
                        : projectAgentCount === 0
                          ? t("processProjectNoAgentHint")
                          : t("processProjectHint")
                }
                onPress={onProcess}
                theme={theme}
                layout={layout}
              />
              {!projectComments || projectComments.commentCount === 0 ? (
                <Text style={styles.scopeDesc}>{t("processProjectNoCommentsHint")}</Text>
              ) : projectAgentCount === 0 && !agentsLoading ? (
                <Text style={styles.scopeDesc}>{t("processProjectNoAgentHint")}</Text>
              ) : null}
              {processingProject ? (
                <Text style={styles.muted}>{t("processingProjectHint", { count: projectComments?.commentCount ?? 0 })}</Text>
              ) : null}
              <Text style={styles.scopeDesc}>{t("queueNextRun")}</Text>
            </View>

            {processError ? <View style={styles.errorCard}><Text style={styles.errorText}>{processError}</Text></View> : null}
            {projectNotice ? <Text style={styles.feedbackSent}>✓ {projectNotice}</Text> : null}
            {processResult ? (
              <View style={styles.analysisBlock}>
                <Text style={styles.sectionTitle}>{t("processResultTitle")}</Text>
                <Text style={styles.routeMeta}>{t("processResultCommentsSent", { count: processResult.commentCount })}</Text>
                <Text selectable numberOfLines={2} ellipsizeMode="middle" style={styles.routeMeta}>
                  {t("processResultAgent", {
                    agent: projectAgentOptions.find((option) => option.value === selectedProcessAgent)?.label ?? selectedProcessAgent,
                  })}
                </Text>
                <Text selectable numberOfLines={2} ellipsizeMode="middle" style={styles.routeMeta}>
                  {t("executionWorkspaceLine", { name: activeWorkspaceName || t("noWorkspaceDirectory"), cwd: processResult.workspaceCwd })}
                </Text>
                <Text selectable style={styles.scopeDesc}>{t("processResultConversationNote")}</Text>
              </View>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

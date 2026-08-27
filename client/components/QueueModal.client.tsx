import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { ProcessProjectReviewResult, ProjectReviewSummary } from "../../review.shared";
import {
  outcomeStatusKeys,
  scopeLabelKeys,
  type PanelLayout,
  type PanelTheme,
  type ProjectCommentsByTarget,
  type ProjectIdentity,
} from "../tools.client";
import type { TFunc } from "../i18n.client";
import type { PanelStyles } from "../styles.client";
import { ActionButton, DropdownSelect, StringGroup } from "./ui.client";

/** Drawer with the project's saved comments, the processing agent picker, the
 * batch process action and the per-comment result/cleanup flow. */
export function QueueModal({ theme, layout, t, styles, open, onClose, projectComments, projectCommentsLoading, projectCommentsError, onRefresh, commentsByTarget, projectIdentity, effectiveProjectId, activeWorkspaceName, reviewCwd, projectAgentOptions, selectedProcessAgent, onSelectProcessAgent, projectAgentCount, canProcessProject, processingProject, onProcess, processResult, canDeleteProcessed, deletingProcessed, onDelete, processError, projectNotice }: {
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
  canProcessProject: boolean;
  processingProject: boolean;
  onProcess: () => void;
  processResult: ProcessProjectReviewResult | null;
  canDeleteProcessed: boolean;
  deletingProcessed: boolean;
  onDelete: () => void;
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
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.topButton}>
              <Text style={styles.topButtonText}>{t("close")}</Text>
            </Pressable>
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
                  theme={theme}
                  layout={layout}
                />
              ) : <Text style={styles.muted}>{t("processProjectNoAgentHint")}</Text>}
              <ActionButton
                variant="primary"
                stretch
                disabled={!canProcessProject}
                label={processingProject ? t("processingProject") : t("processProjectLabel")}
                onPress={onProcess}
                theme={theme}
                layout={layout}
              />
              {!projectComments || projectComments.commentCount === 0 ? (
                <Text style={styles.scopeDesc}>{t("processProjectNoCommentsHint")}</Text>
              ) : projectAgentCount === 0 ? (
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
                {processResult.status !== "idle" ? (
                  <View style={styles.errorCard}>
                    <Text style={styles.errorText}>{t("processResultStatusBad", { status: processResult.status })}</Text>
                  </View>
                ) : null}
                <Text style={styles.routeMeta}>
                  {t("processResultProviderModel", { provider: processResult.provider, model: processResult.model })}
                </Text>
                <Text selectable numberOfLines={2} ellipsizeMode="middle" style={styles.routeMeta}>
                  {t("executionWorkspaceLine", { name: activeWorkspaceName || t("noWorkspaceDirectory"), cwd: processResult.workspaceCwd })}
                </Text>
                <Text selectable style={styles.routeMeta}>{t("executionWorkspaceId", { id: processResult.workspaceId })}</Text>
                <Text style={styles.routeMeta}>{t("processResultCommentsSent", { count: processResult.commentCount })}</Text>
                {processResult.commentOutcomes.length > 0 ? (
                  <View style={styles.analysisBlock}>
                    <Text style={styles.label}>{t("processResultOutcomesTitle")}</Text>
                    <Text style={styles.routeMeta}>
                      {t("processResultOutcomeSummary", {
                        completed: processResult.commentOutcomes.filter((outcome) => outcome.status === "completed").length,
                        pending: processResult.commentOutcomes.filter((outcome) => outcome.status !== "completed").length,
                      })}
                    </Text>
                    {processResult.commentOutcomes.map((outcome) => {
                      const completed = outcome.status === "completed";
                      const symbol = completed ? "✓" : outcome.status === "stale" ? "!" : "—";
                      return (
                        <View key={outcome.id} style={styles.queueOutcome}>
                          <Text selectable numberOfLines={2} style={completed ? styles.statusText : styles.errorText}>
                            {symbol} {t("processResultOutcomeLine", {
                              id: outcome.id,
                              status: t(outcomeStatusKeys[outcome.status] ?? "processResultOutcomeUnknown"),
                            })}
                          </Text>
                          {outcome.detail ? <Text selectable style={styles.body}>{outcome.detail}</Text> : null}
                        </View>
                      );
                    })}
                  </View>
                ) : null}
                {processResult.sections.verifiedFacts.length > 0 ||
                processResult.sections.aiInference.length > 0 ||
                processResult.sections.humanVerificationRecommended.length > 0 ? (
                  <>
                    <StringGroup label={t("findingsVerified")} items={processResult.sections.verifiedFacts} t={t} styles={styles} />
                    <StringGroup label={t("findingsInference")} items={processResult.sections.aiInference} t={t} styles={styles} />
                    <StringGroup label={t("findingsHuman")} items={processResult.sections.humanVerificationRecommended} t={t} styles={styles} />
                  </>
                ) : <Text selectable style={styles.rawReview}>{processResult.review}</Text>}
                {canDeleteProcessed ? (
                  <ActionButton
                    variant="danger"
                    disabled={deletingProcessed}
                    label={deletingProcessed ? t("deletingProcessed") : t("deleteProcessedLabel")}
                    hint={t("deleteProcessedHint", { count: processResult.completedCommentIds.length })}
                    onPress={onDelete}
                    theme={theme}
                    layout={layout}
                  />
                ) : null}
              </View>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

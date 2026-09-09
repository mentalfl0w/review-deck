import { ScrollView, Text, TextInput, View } from "react-native";
import { hunkHeaderParts } from "../diffView";
import type { AgentFeedbackMap, FileCommentDraft, FileCommentEntry, PanelLayout, PanelTheme, SelectedHunk } from "../tools";
import type { TFunc } from "../i18n";
import type { PanelStyles } from "../styles";
import { ActionButton } from "./ui";

/** The file-comment dock: saved comment, editor, anchor bookkeeping, other
 * independent comments, the save action and the current-block agent revision
 * (`按当前批注修改`), which sends the comment to the agent selected in
 * More — a block-scoped action targeting only the currently selected change
 * block, never the whole file. */
export function CommentSheet({ theme, layout, t, styles, selected, activeCommentDraft, activeSavedComment, commentBody, onCommentBodyChange, commentSaving, commentNotice, commentAnchorHunk, commentAnchorHunkId, commentAnchorIsCurrent, commentAnchorMoveArmed, onReturnToAnchor, onMoveAnchor, otherSavedComments, otherCommentsOpen, onToggleOtherComments, onEditSavedComment, onSaveComment, agentsLoading, selectedAgentId, agentFeedback, onReviseCurrentFromComment }: {
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  styles: PanelStyles;
  selected: SelectedHunk;
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
}) {
  const commentAnchorHeader = commentAnchorHunk ? hunkHeaderParts(commentAnchorHunk.header) : null;
  // Feedback for the selected agent's revision run (sending/sent/error).
  const reviseFeedback = selectedAgentId ? (agentFeedback[selectedAgentId] ?? null) : null;
  const reviseSending = reviseFeedback?.phase === "sending";
  return (
    <View style={styles.reviewDock}>
      <View style={styles.dockHeader}>
        <Text numberOfLines={1} style={[styles.sectionTitle, styles.dockTitle]}>{t("fileCommentTitle")}</Text>
        <Text style={[styles.fileStatus, activeCommentDraft?.dirty || activeSavedComment ? styles.fileStatusAccent : null]}>
          {activeCommentDraft?.dirty
            ? `• ${t("fileStatusDraft")}`
            : activeSavedComment
              ? `✓ ${t("fileStatusSaved")}`
              : `— ${t("fileStatusUncommented")}`}
        </Text>
      </View>
      <Text numberOfLines={1} style={styles.sectionSummary}>{t("fileCommentDesc")}</Text>

      {activeSavedComment?.decision.comment ? (
        <View style={styles.savedBody}>
          <Text selectable numberOfLines={2} style={styles.body}>{activeSavedComment.decision.comment}</Text>
          <View style={styles.savedMetaRow}>
            <Text numberOfLines={1} style={styles.routeMeta}>{t("fileCommentSavedAt", { savedAt: activeSavedComment.decision.savedAt })}</Text>
            <Text selectable numberOfLines={1} style={styles.anchorMeta}>
              {t("fileCommentAnchor", {
                anchor: `${activeSavedComment.hunk.id} · ${hunkHeaderParts(activeSavedComment.hunk.header).range}`,
              })}
            </Text>
          </View>
        </View>
      ) : null}

      <TextInput
        multiline
        value={commentBody}
        onChangeText={onCommentBodyChange}
        placeholder={t("fileCommentPlaceholder")}
        placeholderTextColor={theme.colors.foregroundMuted}
        style={[styles.input, styles.commentInput]}
      />

      <View style={styles.commentFooter}>
        <View style={styles.anchorRow}>
          <Text selectable numberOfLines={1} ellipsizeMode="middle" style={styles.anchorMeta}>
            {t("fileCommentAnchor", {
              anchor: commentAnchorHunk
                ? `${commentAnchorHunk.id} · ${commentAnchorHeader?.range ?? commentAnchorHunk.header}`
                : selected.id,
            })}
          </Text>
          {commentAnchorIsCurrent ? (
            <Text numberOfLines={1} style={styles.statusText}>
              {commentAnchorMoveArmed ? t("moveCommentAnchorReady") : t("fileCommentAnchorCurrent")}
            </Text>
          ) : (
            <>
              <Text numberOfLines={1} style={styles.muted}>{t("fileCommentAnchorDifferent")}</Text>
              <View style={styles.actionRow}>
                <ActionButton
                  variant="ghost"
                  label={t("returnToCommentAnchor")}
                  tooltip={t("returnToCommentAnchorHint")}
                  onPress={() => {
                    if (commentAnchorHunkId) onReturnToAnchor(commentAnchorHunkId);
                  }}
                  theme={theme}
                  layout={layout}
                />
                <ActionButton
                  variant="secondary"
                  label={t("moveCommentAnchor")}
                  tooltip={t("moveCommentAnchorHint")}
                  onPress={onMoveAnchor}
                  theme={theme}
                  layout={layout}
                />
              </View>
            </>
          )}
        </View>
        {otherSavedComments.length > 0 ? (
          <ActionButton
            variant="ghost"
            label={otherCommentsOpen ? t("hideOtherFileComments") : t("showOtherFileComments")}
            tooltip={t("otherFileCommentsHint")}
            onPress={onToggleOtherComments}
            theme={theme}
            layout={layout}
          />
        ) : null}
        <ActionButton
          variant="secondary"
          disabled={agentsLoading || !selectedAgentId || reviseSending || commentBody.trim().length === 0}
          label={reviseSending ? t("reviseCurrentCommentBusyLabel") : t("reviseCurrentCommentLabel")}
          tooltip={
            agentsLoading
              ? t("agentsLoading")
              : !selectedAgentId
                ? t("agentActionNoAgentHint")
                : reviseSending
                  ? t("reviseCurrentCommentBusyLabel")
                  : commentBody.trim().length === 0
                    ? t("reviseCurrentCommentNoCommentHint")
                    : t("reviseCurrentCommentHint")
          }
          onPress={() => {
            if (selectedAgentId) void onReviseCurrentFromComment(selectedAgentId);
          }}
          theme={theme}
          layout={layout}
        />
        <ActionButton
          variant="primary"
          disabled={commentSaving || commentBody.trim().length === 0 || !commentAnchorIsCurrent}
          label={commentSaving ? t("savingFileComment") : t("saveFileComment")}
          tooltip={
            commentSaving
              ? t("savingFileComment")
              : commentBody.trim().length === 0
                ? t("saveFileCommentNoCommentHint")
                : !commentAnchorIsCurrent
                  ? t("saveFileCommentWrongAnchorHint")
                  : t("saveFileCommentHint")
          }
          onPress={onSaveComment}
          theme={theme}
          layout={layout}
        />
      </View>

      {reviseFeedback?.phase === "sent" ? <Text style={styles.feedbackSent}>{t("reviseCurrentSent")}</Text> : null}
      {reviseFeedback?.phase === "error" ? <Text style={styles.feedbackError}>{reviseFeedback.message ?? t("reviseCurrentSendFailed")}</Text> : null}

      {otherSavedComments.length > 0 && otherCommentsOpen ? (
        <ScrollView
          style={styles.otherCommentsScroll}
          contentContainerStyle={styles.group}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          {otherSavedComments.map((comment) => (
            <View key={comment.hunk.id} style={styles.otherCommentRow}>
              <Text selectable style={styles.body}>{comment.decision.comment}</Text>
              <Text selectable style={styles.anchorMeta}>
                {t("fileCommentAnchor", { anchor: `${comment.hunk.id} · ${hunkHeaderParts(comment.hunk.header).range}` })}
              </Text>
              <Text style={styles.routeMeta}>{t("fileCommentSavedAt", { savedAt: comment.decision.savedAt })}</Text>
              <ActionButton
                variant="ghost"
                label={t("selectSavedComment")}
                tooltip={t("selectSavedCommentHint")}
                onPress={() => onEditSavedComment(comment.hunk.id)}
                theme={theme}
                layout={layout}
              />
            </View>
          ))}
        </ScrollView>
      ) : null}

      {commentNotice ? <Text style={styles.feedbackSent}>✓ {commentNotice}</Text> : null}
    </View>
  );
}

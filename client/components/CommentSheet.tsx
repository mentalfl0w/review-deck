import { useEffect, useRef } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import type { LineRangeSelection } from "../../shared/review";
import { hunkHeaderParts } from "../diffView";
import { anchorLocationText } from "../lineRange";
import { anchorStateBadgeKeys, anchorStateBadgeTextKeys, anchorStateLabelKeys } from "../tools";
import type { AgentFeedbackMap, FileCommentDraft, FileCommentEntry, PanelLayout, PanelTheme, SelectedHunk } from "../tools";
import type { TFunc } from "../i18n";
import type { PanelStyles } from "../styles";
import { ActionButton } from "./ui";

/** The file-comment dock: saved comment, editor, anchor bookkeeping, other
 * independent comments, the save action and the current-block agent revision
 * (`按当前批注修改`), which sends the comment to the agent selected in
 * More — a block-scoped action targeting only the currently selected change
 * block, never the whole file. The dock targets a ReviewAnchor: the live
 * line-range selection when the diff has one, otherwise the change block the
 * draft is pinned to. `selection` is the structured truth behind the rendered
 * `selectionText`; the dock only displays it and leaves the upstream save to
 * the parent. */
export function CommentSheet({ theme, layout, t, styles, selected, selection, selectionText, selectionPending, commentRequestNonce, activeCommentDraft, activeSavedComment, commentBody, onCommentBodyChange, commentSaving, commentNotice, commentAnchorHunk, commentAnchorHunkId, commentAnchorIsCurrent, commentAnchorMoveArmed, onReturnToAnchor, onMoveAnchor, otherSavedComments, otherCommentsOpen, onToggleOtherComments, onEditSavedComment, onSaveComment, agentsLoading, selectedAgentId, agentFeedback, onReviseCurrentFromComment }: {
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  styles: PanelStyles;
  selected: SelectedHunk;
  selection: LineRangeSelection | null;
  selectionText: string | null;
  selectionPending: boolean;
  commentRequestNonce: number;
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
  const inputRef = useRef<TextInput>(null);
  // [评论] in the diff's selection strip bumps the nonce; the dock answers by
  // taking focus so typing continues where the user just clicked.
  useEffect(() => {
    if (commentRequestNonce > 0) inputRef.current?.focus();
  }, [commentRequestNonce]);
  const commentAnchorHeader = commentAnchorHunk ? hunkHeaderParts(commentAnchorHunk.header) : null;
  // A live target wins while drafting; otherwise keep the saved range visible
  // when its comment body is edited without changing its anchor.
  const liveTargetText = selection ? selectionText : null;
  const savedTargetText = activeSavedComment?.decision.anchor
    ? anchorLocationText(t, activeSavedComment.decision.anchor, activeSavedComment.hunk.header)
    : null;
  const anchorRange = hunkHeaderParts(commentAnchorHunk?.header ?? selected.header).range;
  const targetLocation = liveTargetText ?? savedTargetText ?? (anchorRange.length > 0 ? anchorRange : selected.id);
  // Feedback for the selected agent's revision run (sending/sent/error).
  const reviseFeedback = selectedAgentId ? (agentFeedback[selectedAgentId] ?? null) : null;
  const reviseSending = reviseFeedback?.phase === "sending";
  return (
    <View style={styles.reviewDock}>
      <View style={styles.dockHeader}>
        <Text numberOfLines={1} style={[styles.sectionTitle, styles.dockTitle]}>
          {t("commentTargetTitle", { file: selected.filePath, location: targetLocation })}
        </Text>
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
              {activeSavedComment.decision.anchor
                ? anchorLocationText(t, activeSavedComment.decision.anchor, activeSavedComment.hunk.header)
                : t("fileCommentAnchor", {
                  anchor: `${activeSavedComment.hunk.id} · ${hunkHeaderParts(activeSavedComment.hunk.header).range}`,
                })}
            </Text>
            {activeSavedComment.decision.anchorState ? (
              <View style={[styles.anchorStateBadge, styles[anchorStateBadgeKeys[activeSavedComment.decision.anchorState]]]}>
                <Text style={[styles.anchorStateBadgeText, styles[anchorStateBadgeTextKeys[activeSavedComment.decision.anchorState]]]}>
                  {t(anchorStateLabelKeys[activeSavedComment.decision.anchorState])}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      ) : null}

      <TextInput
        ref={inputRef}
        multiline
        value={commentBody}
        onChangeText={onCommentBodyChange}
        placeholder={t("fileCommentPlaceholder")}
        placeholderTextColor={theme.colors.foregroundMuted}
        style={[styles.input, styles.commentInput]}
      />

      <View style={styles.commentFooter}>
        <View style={styles.anchorRow}>
          {liveTargetText !== null ? (
            <>
              <Text selectable numberOfLines={1} ellipsizeMode="middle" style={styles.anchorMeta}>
                {`${t("lineSelectionLabel")}: ${liveTargetText}`}
              </Text>
              <Text numberOfLines={1} style={styles.statusText}>
                {selectionPending && selection
                  ? t("lineSelectionAwaitingEnd", { line: selection.startLine })
                  : t("lineSelectionRangeHint")}
              </Text>
            </>
          ) : (
            <>
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
          disabled={commentSaving || selectionPending || commentBody.trim().length === 0 || !commentAnchorIsCurrent}
          label={commentSaving ? t("savingFileComment") : t("saveFileComment")}
          tooltip={
            commentSaving
              ? t("savingFileComment")
              : selectionPending && selection
                ? t("lineSelectionAwaitingEnd", { line: selection.startLine })
                : commentBody.trim().length === 0
                  ? t("saveFileCommentNoCommentHint")
                  : !commentAnchorIsCurrent
                    ? t("saveFileCommentWrongAnchorHint")
                    : liveTargetText !== null
                      ? t("saveFileCommentRangeHint", { location: liveTargetText })
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
              <View style={styles.savedMetaRow}>
                <Text selectable style={styles.anchorMeta}>
                  {t("fileCommentAnchor", { anchor: `${comment.hunk.id} · ${hunkHeaderParts(comment.hunk.header).range}` })}
                </Text>
                {comment.decision.anchorState ? (
                  <View style={[styles.anchorStateBadge, styles[anchorStateBadgeKeys[comment.decision.anchorState]]]}>
                    <Text style={[styles.anchorStateBadgeText, styles[anchorStateBadgeTextKeys[comment.decision.anchorState]]]}>
                      {t(anchorStateLabelKeys[comment.decision.anchorState])}
                    </Text>
                  </View>
                ) : null}
              </View>
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

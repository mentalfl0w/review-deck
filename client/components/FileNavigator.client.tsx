import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { ReviewSnapshot } from "../../review.shared";
import {
  maxSeverity,
  severityLabelKeys,
  severityOrder,
  type CommentDraftsMap,
  type PanelLayout,
  type PanelTheme,
  type ReviewDecision,
  type ReviewFile,
  type SelectedHunk,
} from "../tools.client";
import type { StringKey, TFunc } from "../i18n.client";
import type { PanelStyles } from "../styles.client";
import { HoverTooltip, SeverityBadge } from "./ui.client";

/** Left-hand file list split into unreviewed (default open) and reviewed
 * (default closed) collapsible sections; per-file severity, change summary
 * and comment status (draft/saved/uncommented) unchanged. Both section
 * headers remain visible even when their group is empty. */
export function FileNavigator({ theme, layout, t, styles, paneHeight, snapshot, decisions, fileCommentDrafts, selectedFile, selected, onSelectHunk, onClose }: {
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  styles: PanelStyles;
  paneHeight?: number;
  snapshot: ReviewSnapshot;
  decisions: ReviewDecision[];
  fileCommentDrafts: CommentDraftsMap;
  selectedFile: ReviewFile | null;
  selected: SelectedHunk | null;
  onSelectHunk: (hunkId: string) => void;
  onClose: () => void;
}) {
  const [pendingOpen, setPendingOpen] = useState(true);
  const [reviewedOpen, setReviewedOpen] = useState(false);
  const [navigatorHeaderHeight, setNavigatorHeaderHeight] = useState(0);
  const [pendingHeaderHeight, setPendingHeaderHeight] = useState(0);
  const [reviewedHeaderHeight, setReviewedHeaderHeight] = useState(0);
  const desktop = paneHeight !== undefined;
  const headersMeasured = navigatorHeaderHeight > 0 && pendingHeaderHeight > 0 && reviewedHeaderHeight > 0;
  const available = desktop && paneHeight > 0 && headersMeasured
    ? Math.max(0, paneHeight - navigatorHeaderHeight - pendingHeaderHeight - reviewedHeaderHeight)
    : 0;
  // A file is reviewed when it has hunks and every hunk carries a saved
  // decision; zero-hunk files stay in the unreviewed section so nothing
  // silently disappears from the list.
  const reviewedFiles: ReviewFile[] = [];
  const unreviewedFiles: ReviewFile[] = [];
  for (const file of snapshot.files) {
    if (file.hunks.length > 0 && file.hunks.every((hunk) => decisions.some((decision) => decision.hunkId === hunk.id))) {
      reviewedFiles.push(file);
    } else {
      unreviewedFiles.push(file);
    }
  }
  // Content-based height split: a section list never claims more than its
  // rows need (fileRow minHeight + list padding estimate); freed space flows
  // to the other open section. Reviewed is sized first so a one-file reviewed
  // group cannot starve the large pending list.
  const rowEstimate = 69; // fileRow minHeight 68 + 1px border
  const contentHeight = (count: number) => count * rowEstimate + 8;
  const pendingListHeight = !pendingOpen
    ? 0
    : !reviewedOpen
      ? Math.min(contentHeight(unreviewedFiles.length), available)
      : Math.min(contentHeight(unreviewedFiles.length), Math.max(available - Math.min(contentHeight(reviewedFiles.length), Math.floor(available / 2)), Math.floor(available / 2)));
  const reviewedListHeight = !reviewedOpen
    ? 0
    : !pendingOpen
      ? Math.min(contentHeight(reviewedFiles.length), available)
      : Math.min(contentHeight(reviewedFiles.length), available - pendingListHeight);
  const renderFile = (file: ReviewFile) => {
    const severity = severityOrder.find((candidate) => file.hunks.some((hunk) => maxSeverity(hunk) === candidate)) ?? "informational";
    const savedComments = file.hunks.filter((hunk) => decisions.some((decision) => decision.hunkId === hunk.id && Boolean(decision.comment)));
    const draft = fileCommentDrafts[`${snapshot.targetFingerprint}\u0000${file.path}`];
    const statusKey: StringKey = draft?.dirty
      ? "fileStatusDraft"
      : savedComments.length > 0
        ? "fileStatusSaved"
        : "fileStatusUncommented";
    const statusSymbol = draft?.dirty ? "•" : savedComments.length > 0 ? "✓" : "—";
    const active = selectedFile?.path === file.path;
    return (
      <Pressable
        accessibilityRole="button"
        key={file.path}
        onPress={() => {
          const nextHunk = active ? selected ?? file.hunks[0] : file.hunks[0];
          if (nextHunk) onSelectHunk(nextHunk.id);
          onClose();
        }}
        style={[styles.fileRow, active ? styles.fileRowActive : null]}
      >
        <View style={styles.fileRowTop}>
          <Text numberOfLines={1} ellipsizeMode="middle" style={styles.filePath}>{file.path}</Text>
          <SeverityBadge severity={severity} label={t(severityLabelKeys[severity])} theme={theme} compact />
        </View>
        <Text style={styles.fileMeta}>
          {t("fileChangeSummary", { hunks: file.hunks.length, additions: file.additions, deletions: file.deletions })}
        </Text>
        <View style={styles.fileRowTop}>
          <Text style={[styles.fileStatus, draft?.dirty || savedComments.length > 0 ? styles.fileStatusAccent : null]}>
            {statusSymbol} {t(statusKey)}
          </Text>
          {savedComments.length > 1 ? (
            <Text style={styles.fileMeta}>{t("fileStatusMultiple", { count: savedComments.length })}</Text>
          ) : null}
        </View>
      </Pressable>
    );
  };
  const renderSectionHeader = (
    label: string,
    {
      open,
      onToggle,
      onHeightChange,
    }: {
      open: boolean;
      onToggle: () => void;
      onHeightChange: (height: number) => void;
    },
  ) => (
    <HoverTooltip text={t("fileSectionToggleHint")} theme={theme} layout={layout}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onLayout={(event) => onHeightChange(event.nativeEvent.layout.height)}
        onPress={onToggle}
        style={styles.fileSectionHeader}
      >
        <Text style={styles.fileSectionHeaderText}>{label}</Text>
        <Text style={styles.fileMeta}>{open ? "▾" : "▸"}</Text>
      </Pressable>
    </HoverTooltip>
  );
  const renderFileList = (files: ReviewFile[], height?: number, showEmpty = false) => (
    <ScrollView
      style={height === undefined
        ? styles.fileSectionScroll
        : [styles.fileSectionScroll, { height, flexBasis: height, flexGrow: 0, flexShrink: 0 }]}
      contentContainerStyle={styles.fileList}
      nestedScrollEnabled
      scrollEnabled
      showsVerticalScrollIndicator
    >
      {files.map(renderFile)}
      {showEmpty ? <Text style={styles.empty}>{t("noHunksInScope")}</Text> : null}
    </ScrollView>
  );
  return (
    <View style={[styles.fileNavigator, paneHeight && paneHeight > 0 ? { height: paneHeight } : null]}>
      <ScrollView
        style={styles.fileNavigatorScroll}
        contentContainerStyle={styles.fileNavigatorContent}
        nestedScrollEnabled
        scrollEnabled
        showsVerticalScrollIndicator
      >
        <View
          style={styles.navigatorHeader}
          onLayout={(event) => {
            const height = event.nativeEvent.layout.height;
            setNavigatorHeaderHeight((currentHeight) => Math.abs(currentHeight - height) > 1 ? height : currentHeight);
          }}
        >
          <Text style={styles.sectionEyebrow}>{t("fileNavigator")}</Text>
          <Text style={styles.sectionSummary}>
            {t("fileNavigatorSummary", { files: snapshot.files.length, hunks: snapshot.totalHunks })}
          </Text>
        </View>
        <View style={pendingOpen ? styles.fileSection : styles.fileSectionCollapsed}>
          {renderSectionHeader(t("pendingFilesSection", { count: unreviewedFiles.length }), {
            open: pendingOpen,
            onToggle: () => setPendingOpen((open) => !open),
            onHeightChange: (height) => {
              setPendingHeaderHeight((currentHeight) => Math.abs(currentHeight - height) > 1 ? height : currentHeight);
            },
          })}
          {pendingOpen && (!desktop || pendingListHeight > 0)
            ? renderFileList(
                unreviewedFiles,
                desktop ? pendingListHeight : undefined,
                snapshot.files.length === 0,
              )
            : null}
        </View>
        <View style={reviewedOpen ? styles.fileSection : styles.fileSectionCollapsed}>
          {renderSectionHeader(t("reviewedFilesSection", { count: reviewedFiles.length }), {
            open: reviewedOpen,
            onToggle: () => setReviewedOpen((open) => !open),
            onHeightChange: (height) => {
              setReviewedHeaderHeight((currentHeight) => Math.abs(currentHeight - height) > 1 ? height : currentHeight);
            },
          })}
          {reviewedOpen && (!desktop || reviewedListHeight > 0)
            ? renderFileList(reviewedFiles, desktop ? reviewedListHeight : undefined)
            : null}
        </View>
      </ScrollView>
    </View>
  );
}

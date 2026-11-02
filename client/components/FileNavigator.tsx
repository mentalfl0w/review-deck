import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { ReviewSnapshot } from "../../shared/review";
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
} from "../tools";
import type { StringKey, TFunc } from "../i18n";
import type { PanelStyles } from "../styles";
import { HoverTooltip, SeverityBadge } from "./ui";

/**
 * The file rail: changed files split into unreviewed (default open) and
 * reviewed (default closed) collapsible sections, with per-file severity,
 * change summary and comment status. The rail is one independent scroller —
 * it never measures the canvas or splits its own height, so a large diff or a
 * tall file list cannot distort the other zones.
 */
export function FileNavigator({ theme, layout, t, styles, snapshot, decisions, fileCommentDrafts, selectedFile, selected, onSelectHunk, onClose }: {
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  styles: PanelStyles;
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
        accessibilityState={{ selected: active }}
        key={file.path}
        onPress={() => {
          const nextHunk = active ? selected ?? file.hunks[0] : file.hunks[0];
          if (nextHunk) onSelectHunk(nextHunk.id);
          onClose();
        }}
        style={[styles.fileRow, active ? styles.fileRowActive : null]}
      >
        <View style={styles.fileRowTop}>
          <Text numberOfLines={2} ellipsizeMode="middle" style={styles.filePath}>{file.path}</Text>
          <SeverityBadge severity={severity} label={t(severityLabelKeys[severity])} theme={theme} compact />
        </View>
        <View style={styles.fileRowTop}>
          <Text style={styles.fileMeta}>
            {t("fileChangeSummary", { hunks: file.hunks.length, additions: file.additions, deletions: file.deletions })}
          </Text>
        </View>
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
    { open, onToggle }: { open: boolean; onToggle: () => void },
  ) => (
    <HoverTooltip text={t("fileSectionToggleHint")} theme={theme} layout={layout}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={styles.fileSectionHeader}
      >
        <Text style={styles.fileSectionHeaderText}>{label}</Text>
        <Text style={styles.fileMeta}>{open ? "▾" : "▸"}</Text>
      </Pressable>
    </HoverTooltip>
  );
  const renderFileList = (files: ReviewFile[], showEmpty = false) => (
    <View style={styles.fileList}>
      {files.map(renderFile)}
      {showEmpty ? <Text style={styles.empty}>{t("noHunksInScope")}</Text> : null}
    </View>
  );
  return (
    <View style={styles.fileNavigator}>
      <ScrollView
        style={styles.fileNavigatorScroll}
        contentContainerStyle={styles.fileNavigatorContent}
        nestedScrollEnabled
        scrollEnabled
        showsVerticalScrollIndicator
      >
        <View style={styles.navigatorHeader}>
          <Text style={styles.sectionEyebrow}>{t("fileNavigator")}</Text>
          <Text style={styles.sectionSummary}>
            {t("fileNavigatorSummary", { files: snapshot.files.length, hunks: snapshot.totalHunks })}
          </Text>
        </View>
        <View style={styles.fileSection}>
          {renderSectionHeader(t("pendingFilesSection", { count: unreviewedFiles.length }), {
            open: pendingOpen,
            onToggle: () => setPendingOpen((open) => !open),
          })}
          {pendingOpen ? renderFileList(unreviewedFiles, snapshot.files.length === 0) : null}
        </View>
        <View style={styles.fileSection}>
          {renderSectionHeader(t("reviewedFilesSection", { count: reviewedFiles.length }), {
            open: reviewedOpen,
            onToggle: () => setReviewedOpen((open) => !open),
          })}
          {reviewedOpen ? renderFileList(reviewedFiles) : null}
        </View>
      </ScrollView>
    </View>
  );
}

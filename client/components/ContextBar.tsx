import { Pressable, Text, View } from "react-native";
import type { ReviewScope, ReviewSnapshot } from "../../shared/review";
import { scopeLabelKeys, statusLabelKeys, type PanelLayout, type PanelTheme, type ProjectIdentity } from "../tools";
import type { TFunc } from "../i18n";
import type { PanelStyles } from "../styles";
import { HoverTooltip } from "./ui";

/**
 * Persistent context header: one identity line (project › workspace, workspace
 * status) with the Queue entry and its actions, then a single inline metadata
 * line for scope and snapshot freshness. The panel is bound to its workspace,
 * so project and workspace are labels, never selectors.
 */
export function ContextBar({ theme, layout, t, styles, onToggleLocale, activeWorkspaceStatus, projectCommentCount, onOpenQueue, onOpenMore, projectIdentity, effectiveProjectId, activeWorkspaceName, scope, stale, loading, snapshot }: {
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  styles: PanelStyles;
  onToggleLocale: () => void;
  activeWorkspaceStatus: string;
  projectCommentCount: number;
  onOpenQueue: () => void;
  onOpenMore: () => void;
  projectIdentity: ProjectIdentity | null;
  effectiveProjectId: string;
  activeWorkspaceName: string;
  scope: ReviewScope;
  stale: boolean;
  loading: boolean;
  snapshot: ReviewSnapshot | null;
}) {
  const statusText = activeWorkspaceStatus
    ? (statusLabelKeys[activeWorkspaceStatus] ? t(statusLabelKeys[activeWorkspaceStatus]) : activeWorkspaceStatus)
    : "";
  const projectText = projectIdentity?.displayName ?? effectiveProjectId ?? t("noProjectSelected");
  const snapshotText = loading ? t("snapshotRefreshing") : stale ? t("snapshotStale") : t("snapshotCurrent");
  return (
    <View style={styles.contextBar}>
      <View style={styles.contextTop}>
        <Text style={styles.title}>{t("panelTitle")}</Text>
        {activeWorkspaceStatus ? (
          <View style={[styles.statusPill, activeWorkspaceStatus === "failed" ? styles.statusPillDanger : null]}>
            <Text style={[styles.statusPillText, activeWorkspaceStatus === "failed" ? styles.statusPillTextDanger : null]}>{statusText}</Text>
          </View>
        ) : null}
        <View style={styles.contextIdentity}>
          <Text numberOfLines={1} ellipsizeMode="middle" style={styles.contextProject}>{projectText}</Text>
          <Text style={styles.contextSeparator}>›</Text>
          <Text numberOfLines={1} ellipsizeMode="middle" style={styles.contextWorkspace}>
            {activeWorkspaceName || "—"}
          </Text>
        </View>
        <View style={styles.contextActions}>
          <HoverTooltip text={t("localeToggleHint")} theme={theme} layout={layout}>
            <Pressable
              accessibilityRole="button"
              accessibilityHint={t("localeToggleHint")}
              onPress={onToggleLocale}
              style={styles.topButton}
            >
              <Text style={styles.topButtonText}>{t("localeToggleLabel")}</Text>
            </Pressable>
          </HoverTooltip>
          <HoverTooltip text={t("queueButtonHint")} theme={theme} layout={layout}>
            <Pressable accessibilityRole="button" accessibilityHint={t("queueButtonHint")} onPress={onOpenQueue} style={[styles.topButton, styles.queueButton]}>
              <Text style={styles.queueButtonText}>{t("queueButton", { count: projectCommentCount })}</Text>
            </Pressable>
          </HoverTooltip>
          <HoverTooltip text={t("moreHint")} theme={theme} layout={layout}>
            <Pressable accessibilityRole="button" accessibilityHint={t("moreHint")} onPress={onOpenMore} style={styles.topButton}>
              <Text style={styles.topButtonText}>{t("more")}</Text>
            </Pressable>
          </HoverTooltip>
        </View>
      </View>
      <View style={styles.contextMetaRow}>
        <Text numberOfLines={1} style={styles.contextMetaText}>
          {t("scopeLabel")}: {t(scopeLabelKeys[scope])}
        </Text>
        <Text style={styles.contextMetaDot}>·</Text>
        <Text numberOfLines={1} style={[styles.contextMetaText, stale ? styles.contextMetaTextStale : null]}>
          {snapshotText}
        </Text>
        {snapshot ? (
          <>
            <Text style={styles.contextMetaDot}>·</Text>
            <Text numberOfLines={1} style={styles.contextMetaText}>
              {t("snapshotGenerated", { generatedAt: snapshot.generatedAt })}
            </Text>
          </>
        ) : null}
      </View>
    </View>
  );
}

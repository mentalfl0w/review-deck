import { Pressable, Text, View } from "react-native";
import type { ReviewScope, ReviewSnapshot } from "../../review.shared";
import { scopeLabelKeys, statusLabelKeys, type PanelLayout, type PanelTheme, type ProjectIdentity, type WorkspaceEntry } from "../tools.client";
import type { TFunc } from "../i18n.client";
import type { PanelStyles } from "../styles.client";
import { DropdownSelect } from "./ui.client";

/** Top context bar: panel title/status, locale + queue + more actions, and
 * the project/workspace/scope/snapshot meta row (with dropdowns when the
 * workspace registry is available). */
export function ContextBar({ theme, layout, t, styles, onToggleLocale, activeWorkspaceStatus, projectCommentCount, onOpenQueue, onOpenMore, workspaceEntries, projectOptions, effectiveProjectId, onSelectProject, workspaceOptions, workspaceValue, onSelectWorkspace, projectIdentity, activeWorkspaceName, scope, stale, loading, snapshot }: {
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  styles: PanelStyles;
  onToggleLocale: () => void;
  activeWorkspaceStatus: string;
  projectCommentCount: number;
  onOpenQueue: () => void;
  onOpenMore: () => void;
  workspaceEntries: WorkspaceEntry[];
  projectOptions: ReadonlyArray<{ value: string; label: string }>;
  effectiveProjectId: string;
  onSelectProject: (projectId: string) => void;
  workspaceOptions: ReadonlyArray<{ value: string; label: string }>;
  workspaceValue: string;
  onSelectWorkspace: (workspaceId: string) => void;
  projectIdentity: ProjectIdentity | null;
  activeWorkspaceName: string;
  scope: ReviewScope;
  stale: boolean;
  loading: boolean;
  snapshot: ReviewSnapshot | null;
}) {
  const statusText = activeWorkspaceStatus
    ? (statusLabelKeys[activeWorkspaceStatus] ? t(statusLabelKeys[activeWorkspaceStatus]) : activeWorkspaceStatus)
    : "";
  return (
    <View style={styles.contextBar}>
      <View style={styles.contextTop}>
        <Text style={styles.title}>{t("panelTitle")}</Text>
        {activeWorkspaceStatus ? (
          <View style={[styles.statusPill, activeWorkspaceStatus === "failed" ? styles.statusPillDanger : null]}>
            <Text style={[styles.statusPillText, activeWorkspaceStatus === "failed" ? styles.statusPillTextDanger : null]}>{statusText}</Text>
          </View>
        ) : null}
        <View style={styles.contextActions}>
          <Pressable
            accessibilityRole="button"
            onPress={onToggleLocale}
            style={styles.topButton}
          >
            <Text style={styles.topButtonText}>{t("localeToggleLabel")}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onOpenQueue} style={[styles.topButton, styles.queueButton]}>
            <Text style={styles.queueButtonText}>{t("queueButton", { count: projectCommentCount })}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onOpenMore} style={styles.topButton}>
            <Text style={styles.topButtonText}>{t("more")}</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.contextMeta}>
        {workspaceEntries.length > 0 ? (
          <>
            <View style={styles.contextSelector}>
              <DropdownSelect
                label={t("projectLabel")}
                value={effectiveProjectId}
                options={projectOptions}
                onChange={onSelectProject}
                placeholder={t("selectProject")}
                closeLabel={t("closeDropdown")}
                theme={theme}
                layout={layout}
              />
            </View>
            <View style={styles.contextSelector}>
              <DropdownSelect
                label={t("workspaceLabel")}
                value={workspaceValue}
                options={workspaceOptions}
                onChange={onSelectWorkspace}
                placeholder={t("noWorkspaceOptions")}
                closeLabel={t("closeDropdown")}
                theme={theme}
                layout={layout}
              />
            </View>
          </>
        ) : (
          <>
            <View style={styles.contextItem}>
              <Text style={styles.contextLabel}>{t("projectLabel")}</Text>
              <Text numberOfLines={1} style={styles.contextValue}>
                {projectIdentity?.displayName ?? effectiveProjectId ?? t("noProjectSelected")}
              </Text>
            </View>
            <View style={styles.contextItem}>
              <Text style={styles.contextLabel}>{t("workspaceLabel")}</Text>
              <Text numberOfLines={1} style={styles.contextValue}>{activeWorkspaceName}</Text>
            </View>
          </>
        )}
        <View style={styles.contextItem}>
          <Text style={styles.contextLabel}>{t("scopeLabel")}</Text>
          <Text style={styles.contextValue}>{t(scopeLabelKeys[scope])}</Text>
        </View>
        <View style={styles.contextItem}>
          <Text style={styles.contextLabel}>{t("contextSnapshot")}</Text>
          <Text style={[styles.contextValue, stale ? { color: theme.colors.accent } : null]}>
            {loading ? t("snapshotRefreshing") : stale ? t("snapshotStale") : t("snapshotCurrent")}
          </Text>
          {snapshot ? <Text numberOfLines={1} style={styles.routeMeta}>{t("snapshotGenerated", { generatedAt: snapshot.generatedAt })}</Text> : null}
        </View>
      </View>
    </View>
  );
}

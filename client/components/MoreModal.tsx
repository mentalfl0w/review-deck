import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { AiReviewBudgetPreset, AiReviewDepth, ReviewScope, ReviewSnapshot } from "../../shared/review";
import { isReviewPreviewUrl } from "../../shared/review-settings";
import {
  scopeDescKeys,
  type AgentInfo,
  type PanelLayout,
  type PanelTheme,
  type ReviewDecision,
  type SelectedHunk,
} from "../tools";
import type { TFunc } from "../i18n";
import type { PanelStyles } from "../styles";
import { ActionButton, HoverTooltip, Segmented } from "./ui";

/** Centered "More & management" modal: scope/refs/path inputs, the current
 * project's Browser Preview target, the Agent registry/selection surface and
 * the safety (review-state) actions. */
export function MoreModal({ theme, layout, t, styles, open, onClose, agents, agentsLoading, selectedAgentId, onSelectAgent, onRunTargetReview, agentReviewBusy, defaultReviewPreset, reviewDepthOverride, onReviewDepthOverrideChange, scopeOptions, scope, onScopeChange, filePath, onFilePathChange, baseRef, onBaseRefChange, headRef, onHeadRefChange, loading, onRefresh, previewUrl, previewUrlSaveError, previewProjectAvailable, browserPreviewAvailable, onPreviewUrlChange, onPreviewUrlCommit, onOpenPreview, selected, decisions, snapshot, onClearCurrentHunk, onClearCurrentReview, onManage }: {
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  styles: PanelStyles;
  open: boolean;
  onClose: () => void;
  agents: AgentInfo[];
  agentsLoading: boolean;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onRunTargetReview: () => void;
  agentReviewBusy: boolean;
  defaultReviewPreset: AiReviewBudgetPreset;
  reviewDepthOverride: AiReviewDepth | null;
  onReviewDepthOverrideChange: (depth: AiReviewDepth | null) => void;
  scopeOptions: ReadonlyArray<{ value: ReviewScope; label: string }>;
  scope: ReviewScope;
  onScopeChange: (scope: ReviewScope) => void;
  filePath: string;
  onFilePathChange: (path: string) => void;
  baseRef: string;
  onBaseRefChange: (ref: string) => void;
  headRef: string;
  onHeadRefChange: (ref: string) => void;
  loading: boolean;
  onRefresh: () => void;
  /** Preview target of the active project, as a controlled draft value ("" when unset). */
  previewUrl: string;
  /** True when the current Review Deck scope resolves to a project. */
  previewProjectAvailable: boolean;
  previewUrlSaveError: string | null;
  /** True only when the host exposes navigation.openBrowser (Electron). */
  browserPreviewAvailable: boolean;
  onPreviewUrlCommit: () => void;
  onPreviewUrlChange: (url: string) => void;
  onOpenPreview: () => void;
  selected: SelectedHunk | null;
  decisions: ReviewDecision[];
  snapshot: ReviewSnapshot | null;
  onClearCurrentHunk: () => void;
  onClearCurrentReview: () => void;
  onManage: () => void;
}) {
  const presetLabel = t(
    defaultReviewPreset === "economical"
      ? "settingsReviewPresetEconomical"
      : defaultReviewPreset === "balanced"
        ? "settingsReviewPresetBalanced"
        : "settingsReviewPresetDeep",
  );
  const depthOverrideOptions: ReadonlyArray<{ value: "preset" | AiReviewDepth; label: string }> = [
    { value: "preset", label: t("aiReviewDepthUsePreset") },
    { value: "targeted", label: t("settingsReviewDepthTargeted") },
    { value: "full", label: t("settingsReviewDepthFull") },
  ];
  // Only a non-empty absolute http(s) draft may be opened; the parent enforces
  // the same rule at the save and navigation boundaries.
  const previewUrlValid = isReviewPreviewUrl(previewUrl);
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.centeredModalWrap} onPress={onClose}>
        <Pressable onPress={(event) => event.stopPropagation()} style={styles.centeredModal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{t("moreTitle")}</Text>
            <HoverTooltip text={t("closeHint")} theme={theme} layout={layout}>
              <Pressable accessibilityRole="button" onPress={onClose} style={styles.topButton}>
                <Text style={styles.topButtonText}>{t("close")}</Text>
              </Pressable>
            </HoverTooltip>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            <View style={styles.modalSection}>
              <Text style={styles.sectionTitle}>{t("moreContextTitle")}</Text>
              <Text style={styles.label}>{t("scopeLabel")}</Text>
              <Segmented options={scopeOptions.map((option) => ({ ...option, tooltip: t(scopeDescKeys[option.value]) }))} value={scope} onChange={onScopeChange} theme={theme} layout={layout} stretch />
              <Text style={styles.scopeDesc}>{t(scopeDescKeys[scope])}</Text>
              <View style={styles.inputRow}>
                <Text style={styles.label}>{t("path")}</Text>
                <TextInput
                  value={filePath}
                  onChangeText={onFilePathChange}
                  placeholder={t("pathPlaceholder")}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={[styles.input, styles.inputFlex]}
                />
              </View>
              {scope === "commits" ? (
                <View style={styles.inputRow}>
                  <TextInput
                    value={baseRef}
                    onChangeText={onBaseRefChange}
                    placeholder={t("baseRefPlaceholder")}
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={[styles.input, styles.inputFlex]}
                  />
                  <TextInput
                    value={headRef}
                    onChangeText={onHeadRefChange}
                    placeholder={t("headRefPlaceholder")}
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={[styles.input, styles.inputFlex]}
                  />
                </View>
              ) : null}
              <ActionButton
                variant="secondary"
                label={loading ? t("refreshing") : t("refresh")}
                tooltip={t("refreshHint")}
                onPress={onRefresh}
                theme={theme}
                layout={layout}
              />
            </View>

            {previewProjectAvailable ? (
              <View style={styles.modalSection}>
                <Text style={styles.sectionTitle}>{t("previewTitle")}</Text>
                <Text style={styles.scopeDesc}>{t("previewDesc")}</Text>
                <View style={styles.inputRow}>
                  <Text style={styles.label}>{t("previewUrlLabel")}</Text>
                  <TextInput
                    value={previewUrl}
                    onChangeText={onPreviewUrlChange}
                    onBlur={onPreviewUrlCommit}
                    placeholder={t("previewUrlPlaceholder")}
                    placeholderTextColor={theme.colors.foregroundMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    style={[styles.input, styles.inputFlex]}
                  />
                </View>
                {previewUrl.trim().length > 0 && !previewUrlValid ? (
                  <Text style={styles.muted}>{t("previewUrlInvalid")}</Text>
                ) : null}
                {previewUrlSaveError ? (
                  <Text style={styles.errorText}>{t("settingsSaveFailed")} · {previewUrlSaveError}</Text>
                ) : null}
                {browserPreviewAvailable ? (
                  <ActionButton
                    variant="primary"
                    label={t("previewOpen")}
                    tooltip={t("previewOpenHint")}
                    disabled={!previewUrlValid}
                    onPress={onOpenPreview}
                    theme={theme}
                    layout={layout}
                  />
                ) : <Text style={styles.muted}>{t("previewUnavailable")}</Text>}
              </View>
            ) : null}

            <View style={styles.modalSection}>
              <Text style={styles.sectionTitle}>{t("moreAgentTitle")}</Text>
              <Text style={styles.scopeDesc}>{t("moreAgentDesc")}</Text>
              {agentsLoading ? (
                <Text style={styles.muted}>{t("agentsLoading")}</Text>
              ) : agents.length === 0 ? (
                <Text style={styles.muted}>{t("noAgents")}</Text>
              ) : (
                agents.map((agent) => {
                  const selected = agent.id === selectedAgentId;
                  return (
                    <Pressable
                      key={agent.id}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      onPress={() => onSelectAgent(agent.id)}
                      style={[styles.agentSelectRow, selected ? styles.agentSelectRowActive : null]}
                    >
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        {agent.title ? <Text numberOfLines={2} style={styles.routeFile}>{agent.title}</Text> : null}
                        <Text selectable numberOfLines={1} style={styles.routeMeta}>{agent.id}</Text>
                        <Text selectable numberOfLines={1} style={styles.routeMeta}>
                          {t("agentProviderModel", { provider: agent.provider ?? t("unknownAgentProvider"), model: agent.model ?? t("noAgentModel") })}
                        </Text>
                      </View>
                      <Text style={selected ? styles.agentSelectMarkActive : styles.agentSelectMarkIdle}>{selected ? "●" : "○"}</Text>
                    </Pressable>
                  );
                })
              )}
            </View>
            <View style={styles.modalSection}>
              <Text style={styles.sectionTitle}>{t("aiReviewDepthOverrideLabel")}</Text>
              <Text style={styles.scopeDesc}>{t("aiReviewDepthOverrideHint", { preset: presetLabel })}</Text>
              <Segmented
                options={depthOverrideOptions}
                value={reviewDepthOverride ?? "preset"}
                onChange={(value) => onReviewDepthOverrideChange(value === "preset" ? null : value)}
                theme={theme}
                layout={layout}
                stretch={layout.compact}
              />
            </View>
            <View style={styles.modalSection}>
              <Text style={styles.scopeDesc}>{t("aiReviewTargetHint")}</Text>
              <ActionButton
                variant="primary"
                label={agentReviewBusy ? t("aiReviewRunning") : t("aiReviewTargetAction")}
                tooltip={t("aiReviewTargetHint")}
                disabled={agentsLoading || !selectedAgentId || !snapshot || snapshot.totalHunks === 0 || !selected || agentReviewBusy}
                onPress={() => {
                  onClose();
                  onRunTargetReview();
                }}
                theme={theme}
                layout={layout}
              />
            </View>
            <View style={{ gap: 10 }}>
              <Text style={styles.sectionTitle}>{t("moreSafetyTitle")}</Text>
              <Text style={styles.scopeDesc}>{t("reviewStateDesc")}</Text>
              <Text selectable style={styles.routeMeta}>{t("reviewStateLocation")}</Text>
              <Text style={styles.routeMeta}>
                {t("reviewStateCurrentSummary", {
                  decisions: decisions.length,
                  comments: decisions.filter((decision) => Boolean(decision.comment)).length,
                })}
              </Text>
              <View style={styles.actionRow}>
                <ActionButton
                  variant="danger"
                  label={t("clearCurrentHunk")}
                  tooltip={t("clearCurrentHunkHint")}
                  disabled={!selected}
                  onPress={onClearCurrentHunk}
                  theme={theme}
                  layout={layout}
                />
                <ActionButton
                  variant="danger"
                  label={t("clearCurrentReview")}
                  tooltip={t("clearCurrentReviewHint")}
                  disabled={!snapshot}
                  onPress={onClearCurrentReview}
                  theme={theme}
                  layout={layout}
                />
                <ActionButton
                  variant="ghost"
                  label={t("manageSavedReviews")}
                  tooltip={t("manageSavedReviewsHint")}
                  onPress={() => {
                    onClose();
                    onManage();
                  }}
                  theme={theme}
                  layout={layout}
                />
              </View>
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

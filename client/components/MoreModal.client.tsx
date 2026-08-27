import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { ReviewScope, ReviewSnapshot } from "../../review.shared";
import {
  scopeDescKeys,
  type AgentInfo,
  type PanelLayout,
  type PanelTheme,
  type ReviewDecision,
  type SelectedHunk,
} from "../tools.client";
import type { TFunc } from "../i18n.client";
import type { PanelStyles } from "../styles.client";
import { ActionButton, Segmented } from "./ui.client";

/** Centered "More & management" modal: scope/refs/path inputs, whole-diff
 * agent review actions and the safety (review-state) actions. */
export function MoreModal({ theme, layout, t, styles, open, onClose, scopeOptions, scope, onScopeChange, filePath, onFilePathChange, baseRef, onBaseRefChange, headRef, onHeadRefChange, loading, onRefresh, agents, onRunAgentReview, onSendRevision, selected, decisions, snapshot, onClearCurrentHunk, onClearCurrentReview, onManage }: {
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  styles: PanelStyles;
  open: boolean;
  onClose: () => void;
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
  agents: AgentInfo[];
  onRunAgentReview: (agentId: string) => void;
  onSendRevision: (agentId: string) => void;
  selected: SelectedHunk | null;
  decisions: ReviewDecision[];
  snapshot: ReviewSnapshot | null;
  onClearCurrentHunk: () => void;
  onClearCurrentReview: () => void;
  onManage: () => void;
}) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.centeredModalWrap} onPress={onClose}>
        <Pressable onPress={(event) => event.stopPropagation()} style={styles.centeredModal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{t("moreTitle")}</Text>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.topButton}>
              <Text style={styles.topButtonText}>{t("close")}</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            <View style={styles.modalSection}>
              <Text style={styles.sectionTitle}>{t("moreContextTitle")}</Text>
              <Text style={styles.label}>{t("scopeLabel")}</Text>
              <Segmented options={scopeOptions} value={scope} onChange={onScopeChange} theme={theme} layout={layout} stretch />
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
                onPress={onRefresh}
                theme={theme}
                layout={layout}
              />
            </View>

            <View style={styles.modalSection}>
              <Text style={styles.sectionTitle}>{t("moreAgentsTitle")}</Text>
              {agents.length > 0 ? agents.map((agent) => (
                <View key={agent.id} style={styles.agentRow}>
                  <Text numberOfLines={1} style={styles.routeFile}>{agent.title ?? agent.id}</Text>
                  <Text numberOfLines={1} style={styles.routeMeta}>{agent.provider ?? "?"} · {agent.model ?? t("noAgentModel")}</Text>
                  <View style={styles.actionRow}>
                    <ActionButton
                      variant="secondary"
                      label={t("reviewWithAgent", { agentId: agent.id })}
                      onPress={() => {
                        onClose();
                        void onRunAgentReview(agent.id);
                      }}
                      theme={theme}
                      layout={layout}
                    />
                    {selected ? (
                      <ActionButton
                        variant="ghost"
                        label={t("reviseWithAgent", { agentId: agent.id })}
                        onPress={() => {
                          onClose();
                          void onSendRevision(agent.id);
                        }}
                        theme={theme}
                        layout={layout}
                      />
                    ) : null}
                  </View>
                </View>
              )) : <Text style={styles.muted}>{t("noAgents")}</Text>}
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
                  disabled={!selected}
                  onPress={onClearCurrentHunk}
                  theme={theme}
                  layout={layout}
                />
                <ActionButton
                  variant="danger"
                  label={t("clearCurrentReview")}
                  disabled={!snapshot}
                  onPress={onClearCurrentReview}
                  theme={theme}
                  layout={layout}
                />
                <ActionButton
                  variant="ghost"
                  label={t("manageSavedReviews")}
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

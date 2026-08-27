import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import {
  scopeLabelKeys,
  type PanelLayout,
  type PanelTheme,
  type SavedReviewSummary,
} from "../tools.client";
import type { TFunc } from "../i18n.client";
import type { PanelStyles } from "../styles.client";
import { ActionButton } from "./ui.client";

/** Centered modal listing saved review records per target fingerprint with
 * per-target clear and the guarded clear-everything flow. */
export function ManageModal({ theme, layout, t, styles, open, onClose, stateError, savedReviews, onClearTarget, confirmClearAll, onRequestClearAll, onCancelClearAll, onClearAll }: {
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  styles: PanelStyles;
  open: boolean;
  onClose: () => void;
  stateError: string | null;
  savedReviews: SavedReviewSummary[] | null;
  onClearTarget: (targetFingerprint: string) => void;
  confirmClearAll: boolean;
  onRequestClearAll: () => void;
  onCancelClearAll: () => void;
  onClearAll: () => void;
}) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.centeredModalWrap} onPress={onClose}>
        <Pressable onPress={(event) => event.stopPropagation()} style={styles.centeredModal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{t("savedReviewsTitle")}</Text>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.topButton}>
              <Text style={styles.topButtonText}>{t("close")}</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            <Text selectable style={styles.scopeDesc}>{t("reviewStateLocation")}</Text>
            {stateError ? <View style={styles.errorCard}><Text style={styles.errorText}>{stateError}</Text></View> : null}
            {savedReviews === null ? (
              <Text style={styles.muted}>{t("savedReviewsLoading")}</Text>
            ) : savedReviews.length === 0 ? (
              <Text style={styles.muted}>{t("savedReviewsEmpty")}</Text>
            ) : savedReviews.map((review) => (
              <View key={review.targetFingerprint} style={styles.queueGroup}>
                <View style={styles.fileRowTop}>
                  <Text selectable numberOfLines={1} style={[styles.diffHeaderRange, { flex: 1 }]}>{review.targetFingerprint.slice(0, 12)}</Text>
                  <ActionButton
                    variant="danger"
                    label={t("clearTarget")}
                    onPress={() => void onClearTarget(review.targetFingerprint)}
                    theme={theme}
                    layout={layout}
                  />
                </View>
                <Text style={styles.routeMeta} numberOfLines={2}>
                  {review.scope ? t("savedReviewScopeLabel", { scope: t(scopeLabelKeys[review.scope]) }) : ""}
                  {review.cwd ? ` · ${t("savedReviewCwdLabel", { cwd: review.cwd })}` : ""}
                </Text>
                <Text style={styles.routeMeta}>
                  {t("savedReviewRowSummary", { decisions: review.decisionCount, comments: review.commentCount })}
                  {` · ${t("savedReviewLastSaved", { savedAt: review.lastSavedAt })}`}
                </Text>
              </View>
            ))}
            {confirmClearAll ? (
              <View style={styles.errorCard}>
                <Text style={[styles.errorText, { fontWeight: "700" }]}>{t("confirmClearAllTitle")}</Text>
                <Text style={styles.muted}>{t("confirmClearAllBody")}</Text>
                <View style={styles.actionRow}>
                  <ActionButton
                    variant="danger"
                    label={t("confirm")}
                    onPress={onClearAll}
                    theme={theme}
                    layout={layout}
                  />
                  <ActionButton
                    variant="ghost"
                    label={t("cancel")}
                    onPress={onCancelClearAll}
                    theme={theme}
                    layout={layout}
                  />
                </View>
              </View>
            ) : (
              <ActionButton
                variant="danger"
                label={t("clearAllSavedReviews")}
                hint={t("clearAllSavedReviewsHint")}
                onPress={onRequestClearAll}
                theme={theme}
                layout={layout}
              />
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

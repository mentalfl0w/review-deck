import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { usePaseo } from "@getpaseo/plugin/client";
import type { PollVerificationRunResult, ReviewVerificationSuggestion } from "../../shared/review";
import type { TFunc } from "../i18n";
import type { PanelStyles } from "../styles";
import type { PanelLayout, PanelTheme } from "../tools";
import { ActionButton } from "./ui";

type VerificationRuns = Readonly<Record<string, PollVerificationRunResult>>;

function TerminalActions({ run, theme, layout, t, onRefresh, onError }: {
  run: PollVerificationRunResult;
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  onRefresh: (runId: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const paseo = usePaseo();
  const [closedLocally, setClosedLocally] = useState(false);
  if (!run.terminalId || closedLocally) return null;

  const closeTerminal = async () => {
    try {
      await paseo.terminals.ref(run.terminalId!).kill();
      setClosedLocally(true);
      await onRefresh(run.runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onError(t("verificationCloseTerminalFailed", { error: message }));
    }
  };

  return (
    <ActionButton
      variant="ghost"
      label={t("verificationCloseTerminal")}
      tooltip={t("verificationCloseTerminal")}
      onPress={() => void closeTerminal()}
      theme={theme}
      layout={layout}
    />
  );
}

/** Shows structured executable/argv suggestions only. The user sees the exact
 * preview and confirms before Review Deck opens a workspace-owned terminal.
 * v2.0 captures output but does not infer command success. */
export function VerificationCommands({ theme, layout, t, styles, commands, runs, enabled, onRun, onRefresh, onError }: {
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  styles: PanelStyles;
  commands: readonly ReviewVerificationSuggestion[];
  runs: VerificationRuns;
  enabled: boolean;
  onRun: (suggestion: ReviewVerificationSuggestion) => Promise<void>;
  onRefresh: (runId: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [confirmation, setConfirmation] = useState<ReviewVerificationSuggestion | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);

  const confirmAndRun = async () => {
    const suggestion = confirmation;
    if (!suggestion || startingId !== null) return;
    setConfirmation(null);
    setStartingId(suggestion.id);
    try {
      await onRun(suggestion);
    } finally {
      setStartingId(null);
    }
  };

  return (
    <View style={styles.analysisBlock}>
      <Text style={styles.label}>{t("verificationCommandsTitle")}</Text>
      {commands.length === 0 ? (
        <Text style={styles.muted}>{t("verificationNoStructuredCommand")}</Text>
      ) : commands.map((suggestion) => {
        const run = runs[suggestion.id];
        const starting = startingId === suggestion.id;
        const terminalOpen = run?.status === "open";
        return (
          <View key={suggestion.id} style={styles.modalSection}>
            <Text selectable style={styles.body}>{suggestion.label}</Text>
            <Text selectable style={[styles.routeMeta, { writingDirection: "ltr", textAlign: "left" }]}>{suggestion.commandPreview}</Text>
            {starting ? <Text style={styles.muted}>{t("verificationTerminalOpening")}</Text> : null}
            {terminalOpen ? <Text style={styles.muted}>{t("verificationTerminalOpen")}</Text> : null}
            {run?.status === "closed" ? <Text style={styles.muted}>{t("verificationTerminalClosed")}</Text> : null}
            {run && (run.status === "unavailable" || run.status === "error") ? (
              <View style={styles.errorCard}>
                <Text style={styles.errorText}>{run.failure?.message ?? t("verificationTerminalUnavailable")}</Text>
              </View>
            ) : null}
            {run?.outputTail && run.outputTail.length > 0 ? (
              <Text selectable style={styles.rawReview}>{run.outputTail.join("\n")}</Text>
            ) : null}
            <View style={styles.actionRow}>
              <ActionButton
                variant="secondary"
                label={t("verificationRun")}
                tooltip={t("verificationConfirmHint")}
                disabled={!enabled || starting || terminalOpen}
                onPress={() => setConfirmation(suggestion)}
                theme={theme}
                layout={layout}
              />
              {run ? (
                <ActionButton
                  variant="ghost"
                  label={t("verificationRefreshOutput")}
                  tooltip={t("verificationRefreshOutput")}
                  disabled={starting}
                  onPress={() => void onRefresh(run.runId)}
                  theme={theme}
                  layout={layout}
                />
              ) : null}
              {run && run.status !== "closed" ? (
                <TerminalActions run={run} theme={theme} layout={layout} t={t} onRefresh={onRefresh} onError={onError} />
              ) : null}
            </View>
            {terminalOpen ? (
              <Text style={styles.scopeDesc}>{t("verificationNoAutoVerdict")}</Text>
            ) : null}
          </View>
        );
      })}
      <Modal visible={confirmation !== null} transparent animationType="fade" onRequestClose={() => setConfirmation(null)}>
        <Pressable style={styles.centeredModalWrap} onPress={() => setConfirmation(null)}>
          <Pressable onPress={(event) => event.stopPropagation()} style={styles.centeredModal}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t("verificationConfirmTitle")}</Text>
              <Pressable accessibilityRole="button" onPress={() => setConfirmation(null)} style={styles.topButton}>
                <Text style={styles.topButtonText}>{t("cancel")}</Text>
              </Pressable>
            </View>
            {confirmation ? (
              <View style={styles.modalBody}>
                <Text style={styles.scopeDesc}>{t("verificationConfirmHint")}</Text>
                <Text selectable style={[styles.rawReview, { writingDirection: "ltr", textAlign: "left" }]}>{confirmation.commandPreview}</Text>
                <Text selectable style={styles.routeMeta}>{confirmation.label}</Text>
                <View style={styles.actionRow}>
                  <ActionButton
                    variant="ghost"
                    label={t("cancel")}
                    tooltip={t("cancel")}
                    onPress={() => setConfirmation(null)}
                    theme={theme}
                    layout={layout}
                  />
                  <ActionButton
                    variant="primary"
                    label={t("verificationConfirmRun")}
                    tooltip={t("verificationConfirmHint")}
                    disabled={!enabled || startingId !== null}
                    onPress={() => void confirmAndRun()}
                    theme={theme}
                    layout={layout}
                  />
                </View>
              </View>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

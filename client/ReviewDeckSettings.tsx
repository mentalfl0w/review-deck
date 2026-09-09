import { useMemo, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsRow, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { detectLocale, makeT } from "./i18n";
import {
  reviewDeckSettings,
  type ReviewDeckSettingsValues,
  type ReviewDiffModeSetting,
  type ReviewLocaleSetting,
} from "../shared/review-settings";

const CONTENT_PADDING = 16;

/** Host settings screen for the Review Deck v1 presentation defaults
 * (interface language and default diff layout). The plugin entry point
 * registers this component via addSettingsScreen together with
 * reviewDeckSettings on the server; this file neither registers nor consumes
 * anything itself.
 *
 * Rendering follows the settings state machine from useSettings: loading
 * placeholder, read error with reload, invalid persisted data with reset,
 * and the ready form with auto-saving selects (whole-document save against
 * the displayed revision; conflicts surface as a save-error row with a
 * reload action). Reload and reset stay available in every editable state. */
export function ReviewDeckSettings(): ReactNode {
  const settings = useSettings(reviewDeckSettings);
  const t = useMemo(() => makeT(detectLocale()), []);

  const localeOptions = useMemo(
    (): ReadonlyArray<{ label: string; value: ReviewLocaleSetting }> => [
      { label: t("settingsAuto"), value: "auto" },
      { label: t("settingsLanguageChinese"), value: "zh" },
      { label: t("settingsLanguageEnglish"), value: "en" },
    ],
    [t],
  );
  const diffModeOptions = useMemo(
    (): ReadonlyArray<{ label: string; value: ReviewDiffModeSetting }> => [
      { label: t("settingsAuto"), value: "auto" },
      { label: t("diffModeUnified"), value: "unified" },
      { label: t("diffModeSplit"), value: "split" },
    ],
    [t],
  );

  let content: ReactNode;
  if (settings.status === "loading") {
    content = <SettingsRow label={t("settingsLoading")} testID="review-deck-settings-loading" />;
  } else if (settings.status === "error") {
    content = (
      <>
        <SettingsRow
          label={t("settingsLoadFailed")}
          hint={settings.error}
          testID="review-deck-settings-read-error"
        />
        <SettingsAction
          label={t("settingsReloadLabel")}
          hint={t("settingsReloadHint")}
          actionLabel={t("settingsReloadLabel")}
          onPress={() => void settings.reload()}
          disabled={settings.saving}
          testID="review-deck-settings-reload"
        />
      </>
    );
  } else if (settings.status === "invalid") {
    content = (
      <>
        <SettingsRow
          label={t("settingsInvalidTitle")}
          hint={`${settings.error} · ${t("settingsInvalidHint")}`}
          testID="review-deck-settings-invalid"
        />
        <SettingsAction
          label={t("settingsResetLabel")}
          hint={t("settingsResetHint")}
          actionLabel={t("settingsResetLabel")}
          onPress={() => void settings.reset()}
          disabled={settings.saving}
          testID="review-deck-settings-reset"
        />
      </>
    );
  } else {
    const { values, revision } = settings;
    const apply = (next: ReviewDeckSettingsValues) => {
      // Whole-document save against the revision currently displayed; the
      // hook reports conflicts and write errors via saveError, never throws.
      void settings.save(next, revision);
    };
    content = (
      <>
        <SettingsSelect
          label={t("settingsLocaleLabel")}
          hint={t("settingsLocaleHint")}
          value={values.locale}
          options={localeOptions}
          onValueChange={(locale) => {
            if (locale !== values.locale) apply({ ...values, locale });
          }}
          disabled={settings.saving}
          testID="review-deck-settings-locale"
        />
        <SettingsSelect
          label={t("settingsDiffModeLabel")}
          hint={t("settingsDiffModeHint")}
          value={values.diffMode}
          options={diffModeOptions}
          onValueChange={(diffMode) => {
            if (diffMode !== values.diffMode) apply({ ...values, diffMode });
          }}
          disabled={settings.saving}
          testID="review-deck-settings-diff-mode"
        />
        {settings.saveError ? (
          <SettingsRow
            label={t("settingsSaveFailed")}
            hint={settings.saveError}
            testID="review-deck-settings-save-error"
          />
        ) : null}
        <SettingsAction
          label={t("settingsResetLabel")}
          hint={t("settingsResetHint")}
          actionLabel={t("settingsResetLabel")}
          onPress={() => void settings.reset()}
          disabled={settings.saving}
          testID="review-deck-settings-reset"
        />
        <SettingsAction
          label={t("settingsReloadLabel")}
          hint={t("settingsReloadHint")}
          actionLabel={t("settingsReloadLabel")}
          onPress={() => void settings.reload()}
          disabled={settings.saving}
          testID="review-deck-settings-reload"
        />
      </>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={{ paddingVertical: 4, paddingHorizontal: CONTENT_PADDING }}
      keyboardShouldPersistTaps="handled"
    >
      {content}
    </ScrollView>
  );
}

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsRow,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { resolveConfiguredLocale } from "./locale";
import { detectLocale, makeT } from "./i18n";
import { clearAiReviewCache } from "../shared/review";
import {
  reviewDeckSettings,
  type ReviewDeckSettingsValues,
  type ReviewDiffModeSetting,
  type ReviewLocaleSetting,
} from "../shared/review-settings";

const CONTENT_PADDING = 16;

type ReviewerStrategy = ReviewDeckSettingsValues["reviewerStrategy"];
type ReviewBudgetPreset = ReviewDeckSettingsValues["defaultReviewPreset"];

// The provider catalog is read straight from Paseo's provider snapshot, so the
// screen never ships a model list of its own: only what the host discovers may
// appear in a selector.
type ProviderThinkingOption = { id: string; label: string };
type ProviderModel = {
  id: string;
  label: string;
  isSelectable?: boolean;
  thinkingOptions?: readonly ProviderThinkingOption[];
};
type ProviderEntry = {
  provider: string;
  label?: string;
  enabled?: boolean;
  status: string;
  models?: readonly ProviderModel[];
};
type ProvidersState =
  | { status: "loading" }
  | { status: "ready"; entries: readonly ProviderEntry[] }
  | { status: "error"; error: string };
type ClearCacheState =
  | { status: "idle" }
  | { status: "clearing" }
  | { status: "cleared" }
  | { status: "empty" }
  | { status: "error"; error: string };

/** Host settings screen for Review Deck defaults: interface language, diff
 * layout, AI reviewer strategy and catalog selection, cache, usage display,
 * and the default review budget preset. Targeted/Full depth is an in-memory
 * per-run override in the review modal.
 *
 * Reviewers prefer native Read-only/Plan modes. OMP Ask is an approval-gated
 * fallback; approving a write/exec request can let the reviewer act. Provider,
 * model, and thinking options come from Paseo's current provider catalog.
 * Persisted selections that disappear stay visible as unavailable.
 *
 * Rendering follows the settings state machine from useSettings: loading,
 * read error with reload, invalid persisted data with reset, and a ready form
 * with revisioned whole-document saves and conflict reporting. */
export function ReviewDeckSettings(): ReactNode {
  const settings = useSettings(reviewDeckSettings);
  const paseo = usePaseo();
  const clearCacheRpc = useRpc(clearAiReviewCache);
  const automaticLocale = useMemo(() => detectLocale(), []);
  const configuredLocale = settings.status === "ready" ? settings.values.locale : "auto";
  const locale = resolveConfiguredLocale(configuredLocale, automaticLocale);
  const t = useMemo(() => makeT(locale), [locale]);

  const [providers, setProviders] = useState<ProvidersState>({ status: "loading" });
  const [clearState, setClearState] = useState<ClearCacheState>({ status: "idle" });

  // Discovery is an explicit wait: the selectors stay disabled until the host
  // has finished its lazy provider scan, so a slow provider never looks absent.
  useEffect(() => {
    let cancelled = false;
    void paseo.providers.waitForReady().then(
      (snapshot) => {
        if (!cancelled) setProviders({ status: "ready", entries: snapshot.entries });
      },
      (error: unknown) => {
        if (!cancelled) {
          setProviders({ status: "error", error: error instanceof Error ? error.message : String(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [paseo]);

  const onClearCache = useCallback(() => {
    setClearState({ status: "clearing" });
    void clearCacheRpc({}).then(
      (result) => setClearState(result.cleared ? { status: "cleared" } : { status: "empty" }),
      (error: unknown) => {
        setClearState({ status: "error", error: error instanceof Error ? error.message : String(error) });
      },
    );
  }, [clearCacheRpc]);

  const selectedProvider = settings.status === "ready" ? settings.values.reviewerProvider : "";
  const selectedModel = settings.status === "ready" ? settings.values.reviewerModel : "";
  const selectedThinking = settings.status === "ready" ? settings.values.reviewerThinkingOptionId : "";

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
  const strategyOptions = useMemo(
    (): ReadonlyArray<{ label: string; value: ReviewerStrategy }> => [
      { label: t("settingsReviewerStrategyInherit"), value: "inherit" },
      { label: t("settingsReviewerStrategyCustom"), value: "custom" },
    ],
    [t],
  );
  const reviewPresetOptions = useMemo(
    (): ReadonlyArray<{ label: string; value: ReviewBudgetPreset }> => [
      { label: t("settingsReviewPresetEconomical"), value: "economical" },
      { label: t("settingsReviewPresetBalanced"), value: "balanced" },
      { label: t("settingsReviewPresetDeep"), value: "deep" },
    ],
    [t],
  );

  // Enabled, ready providers are the only selectable ones; a provider that is
  // still loading or in error state is not offered as a choice.
  const usableProviders = useMemo<readonly ProviderEntry[]>(
    () =>
      providers.status === "ready"
        ? providers.entries.filter((entry) => entry.enabled !== false && entry.status === "ready")
        : [],
    [providers],
  );

  const providerOptions = useMemo((): ReadonlyArray<{ label: string; value: string }> => {
    const options = usableProviders.map((entry) => ({
      label: entry.label ?? entry.provider,
      value: entry.provider,
    }));
    if (selectedProvider !== "" && !options.some((option) => option.value === selectedProvider)) {
      options.push({
        label: `${selectedProvider} · ${t("settingsReviewerUnavailable")}`,
        value: selectedProvider,
      });
    }
    return [{ label: t("settingsReviewerSelectProvider"), value: "" }, ...options];
  }, [usableProviders, selectedProvider, t]);

  const selectedEntry = useMemo(
    () =>
      selectedProvider === ""
        ? null
        : usableProviders.find((entry) => entry.provider === selectedProvider) ?? null,
    [usableProviders, selectedProvider],
  );

  // Non-selectable models exist in a provider catalog only as references, so
  // they are never offered; the persisted model is still shown if it vanished.
  const selectableModels = useMemo<readonly ProviderModel[]>(
    () => (selectedEntry?.models ?? []).filter((model) => model.isSelectable !== false),
    [selectedEntry],
  );

  const modelOptions = useMemo((): ReadonlyArray<{ label: string; value: string }> => {
    const options = selectableModels.map((model) => ({ label: model.label, value: model.id }));
    if (selectedModel !== "" && !selectableModels.some((model) => model.id === selectedModel)) {
      options.push({
        label: `${selectedModel} · ${t("settingsReviewerUnavailable")}`,
        value: selectedModel,
      });
    }
    return [{ label: t("settingsReviewerModelDefault"), value: "" }, ...options];
  }, [selectableModels, selectedModel, t]);

  const selectedModelEntry = useMemo(
    () =>
      selectedModel === ""
        ? null
        : (selectedEntry?.models ?? []).find((model) => model.id === selectedModel) ?? null,
    [selectedEntry, selectedModel],
  );

  const thinkingOptions = useMemo((): ReadonlyArray<{ label: string; value: string }> => {
    const options = (selectedModelEntry?.thinkingOptions ?? []).map((option) => ({
      label: option.label,
      value: option.id,
    }));
    if (selectedThinking !== "" && !options.some((option) => option.value === selectedThinking)) {
      options.push({
        label: `${selectedThinking} · ${t("settingsReviewerUnavailable")}`,
        value: selectedThinking,
      });
    }
    return [{ label: t("settingsReviewerThinkingDefault"), value: "" }, ...options];
  }, [selectedModelEntry, selectedThinking, t]);

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
    const custom = values.reviewerStrategy === "custom";
    const providersReady = providers.status === "ready";
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
        <SettingsSelect
          label={t("settingsReviewerStrategyLabel")}
          hint={t("settingsReviewerStrategyHint")}
          value={values.reviewerStrategy}
          options={strategyOptions}
          onValueChange={(reviewerStrategy) => {
            if (reviewerStrategy !== values.reviewerStrategy) apply({ ...values, reviewerStrategy });
          }}
          disabled={settings.saving}
          testID="review-deck-settings-reviewer-strategy"
        />
        <SettingsRow
          label={t("settingsReviewerModeLabel")}
          hint={`${t("settingsReviewerModeFixed")} · ${t("settingsReviewerModeHint")}`}
          testID="review-deck-settings-reviewer-mode"
        />
        {providers.status === "loading" ? (
          <SettingsRow
            label={t("settingsReviewerProvidersLoading")}
            testID="review-deck-settings-providers-loading"
          />
        ) : null}
        {providers.status === "error" ? (
          <SettingsRow
            label={t("settingsReviewerProvidersFailed")}
            hint={providers.error}
            testID="review-deck-settings-providers-error"
          />
        ) : null}
        {providersReady && usableProviders.length === 0 ? (
          <SettingsRow
            label={t("settingsReviewerNoProviders")}
            testID="review-deck-settings-providers-empty"
          />
        ) : null}
        <SettingsSelect
          label={t("settingsReviewerProviderLabel")}
          hint={t("settingsReviewerProviderHint")}
          value={values.reviewerProvider}
          options={providerOptions}
          onValueChange={(reviewerProvider) => {
            // A new provider invalidates the model and thinking choice: they
            // are catalog-scoped and must never survive as a stale reference.
            if (reviewerProvider !== values.reviewerProvider) {
              apply({ ...values, reviewerProvider, reviewerModel: "", reviewerThinkingOptionId: "" });
            }
          }}
          disabled={settings.saving || !custom || !providersReady}
          testID="review-deck-settings-reviewer-provider"
        />
        <SettingsSelect
          label={t("settingsReviewerModelLabel")}
          hint={
            custom && providersReady && selectedEntry !== null && selectableModels.length === 0
              ? t("settingsReviewerNoModels")
              : t("settingsReviewerModelHint")
          }
          value={values.reviewerModel}
          options={modelOptions}
          onValueChange={(reviewerModel) => {
            if (reviewerModel !== values.reviewerModel) {
              apply({ ...values, reviewerModel, reviewerThinkingOptionId: "" });
            }
          }}
          disabled={settings.saving || !custom || selectedEntry === null}
          testID="review-deck-settings-reviewer-model"
        />
        <SettingsSelect
          label={t("settingsReviewerThinkingLabel")}
          hint={t("settingsReviewerThinkingHint")}
          value={values.reviewerThinkingOptionId}
          options={thinkingOptions}
          onValueChange={(reviewerThinkingOptionId) => {
            if (reviewerThinkingOptionId !== values.reviewerThinkingOptionId) {
              apply({ ...values, reviewerThinkingOptionId });
            }
          }}
          disabled={settings.saving || !custom || selectedModelEntry === null}
          testID="review-deck-settings-reviewer-thinking"
        />
        <SettingsSwitch
          label={t("settingsAiReviewCacheLabel")}
          hint={t("settingsAiReviewCacheHint")}
          value={values.aiReviewCacheEnabled}
          onValueChange={(aiReviewCacheEnabled) => {
            if (aiReviewCacheEnabled !== values.aiReviewCacheEnabled) {
              apply({ ...values, aiReviewCacheEnabled });
            }
          }}
          disabled={settings.saving}
          testID="review-deck-settings-ai-review-cache"
        />
        <SettingsSwitch
          label={t("settingsShowAiReviewUsageLabel")}
          hint={t("settingsShowAiReviewUsageHint")}
          value={values.showAiReviewUsage}
          onValueChange={(showAiReviewUsage) => {
            if (showAiReviewUsage !== values.showAiReviewUsage) {
              apply({ ...values, showAiReviewUsage });
            }
          }}
          disabled={settings.saving}
          testID="review-deck-settings-show-ai-review-usage"
        />
        <SettingsSelect
          label={t("settingsDefaultReviewPresetLabel")}
          hint={t("settingsDefaultReviewPresetHint")}
          value={values.defaultReviewPreset}
          options={reviewPresetOptions}
          onValueChange={(defaultReviewPreset) => {
            if (defaultReviewPreset !== values.defaultReviewPreset) {
              apply({ ...values, defaultReviewPreset });
            }
          }}
          disabled={settings.saving}
          testID="review-deck-settings-default-review-preset"
        />
        <SettingsAction
          label={t("settingsClearAiReviewCacheLabel")}
          hint={t("settingsClearAiReviewCacheHint")}
          actionLabel={
            clearState.status === "clearing"
              ? t("settingsClearAiReviewCacheClearing")
              : t("settingsClearAiReviewCacheAction")
          }
          onPress={onClearCache}
          disabled={clearState.status === "clearing"}
          testID="review-deck-settings-clear-cache"
        />
        {clearState.status === "cleared" ? (
          <SettingsRow
            label={t("settingsClearAiReviewCacheDone")}
            testID="review-deck-settings-clear-cache-result"
          />
        ) : null}
        {clearState.status === "empty" ? (
          <SettingsRow
            label={t("settingsClearAiReviewCacheEmpty")}
            testID="review-deck-settings-clear-cache-result"
          />
        ) : null}
        {clearState.status === "error" ? (
          <SettingsRow
            label={t("settingsClearAiReviewCacheFailed")}
            error={clearState.error}
            testID="review-deck-settings-clear-cache-error"
          />
        ) : null}
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

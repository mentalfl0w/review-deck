import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useSettings } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { reviewDeckSettings } from "../../shared/review-settings";
import { detectLocale, makeT } from "../i18n";
import { resolveConfiguredLocale } from "../locale";
import type { ReviewPillMenuAction } from "../review-entries";

type ReviewPillMenuProps = PluginButtonContentProps & {
  actions: readonly ReviewPillMenuAction[];
};

export function ReviewPillMenu({ actions, theme, layout, close }: ReviewPillMenuProps) {
  const settings = useSettings(reviewDeckSettings);
  const automaticLocale = useMemo(() => detectLocale(), []);
  const configuredLocale = settings.status === "ready" ? settings.values.locale : "auto";
  const locale = resolveConfiguredLocale(configuredLocale, automaticLocale);
  const t = useMemo(() => makeT(locale), [locale]);
  const toast = useToast();

  const activate = async (action: ReviewPillMenuAction) => {
    if (action.disabled) return;
    close();
    try {
      await action.onPress();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      toast.error(`${t("reviewEntryActionFailed")}: ${detail}`);
    }
  };

  return (
    <View style={{ gap: 2 }}>
      {actions.map((action) => (
        <View key={action.id}>
          {action.separatorBefore ? (
            <View style={{ height: 1, backgroundColor: theme.colors.border, marginHorizontal: 8, marginVertical: 6 }} />
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(action.labelKey)}
            accessibilityState={{ disabled: action.disabled }}
            disabled={action.disabled}
            onPress={() => { void activate(action); }}
            style={({ pressed }) => ({
              minHeight: layout.compact ? 48 : 40,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 8,
              opacity: action.disabled ? 0.45 : pressed ? 0.72 : 1,
            })}
          >
            <Icon name={action.icon} size={18} color={theme.colors.foregroundMuted} />
            <Text style={{ color: theme.colors.foreground, flexShrink: 1, fontSize: layout.compact ? 14 : 13 }}>
              {t(action.labelKey)}
            </Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

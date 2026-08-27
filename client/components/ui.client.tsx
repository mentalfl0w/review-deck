import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { TFunc } from "../i18n.client";
import type { PanelStyles } from "../styles.client";
import { severityColor, withAlpha, type Finding, type PanelLayout, type PanelTheme, type Severity } from "../tools.client";

export function SeverityBadge({ severity, label, theme, compact = false }: {
  severity: Severity;
  label: string;
  theme: PanelTheme;
  compact?: boolean;
}) {
  const color = severityColor(severity, theme);
  return (
    <View style={{ backgroundColor: withAlpha(color, 0.13), borderRadius: 999, paddingHorizontal: compact ? 6 : 7, paddingVertical: 1.5, alignSelf: "flex-start" }}>
      <Text style={{ color, fontSize: compact ? 9 : 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4, lineHeight: compact ? 12 : 13 }}>{label}</Text>
    </View>
  );
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function ActionButton({ label, hint, onPress, variant, theme, layout, disabled = false, stretch = false }: {
  label: string;
  hint?: string;
  onPress: () => void;
  variant: ButtonVariant;
  theme: PanelTheme;
  layout: PanelLayout;
  disabled?: boolean;
  stretch?: boolean;
}) {
  const c = theme.colors;
  const compact = layout.compact;
  const button = {
    primary: {
      backgroundColor: c.accent,
      paddingVertical: 8,
      paddingHorizontal: compact ? 12 : 14,
      minHeight: compact ? 40 : 36,
    },
    secondary: {
      borderWidth: 1,
      borderColor: withAlpha(c.accent, 0.5),
      paddingVertical: 8,
      paddingHorizontal: compact ? 12 : 14,
      minHeight: compact ? 40 : 36,
    },
    ghost: {
      borderWidth: 1,
      borderColor: withAlpha(c.foregroundMuted, 0.35),
      paddingVertical: 8,
      paddingHorizontal: compact ? 10 : 12,
      minHeight: compact ? 40 : 36,
    },
    danger: {
      borderWidth: 1,
      borderColor: withAlpha(c.statusDanger, 0.55),
      paddingVertical: 8,
      paddingHorizontal: compact ? 12 : 14,
      minHeight: compact ? 40 : 36,
    },
  } as const;
  const text = {
    primary: { color: c.accentForeground, fontSize: 12.5, fontWeight: "700" as const },
    secondary: { color: c.accent, fontSize: 12.5, fontWeight: "600" as const },
    ghost: { color: c.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
    danger: { color: c.statusDanger, fontSize: 12.5, fontWeight: "600" as const },
  };
  return (
    <View style={{ gap: hint ? 3 : 0, alignItems: stretch ? "stretch" : "flex-start", alignSelf: stretch ? "stretch" : undefined }}>
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={onPress}
        style={[
          { borderRadius: 7, justifyContent: "center", alignItems: "center", alignSelf: stretch ? "stretch" : "flex-start" },
          button[variant],
          disabled ? { opacity: 0.45 } : null,
        ]}
      >
        <Text style={text[variant]}>{label}</Text>
      </Pressable>
      {hint ? (
        <Text style={{ color: c.foregroundMuted, fontSize: compact ? 10 : 10.5, lineHeight: compact ? 14 : 15, maxWidth: stretch ? undefined : 280 }}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function Segmented<T extends string>({ options, value, onChange, theme, layout, stretch = false }: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  theme: PanelTheme;
  layout: PanelLayout;
  stretch?: boolean;
}) {
  return (
    <View style={{ alignSelf: stretch ? "stretch" : undefined, flexDirection: "row", borderWidth: 1, borderColor: withAlpha(theme.colors.foregroundMuted, 0.3), borderRadius: 8, padding: 2, gap: 2 }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            style={{ flex: stretch ? 1 : undefined, borderRadius: 6, paddingVertical: layout.compact ? 4 : 5, paddingHorizontal: layout.compact ? 8 : 10, backgroundColor: active ? theme.colors.accent : undefined }}
          >
            <Text style={{ color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted, fontSize: layout.compact ? 11 : 12, fontWeight: "600", textAlign: stretch ? "center" : undefined }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Full-row select control: a bordered field that opens a centered modal list.
 * Value selection is a real picker interaction, not a row of chips.
 */
export function DropdownSelect({ label, value, options, onChange, placeholder, closeLabel, theme, layout }: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  placeholder: string;
  closeLabel: string;
  theme: PanelTheme;
  layout: PanelLayout;
}) {
  const c = theme.colors;
  const compact = layout.compact;
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? null;
  // Semi-transparent, theme-derived backdrop that dims the content behind the card.
  const backdrop = withAlpha(c.foreground, 0.45);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={{
          minHeight: 38,
          flexDirection: "row",
          alignItems: "center",
          gap: compact ? 6 : 8,
          borderWidth: 1,
          borderColor: withAlpha(c.foregroundMuted, 0.3),
          borderRadius: 7,
          paddingHorizontal: compact ? 10 : 12,
          paddingVertical: compact ? 7 : 8,
          backgroundColor: withAlpha(c.foreground, 0.03),
        }}
      >
        <Text
          numberOfLines={1}
          style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: compact ? 10 : 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 }}
        >
          {label}
        </Text>
        <View style={{ flex: 1, minWidth: 0 }} />
        <Text
          numberOfLines={1}
          style={{ flexShrink: 1, color: selected ? c.foreground : c.foregroundMuted, fontSize: compact ? 12 : 13, fontWeight: selected ? "600" : "400" }}
        >
          {selected?.label ?? value ?? placeholder}
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: compact ? 11 : 12 }}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: compact ? 12 : 24, backgroundColor: backdrop }}
          onPress={() => setOpen(false)}
        >
          <Pressable
            onPress={(event) => event.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: compact ? undefined : 520,
              maxHeight: compact ? "92%" : "80%",
              borderRadius: 12,
              borderWidth: 1,
              borderColor: withAlpha(c.foregroundMuted, 0.25),
              backgroundColor: c.surface0,
              padding: compact ? 12 : 16,
              gap: compact ? 8 : 10,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: compact ? 13 : 15, fontWeight: "700" }}>{label}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setOpen(false)}
                style={{ borderWidth: 1, borderColor: withAlpha(c.foregroundMuted, 0.35), borderRadius: 999, paddingHorizontal: compact ? 8 : 10, paddingVertical: compact ? 3 : 4 }}
              >
                <Text style={{ color: c.foregroundMuted, fontSize: compact ? 10.5 : 11.5, fontWeight: "600" }}>{closeLabel}</Text>
              </Pressable>
            </View>
            {options.length > 0 ? (
              <ScrollView style={{ maxHeight: compact ? 360 : 420 }} contentContainerStyle={{ gap: 2, paddingVertical: 2 }}>
                {options.map((option) => {
                  const active = option.value === value;
                  return (
                    <Pressable
                      key={option.value}
                      accessibilityRole="button"
                      onPress={() => {
                        onChange(option.value);
                        setOpen(false);
                      }}
                      style={{
                        minHeight: 40,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        borderRadius: 7,
                        paddingHorizontal: compact ? 10 : 12,
                        paddingVertical: compact ? 6 : 8,
                        backgroundColor: active ? c.accent : undefined,
                      }}
                    >
                      <Text numberOfLines={2} style={{ flex: 1, color: active ? c.accentForeground : c.foreground, fontSize: compact ? 12.5 : 13.5, fontWeight: active ? "600" : "400" }}>
                        {option.label}
                      </Text>
                      {active ? (
                        <Text style={{ color: c.accentForeground, fontSize: compact ? 12 : 13, fontWeight: "700" }}>✓</Text>
                      ) : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : (
              <Text style={{ color: c.foregroundMuted, fontSize: compact ? 12 : 13, lineHeight: 18, paddingVertical: 6 }}>{placeholder}</Text>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

export function StringGroup({ label, items, t, styles }: {
  label: string;
  items: readonly string[];
  t: TFunc;
  styles: PanelStyles;
}) {
  if (items.length === 0) return null;
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{label}</Text>
      {items.map((item, index) => (
        <View key={index} style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.body}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

export function FindingGroup({ label, findings, t, theme, styles }: {
  label: string;
  findings: Finding[];
  t: TFunc;
  theme: PanelTheme;
  styles: PanelStyles;
}) {
  if (findings.length === 0) return null;
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{label}</Text>
      {findings.map((finding) => (
        <View key={finding.id} style={styles.bulletRow}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: severityColor(finding.severity, theme), marginTop: 6 }} />
          <View style={styles.bulletContent}>
            <Text style={[styles.body, { fontWeight: "600" }]}>{finding.summary}</Text>
            <Text style={styles.muted}>{finding.detail}</Text>
            {finding.suggestedCheck ? <Text style={styles.muted}>{t("checkSuggestion", { check: finding.suggestedCheck })}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

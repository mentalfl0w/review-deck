import assert from "node:assert/strict";
import { createRequire } from "node:module";

const requireFromRepo = createRequire(import.meta.url);
const { detectLocaleFromSignals, resolveConfiguredLocale } = requireFromRepo("../client/locale.ts") as {
  detectLocaleFromSignals: (intlLocale: unknown, browserLanguage: unknown, nativeSettings: unknown, nativeLocaleIdentifier: unknown) => "zh" | "en";
  resolveConfiguredLocale: (configuredLocale: "auto" | "zh" | "en", automaticLocale: "zh" | "en") => "zh" | "en";
};
const iosSettings = (values: Record<string, unknown>) => ({
  get(key: string): unknown {
    return values[key];
  },
});

// iOS exposes preferred languages through React Native's public Settings API;
// Intl and the region locale can still report English.
assert.equal(
  detectLocaleFromSignals(
    "en-US",
    "",
    iosSettings({ AppleLanguages: ["zh-Hans-CN", "en-US"], AppleLocale: "en_US" }),
    undefined,
  ),
  "zh",
  "the first iOS preferred language must win over English locale fallbacks",
);

assert.equal(
  detectLocaleFromSignals("en-US", "", iosSettings({ AppleLocale: "zh_CN" }), undefined),
  "zh",
  "AppleLocale remains a supported native fallback",
);
assert.equal(
  detectLocaleFromSignals("en-US", "zh-CN", null, undefined),
  "zh",
  "browser language can select Chinese when Intl reports English",
);
assert.equal(
  detectLocaleFromSignals(
    "en-US",
    "",
    iosSettings({ AppleLanguages: ["en-US", "zh-Hans-CN"], AppleLocale: "zh_CN" }),
    undefined,
  ),
  "en",
  "only the first iOS preferred language determines the UI locale",
);
assert.equal(
  detectLocaleFromSignals("en-US", "", null, {
    getConstants: () => ({ localeIdentifier: "zh_TW" }),
    localeIdentifier: "en_US",
  }),
  "zh",
  "Android TurboModule constants take precedence over legacy direct fields",
);
assert.equal(
  detectLocaleFromSignals("en-US", "", null, {
    getConstants: () => ({}),
    localeIdentifier: "zh_CN",
  }),
  "zh",
  "Android legacy locale fields remain a fallback",
);
assert.equal(
  resolveConfiguredLocale("zh", "en"),
  "zh",
  "an explicit Chinese settings value overrides an English system locale",
);
assert.equal(
  resolveConfiguredLocale("en", "zh"),
  "en",
  "an explicit English settings value overrides a Chinese system locale",
);
assert.equal(
  resolveConfiguredLocale("auto", "zh"),
  "zh",
  "auto follows the detected locale",
);

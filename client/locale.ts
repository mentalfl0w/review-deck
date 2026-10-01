export type Locale = "zh" | "en";
export type LocalePreference = "auto" | Locale;

type NativeSettingsModule = {
  get?: (key: string) => unknown;
  AppleLocale?: unknown;
  AppleLanguages?: unknown;
} | null;

function localeFromLanguage(value: unknown): Locale | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return /^zh(?:[-_]|$)/i.test(value) ? "zh" : "en";
}
function localeIdentifierFromModule(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;

  let constants: unknown;
  if ("getConstants" in value && typeof value.getConstants === "function") {
    try {
      constants = value.getConstants();
    } catch { /* native constants unavailable */ }
  }
  if (typeof constants === "object" && constants !== null && "localeIdentifier" in constants) {
    const localeIdentifier = constants.localeIdentifier;
    if (localeIdentifier !== undefined && localeIdentifier !== null) return localeIdentifier;
  }
  return "localeIdentifier" in value ? value.localeIdentifier : undefined;
}

/** Resolves platform signals through React Native's public Settings API when available. */
export function detectLocaleFromSignals(
  intlLocale: unknown,
  browserLanguage: unknown,
  nativeSettings: unknown,
  nativeLocaleIdentifier: unknown,
): Locale {
  const settings = typeof nativeSettings === "object" && nativeSettings !== null
    ? nativeSettings as NativeSettingsModule
    : null;
  let preferredLanguages: unknown;
  let appleLocale: unknown;
  try {
    preferredLanguages = settings?.get?.("AppleLanguages");
  } catch { /* native Settings bridge unavailable */ }
  try {
    appleLocale = settings?.get?.("AppleLocale");
  } catch { /* native Settings bridge unavailable */ }
  preferredLanguages ??= settings?.AppleLanguages;
  appleLocale ??= settings?.AppleLocale;
  const firstPreferredLanguage = Array.isArray(preferredLanguages) ? preferredLanguages[0] : undefined;

  return localeFromLanguage(browserLanguage)
    ?? localeFromLanguage(firstPreferredLanguage)
    ?? localeFromLanguage(appleLocale)
    ?? localeFromLanguage(localeIdentifierFromModule(nativeLocaleIdentifier))
    ?? localeFromLanguage(intlLocale)
    ?? "en";
}

export function resolveConfiguredLocale(configuredLocale: LocalePreference, automaticLocale: Locale): Locale {
  return configuredLocale === "auto" ? automaticLocale : configuredLocale;
}

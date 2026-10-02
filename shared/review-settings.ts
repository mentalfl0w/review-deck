import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { aiReviewBudgetPresetSchema } from "./review";


// Host-scoped v4 defaults for presentation, reviewer configuration, the
// default AI review budget preset, and the project-keyed Browser Preview
// target map.
export const reviewLocaleSettingSchema = z.enum(["auto", "zh", "en"]);
export type ReviewLocaleSetting = z.infer<typeof reviewLocaleSettingSchema>;

export const reviewDiffModeSettingSchema = z.enum(["auto", "unified", "split"]);
export type ReviewDiffModeSetting = z.infer<typeof reviewDiffModeSettingSchema>;

// Absolute http(s) URL with an authority: optional userinfo, then a bracketed
// IPv6 literal or a hostname, an optional port, and a path/query/hash or the
// end of the string. Deliberately an explicit pattern instead of new URL():
// React Native ships a partial URL polyfill whose host/protocol getters
// disagree with Node/Electron, and a preview target must validate the same on
// every client. The match is anchored on ^https?://, so relative references
// and every other scheme (file:, data:, javascript:, ...) can never pass.
const REVIEW_PREVIEW_URL_PATTERN =
  /^https?:\/\/(?:[^@\s/?#]*@)?(?:\[[0-9a-f:.]+\]|[^@:\s/?#]+)(?::\d+)?(?:[/?#]|$)/i;

/** Absolute http(s) check for Browser Preview targets: review previews point
 * at a locally served front-end, so relative references and every other
 * scheme (file:, data:, javascript:, ...) must never be stored or opened. */
export function isReviewPreviewUrl(value: unknown): value is string {
  return typeof value === "string" && REVIEW_PREVIEW_URL_PATTERN.test(value.trim());
}

export const reviewPreviewUrlSchema = z.string().refine(isReviewPreviewUrl, {
  message: "Preview URL must be an absolute http(s) URL",
});
export type ReviewPreviewUrl = z.infer<typeof reviewPreviewUrlSchema>;

export const reviewDeckSettingsSchema = z.object({
  // "auto" follows the system/browser language; zh/en force the panel language.
  locale: reviewLocaleSettingSchema.default("auto"),
  // "auto" picks the layout from available panel space.
  diffMode: reviewDiffModeSettingSchema.default("auto"),
  reviewerStrategy: z.enum(["inherit", "custom"]).default("inherit"),
  reviewerProvider: z.string().default(""),
  reviewerModel: z.string().default(""),
  reviewerThinkingOptionId: z.string().default(""),
  aiReviewCacheEnabled: z.boolean().default(true),
  showAiReviewUsage: z.boolean().default(true),
  defaultReviewPreset: aiReviewBudgetPresetSchema.default("balanced"),
  // Browser Preview targets keyed by Paseo project id — the URL "Open
  // Preview" hands to navigation.openBrowser. Values are strict absolute
  // http(s) URLs, so the host rejects any document carrying anything else,
  // and setProjectPreviewUrl below is the only writer that builds entries.
  projectPreviewUrls: z.record(z.string(), reviewPreviewUrlSchema).default({}),
});
export type ReviewDeckSettingsValues = z.infer<typeof reviewDeckSettingsSchema>;

/** Returns values with `projectId` mapped to `url`, leaving the other project
 * entries and every other preference untouched. Blank input (or a blank
 * project id) removes the entry; a non-blank value that is not an absolute
 * http(s) URL is ignored, so an invalid URL can never reach the document. The
 * input document is never mutated, and no-op calls return it by identity. */
export function setProjectPreviewUrl(
  values: ReviewDeckSettingsValues,
  projectId: string,
  url: string,
): ReviewDeckSettingsValues {
  const key = projectId.trim();
  if (key.length === 0) return values;
  const next = url.trim();
  const current = values.projectPreviewUrls;
  if (next.length === 0) {
    if (!(key in current)) return values;
    const rest = { ...current };
    delete rest[key];
    return { ...values, projectPreviewUrls: rest };
  }
  if (!isReviewPreviewUrl(next) || current[key] === next) return values;
  return { ...values, projectPreviewUrls: { ...current, [key]: next } };
}

/** Current stored-settings version; v4 adds the project preview URL map. */
const REVIEW_DECK_SETTINGS_VERSION = 4;

/** Drops everything the schema could never accept from a stored preview map:
 * legacy documents have no map at all, and a tampered one is sanitized here
 * instead of blocking the upgrade of the user's other preferences. */
function sanitizeProjectPreviewUrls(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sanitized: Record<string, string> = {};
  for (const [projectId, url] of Object.entries(value as Record<string, unknown>)) {
    if (projectId.trim().length === 0 || !isReviewPreviewUrl(url)) continue;
    sanitized[projectId] = url.trim();
  }
  return sanitized;
}

function migrateReviewDeckSettings(values: unknown, fromVersion: number): unknown {
  if (!values || typeof values !== "object" || Array.isArray(values)) return values;
  if (fromVersion >= REVIEW_DECK_SETTINGS_VERSION) return values;
  const stored = values as Record<string, unknown>;
  // v4 adds projectPreviewUrls; documents from earlier versions simply gain
  // the (sanitized) map.
  const withPreviewUrls: Record<string, unknown> = {
    ...stored,
    projectPreviewUrls: sanitizeProjectPreviewUrls(stored.projectPreviewUrls),
  };
  if (fromVersion >= 3) return withPreviewUrls;
  if (fromVersion < 2) {
    return {
      ...withPreviewUrls,
      reviewerStrategy: "inherit",
      reviewerProvider: "",
      reviewerModel: "",
      reviewerThinkingOptionId: "",
      aiReviewCacheEnabled: true,
      showAiReviewUsage: true,
      defaultReviewPreset: "balanced",
    };
  }
  const { defaultReviewDepth, ...preserved } = withPreviewUrls;
  return {
    ...preserved,
    defaultReviewPreset: defaultReviewDepth === "full" ? "deep" : "balanced",
  };
}

export const reviewDeckSettings = defineSettings({
  id: "review-deck",
  scope: "host",
  version: REVIEW_DECK_SETTINGS_VERSION,
  schema: reviewDeckSettingsSchema,
  migrate: migrateReviewDeckSettings,
});

export type ReviewDeckSettingsState =
  | { status: "ready"; revision: string; values: ReviewDeckSettingsValues }
  | { status: "invalid"; revision: string; error: string };

export interface ReviewDeckSettingsHandle {
  read(): Promise<ReviewDeckSettingsState>;
  subscribe(listener: (state: ReviewDeckSettingsState) => void | Promise<void>): () => void | Promise<void>;
}

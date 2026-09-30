import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { aiReviewBudgetPresetSchema } from "./review";


// Host-scoped v3 defaults for presentation, reviewer configuration, and the
// default AI review budget preset.
export const reviewLocaleSettingSchema = z.enum(["auto", "zh", "en"]);
export type ReviewLocaleSetting = z.infer<typeof reviewLocaleSettingSchema>;

export const reviewDiffModeSettingSchema = z.enum(["auto", "unified", "split"]);
export type ReviewDiffModeSetting = z.infer<typeof reviewDiffModeSettingSchema>;

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
});
export type ReviewDeckSettingsValues = z.infer<typeof reviewDeckSettingsSchema>;
function migrateReviewDeckSettings(values: unknown, fromVersion: number): unknown {
  if (!values || typeof values !== "object" || Array.isArray(values)) return values;
  if (fromVersion >= 3) return values;
  const stored = values as Record<string, unknown>;
  if (fromVersion < 2) {
    return {
      ...stored,
      reviewerStrategy: "inherit",
      reviewerProvider: "",
      reviewerModel: "",
      reviewerThinkingOptionId: "",
      aiReviewCacheEnabled: true,
      showAiReviewUsage: true,
      defaultReviewPreset: "balanced",
    };
  }
  const { defaultReviewDepth, ...preserved } = stored;
  return {
    ...preserved,
    defaultReviewPreset: defaultReviewDepth === "full" ? "deep" : "balanced",
  };
}

export const reviewDeckSettings = defineSettings({
  id: "review-deck",
  scope: "host",
  version: 3,
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

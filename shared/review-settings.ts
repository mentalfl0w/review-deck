import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Host-scoped Review Deck presentation defaults (v1). Only harmless display
// preferences live here: the panel interface language and the default diff
// layout. Agent identity, review scopes, refs, paths, comments and review
// state are deliberately never persisted as settings — they are either
// workspace-derived or stored in the separate review-state file.
export const reviewLocaleSettingSchema = z.enum(["auto", "zh", "en"]);
export type ReviewLocaleSetting = z.infer<typeof reviewLocaleSettingSchema>;

export const reviewDiffModeSettingSchema = z.enum(["auto", "unified", "split"]);
export type ReviewDiffModeSetting = z.infer<typeof reviewDiffModeSettingSchema>;

export const reviewDeckSettingsSchema = z.object({
  // "auto" follows the system/browser language; zh/en force the panel language.
  locale: reviewLocaleSettingSchema.default("auto"),
  // "auto" picks the layout from available panel space.
  diffMode: reviewDiffModeSettingSchema.default("auto"),
});
export type ReviewDeckSettingsValues = z.infer<typeof reviewDeckSettingsSchema>;

export const reviewDeckSettings = defineSettings({
  id: "review-deck",
  scope: "host",
  version: 1,
  schema: reviewDeckSettingsSchema,
});

/**
 * Node-runnable contract test for Review Deck settings v3 and the v0.8
 * enhancement schemas:
 *
 *  - shared/review-settings.ts — host-scoped v3 settings: panel locale/layout,
 *    reviewer strategy, Paseo-discovered provider/model/thinking, cache and
 *    usage display, plus a default Economical/Balanced/Deep review preset.
 *    The v1 -> v3 migration adds defaults; the v2 -> v3 migration preserves the
 *    reviewer configuration and maps the old Targeted/Full default to the
 *    nearest preset. Per-run depth overrides are not persisted in settings.
 *    Workspace/project/agent identities, paths, comments, and review state
 *    must never be persisted there.
 *  - shared/review-handoff.ts — the version-1 "review-deck-handoff" timeline
 *    item payload: exactly a positive commentCount and an ISO-8601
 *    submittedAt. The schema is .strict(): a row never carries review content,
 *    file paths, cwd, workspace/project/agent identifiers, or any other
 *    field — and it never claims the Agent's work completed.
 *
 * The shared modules are loaded through createRequire at runtime: Node's type
 * stripping runs .ts files as ESM, where relative imports need an explicit
 * extension that the repository's Bundler-resolution typecheck forbids.
 *
 * Run: node tests/review-settings-timeline.test.ts
 */
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";

// The shared modules import each other with Bundler-style specifiers (no file
// extension), which is what tsconfig's Bundler resolution expects and what the
// Paseo bundler accepts, but which Node's ESM loader never guesses. The sync
// resolve hook below bridges exactly that gap for this test: a relative
// specifier that has no extension is retried as ".ts" so the type-stripped
// module graph loads the same way the bundler resolves it.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

type ZodIssue = { path: Array<string | number> };
type SafeParseOk<T> = { success: true; data: T };
type SafeParseFail = { success: false; error: { issues: ZodIssue[] } };
type MinimalSchema<T> = {
  parse(input: unknown): T;
  safeParse(input: unknown): SafeParseOk<T> | SafeParseFail;
};
type ReviewDeckSettingsValues = {
  locale: string;
  diffMode: string;
  reviewerStrategy: string;
  reviewerProvider: string;
  reviewerModel: string;
  reviewerThinkingOptionId: string;
  aiReviewCacheEnabled: boolean;
  showAiReviewUsage: boolean;
  defaultReviewPreset: string;
};

const requireFromRepo = createRequire(import.meta.url);

function requireExport<T>(moduleExports: Record<string, unknown>, name: string): T {
  assert.ok(name in moduleExports, `shared module must export ${name}`);
  return moduleExports[name] as T;
}

const settingsModule = requireFromRepo("../shared/review-settings.ts") as Record<string, unknown>;
const reviewModule = requireFromRepo("../shared/review.ts") as Record<string, unknown>;
const handoffModule = requireFromRepo("../shared/review-handoff.ts") as Record<string, unknown>;

const reviewDeckSettings = requireExport<{
  id: string;
  scope: "host";
  version: number;
  schema: unknown;
  migrate?: (values: unknown, fromVersion: number) => unknown;
}>(settingsModule, "reviewDeckSettings");
const reviewDeckSettingsSchema = requireExport<MinimalSchema<ReviewDeckSettingsValues>>(
  settingsModule,
  "reviewDeckSettingsSchema",
);
const reviewLocaleSettingSchema = requireExport<{ options: readonly string[] }>(
  settingsModule,
  "reviewLocaleSettingSchema",
);
const reviewDiffModeSettingSchema = requireExport<{ options: readonly string[] }>(
  settingsModule,
  "reviewDiffModeSettingSchema",
);
const aiReviewDepthSchema = requireExport<{ options: readonly string[] }>(reviewModule, "aiReviewDepthSchema");
const aiReviewBudgetPresetSchema = requireExport<{ options: readonly string[] }>(
  reviewModule,
  "aiReviewBudgetPresetSchema",
);
const reviewHandoffTimelineKind = requireExport<string>(handoffModule, "reviewHandoffTimelineKind");
const reviewHandoffTimelineVersion = requireExport<number>(handoffModule, "reviewHandoffTimelineVersion");
const reviewHandoffTimelineSchema = requireExport<MinimalSchema<{ commentCount: number; submittedAt: string }>>(
  handoffModule,
  "reviewHandoffTimelineSchema",
);

const VALID_SUBMITTED_AT = "2026-09-08T10:20:30.000Z";

// Fresh installs and v1 migrations use Balanced, the middle-cost profile.
const V3_DEFAULTS: ReviewDeckSettingsValues = {
  locale: "auto",
  diffMode: "auto",
  reviewerStrategy: "inherit",
  reviewerProvider: "",
  reviewerModel: "",
  reviewerThinkingOptionId: "",
  aiReviewCacheEnabled: true,
  showAiReviewUsage: true,
  defaultReviewPreset: "balanced",
};

// ---------------------------------------------------------------------------
// 1. Review Deck settings: host-scoped v3 defaults and accepted values.
// ---------------------------------------------------------------------------
assert.equal(reviewDeckSettings.id, "review-deck", "settings id must be review-deck");
assert.equal(reviewDeckSettings.scope, "host", "review defaults must be host-scoped (never per-workspace)");
assert.equal(reviewDeckSettings.version, 3, "review defaults must be version 3");
assert.equal(reviewDeckSettings.schema, reviewDeckSettingsSchema, "settings must expose the same schema they validate with");

assert.deepEqual(
  reviewDeckSettingsSchema.parse({}),
  V3_DEFAULTS,
  "fresh installs default to Balanced with cache and token usage on",
);
for (const locale of ["auto", "zh", "en"]) {
  assert.deepEqual(reviewDeckSettingsSchema.parse({ locale }), { ...V3_DEFAULTS, locale });
}
for (const diffMode of ["auto", "unified", "split"]) {
  assert.deepEqual(reviewDeckSettingsSchema.parse({ diffMode }), { ...V3_DEFAULTS, diffMode });
}
for (const reviewerStrategy of ["inherit", "custom"]) {
  assert.deepEqual(reviewDeckSettingsSchema.parse({ reviewerStrategy }), { ...V3_DEFAULTS, reviewerStrategy });
}
for (const defaultReviewPreset of ["economical", "balanced", "deep"]) {
  assert.deepEqual(
    reviewDeckSettingsSchema.parse({ defaultReviewPreset }),
    { ...V3_DEFAULTS, defaultReviewPreset },
    `preset ${defaultReviewPreset} must be accepted`,
  );
}
assert.deepEqual(reviewLocaleSettingSchema.options, ["auto", "zh", "en"]);
assert.deepEqual(reviewDiffModeSettingSchema.options, ["auto", "unified", "split"]);
assert.deepEqual(aiReviewBudgetPresetSchema.options, ["economical", "balanced", "deep"]);
assert.deepEqual(aiReviewDepthSchema.options, ["targeted", "full"], "Targeted/Full remain per-run overrides");

assert.deepEqual(
  reviewDeckSettingsSchema.parse({ locale: "en", diffMode: "split" }),
  { ...V3_DEFAULTS, locale: "en", diffMode: "split" },
  "explicit locale and diff layout remain independent settings",
);
assert.deepEqual(
  reviewDeckSettingsSchema.parse({
    reviewerStrategy: "custom",
    reviewerProvider: "anthropic",
    reviewerModel: "claude-elegy",
    reviewerThinkingOptionId: "high",
    aiReviewCacheEnabled: false,
    showAiReviewUsage: false,
    defaultReviewPreset: "deep",
  }),
  {
    ...V3_DEFAULTS,
    reviewerStrategy: "custom",
    reviewerProvider: "anthropic",
    reviewerModel: "claude-elegy",
    reviewerThinkingOptionId: "high",
    aiReviewCacheEnabled: false,
    showAiReviewUsage: false,
    defaultReviewPreset: "deep",
  },
  "custom reviewer settings and budget preset round-trip",
);

const settingsRejections: Array<{ values: unknown; path: string; label: string }> = [
  { values: { locale: "fr" }, path: "locale", label: "locale outside auto|zh|en" },
  { values: { locale: 5 }, path: "locale", label: "non-string locale" },
  { values: { locale: null }, path: "locale", label: "null locale" },
  { values: { diffMode: "side-by-side" }, path: "diffMode", label: "diffMode outside auto|unified|split" },
  { values: { diffMode: 3 }, path: "diffMode", label: "non-string diffMode" },
  { values: { reviewerStrategy: "workspace" }, path: "reviewerStrategy", label: "reviewerStrategy outside inherit|custom" },
  { values: { reviewerStrategy: true }, path: "reviewerStrategy", label: "non-string reviewerStrategy" },
  { values: { reviewerProvider: 5 }, path: "reviewerProvider", label: "non-string reviewerProvider" },
  { values: { reviewerModel: null }, path: "reviewerModel", label: "null reviewerModel" },
  { values: { reviewerThinkingOptionId: false }, path: "reviewerThinkingOptionId", label: "non-string reviewerThinkingOptionId" },
  { values: { aiReviewCacheEnabled: "yes" }, path: "aiReviewCacheEnabled", label: "non-boolean aiReviewCacheEnabled" },
  { values: { showAiReviewUsage: 1 }, path: "showAiReviewUsage", label: "non-boolean showAiReviewUsage" },
  { values: { defaultReviewPreset: "fast" }, path: "defaultReviewPreset", label: "unknown review preset" },
];
for (const { values, path, label } of settingsRejections) {
  const result = reviewDeckSettingsSchema.safeParse(values);
  assert.equal(result.success, false, `${label} must be rejected`);
  if (!result.success) {
    assert.ok(result.error.issues.some((issue) => issue.path[0] === path), `${label} must fail on ${path}`);
  }
}

// Migrations retain the user's harmless preferences and reviewer configuration.
assert.equal(typeof reviewDeckSettings.migrate, "function", "reviewDeckSettings must define migrations");
const migrate = reviewDeckSettings.migrate;
assert.ok(migrate, "migration must be callable after the typeof check");

assert.deepEqual(
  reviewDeckSettingsSchema.parse(migrate({ locale: "zh", diffMode: "split" }, 1)),
  { ...V3_DEFAULTS, locale: "zh", diffMode: "split" },
  "v1 migration preserves display settings and adds v3 reviewer defaults",
);
assert.deepEqual(
  reviewDeckSettingsSchema.parse(migrate({ locale: "en" }, 1)),
  { ...V3_DEFAULTS, locale: "en" },
  "a v1 document without diffMode still defaults to auto",
);

const v2CustomSettings = {
  locale: "zh",
  diffMode: "split",
  reviewerStrategy: "custom",
  reviewerProvider: "omp",
  reviewerModel: "model-x",
  reviewerThinkingOptionId: "high",
  aiReviewCacheEnabled: false,
  showAiReviewUsage: false,
  defaultReviewDepth: "full",
};
assert.deepEqual(
  reviewDeckSettingsSchema.parse(migrate(v2CustomSettings, 2)),
  {
    ...V3_DEFAULTS,
    locale: "zh",
    diffMode: "split",
    reviewerStrategy: "custom",
    reviewerProvider: "omp",
    reviewerModel: "model-x",
    reviewerThinkingOptionId: "high",
    aiReviewCacheEnabled: false,
    showAiReviewUsage: false,
    defaultReviewPreset: "deep",
  },
  "v2 Full depth maps to Deep without losing the custom reviewer settings",
);
assert.deepEqual(
  reviewDeckSettingsSchema.parse(migrate({ locale: "en", diffMode: "unified", defaultReviewDepth: "targeted" }, 2)),
  { ...V3_DEFAULTS, locale: "en", diffMode: "unified", defaultReviewPreset: "balanced" },
  "v2 Targeted depth maps to Balanced",
);
const futureSettings = { locale: "en", defaultReviewPreset: "deep", futureOption: true };
assert.equal(migrate(futureSettings, 3), futureSettings, "same-version settings are not reset by migration");
assert.equal(migrate(futureSettings, 4), futureSettings, "future-version settings are not downgraded by migration");

// Non-object input is handed to the schema untouched: the migration never
// fabricates a document out of a corrupt store.
const nonObjectInputs: unknown[] = [null, undefined, 7, "review-deck", []];
for (const input of nonObjectInputs) {
  assert.equal(
    migrate(input, 1),
    input,
    `migration must pass a non-object document (${JSON.stringify(input)}) through unchanged`,
  );
}

// ---------------------------------------------------------------------------
// 2. Submission timeline row: one content-minimal, versioned plugin kind whose
//    data is strictly a positive commentCount and an ISO submittedAt.
// ---------------------------------------------------------------------------
assert.equal(reviewHandoffTimelineKind, "review-deck-handoff", "handoff timeline kind must be review-deck-handoff");
assert.equal(reviewHandoffTimelineVersion, 1, "handoff timeline payload must be version 1");

// 2a. Accepted payloads: positive integer count + ISO-8601 timestamp, with no
//     transformation of the submitted values.
for (const submittedAt of [VALID_SUBMITTED_AT, "2026-09-08T10:20:30Z", "2026-09-08T10:20:30.123Z"]) {
  const parsed = reviewHandoffTimelineSchema.parse({ commentCount: 1, submittedAt });
  assert.deepEqual(parsed, { commentCount: 1, submittedAt }, `payload with submittedAt ${submittedAt} must parse untouched`);
}
assert.deepEqual(
  reviewHandoffTimelineSchema.parse({ commentCount: 12, submittedAt: VALID_SUBMITTED_AT }),
  { commentCount: 12, submittedAt: VALID_SUBMITTED_AT },
  "a larger positive count must parse untouched",
);

// 2b. Positive integer constraint on commentCount.
const invalidCounts: Array<{ count: unknown; label: string }> = [
  { count: 0, label: "zero commentCount" },
  { count: -1, label: "negative commentCount" },
  { count: 2.5, label: "fractional commentCount" },
  { count: "3", label: "string commentCount" },
  { count: null, label: "null commentCount" },
  { count: undefined, label: "missing commentCount" },
];
for (const { count, label } of invalidCounts) {
  const result = reviewHandoffTimelineSchema.safeParse({ commentCount: count, submittedAt: VALID_SUBMITTED_AT });
  assert.equal(result.success, false, `${label} must be rejected`);
  if (!result.success) {
    assert.ok(
      result.error.issues.some((issue) => issue.path[0] === "commentCount"),
      `${label} must fail on the commentCount field`,
    );
  }
}

// 2c. ISO-8601 datetime constraint on submittedAt: the row always records when
//     the submission happened, so a bare date, a space-separated local time,
//     a non-timestamp, or a missing timestamp must all be rejected.
const invalidTimestamps: Array<{ submittedAt: unknown; label: string }> = [
  { submittedAt: "2026-09-08", label: "date-only submittedAt" },
  { submittedAt: "2026-09-08 10:20:30", label: "space-separated local-time submittedAt" },
  { submittedAt: "not-a-timestamp", label: "non-ISO submittedAt" },
  { submittedAt: 5, label: "numeric submittedAt" },
  { submittedAt: undefined, label: "missing submittedAt" },
];
for (const { submittedAt, label } of invalidTimestamps) {
  const result = reviewHandoffTimelineSchema.safeParse({ commentCount: 1, submittedAt });
  assert.equal(result.success, false, `${label} must be rejected`);
  if (!result.success) {
    assert.ok(
      result.error.issues.some((issue) => issue.path[0] === "submittedAt"),
      `${label} must fail on the submittedAt field`,
    );
  }
}

// 2d. Strict rejection of forbidden fields: the payload is content-minimal by
//     contract, so review content, paths, cwd, and workspace/project/agent
//     identifiers must never slip into a row — each one alone, a generic
//     extra field, and the whole set together are all rejected.
const validBase = { commentCount: 3, submittedAt: VALID_SUBMITTED_AT };
const forbiddenPayloads: Array<Record<string, unknown>> = [
  { comment: "please tighten this loop" },
  { hunkPatch: "diff --git a/src/a.ts b/src/a.ts" },
  { hunkHeader: "@@ -1,2 +1,2 @@" },
  { filePath: "src/a.ts" },
  { hunkId: "hunk-1" },
  { cwd: "/worktree/repo" },
  { workspaceId: "ws-1" },
  { projectId: "proj-1" },
  { agentId: "agent-1" },
  { prompt: "Process every saved review comment below as one task." },
  { content: "the human comment body" },
  { unrelated: "anything else" },
  {
    comment: "please tighten this loop",
    hunkPatch: "diff --git a/src/a.ts b/src/a.ts",
    hunkHeader: "@@ -1,2 +1,2 @@",
    filePath: "src/a.ts",
    hunkId: "hunk-1",
    cwd: "/worktree/repo",
    workspaceId: "ws-1",
    projectId: "proj-1",
    agentId: "agent-1",
    prompt: "Process every saved review comment below as one task.",
    content: "the human comment body",
  },
];
for (const extra of forbiddenPayloads) {
  const result = reviewHandoffTimelineSchema.safeParse({ ...validBase, ...extra });
  assert.equal(
    result.success,
    false,
    `a timeline payload carrying ${Object.keys(extra).join(", ")} must be rejected by the strict schema`,
  );
}

console.log("review-settings-timeline: all assertions passed");
console.log("verdict: reviewDeckSettings is a host-scoped v3 definition whose schema defaults");
console.log("         locale/diffMode to auto and the reviewer to inherit + no provider/model/thinking +");
console.log("         cache on + usage on + Balanced preset. It accepts Economical/Balanced/Deep budgets");
console.log("         and Targeted/Full per-run overrides, rejects invalid values, maps v2 Full to Deep");
console.log("         and v2 Targeted to Balanced, preserving reviewer settings during migration.");
console.log("         Corrupt non-object documents pass through unchanged. The version-1 handoff row is content-minimal:");
console.log("         exactly a positive integer commentCount plus an ISO-8601 submittedAt, strictly parsed —");
console.log("         review content, patch text, file paths, hunk ids, cwd, and workspace/project/agent");
console.log("         identifiers are all rejected, so the row can record only that a submission happened.");

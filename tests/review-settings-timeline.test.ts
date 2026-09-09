/**
 * Node-runnable contract test for the v0.8 Review Deck enhancement schemas:
 *
 *  - shared/review-settings.ts — host-scoped v1 presentation defaults: the
 *    panel locale (auto | zh | en) and default diff layout
 *    (auto | unified | split). Only harmless display preferences may live in
 *    settings; agent identity, scopes, paths, comments and review state must
 *    never be persisted there.
 *  - shared/review-handoff.ts — the version-1 "review-deck-handoff" timeline
 *    item payload: exactly a positive commentCount and an ISO-8601
 *    submittedAt. The schema is .strict(): a row never carries review content,
 *    file paths, cwd, workspace/project/agent identifiers, or any other
 *    field — and it never claims the Agent's work completed.
 *
 * The shared modules are loaded through createRequire at runtime: Node's
 * type stripping runs .ts files as ESM, where a relative import needs an
 * explicit ".ts" extension, which the repository's Bundler-resolution
 * typecheck forbids. Every required export is asserted present and cast to a
 * minimal structural type, so an export rename fails this test with a clear
 * message instead of a silent undefined.
 *
 * Run: node tests/review-settings-timeline.test.ts
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

type ZodIssue = { path: Array<string | number> };
type SafeParseOk<T> = { success: true; data: T };
type SafeParseFail = { success: false; error: { issues: ZodIssue[] } };
type MinimalSchema<T> = {
  parse(input: unknown): T;
  safeParse(input: unknown): SafeParseOk<T> | SafeParseFail;
};

const requireFromRepo = createRequire(import.meta.url);

function requireExport<T>(moduleExports: Record<string, unknown>, name: string): T {
  assert.ok(name in moduleExports, `shared module must export ${name}`);
  return moduleExports[name] as T;
}

const settingsModule = requireFromRepo("../shared/review-settings.ts") as Record<string, unknown>;
const handoffModule = requireFromRepo("../shared/review-handoff.ts") as Record<string, unknown>;

const reviewDeckSettings = requireExport<{
  id: string;
  scope: "host";
  version: number;
  schema: unknown;
}>(settingsModule, "reviewDeckSettings");
const reviewDeckSettingsSchema = requireExport<MinimalSchema<{ locale: string; diffMode: string }>>(
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
const reviewHandoffTimelineKind = requireExport<string>(handoffModule, "reviewHandoffTimelineKind");
const reviewHandoffTimelineVersion = requireExport<number>(handoffModule, "reviewHandoffTimelineVersion");
const reviewHandoffTimelineSchema = requireExport<MinimalSchema<{ commentCount: number; submittedAt: string }>>(
  handoffModule,
  "reviewHandoffTimelineSchema",
);

const VALID_SUBMITTED_AT = "2026-09-08T10:20:30.000Z";

// ---------------------------------------------------------------------------
// 1. Review Deck settings: a HOST-scoped v1 definition whose schema carries
//    exactly the two harmless display defaults.
// ---------------------------------------------------------------------------
assert.equal(reviewDeckSettings.id, "review-deck", "settings id must be review-deck");
assert.equal(reviewDeckSettings.scope, "host", "review defaults must be host-scoped (never per-workspace)");
assert.equal(reviewDeckSettings.version, 1, "review defaults must be version 1");
assert.equal(reviewDeckSettings.schema, reviewDeckSettingsSchema, "settings must expose the same schema they validate with");

// 1a. Default values: an empty document parses to auto/auto.
assert.deepEqual(
  reviewDeckSettingsSchema.parse({}),
  { locale: "auto", diffMode: "auto" },
  "missing settings must default to locale auto and diffMode auto",
);

// 1b. Accepted enum values: each locale and each diff mode parses, and an
//     omitted key still receives its default.
for (const locale of ["auto", "zh", "en"]) {
  const parsed = reviewDeckSettingsSchema.parse({ locale });
  assert.equal(parsed.locale, locale, `locale ${locale} must be accepted`);
  assert.equal(parsed.diffMode, "auto", "omitted diffMode must default to auto");
}
for (const diffMode of ["auto", "unified", "split"]) {
  const parsed = reviewDeckSettingsSchema.parse({ diffMode });
  assert.equal(parsed.diffMode, diffMode, `diffMode ${diffMode} must be accepted`);
  assert.equal(parsed.locale, "auto", "omitted locale must default to auto");
}
assert.deepEqual(
  reviewDeckSettingsSchema.parse({ locale: "en", diffMode: "split" }),
  { locale: "en", diffMode: "split" },
  "an explicit locale+diffMode combination must be accepted",
);

// The leaf enums are exported, so the accepted values are the advertised ones.
assert.deepEqual(reviewLocaleSettingSchema.options, ["auto", "zh", "en"], "locale enum must stay auto|zh|en");
assert.deepEqual(reviewDiffModeSettingSchema.options, ["auto", "unified", "split"], "diffMode enum must stay auto|unified|split");

// 1c. Rejection of invalid values: out-of-enum and wrong-typed values fail on
//     the offending field.
const settingsRejections: Array<{ values: unknown; path: string; label: string }> = [
  { values: { locale: "fr" }, path: "locale", label: "locale outside auto|zh|en" },
  { values: { locale: 5 }, path: "locale", label: "non-string locale" },
  { values: { locale: null }, path: "locale", label: "null locale" },
  { values: { diffMode: "side-by-side" }, path: "diffMode", label: "diffMode outside auto|unified|split" },
  { values: { diffMode: 3 }, path: "diffMode", label: "non-string diffMode" },
];
for (const { values, path, label } of settingsRejections) {
  const result = reviewDeckSettingsSchema.safeParse(values);
  assert.equal(result.success, false, `${label} must be rejected`);
  if (!result.success) {
    assert.ok(
      result.error.issues.some((issue) => issue.path[0] === path),
      `${label} must fail on the ${path} field`,
    );
  }
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
console.log("verdict: reviewDeckSettings is a host-scoped v1 definition (id review-deck) whose schema defaults");
console.log("         locale to auto and diffMode to auto, accepts locale auto|zh|en and diffMode");
console.log("         auto|unified|split, and rejects out-of-enum or wrong-typed values on the offending");
console.log("         field. The version-1 review-deck-handoff timeline row is content-minimal: exactly a");
console.log("         positive integer commentCount plus an ISO-8601 submittedAt, strictly parsed — review");
console.log("         content, patch text, file paths, hunk ids, cwd, and workspace/project/agent");
console.log("         identifiers are all rejected, so the row can record only that a submission happened.");

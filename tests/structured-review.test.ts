import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { extname } from "node:path";
import type * as StructuredReviewModule from "../server/structured-review";
import type { StructuredReviewResult } from "../shared/review";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && extname(specifier) === "") {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const requireFromRepo = createRequire(import.meta.url);
const structuredReviewModule: typeof StructuredReviewModule = requireFromRepo("../server/structured-review.ts");
const {
  AI_REVIEW_OUTPUT_SCHEMA,
  normalizeStructuredReviewResult,
  parseStructuredReviewResult,
} = structuredReviewModule;

const structured = {
  summary: "The file cache can return stale entries.",
  findings: [
    {
      hunkId: "H-0123456789ab",
      filePath: "server/cache.ts",
      severity: "high",
      evidenceKind: "verified_fact",
      category: "stale cache",
      summary: "The cache key omits the provider mode.",
      detail: "A read-only and writable reviewer configuration can share the same cache entry.",
      suggestedCheck: "Add the selected mode to the cache-key inputs.",
    },
    {
      filePath: "client/review.ts",
      severity: "medium",
      evidenceKind: "ai_inference",
      category: "state handling",
      summary: "A failed refresh may leave the old result visible.",
      detail: "The refresh error path does not clear the previous result.",
    },
    {
      filePath: "tests/review.test.ts",
      severity: "low",
      evidenceKind: "human_verification_recommended",
      category: "coverage",
      summary: "The error boundary is not exercised in a mounted panel.",
      detail: "A focused UI smoke would validate the error state.",
    },
  ],
} satisfies StructuredReviewResult;

const schema = AI_REVIEW_OUTPUT_SCHEMA as {
  type: string;
  required: string[];
  additionalProperties: boolean;
  properties: Record<string, {
    type?: string;
    enum?: string[];
    required?: string[];
    items?: { properties?: Record<string, { enum?: string[] }> };
  }>;
};
assert.equal(schema.type, "object");
assert.deepEqual(schema.required, ["findings"]);
assert.equal(schema.additionalProperties, false);
assert.equal(schema.properties.findings?.type, "array");
assert.equal(schema.properties.summary?.type, "string");
assert.ok(!schema.required.includes("summary"), "summary remains optional in JSON Schema");
assert.deepEqual(schema.properties.findings?.items?.properties?.severity?.enum, [
  "critical", "high", "medium", "low", "informational",
]);
assert.deepEqual(schema.properties.findings?.items?.properties?.evidenceKind?.enum, [
  "verified_fact", "ai_inference", "human_verification_recommended",
]);

const parsed = parseStructuredReviewResult(JSON.stringify(structured));
assert.deepEqual(parsed, structured);
assert.equal(parseStructuredReviewResult("### Verified Facts\n- Markdown fallback"), null);
assert.equal(
  parseStructuredReviewResult(JSON.stringify({ ...structured, unrecognized: true })),
  null,
  "unknown top-level fields fail closed",
);
assert.equal(
  parseStructuredReviewResult(JSON.stringify({ ...structured, findings: [{ ...structured.findings[0], severity: "urgent" }] })),
  null,
  "invalid severity fails schema validation",
);

const normalized = normalizeStructuredReviewResult(structured);
assert.equal(normalized.sections.summary, structured.summary);
assert.equal(normalized.sections.verifiedFacts.length, 1);
assert.equal(normalized.sections.aiInference.length, 1);
assert.equal(normalized.sections.humanVerificationRecommended.length, 1);
assert.ok(normalized.sections.verifiedFacts[0]?.includes("server/cache.ts · H-0123456789ab"));
assert.ok(normalized.sections.verifiedFacts[0]?.includes("HIGH · stale cache"));
assert.ok(normalized.review.includes(structured.summary));
assert.ok(normalized.review.includes("Suggested check: Add the selected mode to the cache-key inputs."));

const empty = normalizeStructuredReviewResult({ findings: [] });
assert.deepEqual(empty.sections, {
  verifiedFacts: [],
  aiInference: [],
  humanVerificationRecommended: [],
});
assert.equal(empty.review, "No findings were reported.");

console.log("structured-review: all assertions passed");

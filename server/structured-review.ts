import { z } from "zod";
import {
  structuredReviewResultSchema,
  type ReviewSections,
  type StructuredReviewResult,
} from "../shared/review";

/** JSON Schema sent to Paseo's agent creation request; Zod remains the validator. */
export const AI_REVIEW_OUTPUT_SCHEMA: Record<string, unknown> = z.toJSONSchema(structuredReviewResultSchema);

/**
 * Structured output is provider-authored data. Validate the complete result
 * before mapping it into Review Deck's stable sections; malformed JSON or
 * schema drift returns null so the existing Markdown parser can handle it.
 */
export function parseStructuredReviewResult(text: string): StructuredReviewResult | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = structuredReviewResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function formatFinding(finding: StructuredReviewResult["findings"][number]): string {
  const location = finding.hunkId
    ? `${finding.filePath} · ${finding.hunkId}`
    : finding.filePath;
  return [
    `**${finding.severity.toUpperCase()} · ${finding.category}** — ${location}`,
    finding.summary,
    finding.detail,
    ...(finding.suggestedCheck ? [`Suggested check: ${finding.suggestedCheck}`] : []),
  ].join("\n\n");
}

/** Convert the validated result into the display string and source-neutral UI sections. */
export function normalizeStructuredReviewResult(result: StructuredReviewResult): {
  review: string;
  sections: ReviewSections;
} {
  const sections: ReviewSections = {
    ...(result.summary ? { summary: result.summary } : {}),
    verifiedFacts: [],
    aiInference: [],
    humanVerificationRecommended: [],
  };
  for (const finding of result.findings) {
    const formatted = formatFinding(finding);
    switch (finding.evidenceKind) {
      case "verified_fact":
        sections.verifiedFacts.push(formatted);
        break;
      case "ai_inference":
        sections.aiInference.push(formatted);
        break;
      case "human_verification_recommended":
        sections.humanVerificationRecommended.push(formatted);
        break;
    }
  }

  const reviewParts = [
    ...(result.summary ? [`## Summary\n\n${result.summary}`] : []),
    ...result.findings.map(formatFinding),
  ];
  return {
    review: reviewParts.length > 0 ? reviewParts.join("\n\n") : "No findings were reported.",
    sections,
  };
}

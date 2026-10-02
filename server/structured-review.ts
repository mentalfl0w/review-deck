import { z } from "zod";
import {
  VERIFICATION_SUGGESTION_LABEL_MAX_LENGTH,
  formatVerificationCommand,
  structuredReviewResultSchema,
  verificationCommandSchema,
  type ReviewSections,
  type ReviewVerificationSuggestion,
  type StructuredReviewResult,
  type VerificationCommand,
} from "../shared/review";
import { canonicalJson, sha256 } from "./util/crypto";

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

/** The finding's header line, used both as the section entry caption and as the
 * caption of the verification command it suggests. */
function findingLabel(finding: StructuredReviewResult["findings"][number]): string {
  const location = finding.hunkId
    ? `${finding.filePath} · ${finding.hunkId}`
    : finding.filePath;
  return `**${finding.severity.toUpperCase()} · ${finding.category}** — ${location}`;
}

function formatFinding(finding: StructuredReviewResult["findings"][number]): string {
  return [
    findingLabel(finding),
    finding.summary,
    finding.detail,
    ...(finding.suggestedCheck ? [`Suggested check: ${finding.suggestedCheck}`] : []),
    ...(finding.verificationCommand
      ? [`Verification command: ${formatVerificationCommand(finding.verificationCommand)}`]
      : []),
  ].join("\n\n");
}

/** The sections a verification suggestion can belong to: a suggestion is for
 * what still needs verifying, never for a claimed fact. */
export type VerificationSuggestionSection = "ai_inference" | "human_verification_recommended";

/** Stable id of one verification suggestion: the section it belongs to, its
 * caption, where it points, and the exact command. */
export function verificationSuggestionId(entry: {
  evidenceKind: VerificationSuggestionSection;
  label: string;
  hunkId?: string;
  filePath?: string;
  command: VerificationCommand;
}): string {
  return `VC-${sha256(canonicalJson({
    evidenceKind: entry.evidenceKind,
    label: entry.label,
    hunkId: entry.hunkId ?? null,
    filePath: entry.filePath ?? null,
    command: { executable: entry.command.executable, args: entry.command.args },
  })).slice(0, 12)}`;
}

/**
 * Build one UI suggestion (stable id, validated command, exact preview), or
 * null when the command is not a runnable executable + argv. Suggestions are
 * never executed by Review Deck: the UI shows the preview and the user
 * confirms.
 */
export function reviewVerificationSuggestion(entry: {
  evidenceKind: VerificationSuggestionSection;
  label: string;
  hunkId?: string;
  filePath?: string;
  command: VerificationCommand;
}): ReviewVerificationSuggestion | null {
  const command = verificationCommandSchema.safeParse(entry.command);
  const label = entry.label.trim().replace(/^\*\*(.+?)\*\*\s+—\s*/, "$1 — ").slice(0, VERIFICATION_SUGGESTION_LABEL_MAX_LENGTH);
  if (!command.success || label.length === 0) return null;
  return {
    id: verificationSuggestionId({ ...entry, label, command: command.data }),
    evidenceKind: entry.evidenceKind,
    label,
    ...(entry.hunkId !== undefined ? { hunkId: entry.hunkId } : {}),
    ...(entry.filePath !== undefined ? { filePath: entry.filePath } : {}),
    command: command.data,
    commandPreview: formatVerificationCommand(command.data),
  };
}

/** Convert the validated result into the display string and source-neutral UI
 * sections. A verified fact is never claimed here: a command is a suggestion,
 * and only a confirmed run that really exited 0 produces evidence. */
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
  const suggestions: ReviewVerificationSuggestion[] = [];
  const suggestedIds = new Set<string>();
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
    // A command never decorates a finding the reviewer already reports as a
    // verified fact: the suggestion is for what still needs verifying.
    if (!finding.verificationCommand || finding.evidenceKind === "verified_fact") continue;
    const suggestion = reviewVerificationSuggestion({
      evidenceKind: finding.evidenceKind,
      label: findingLabel(finding),
      ...(finding.hunkId !== undefined ? { hunkId: finding.hunkId } : {}),
      filePath: finding.filePath,
      command: finding.verificationCommand,
    });
    if (!suggestion || suggestedIds.has(suggestion.id)) continue;
    suggestedIds.add(suggestion.id);
    suggestions.push(suggestion);
  }

  const reviewParts = [
    ...(result.summary ? [`## Summary\n\n${result.summary}`] : []),
    ...result.findings.map(formatFinding),
  ];
  return {
    review: reviewParts.length > 0 ? reviewParts.join("\n\n") : "No findings were reported.",
    sections: suggestions.length > 0 ? { ...sections, verificationCommands: suggestions } : sections,
  };
}

/**
 * Markdown fallback command section. The reviewer is told to put its commands
 * under a `Verification Commands` (or `验证命令`) heading as one JSON array of
 * `{ "executable": …, "args": […] }` objects, optionally carrying `hunkId`,
 * `filePath`, `label`, and `evidenceKind`. Anything else — a missing heading, a
 * missing or malformed JSON block, an unknown key, an unrunnable command — is
 * ignored as a whole, so the fallback can never smuggle a shell string into a
 * runnable suggestion.
 */
const VERIFICATION_COMMAND_HEADINGS: Record<string, true> = {
  "verification commands": true,
  "验证命令": true,
};
/** Commands one fallback section may carry. */
const VERIFICATION_FALLBACK_ENTRY_LIMIT = 16;

const fallbackCommandEntrySchema = z.object({
  executable: z.string(),
  args: z.array(z.string()),
  hunkId: z.string().min(1).optional(),
  filePath: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  /** A suggestion is never a fact: `verified_fact` is not accepted here. */
  evidenceKind: z.enum(["ai_inference", "human_verification_recommended"]).optional(),
}).strict();

export type FallbackVerificationSection = {
  /** First and last line (inclusive, in `text.split("\n")` terms) of the
   * command section; both -1 when the fallback has none. Callers skip this span
   * so the machine-readable block never leaks into a prose section. */
  start: number;
  end: number;
  suggestions: ReviewVerificationSuggestion[];
};

const NO_FALLBACK_SECTION: FallbackVerificationSection = { start: -1, end: -1, suggestions: [] };

/**
 * Convert a Markdown fallback review into Review Deck's stable UI sections.
 * The machine-readable command section is parsed as one unit and skipped here,
 * so neither its heading nor its JSON block can leak into a prose section; a
 * fallback that names no section at all is reported as plain inference.
 */
export function reviewSectionsFromMarkdown(text: string): ReviewSections {
  const sections: ReviewSections = {
    verifiedFacts: [],
    aiInference: [],
    humanVerificationRecommended: [],
  };
  const verification = parseFallbackVerificationSection(text);
  let active: "verifiedFacts" | "aiInference" | "humanVerificationRecommended" | null = null;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (verification.start !== -1 && index >= verification.start && index <= verification.end) continue;
    const line = lines[index] ?? "";
    const heading = line.trim().toUpperCase().replace(/^#+\s*/, "").replace(/[:：]$/, "");
    if (heading === "VERIFIED FACTS" || heading === "已确认事实" || heading === "已验证事实") active = "verifiedFacts";
    else if (heading === "AI INFERENCE" || heading === "AI 推断" || heading === "AI推断") active = "aiInference";
    else if (
      heading === "HUMAN VERIFICATION RECOMMENDED"
      || heading === "建议人工确认"
      || heading === "人工验证建议"
    ) active = "humanVerificationRecommended";
    else if (active && line.trim()) sections[active].push(line.trim().replace(/^[-*]\s+/, ""));
  }
  if (sections.verifiedFacts.length === 0 && sections.aiInference.length === 0 && sections.humanVerificationRecommended.length === 0 && text.trim()) {
    sections.aiInference.push(text.trim());
  }
  return verification.suggestions.length > 0
    ? { ...sections, verificationCommands: verification.suggestions }
    : sections;
}

export function parseFallbackVerificationSection(text: string): FallbackVerificationSection {
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => {
    const heading = /^\s*#{1,6}\s+(.*?)\s*$/.exec(line);
    return heading !== null && VERIFICATION_COMMAND_HEADINGS[(heading[1] ?? "").toLowerCase()] === true;
  });
  if (headingIndex === -1) return NO_FALLBACK_SECTION;
  let end = lines.length - 1;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^\s*#{1,6}\s+\S/.test(lines[index] ?? "")) {
      end = index - 1;
      break;
    }
  }
  const section = lines.slice(headingIndex, end + 1).join("\n");
  const fenced = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/i.exec(section);
  const trimmedSection = section.trim();
  const jsonStart = trimmedSection.indexOf("[");
  const payload = fenced?.[1] !== undefined
    ? fenced[1].trim()
    : jsonStart === -1 ? "" : trimmedSection.slice(jsonStart).trim();
  if (!payload.startsWith("[")) return { start: headingIndex, end, suggestions: [] };
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { start: headingIndex, end, suggestions: [] };
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > VERIFICATION_FALLBACK_ENTRY_LIMIT) {
    return { start: headingIndex, end, suggestions: [] };
  }
  const entries = z.array(fallbackCommandEntrySchema).safeParse(value);
  if (!entries.success) return { start: headingIndex, end, suggestions: [] };
  const suggestions: ReviewVerificationSuggestion[] = [];
  const suggestedIds = new Set<string>();
  for (const entry of entries.data) {
    const command = { executable: entry.executable, args: entry.args };
    const suggestion = reviewVerificationSuggestion({
      evidenceKind: entry.evidenceKind ?? "human_verification_recommended",
      label: entry.label ?? formatVerificationCommand(command),
      ...(entry.hunkId !== undefined ? { hunkId: entry.hunkId } : {}),
      ...(entry.filePath !== undefined ? { filePath: entry.filePath } : {}),
      command,
    });
    if (!suggestion) return { start: headingIndex, end, suggestions: [] };
    if (suggestedIds.has(suggestion.id)) continue;
    suggestedIds.add(suggestion.id);
    suggestions.push(suggestion);
  }
  return { start: headingIndex, end, suggestions };
}

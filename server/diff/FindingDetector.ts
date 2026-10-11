import type { ReviewLocale, ReviewScope, ReviewSnapshot } from "../../shared/review";
import { canonicalJson, sha256 } from "../util/crypto";
import { detectFindingRuleMatches } from "./rules/index";

type Finding = ReviewSnapshot["files"][number]["hunks"][number]["findings"][number];

export function severityRank(severity: Finding["severity"]): number {
  return { critical: 5, high: 4, medium: 3, low: 2, informational: 1 }[severity];
}

export function detectFindings(
  lines: string[],
  locale: ReviewLocale = "en",
  identity?: {
    filePath: string;
    anchorFingerprint: string;
    duplicateOrdinal?: number;
    scope?: ReviewScope;
    worktreePath?: string;
  },
): Finding[] {
  const anchorFingerprint = identity?.anchorFingerprint ?? sha256(canonicalJson(lines));
  const filePath = identity?.filePath ?? "";
  const duplicateOrdinal = identity?.duplicateOrdinal ?? 0;
  return detectFindingRuleMatches(lines, locale).map((match) => ({
    id: `RF-${sha256(canonicalJson({
      source: "deterministic_rule",
      originId: match.ruleId,
      sourceVersion: match.ruleVersion,
      filePath,
      scope: identity?.scope ?? null,
      worktreePath: identity?.worktreePath ?? null,
      anchorFingerprint,
      duplicateOrdinal,
      normalizedMatch: match.matchKey,
    })).slice(0, 20)}`,
    category: match.category,
    severity: match.severity,
    evidenceKind: match.evidenceKind,
    summary: match.summary,
    detail: match.detail,
    ...(match.suggestedCheck !== undefined ? { suggestedCheck: match.suggestedCheck } : {}),
    source: "deterministic_rule",
    originId: match.ruleId,
    sourceVersion: match.ruleVersion,
    anchorFingerprint,
  }));
}

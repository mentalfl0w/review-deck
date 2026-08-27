import { randomUUID } from "node:crypto";
 import type { ReviewSnapshot } from "../../review.shared";

type Finding = ReviewSnapshot["files"][number]["hunks"][number]["findings"][number];

export function severityRank(severity: Finding["severity"]): number {
  return { critical: 5, high: 4, medium: 3, low: 2, informational: 1 }[severity];
}

export function detectFindings(lines: string[]): Finding[] {
  const changed = lines.filter((line) => line.startsWith("+")).join("\n");
  const removed = lines.filter((line) => line.startsWith("-")).join("\n");
  const findings: Finding[] = [];
  const add = (category: string, severity: Finding["severity"], summary: string, detail: string, check?: string) => {
    findings.push({ id: randomUUID(), category, severity, evidenceKind: "verified_fact", summary, detail, ...(check ? { suggestedCheck: check } : {}) });
  };
  if (/\b(public|export|pub\s+|extern\s+|interface\s+|class\s+)/.test(changed)) {
    add("breaking_api_change", "high", "Public surface may have changed", "Added lines contain a public/exported declaration.", "Check callers and compatibility commitments.");
  }
  if (/\b(mutex|lock_guard|rwlock|synchronized|atomic|await\s+.*lock|lock\s*\()/.test(changed)) {
    add("concurrency", "high", "Synchronization code changed", "Added lines contain lock, mutex, atomic, or synchronization constructs.", "Check lock ordering, scope, cancellation, and race coverage.");
  }
  if (/\b(crypto|cipher|curve|scalar|nonce|hash|sign|verify|constant[_-]?time|mod(?:ulo)?\b)/i.test(changed)) {
    add("cryptography_algorithm", "high", "Cryptographic or algorithmic code changed", "Added lines match cryptography or arithmetic vocabulary.", "Compare against the specification and known-answer test vectors.");
  }
  if (/\b(catch|throw|Error\b|Exception\b|Result<|Err\(|panic!|unwrap\()/.test(changed) || /\b(catch|throw|Error\b|Exception\b)/.test(removed)) {
    add("error_handling", "medium", "Error-handling behavior changed", "Changed lines contain error handling constructs.", "Check error mapping, cleanup, retry behavior, and observable status codes.");
  }
  if (/\b(migration|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE|schema\b)/i.test(changed)) {
    add("database_migration", "high", "Database or schema change detected", "Added lines match migration or schema operations.", "Check upgrade, rollback, backfill, locking, and deployed compatibility.");
  }
  if (/\b(for|while)\b/.test(changed) && /\b(sort|collect|clone|alloc|push_back|append)\b/.test(changed)) {
    add("performance_regression", "medium", "Loop with allocation or collection change", "Added lines contain a loop and allocation/collection vocabulary.", "Check complexity and benchmark hot paths.");
  }
  if (findings.length === 0) {
    findings.push({
      id: randomUUID(),
      category: "behavior_semantic_change",
      severity: "informational",
      evidenceKind: "verified_fact",
      summary: "Source behavior changed",
      detail: "This hunk contains source additions/removals but no high-signal deterministic category.",
    });
  }
  return findings;
}

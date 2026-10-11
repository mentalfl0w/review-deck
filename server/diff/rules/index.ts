import type { ReviewLocale } from "../../../shared/review";

/**
 * Pure, deterministic finding-rule registry for diff hunks.
 *
 * This module owns the six high-signal regex rules plus the semantic-change
 * fallback that the local (non-AI) detector applies to a hunk's changed lines.
 * It mirrors `server/diff/FindingDetector.ts` exactly: same trigger conditions,
 * same severities, same English/Chinese copy, and the same fallback that only
 * appears when no high-signal rule matched.
 *
 * Unlike the detector it is pure: it allocates no ids, reads no clock, and
 * never consults a target fingerprint. Callers combine the returned
 * `matchKey` with their own file/hunk content identity and hash the pair.
 */

/** Severity vocabulary shared with `ReviewSnapshot` findings. */
export type FindingRuleSeverity = "critical" | "high" | "medium" | "low" | "informational";

/** Every deterministic rule this registry can emit, including the fallback. */
export type FindingRuleId =
  | "breaking_api_change"
  | "concurrency"
  | "cryptography_algorithm"
  | "error_handling"
  | "database_migration"
  | "performance_regression"
  | "behavior_semantic_change";

/** Deterministic matches stay evidence-classified as verified facts. */
export type FindingRuleEvidenceKind = "verified_fact";

export type FindingRuleCopy = {
  summary: string;
  detail: string;
  suggestedCheck?: string;
};

export type FindingRuleMatch = {
  /** Stable identity of the rule that produced the match. */
  ruleId: FindingRuleId;
  /** Monotonic version of `ruleId`'s trigger and copy; bump on any change. */
  ruleVersion: number;
  /** Finding category; one-to-one with `ruleId` for the deterministic rules. */
  category: FindingRuleId;
  severity: FindingRuleSeverity;
  evidenceKind: FindingRuleEvidenceKind;
  summary: string;
  detail: string;
  suggestedCheck?: string;
  /**
   * Normalized, content-derived identity for this match
   * (`<ruleId>@v<version>#<normalized evidence>`). It is deterministic for
   * identical input and excludes any file/hunk identity, so callers hash it
   * together with the hunk's content identity rather than on its own.
   */
  matchKey: string;
};

type RuleTarget = "changed" | "removed";
type RulePattern = { readonly target: RuleTarget; readonly pattern: RegExp };
type RuleDefinition = {
  readonly ruleId: FindingRuleId;
  readonly ruleVersion: number;
  readonly severity: FindingRuleSeverity;
  /** `any`: at least one pattern must match; `all`: every pattern must match. */
  readonly mode: "any" | "all";
  readonly patterns: readonly RulePattern[];
};

const FINDING_RULE_COPY: Record<FindingRuleId, Record<ReviewLocale, FindingRuleCopy>> = {
  breaking_api_change: {
    en: {
      summary: "Public surface may have changed",
      detail: "Added lines contain a public/exported declaration.",
      suggestedCheck: "Check callers and compatibility commitments.",
    },
    zh: {
      summary: "公开接口可能发生变化",
      detail: "新增代码包含公开或导出的声明。",
      suggestedCheck: "检查调用方及兼容性约束。",
    },
  },
  concurrency: {
    en: {
      summary: "Synchronization code changed",
      detail: "Added lines contain lock, mutex, atomic, or synchronization constructs.",
      suggestedCheck: "Check lock ordering, scope, cancellation, and race coverage.",
    },
    zh: {
      summary: "同步代码发生变化",
      detail: "新增代码包含锁、互斥量、原子操作或其他同步结构。",
      suggestedCheck: "检查锁顺序、作用域、取消处理和竞态覆盖。",
    },
  },
  cryptography_algorithm: {
    en: {
      summary: "Cryptographic or algorithmic code changed",
      detail: "Added lines match cryptography or arithmetic vocabulary.",
      suggestedCheck: "Compare against the specification and known-answer test vectors.",
    },
    zh: {
      summary: "加密或算法代码发生变化",
      detail: "新增代码匹配加密或算术相关词汇。",
      suggestedCheck: "对照规范和已知答案测试向量检查。",
    },
  },
  error_handling: {
    en: {
      summary: "Error-handling behavior changed",
      detail: "Changed lines contain error handling constructs.",
      suggestedCheck: "Check error mapping, cleanup, retry behavior, and observable status codes.",
    },
    zh: {
      summary: "错误处理行为发生变化",
      detail: "变更代码包含错误处理结构。",
      suggestedCheck: "检查错误映射、清理、重试行为及可观察状态码。",
    },
  },
  database_migration: {
    en: {
      summary: "Database or schema change detected",
      detail: "Added lines match migration or schema operations.",
      suggestedCheck: "Check upgrade, rollback, backfill, locking, and deployed compatibility.",
    },
    zh: {
      summary: "检测到数据库或 schema 变更",
      detail: "新增代码匹配迁移或 schema 操作。",
      suggestedCheck: "检查升级、回滚、回填、锁定以及部署兼容性。",
    },
  },
  performance_regression: {
    en: {
      summary: "Loop with allocation or collection change",
      detail: "Added lines contain a loop and allocation/collection vocabulary.",
      suggestedCheck: "Check complexity and benchmark hot paths.",
    },
    zh: {
      summary: "检测到循环中的分配或集合变化",
      detail: "新增代码同时包含循环和分配/集合相关词汇。",
      suggestedCheck: "检查复杂度和性能热点。",
    },
  },
  behavior_semantic_change: {
    en: {
      summary: "Source behavior changed",
      detail: "This hunk contains source additions/removals but no high-signal deterministic category.",
    },
    zh: {
      summary: "源代码行为发生变化",
      detail: "此变更块包含源代码新增/删除，但未命中高信号确定性类别。",
    },
  },
};

/** High-signal rules, evaluated in order; the fallback covers "none matched". */
const HIGH_SIGNAL_RULES: readonly RuleDefinition[] = [
  {
    ruleId: "breaking_api_change",
    ruleVersion: 1,
    severity: "high",
    mode: "any",
    patterns: [
      { target: "changed", pattern: /\b(public|export|pub\s+|extern\s+|interface\s+|class\s+)/ },
    ],
  },
  {
    ruleId: "concurrency",
    ruleVersion: 1,
    severity: "high",
    mode: "any",
    patterns: [
      { target: "changed", pattern: /\b(mutex|lock_guard|rwlock|synchronized|atomic|await\s+.*lock|lock\s*\()/ },
    ],
  },
  {
    ruleId: "cryptography_algorithm",
    ruleVersion: 1,
    severity: "high",
    mode: "any",
    patterns: [
      {
        target: "changed",
        pattern: /\b(crypto|cipher|curve|scalar|nonce|hash|sign|verify|constant[_-]?time|mod(?:ulo)?\b)/i,
      },
    ],
  },
  {
    ruleId: "error_handling",
    ruleVersion: 1,
    severity: "medium",
    mode: "any",
    patterns: [
      { target: "changed", pattern: /\b(catch|throw|Error\b|Exception\b|Result<|Err\(|panic!|unwrap\()/ },
      { target: "removed", pattern: /\b(catch|throw|Error\b|Exception\b)/ },
    ],
  },
  {
    ruleId: "database_migration",
    ruleVersion: 1,
    severity: "high",
    mode: "any",
    patterns: [
      { target: "changed", pattern: /\b(migration|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE|schema\b)/i },
    ],
  },
  {
    ruleId: "performance_regression",
    ruleVersion: 1,
    severity: "medium",
    mode: "all",
    patterns: [
      { target: "changed", pattern: /\b(for|while)\b/ },
      { target: "changed", pattern: /\b(sort|collect|clone|alloc|push_back|append)\b/ },
    ],
  },
];

const FALLBACK_RULE_ID: FindingRuleId = "behavior_semantic_change";
const FALLBACK_RULE_VERSION = 1;
const FALLBACK_SEVERITY: FindingRuleSeverity = "informational";

/**
 * Collect every match of every pattern, whitespace/case-normalized and
 * side-qualified, so the evidence string is stable for identical input and
 * distinguishes additions from removals.
 */
function collectEvidence(texts: Record<RuleTarget, string>, patterns: readonly RulePattern[]): string[] {
  const tokens: string[] = [];
  for (const { target, pattern } of patterns) {
    const global = new RegExp(pattern.source, `${pattern.flags}g`);
    const text = texts[target];
    let match: RegExpExecArray | null;
    while ((match = global.exec(text)) !== null) {
      if (match[0].length === 0) {
        global.lastIndex += 1;
        continue;
      }
      const normalized = match[0].replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.length > 0) tokens.push(`${target}:${normalized}`);
    }
  }
  return tokens;
}

/**
 * Evaluate the deterministic rules against one hunk's raw diff lines.
 *
 * Lines are split the same way the detector splits them: additions joined from
 * `+`-prefixed lines, removals from `-`-prefixed lines. Every high-signal rule
 * that matches contributes one match, in registry order; when none match the
 * single `behavior_semantic_change` fallback is returned. The result is pure
 * and repeatable for identical input.
 */
export function detectFindingRuleMatches(
  lines: string[],
  locale: ReviewLocale = "en",
): FindingRuleMatch[] {
  const changed = lines.filter((line) => line.startsWith("+")).join("\n");
  const removed = lines.filter((line) => line.startsWith("-")).join("\n");
  const texts: Record<RuleTarget, string> = { changed, removed };

  const matches: FindingRuleMatch[] = [];
  for (const rule of HIGH_SIGNAL_RULES) {
    const isMatch =
      rule.mode === "any"
        ? rule.patterns.some(({ target, pattern }) => pattern.test(texts[target]))
        : rule.patterns.every(({ target, pattern }) => pattern.test(texts[target]));
    if (!isMatch) continue;

    const evidence = collectEvidence(texts, rule.patterns);
    const base = `${rule.ruleId}@v${rule.ruleVersion}`;
    matches.push({
      ruleId: rule.ruleId,
      ruleVersion: rule.ruleVersion,
      category: rule.ruleId,
      severity: rule.severity,
      evidenceKind: "verified_fact",
      ...FINDING_RULE_COPY[rule.ruleId][locale],
      matchKey: evidence.length > 0 ? `${base}#${evidence.join("|")}` : base,
    });
  }

  if (matches.length === 0) {
    matches.push({
      ruleId: FALLBACK_RULE_ID,
      ruleVersion: FALLBACK_RULE_VERSION,
      category: FALLBACK_RULE_ID,
      severity: FALLBACK_SEVERITY,
      evidenceKind: "verified_fact",
      ...FINDING_RULE_COPY[FALLBACK_RULE_ID][locale],
      matchKey: `${FALLBACK_RULE_ID}@v${FALLBACK_RULE_VERSION}`,
    });
  }

  return matches;
}

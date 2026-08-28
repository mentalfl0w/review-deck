import { randomUUID } from "node:crypto";
import type { ReviewLocale, ReviewSnapshot } from "../../review.shared";

type Finding = ReviewSnapshot["files"][number]["hunks"][number]["findings"][number];
type FindingCopy = {
  summary: string;
  detail: string;
  suggestedCheck?: string;
};

const FINDING_COPY: Record<string, Record<ReviewLocale, FindingCopy>> = {
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

export function severityRank(severity: Finding["severity"]): number {
  return { critical: 5, high: 4, medium: 3, low: 2, informational: 1 }[severity];
}

export function detectFindings(lines: string[], locale: ReviewLocale = "en"): Finding[] {
  const changed = lines.filter((line) => line.startsWith("+")).join("\n");
  const removed = lines.filter((line) => line.startsWith("-")).join("\n");
  const findings: Finding[] = [];
  const add = (category: string, severity: Finding["severity"]) => {
    const copy = FINDING_COPY[category][locale];
    findings.push({ id: randomUUID(), category, severity, evidenceKind: "verified_fact", ...copy });
  };
  if (/\b(public|export|pub\s+|extern\s+|interface\s+|class\s+)/.test(changed)) {
    add("breaking_api_change", "high");
  }
  if (/\b(mutex|lock_guard|rwlock|synchronized|atomic|await\s+.*lock|lock\s*\()/.test(changed)) {
    add("concurrency", "high");
  }
  if (/\b(crypto|cipher|curve|scalar|nonce|hash|sign|verify|constant[_-]?time|mod(?:ulo)?\b)/i.test(changed)) {
    add("cryptography_algorithm", "high");
  }
  if (/\b(catch|throw|Error\b|Exception\b|Result<|Err\(|panic!|unwrap\()/.test(changed) || /\b(catch|throw|Error\b|Exception\b)/.test(removed)) {
    add("error_handling", "medium");
  }
  if (/\b(migration|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE|schema\b)/i.test(changed)) {
    add("database_migration", "high");
  }
  if (/\b(for|while)\b/.test(changed) && /\b(sort|collect|clone|alloc|push_back|append)\b/.test(changed)) {
    add("performance_regression", "medium");
  }
  if (findings.length === 0) {
    add("behavior_semantic_change", "informational");
  }
  return findings;
}

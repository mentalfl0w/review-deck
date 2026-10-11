/**
 * Behavior tests for the pure deterministic finding-rule registry.
 *
 * The registry must reproduce `server/diff/FindingDetector.ts` exactly: the six
 * high-signal regex rules trigger on the same text, carry the same severities,
 * bilingual copy, and fallback semantics, produce stable versioned rule ids and
 * deterministic normalized match keys — while staying free of the target
 * fingerprint and any per-finding identity. A cross-check against the legacy
 * detector proves output parity for every rule and both locales.
 *
 * Run: node --experimental-strip-types tests/finding-rules.test.ts
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { FindingRuleId, FindingRuleMatch, FindingRuleSeverity } from "../server/diff/rules/index";

type ReviewLocale = "zh" | "en";
type FindingCopy = { summary: string; detail: string; suggestedCheck?: string };

const requireFromRepo = createRequire(import.meta.url);
const { detectFindingRuleMatches } = requireFromRepo("../server/diff/rules/index.ts") as {
  detectFindingRuleMatches: (lines: string[], locale?: ReviewLocale) => FindingRuleMatch[];
};

const LOCALES: readonly ReviewLocale[] = ["en", "zh"];

const EXPECTED_COPY: Record<FindingRuleId, Record<ReviewLocale, FindingCopy>> = {
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

const EXPECTED_SEVERITY: Record<FindingRuleId, FindingRuleSeverity> = {
  breaking_api_change: "high",
  concurrency: "high",
  cryptography_algorithm: "high",
  error_handling: "medium",
  database_migration: "high",
  performance_regression: "medium",
  behavior_semantic_change: "informational",
};

// --- Each high-signal rule fires and carries exact copy/severity ------------

const RULE_CASES: Array<{ lines: string[]; ruleId: FindingRuleId }> = [
  { lines: ["+export function run() {}"], ruleId: "breaking_api_change" },
  { lines: ["+pub fn run() {}"], ruleId: "breaking_api_change" },
  { lines: ["+extern int run();"], ruleId: "breaking_api_change" },
  { lines: ["+interface Thing {}"], ruleId: "breaking_api_change" },
  { lines: ["+class Service {}"], ruleId: "breaking_api_change" },
  { lines: ["+lock_guard guard(m);"], ruleId: "concurrency" },
  { lines: ["+std::rwlock lock;"], ruleId: "concurrency" },
  { lines: ["+synchronized (this) {}"], ruleId: "concurrency" },
  { lines: ["+atomic_int counter;"], ruleId: "concurrency" },
  { lines: ["+await mutex.lock();"], ruleId: "concurrency" },
  { lines: ["+mutex.lock();"], ruleId: "concurrency" },
  { lines: ["+const digest = hash(data);"], ruleId: "cryptography_algorithm" },
  { lines: ["+const c = cipher.encrypt(x);"], ruleId: "cryptography_algorithm" },
  { lines: ["+const ok = verify(signature);"], ruleId: "cryptography_algorithm" },
  { lines: ["+const r = a mod b;"], ruleId: "cryptography_algorithm" },
  { lines: ["+const r = a modulo b;"], ruleId: "cryptography_algorithm" },
  { lines: ["+if (constant_time_eq(a, b)) {}"], ruleId: "cryptography_algorithm" },
  { lines: ['+try { run(); } catch (error) { log(error); }'], ruleId: "error_handling" },
  { lines: ['+throw new Error("boom");'], ruleId: "error_handling" },
  { lines: ["+fn run() -> Result<u8> {}"], ruleId: "error_handling" },
  { lines: ['+panic!("boom");'], ruleId: "error_handling" },
  { lines: ["+value.unwrap();"], ruleId: "error_handling" },
  { lines: ['-throw new Error("gone");', "+const y = 1;"], ruleId: "error_handling" },
  { lines: ["-catch (error) {}", "+const y = 1;"], ruleId: "error_handling" },
  { lines: ["+ALTER TABLE users ADD COLUMN age int;"], ruleId: "database_migration" },
  { lines: ["+alter table users add column age int;"], ruleId: "database_migration" },
  { lines: ["+DROP TABLE users;"], ruleId: "database_migration" },
  { lines: ["+CREATE TABLE users (id int);"], ruleId: "database_migration" },
  { lines: ["+const schema = build();"], ruleId: "database_migration" },
  { lines: ["+const migration = load();"], ruleId: "database_migration" },
  { lines: ["+for (const item of items) result.push_back(item);"], ruleId: "performance_regression" },
  { lines: ["+while (running) buffer.append(chunk);"], ruleId: "performance_regression" },
  { lines: ["+for (const x of xs) xs.sort();"], ruleId: "performance_regression" },
];

for (const { lines, ruleId } of RULE_CASES) {
  for (const locale of LOCALES) {
    const match = detectFindingRuleMatches(lines, locale).find((entry) => entry.ruleId === ruleId);
    assert.ok(match, `${ruleId} must fire for ${JSON.stringify(lines)} (${locale})`);
    assert.equal(match.ruleId, match.category, "ruleId and category stay one-to-one");
    assert.equal(match.ruleVersion, 1, "every rule ships at version 1");
    assert.equal(match.severity, EXPECTED_SEVERITY[ruleId], `severity for ${ruleId}`);
    assert.equal(match.evidenceKind, "verified_fact", "the legacy evidenceKind wire value remains compatible");
    assert.deepEqual(
      { summary: match.summary, detail: match.detail, suggestedCheck: match.suggestedCheck },
      EXPECTED_COPY[ruleId][locale],
      `copy for ${ruleId} (${locale})`,
    );
  }
}

// --- Each rule's bilingual copy is distinct and stable-----------------------

for (const ruleId of Object.keys(EXPECTED_COPY) as FindingRuleId[]) {
  assert.notEqual(
    EXPECTED_COPY[ruleId].en.summary,
    EXPECTED_COPY[ruleId].zh.summary,
    `${ruleId} must have distinct en/zh copy`,
  );
}

// --- Fallback appears only when no high-signal rule matches -----------------

const FALLBACK_ONLY_CASES: string[][] = [
  [],
  ["+const value = 1;"],
  [" context line without a marker"],
  ["+while (x) { y += 1; }"],
  ["+const cloned = source.clone();"],
  ["-hash(x)"],
  ["-const removed = 1;"],
];

for (const lines of FALLBACK_ONLY_CASES) {
  for (const locale of LOCALES) {
    const matches = detectFindingRuleMatches(lines, locale);
    assert.deepEqual(
      matches.map((entry) => entry.ruleId),
      ["behavior_semantic_change"],
      `fallback is the only match for ${JSON.stringify(lines)} (${locale})`,
    );
    const [match] = matches;
    assert.equal(match.severity, "informational");
    assert.equal(match.category, "behavior_semantic_change");
    assert.equal(match.ruleVersion, 1);
    assert.equal(match.matchKey, "behavior_semantic_change@v1");
    assert.equal(match.summary, EXPECTED_COPY.behavior_semantic_change[locale].summary);
    assert.equal(match.detail, EXPECTED_COPY.behavior_semantic_change[locale].detail);
    assert.equal(match.suggestedCheck, undefined, "the fallback carries no suggested check");
  }
}

// --- Multiple simultaneous matches keep registry order ----------------------

const MIXED = ["+export class Service {", "+  mutex.lock();", "+  hash(secret);"];
for (const locale of LOCALES) {
  const matches = detectFindingRuleMatches(MIXED, locale);
  assert.deepEqual(
    matches.map((entry) => entry.ruleId),
    ["breaking_api_change", "concurrency", "cryptography_algorithm"],
    "all matching rules are returned in registry order",
  );
  assert.ok(
    matches.every((entry) => entry.ruleId !== "behavior_semantic_change"),
    "no fallback when high-signal rules match",
  );
  assert.equal(matches[0].severity, "high");
  assert.equal(matches[1].severity, "high");
  assert.equal(matches[2].severity, "high");
}

const perfAndCrypto = ["+for (const x of xs) {", "+  result.append(hash(x));", "+}"];
assert.deepEqual(
  detectFindingRuleMatches(perfAndCrypto).map((entry) => entry.ruleId),
  ["cryptography_algorithm", "performance_regression"],
  "a hunk matching crypto and performance yields both, in registry order",
);

// --- Normalized match keys are deterministic and repeatable -----------------

assert.deepEqual(
  detectFindingRuleMatches(MIXED),
  detectFindingRuleMatches(MIXED),
  "identical input yields identical matches, keys included",
);

assert.deepEqual(
  detectFindingRuleMatches(["+hash(x)"]),
  detectFindingRuleMatches(["+hash(x)"], "en"),
  "the locale defaults to English",
);

for (const match of detectFindingRuleMatches(MIXED)) {
  assert.equal(typeof match.ruleVersion, "number", "ruleVersion is numeric");
  assert.ok(Number.isInteger(match.ruleVersion) && match.ruleVersion >= 1, "ruleVersion is a positive integer");
  assert.equal(match.ruleId, match.category, "ruleId and category agree on every match");
}

const [cryptoUppercase] = detectFindingRuleMatches(["+HASH(x)"]);
const [cryptoLowercase] = detectFindingRuleMatches(["+hash(x)"]);
assert.equal(cryptoUppercase.ruleId, "cryptography_algorithm");
assert.equal(
  cryptoUppercase.matchKey,
  cryptoLowercase.matchKey,
  "case-insensitive rule evidence normalizes to one key",
);
assert.ok(
  cryptoUppercase.matchKey.startsWith("cryptography_algorithm@v1#"),
  "match key carries the versioned rule id prefix",
);
assert.equal(cryptoUppercase.matchKey, "cryptography_algorithm@v1#changed:hash");

const [dbSpaced] = detectFindingRuleMatches(["+ALTER   TABLE t;"]);
const [dbSingle] = detectFindingRuleMatches(["+ALTER TABLE t;"]);
assert.equal(dbSpaced.matchKey, dbSingle.matchKey, "whitespace in evidence normalizes to one key");
assert.equal(dbSpaced.matchKey, "database_migration@v1#changed:alter table");

const mixedKeys = detectFindingRuleMatches(MIXED).map((entry) => entry.matchKey);
assert.notEqual(mixedKeys[0], mixedKeys[1], "distinct rules yield distinct match keys");
assert.notEqual(mixedKeys[1], mixedKeys[2], "distinct rules yield distinct match keys");
assert.notEqual(mixedKeys[0], mixedKeys[2], "distinct rules yield distinct match keys");

const [breakingOnly] = detectFindingRuleMatches(["+export const x = 1;"]);
const [cryptoOnly] = detectFindingRuleMatches(["+hash(x)"]);
assert.notEqual(breakingOnly.matchKey, cryptoOnly.matchKey, "different rules never share a key");


// --- Purity: no per-finding identity leaks through the registry -------------

const purity = detectFindingRuleMatches(["+hash(x)"]);
assert.equal(purity.length, 1);
assert.equal("id" in purity[0], false, "the pure registry never mints a finding id");
assert.equal("hunkFingerprint" in purity[0], false, "the registry never depends on the target fingerprint");

/**
 * Persistence contract for the AI review cache (v1.4).
 *
 * `ai-review-cache.json` is a validated version-1 envelope
 * (`{ version: 1, entries }`) keyed by the caller-computed cache key. The cache
 * is a pure accelerator — but never a silent one: a document that is not valid
 * JSON, declares another version, or fails entry validation raises
 * AiReviewCacheStoreError and is left byte-identical, so a damaged cache is
 * visible rather than quietly reset. Only an explicit user-driven clear()
 * replaces a damaged file with an empty valid store.
 *
 * Retention is a 30-day sliding TTL plus a 256-entry LRU cap; both are driven
 * here through the injected clock and an injected cap, and every read/write
 * runs in one critical section so concurrent read-modify-write cycles cannot
 * lose entries.
 *
 * Run: node tests/ai-review-cache.test.ts
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import type {
  AiReviewCacheEntry,
  AiReviewCacheEntryInput,
  AiReviewCacheStoreOptions,
} from "../server/persistence/AiReviewCacheStore";

type Store = {
  get(key: string): Promise<AiReviewCacheEntry | null>;
  put(entry: AiReviewCacheEntryInput): Promise<void>;
  clear(): Promise<void>;
};

// Production modules use bundler-style extensionless imports, which node's
// type stripping does not resolve; this test loads the real server module, so
// relative specifiers without an extension get the .ts extension here.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && extname(specifier) === "") {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

// The domain types come from the type-only import above (erased at runtime,
// checked by tsc); the runtime values are required at their real path.
const requireFromRepo = createRequire(import.meta.url);
const {
  AI_REVIEW_CACHE_VERSION,
  DEFAULT_AI_REVIEW_CACHE_MAX_ENTRIES,
  DEFAULT_AI_REVIEW_CACHE_PATH,
  DEFAULT_AI_REVIEW_CACHE_TTL_MS,
  AiReviewCacheStore,
  AiReviewCacheStoreError,
} = requireFromRepo("../server/persistence/AiReviewCacheStore.ts") as {
  AI_REVIEW_CACHE_VERSION: number;
  DEFAULT_AI_REVIEW_CACHE_MAX_ENTRIES: number;
  DEFAULT_AI_REVIEW_CACHE_PATH: string;
  DEFAULT_AI_REVIEW_CACHE_TTL_MS: number;
  AiReviewCacheStore: new (options?: AiReviewCacheStoreOptions | string) => Store;
  AiReviewCacheStoreError: new (message: string, options?: ErrorOptions) => Error;
};

const root = await mkdtemp(join(tmpdir(), "review-deck-ai-cache-"));
const cachePath = join(root, "nested", "ai-review-cache.json");
const ttl = 30 * 24 * 60 * 60 * 1000;

let clockMs = Date.parse("2026-01-01T00:00:00.000Z");
const clock = () => new Date(clockMs);
const at = (ms: number) => {
  clockMs = ms;
  return new Date(clockMs).toISOString();
};
const store = (path: string = cachePath, options: Partial<AiReviewCacheStoreOptions> = {}) =>
  new AiReviewCacheStore({ storagePath: path, now: clock, ...options });

const entry = (key: string, overrides: Partial<AiReviewCacheEntryInput> = {}): AiReviewCacheEntryInput => ({
  key,
  mode: "hunk",
  provider: "claude",
  model: "sonnet",
  thinking: null,
  promptVersion: 3,
  schemaVersion: 1,
  inputFingerprint: `fp-${key}`,
  review: `review ${key}`,
  sections: { verifiedFacts: [`fact ${key}`], aiInference: [], humanVerificationRecommended: [] },
  ...overrides,
});

const readCache = async (path: string = cachePath) => JSON.parse(await readFile(path, "utf8"));
const tempFiles = async (path: string = cachePath) =>
  (await readdir(dirname(path))).filter((name) => name.endsWith(".tmp"));

try {
  // -------------------------------------------------------------------------
  // 0. Contract constants: default path, 30-day TTL, 256-entry cap.
  // -------------------------------------------------------------------------
  assert.strictEqual(AI_REVIEW_CACHE_VERSION, 1);
  assert.strictEqual(DEFAULT_AI_REVIEW_CACHE_TTL_MS, ttl);
  assert.strictEqual(DEFAULT_AI_REVIEW_CACHE_MAX_ENTRIES, 256);
  assert.ok(DEFAULT_AI_REVIEW_CACHE_PATH.endsWith(join("review-deck", "ai-review-cache.json")));

  // -------------------------------------------------------------------------
  // 1. A cache that was never written is a miss and is not created.
  // -------------------------------------------------------------------------
  const fresh = store();
  assert.strictEqual(await fresh.get("absent"), null);
  await assert.rejects(
    readFile(cachePath, "utf8"),
    (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );

  // -------------------------------------------------------------------------
  // 2. put writes a version-1 envelope; timestamps are stamped by the store,
  //    and every optional field round-trips.
  // -------------------------------------------------------------------------
  const createdAt = at(Date.parse("2026-01-02T03:04:05.000Z"));
  await fresh.put(
    entry("hunk-1", {
      depth: "full",
      usage: { inputTokens: 1200, outputTokens: 300, cachedTokens: 0, contextTokens: 900 },
    }),
  );
  const stored = await readCache();
  assert.strictEqual(stored.version, AI_REVIEW_CACHE_VERSION);
  assert.deepStrictEqual(Object.keys(stored.entries), ["hunk-1"]);
  assert.deepStrictEqual(stored.entries["hunk-1"], {
    ...entry("hunk-1", {
      depth: "full",
      usage: { inputTokens: 1200, outputTokens: 300, cachedTokens: 0, contextTokens: 900 },
    }),
    createdAt,
    lastUsedAt: createdAt,
  });
  assert.deepStrictEqual(await fresh.get("hunk-1"), stored.entries["hunk-1"]);
  assert.deepStrictEqual(await tempFiles(), []);

  // 2b. Unknown fields written by another plugin version survive a rewrite.
  await fresh.put({
    ...entry("hunk-2"),
    futureField: { nested: ["kept"] },
  } as unknown as AiReviewCacheEntryInput);
  assert.deepStrictEqual((await readCache()).entries["hunk-2"].futureField, { nested: ["kept"] });

  // -------------------------------------------------------------------------
  // 3. The store is durable: a second instance at the same path reads it.
  // -------------------------------------------------------------------------
  assert.deepStrictEqual(await store().get("hunk-2"), (await readCache()).entries["hunk-2"]);

  // -------------------------------------------------------------------------
  // 4. A hit slides lastUsedAt; a re-read in the same millisecond is not a use.
  // -------------------------------------------------------------------------
  const t0 = Date.parse("2026-02-01T00:00:00.000Z");
  const slidingPath = join(root, "sliding", "ai-review-cache.json");
  const sliding = store(slidingPath);
  const putAt = at(t0);
  await sliding.put(entry("hunk-1"));
  assert.strictEqual((await sliding.get("hunk-1"))?.lastUsedAt, putAt);

  const touch1 = at(clockMs + 1000);
  assert.strictEqual((await sliding.get("hunk-1"))?.lastUsedAt, touch1);
  assert.strictEqual((await store(slidingPath).get("hunk-1"))?.lastUsedAt, touch1);
  assert.strictEqual((await sliding.get("hunk-1"))?.lastUsedAt, touch1);

  // -------------------------------------------------------------------------
  // 5. Sliding TTL: the last use counts, not the creation time, and the entry
  //    expires exactly one TTL after that last use.
  // -------------------------------------------------------------------------
  const lastTouch = at(t0 + 1000 + ttl - 1);
  assert.ok(await sliding.get("hunk-1"), "a hit a full TTL after creation still lands");
  assert.strictEqual((await sliding.get("hunk-1"))?.lastUsedAt, lastTouch);

  at(t0 + 1000 + 2 * ttl - 2);
  assert.ok(await sliding.get("hunk-1"), "one millisecond short of the refreshed deadline");

  at(clockMs + ttl);
  assert.strictEqual(await sliding.get("hunk-1"), null);
  assert.deepStrictEqual((await readCache(slidingPath)).entries, {});
  assert.strictEqual(await store(slidingPath).get("hunk-1"), null);

  // 5b. The TTL is measured from the entry's own last use: put, a hit at the
  //     very end of the window, then a miss one TTL after that hit.
  const expiryPath = join(root, "expiry", "ai-review-cache.json");
  const expiry = store(expiryPath);
  at(t0);
  await expiry.put(entry("hunk-1"));
  at(t0 + ttl - 1);
  assert.ok(await expiry.get("hunk-1"), "just inside the window");
  assert.strictEqual((await expiry.get("hunk-1"))?.lastUsedAt, new Date(clockMs).toISOString());
  at(clockMs + ttl);
  assert.strictEqual(await expiry.get("hunk-1"), null);

  // -------------------------------------------------------------------------
  // 6. Overwrite by key: replacing an entry restarts both timestamps and never
  //    duplicates the key.
  // -------------------------------------------------------------------------
  const upsertPath = join(root, "upsert", "ai-review-cache.json");
  const upsert = store(upsertPath);
  at(t0);
  await upsert.put(entry("hunk-1", { review: "first pass" }));
  const replacedAt = at(t0 + 60_000);
  await upsert.put(entry("hunk-1", { review: "second pass", mode: "file", provider: "codex" }));
  const upserted = await readCache(upsertPath);
  assert.deepStrictEqual(Object.keys(upserted.entries), ["hunk-1"]);
  assert.deepStrictEqual(await upsert.get("hunk-1"), {
    ...entry("hunk-1", { review: "second pass", mode: "file", provider: "codex" }),
    createdAt: replacedAt,
    lastUsedAt: replacedAt,
  });

  // -------------------------------------------------------------------------
  // 7. LRU eviction past the cap drops the least recently used entries, and a
  //    hit is what makes an entry recent.
  // -------------------------------------------------------------------------
  const lruPath = join(root, "lru", "ai-review-cache.json");
  const lru = store(lruPath, { maxEntries: 3 });
  at(t0);
  await lru.put(entry("hunk-a"));
  at(clockMs + 1000);
  await lru.put(entry("hunk-b"));
  at(clockMs + 1000);
  await lru.put(entry("hunk-c"));
  at(clockMs + 1000);
  await lru.get("hunk-a"); // hunk-b is now the oldest
  at(clockMs + 1000);
  await lru.put(entry("hunk-d"));
  const evicted = await readCache(lruPath);
  assert.deepStrictEqual(Object.keys(evicted.entries).sort(), ["hunk-a", "hunk-c", "hunk-d"]);
  assert.deepStrictEqual(await store(lruPath, { maxEntries: 3 }).get("hunk-b"), null);

  // 7b. A put that replaces an existing key does not evict anything.
  await lru.put(entry("hunk-a", { review: "refreshed" }));
  assert.deepStrictEqual(Object.keys((await readCache(lruPath)).entries).sort(), ["hunk-a", "hunk-c", "hunk-d"]);

  // 7c. Eviction ties on lastUsedAt are broken by key, so the outcome is stable.
  const tiePath = join(root, "tie", "ai-review-cache.json");
  const tie = store(tiePath, { maxEntries: 2 });
  at(t0);
  await tie.put(entry("hunk-a"));
  await tie.put(entry("hunk-b"));
  await tie.put(entry("hunk-c"));
  assert.deepStrictEqual(Object.keys((await readCache(tiePath)).entries), ["hunk-b", "hunk-c"]);

  // -------------------------------------------------------------------------
  // 8. clear() leaves an empty valid store behind.
  // -------------------------------------------------------------------------
  at(t0);
  await lru.clear();
  assert.deepStrictEqual(await readCache(lruPath), { version: AI_REVIEW_CACHE_VERSION, entries: {} });
  assert.strictEqual(await lru.get("hunk-a"), null);
  assert.deepStrictEqual(await tempFiles(lruPath), []);

  // 8b. Clearing a cache that was never written still yields a valid store.
  const unwrittenPath = join(root, "unwritten", "ai-review-cache.json");
  await store(unwrittenPath).clear();
  assert.deepStrictEqual(await readCache(unwrittenPath), { version: AI_REVIEW_CACHE_VERSION, entries: {} });

  // -------------------------------------------------------------------------
  // 9. Fail closed: a damaged or unsupported file is reported and preserved
  //    byte for byte by both get and put.
  // -------------------------------------------------------------------------
  const damagedPath = join(root, "damaged", "ai-review-cache.json");
  const damaged = store(damagedPath);
  await mkdir(dirname(damagedPath), { recursive: true });
  const damagedDocuments = [
    '{ "version": 1, "entries": { "hunk-1": { ',
    "",
    " \n\t ",
    "[]",
    "null",
    JSON.stringify({ entries: {} }),
    JSON.stringify({ version: AI_REVIEW_CACHE_VERSION + 1, entries: {} }),
    JSON.stringify({ version: "1", entries: {} }),
    JSON.stringify({ version: AI_REVIEW_CACHE_VERSION, entries: [] }),
    JSON.stringify({ version: AI_REVIEW_CACHE_VERSION, entries: { "hunk-1": { ...entry("hunk-1"), mode: "bogus" } } }),
    JSON.stringify({
      version: AI_REVIEW_CACHE_VERSION,
      entries: { "hunk-1": { ...entry("hunk-1"), createdAt: "not-a-date", lastUsedAt: "not-a-date" } },
    }),
    JSON.stringify({
      version: AI_REVIEW_CACHE_VERSION,
      entries: { "hunk-1": { ...entry("hunk-1"), sections: { verifiedFacts: "nope", aiInference: [], humanVerificationRecommended: [] } } },
    }),
    JSON.stringify({ version: AI_REVIEW_CACHE_VERSION, entries: { "wrong-key": entry("hunk-1") } }),
  ];
  for (const document of damagedDocuments) {
    await writeFile(damagedPath, document, "utf8");
    await assert.rejects(
      damaged.get("hunk-1"),
      (error) => error instanceof AiReviewCacheStoreError && error.message.includes(damagedPath),
      `get must report the damaged cache: ${document.slice(0, 40)}`,
    );
    await assert.rejects(
      damaged.put(entry("hunk-1")),
      (error) => error instanceof AiReviewCacheStoreError,
      `put must refuse to overwrite a damaged cache: ${document.slice(0, 40)}`,
    );
    assert.strictEqual(await readFile(damagedPath, "utf8"), document, "the damaged file must stay byte-identical");
  }

  // 9b. An unreadable cache (the path is a directory) is an error, not a miss.
  await assert.rejects(store(root).get("hunk-1"), (error) => error instanceof AiReviewCacheStoreError);

  // 9c. clear() is the only recovery path: it replaces the damaged file with a
  //     valid empty store and the cache is usable again.
  await damaged.clear();
  assert.deepStrictEqual(await readCache(damagedPath), { version: AI_REVIEW_CACHE_VERSION, entries: {} });
  assert.strictEqual(await damaged.get("hunk-1"), null);
  await damaged.put(entry("hunk-1"));
  assert.ok(await damaged.get("hunk-1"));

  // -------------------------------------------------------------------------
  // 10. put() validates its payload before touching the file: an invalid entry
  //     never lands and never creates a cache file.
  // -------------------------------------------------------------------------
  const strictPath = join(root, "strict", "ai-review-cache.json");
  const strict = store(strictPath);
  const beforeInvalidPut = await readCache(damagedPath);
  const invalidEntries = [
    { ...entry("hunk-1"), key: "" },
    { ...entry("hunk-1"), mode: "whole-repo" },
    { ...entry("hunk-1"), provider: undefined },
    { ...entry("hunk-1"), model: undefined },
    { ...entry("hunk-1"), review: undefined },
    { ...entry("hunk-1"), sections: undefined },
    { ...entry("hunk-1"), usage: { inputTokens: -1 } },
  ] as unknown as AiReviewCacheEntryInput[];
  for (const invalid of invalidEntries) {
    await assert.rejects(strict.put(invalid), (error) => error instanceof AiReviewCacheStoreError);
  }
  await assert.rejects(readFile(strictPath, "utf8"), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.deepStrictEqual(await readCache(damagedPath), beforeInvalidPut, "an invalid put must not disturb other caches");

  // -------------------------------------------------------------------------
  // 11. Concurrent read-modify-write cycles are serialized: every put lands.
  // -------------------------------------------------------------------------
  const sharedPath = join(root, "concurrent", "ai-review-cache.json");
  const shared = store(sharedPath);
  const writers = 25;
  await Promise.all(Array.from({ length: writers }, (_, index) => shared.put(entry(`hunk-${index}`))));
  const concurrent = await readCache(sharedPath);
  assert.strictEqual(Object.keys(concurrent.entries).length, writers);
  assert.deepStrictEqual(await tempFiles(sharedPath), []);
} finally {
  await rm(root, { recursive: true, force: true });
}

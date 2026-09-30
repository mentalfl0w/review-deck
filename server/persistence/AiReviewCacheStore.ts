import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  aiReviewDepthSchema,
  aiReviewModeSchema,
  aiReviewUsageSchema,
  reviewSectionsSchema,
  type AiReviewDepth,
  type AiReviewMode,
  type AiReviewUsage,
  type ReviewSections,
} from "../../shared/review";
import { createMutex, type Mutex } from "../util/mutex";

/**
 * One cached AI review. `key` is the caller-computed cache identity (mode,
 * input fingerprint, reviewer configuration, prompt/schema versions); the
 * store never derives it, so a key change is always a deliberate caller
 * decision. `createdAt`/`lastUsedAt` are owned by the store: they are stamped
 * on every `put` and refreshed on every hit, and are never accepted from the
 * caller.
 */
export type AiReviewCacheEntry = {
  key: string;
  mode: AiReviewMode;
  provider: string;
  model: string | null;
  thinking: string | null;
  promptVersion: number;
  schemaVersion: number;
  inputFingerprint: string;
  review: string;
  sections: ReviewSections;
  depth?: AiReviewDepth;
  usage?: AiReviewUsage;
  createdAt: string;
  lastUsedAt: string;
};

/** What a caller hands to `put`: the store stamps the two timestamps itself. */
export type AiReviewCacheEntryInput = Omit<AiReviewCacheEntry, "createdAt" | "lastUsedAt">;

/** Entries on disk, keyed by the caller-computed cache key. */
export type AiReviewCacheFile = Record<string, AiReviewCacheEntry>;

/** Envelope version written to disk. */
export const AI_REVIEW_CACHE_VERSION = 1;

export type AiReviewCacheEnvelope = {
  version: typeof AI_REVIEW_CACHE_VERSION;
  entries: AiReviewCacheFile;
};

export const DEFAULT_AI_REVIEW_CACHE_PATH = join(homedir(), ".paseo", "review-deck", "ai-review-cache.json");

/** Sliding TTL: an entry older than this (by last use) is a miss. */
export const DEFAULT_AI_REVIEW_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Hard cap on retained entries; the least recently used ones are dropped. */
export const DEFAULT_AI_REVIEW_CACHE_MAX_ENTRIES = 256;

export type AiReviewCacheStoreOptions = {
  /** Store file; defaults to the user's Review Deck directory. */
  storagePath?: string;
  /** Clock injection for TTL/LRU tests; defaults to the wall clock. */
  now?: () => Date;
  /** Sliding TTL in milliseconds; defaults to 30 days. */
  ttlMs?: number;
  /** Maximum retained entries; defaults to 256. */
  maxEntries?: number;
};

/**
 * A cache file (or payload) that could not be read, parsed, or validated.
 *
 * The cache is expendable, so this is deliberately NOT swallowed: a damaged or
 * future-version file stays on disk, byte for byte, for inspection instead of
 * being silently replaced by an empty cache. Only an explicit `clear()` — which
 * the user asks for — replaces such a file with an empty valid store.
 */
export class AiReviewCacheStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AiReviewCacheStoreError";
  }
}

/**
 * Timestamps are validated as parseable dates, not merely as strings: TTL and
 * LRU are computed from them, so an unparseable value would silently corrupt
 * both budgets instead of surfacing as a damaged store.
 */
const timestampSchema = z
  .string()
  .min(1)
  .refine((value) => Number.isFinite(Date.parse(value)), { message: "must be a parseable date" });

/**
 * Entry validation. Known fields are type-checked; unknown fields are kept, so
 * a rewrite never drops data written by a future plugin version.
 */
const cacheEntrySchema = z
  .object({
    key: z.string().min(1),
    mode: aiReviewModeSchema,
    provider: z.string(),
    model: z.string().nullable(),
    thinking: z.string().nullable(),
    promptVersion: z.number(),
    schemaVersion: z.number(),
    inputFingerprint: z.string(),
    review: z.string(),
    sections: reviewSectionsSchema,
    depth: aiReviewDepthSchema.optional(),
    usage: aiReviewUsageSchema.optional(),
    createdAt: timestampSchema,
    lastUsedAt: timestampSchema,
  })
  .loose();

const cacheFileSchema = z.record(z.string(), cacheEntrySchema);
const cacheEnvelopeSchema = z
  .object({ version: z.literal(AI_REVIEW_CACHE_VERSION), entries: cacheFileSchema })
  .loose();
/** Minimal probe: does the document declare an envelope version at all? */
const cacheVersionMarkerSchema = z.object({ version: z.number() });

/**
 * Persistence for cached AI reviews: one JSON file holding every cached review
 * under its caller-computed key.
 *
 * The file is a validated version-1 envelope (`{ version: 1, entries }`); a
 * document that is not valid JSON, declares another version, or fails entry
 * validation raises `AiReviewCacheStoreError` and is left untouched, so a
 * damaged cache is visible instead of being quietly reset. Reads that do find a
 * valid store stay inside one critical section per operation, which makes the
 * read-modify-write cycle atomic within the process; the actual write goes to a
 * temp file that is renamed into place, so a crash can never leave a truncated
 * cache. Retention is a 30-day sliding TTL plus a 256-entry LRU cap: a hit
 * refreshes `lastUsedAt`, and a `put` that overflows the cap drops the entries
 * used longest ago. The storage path, clock, TTL, and cap are constructor
 * injected so tests can drive them deterministically.
 */
export class AiReviewCacheStore {
  private readonly storagePath: string;
  private readonly clock: () => Date;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly mutex: Mutex = createMutex();

  constructor(options: AiReviewCacheStoreOptions | string = {}) {
    const resolved = typeof options === "string" ? { storagePath: options } : options;
    this.storagePath = resolved.storagePath ?? DEFAULT_AI_REVIEW_CACHE_PATH;
    this.clock = resolved.now ?? (() => new Date());
    this.ttlMs = resolved.ttlMs ?? DEFAULT_AI_REVIEW_CACHE_TTL_MS;
    this.maxEntries = resolved.maxEntries ?? DEFAULT_AI_REVIEW_CACHE_MAX_ENTRIES;
  }

  /**
   * Look up a cached review. A hit refreshes `lastUsedAt` (the TTL slides);
   * an entry at or past the TTL is dropped and reported as a miss. A damaged or
   * unsupported store raises instead of returning a miss, so the caller can
   * distinguish "not cached" from "cache unreadable".
   */
  get(key: string): Promise<AiReviewCacheEntry | null> {
    return this.mutex.run(async () => {
      const entries = await this.read();
      const entry = entries[key];
      if (entry === undefined) return null;
      const nowMs = this.clock().getTime();
      if (nowMs - Date.parse(entry.lastUsedAt) >= this.ttlMs) {
        delete entries[key];
        await this.write(entries);
        return null;
      }
      const stamped = new Date(nowMs).toISOString();
      // Same-millisecond re-reads are not a use: skip the identical rewrite.
      if (stamped !== entry.lastUsedAt) {
        entry.lastUsedAt = stamped;
        await this.write(entries);
      }
      return entry;
    });
  }

  /**
   * Insert or replace one entry under `entry.key`. Both timestamps are stamped
   * from the clock, so replacing an entry with new content also restarts its
   * TTL. The payload is validated before anything is read or written; an
   * invalid entry, or a damaged store, leaves the file untouched.
   */
  put(input: AiReviewCacheEntryInput): Promise<void> {
    const stamped = new Date(this.clock().getTime()).toISOString();
    const parsed = cacheEntrySchema.safeParse({ ...(input as object), createdAt: stamped, lastUsedAt: stamped });
    if (!parsed.success) {
      return Promise.reject(
        new AiReviewCacheStoreError(
          `AI review cache entry for ${this.storagePath} failed validation; the cache was left untouched.`,
          { cause: parsed.error },
        ),
      );
    }
    const entry = parsed.data as AiReviewCacheEntry;
    return this.mutex.run(async () => {
      const entries = await this.read();
      entries[entry.key] = entry;
      await this.write(this.evict(entries));
    });
  }

  /**
   * Discard every cached review, replacing the file with an empty valid store.
   * This is the one operation allowed to overwrite a damaged or
   * future-version cache: the user asked for it, and a corrupt file has no
   * data worth keeping.
   */
  clear(): Promise<void> {
    return this.mutex.run(() => this.write({}));
  }

  /**
   * Keep the most recently used `maxEntries` entries. Ties on `lastUsedAt` are
   * broken by key so eviction is deterministic, not insertion-order dependent.
   */
  private evict(entries: AiReviewCacheFile): AiReviewCacheFile {
    const keys = Object.keys(entries);
    if (keys.length <= this.maxEntries) return entries;
    const survivors = keys
      .sort((left, right) => {
        const delta = Date.parse(entries[left].lastUsedAt) - Date.parse(entries[right].lastUsedAt);
        if (delta !== 0) return delta;
        return left < right ? -1 : left > right ? 1 : 0;
      })
      .slice(keys.length - this.maxEntries);
    const kept: AiReviewCacheFile = {};
    for (const key of survivors) kept[key] = entries[key];
    return kept;
  }

  /** Read and validate the store; a missing file is an empty cache. */
  private async read(): Promise<AiReviewCacheFile> {
    let raw: string;
    try {
      raw = await readFile(this.storagePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return {};
      throw new AiReviewCacheStoreError(`AI review cache at ${this.storagePath} could not be read.`, {
        cause: error,
      });
    }
    return this.parse(raw);
  }

  /** Parse and validate a cache document; throws without touching the file. */
  private parse(raw: string): AiReviewCacheFile {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new AiReviewCacheStoreError(
        `AI review cache at ${this.storagePath} is not valid JSON; the file was left untouched.`,
        { cause: error },
      );
    }
    // An empty or whitespace-only file is malformed JSON (JSON.parse already
    // rejected the truly empty case); only ENOENT means "nothing cached yet".
    const marked = cacheVersionMarkerSchema.safeParse(parsed);
    if (!marked.success) {
      throw new AiReviewCacheStoreError(
        `AI review cache at ${this.storagePath} is not a version ${AI_REVIEW_CACHE_VERSION} store; the file was left untouched.`,
      );
    }
    if (marked.data.version !== AI_REVIEW_CACHE_VERSION) {
      throw new AiReviewCacheStoreError(
        `AI review cache at ${this.storagePath} uses unsupported version ${marked.data.version}; this build reads version ${AI_REVIEW_CACHE_VERSION} and left the file untouched.`,
      );
    }
    const envelope = cacheEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      throw new AiReviewCacheStoreError(
        `AI review cache at ${this.storagePath} has an invalid version ${AI_REVIEW_CACHE_VERSION} envelope; the file was left untouched.`,
        { cause: envelope.error },
      );
    }
    const entries = envelope.data.entries as AiReviewCacheFile;
    for (const [mapKey, entry] of Object.entries(entries)) {
      if (mapKey !== entry.key) {
        throw new AiReviewCacheStoreError(
          `AI review cache at ${this.storagePath} has a mismatched entry key; the file was left untouched.`,
        );
      }
    }
    return entries;
  }


  /** Write the envelope atomically: temp file in the same directory, renamed. */
  private async write(entries: AiReviewCacheFile): Promise<void> {
    const envelope: AiReviewCacheEnvelope = { version: AI_REVIEW_CACHE_VERSION, entries };
    const temporary = `${this.storagePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.storagePath), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
      await rename(temporary, this.storagePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new AiReviewCacheStoreError(`AI review cache at ${this.storagePath} could not be written.`, {
        cause: error,
      });
    }
  }
}

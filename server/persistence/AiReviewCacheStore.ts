import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  aiReviewDepthSchema,
  aiReviewModeSchema,
  aiReviewUsageSchema,
  reviewSectionsSchema,
  structuredReviewFindingSchema,
  type AiReviewDepth,
  type AiReviewMode,
  type AiReviewUsage,
  type ReviewSections,
  type StructuredReviewFinding,
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
  structuredFindings?: StructuredReviewFinding[];
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
export const AI_REVIEW_CACHE_VERSION = 2;
const LEGACY_AI_REVIEW_CACHE_VERSION = 1;

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
    structuredFindings: z.array(structuredReviewFindingSchema).optional(),
    depth: aiReviewDepthSchema.optional(),
    usage: aiReviewUsageSchema.optional(),
    createdAt: timestampSchema,
    lastUsedAt: timestampSchema,
  })
  .loose();

const cacheFileSchema = z.record(z.string(), cacheEntrySchema);
const legacyCacheEnvelopeSchema = z
  .object({ version: z.literal(LEGACY_AI_REVIEW_CACHE_VERSION), entries: cacheFileSchema })
  .loose();
const cacheEnvelopeSchema = z
  .object({ version: z.literal(AI_REVIEW_CACHE_VERSION), entries: cacheFileSchema })
  .loose();
/** Minimal probe: does the document declare an envelope version at all? */
const cacheVersionMarkerSchema = z.object({ version: z.number() });

/**
 * Persistence for cached AI reviews: one JSON file holding every cached review
 * under its caller-computed key.
 *
 * The current store is a validated version-2 envelope (`{ version: 2, entries }`).
 * Valid v1 entries are backed up byte-for-byte to a non-overwritable read-only
 * `.v1.bak` before atomic migration. Damaged and future-version files remain
 * untouched. Reads and read-modify-write operations stay inside one critical
 * section per operation; writes use a same-directory temporary file plus
 * rename. Retention is a 30-day sliding TTL plus a 256-entry LRU cap.
 * The storage path, clock, TTL, and cap are constructor-injected for tests.
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
    const parsed = this.parse(raw);
    if (parsed.version === AI_REVIEW_CACHE_VERSION) return parsed.entries;
    return this.migrateLegacy(raw, parsed.entries);
  }

  /** Parse and validate a cache document; throws without touching the file. */
  private parse(raw: string): { version: number; entries: AiReviewCacheFile } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new AiReviewCacheStoreError(
        `AI review cache at ${this.storagePath} is not valid JSON; the file was left untouched.`,
        { cause: error },
      );
    }
    const marked = cacheVersionMarkerSchema.safeParse(parsed);
    if (!marked.success) {
      throw new AiReviewCacheStoreError(
        `AI review cache at ${this.storagePath} is not a version ${AI_REVIEW_CACHE_VERSION} store; the file was left untouched.`,
      );
    }
    let version: number;
    let entries: AiReviewCacheFile;
    if (marked.data.version === LEGACY_AI_REVIEW_CACHE_VERSION) {
      const legacy = legacyCacheEnvelopeSchema.safeParse(parsed);
      if (!legacy.success) {
        throw new AiReviewCacheStoreError(
          `AI review cache at ${this.storagePath} has an invalid version ${LEGACY_AI_REVIEW_CACHE_VERSION} envelope; the file was left untouched.`,
          { cause: legacy.error },
        );
      }
      version = LEGACY_AI_REVIEW_CACHE_VERSION;
      entries = legacy.data.entries as AiReviewCacheFile;
    } else if (marked.data.version === AI_REVIEW_CACHE_VERSION) {
      const current = cacheEnvelopeSchema.safeParse(parsed);
      if (!current.success) {
        throw new AiReviewCacheStoreError(
          `AI review cache at ${this.storagePath} has an invalid version ${AI_REVIEW_CACHE_VERSION} envelope; the file was left untouched.`,
          { cause: current.error },
        );
      }
      version = AI_REVIEW_CACHE_VERSION;
      entries = current.data.entries as AiReviewCacheFile;
    } else {
      throw new AiReviewCacheStoreError(
        `AI review cache at ${this.storagePath} uses unsupported version ${marked.data.version}; this build reads versions ${LEGACY_AI_REVIEW_CACHE_VERSION} and ${AI_REVIEW_CACHE_VERSION} and left the file untouched.`,
      );
    }
    for (const [mapKey, entry] of Object.entries(entries)) {
      if (mapKey !== entry.key) {
        throw new AiReviewCacheStoreError(
          `AI review cache at ${this.storagePath} has a mismatched entry key; the file was left untouched.`,
        );
      }
    }
    return { version, entries };
  }

  private async migrateLegacy(raw: string, entries: AiReviewCacheFile): Promise<AiReviewCacheFile> {
    let current: string;
    try {
      current = await readFile(this.storagePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return {};
      throw new AiReviewCacheStoreError(`AI review cache at ${this.storagePath} could not be re-read for migration.`, {
        cause: error,
      });
    }
    if (current !== raw) {
      const latest = this.parse(current);
      if (latest.version === AI_REVIEW_CACHE_VERSION) return latest.entries;
      throw new AiReviewCacheStoreError(
        `AI review cache at ${this.storagePath} changed during version 1 migration; the file was left untouched.`,
      );
    }
    await this.backupLegacy(raw);
    let rechecked: string;
    try {
      rechecked = await readFile(this.storagePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return {};
      throw new AiReviewCacheStoreError(`AI review cache at ${this.storagePath} could not be re-read for migration.`, {
        cause: error,
      });
    }
    if (rechecked !== raw) {
      const latest = this.parse(rechecked);
      if (latest.version === AI_REVIEW_CACHE_VERSION) return latest.entries;
      throw new AiReviewCacheStoreError(
        `AI review cache at ${this.storagePath} changed during version 1 migration; the file was left untouched.`,
      );
    }
    await this.write(entries);
    return entries;
  }

  /** Create a non-overwritable, read-only copy of the v1 bytes beside the store. */
  private async backupLegacy(raw: string): Promise<void> {
    const backupPath = `${this.storagePath}.v1.bak`;
    if (await this.verifyLegacyBackup(backupPath, raw)) return;
    const temporary = `${backupPath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(backupPath), { recursive: true });
      await writeFile(temporary, raw, { encoding: "utf8", mode: 0o400, flag: "wx" });
      await link(temporary, backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST" && await this.verifyLegacyBackup(backupPath, raw)) {
        return;
      }
      throw new AiReviewCacheStoreError(`Version 1 backup for ${this.storagePath} could not be created.`, { cause: error });
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async verifyLegacyBackup(backupPath: string, raw: string): Promise<boolean> {
    let metadata: Stats;
    try {
      metadata = await lstat(backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return false;
      throw new AiReviewCacheStoreError(`Version 1 backup for ${this.storagePath} could not be inspected.`, { cause: error });
    }
    if (!metadata.isFile() || (metadata.mode & 0o222) !== 0) {
      throw new AiReviewCacheStoreError(
        `Version 1 backup for ${this.storagePath} already exists but is not a read-only regular file; migration was refused.`,
      );
    }
    let existing: string;
    try {
      existing = await readFile(backupPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return false;
      throw new AiReviewCacheStoreError(`Version 1 backup for ${this.storagePath} could not be read.`, { cause: error });
    }
    if (existing !== raw) {
      throw new AiReviewCacheStoreError(
        `Version 1 backup for ${this.storagePath} already exists with different contents; migration was refused.`,
      );
    }
    return true;
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

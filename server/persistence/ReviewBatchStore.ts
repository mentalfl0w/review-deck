import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  reviewBatchSchema,
  reviewBatchV1PayloadSchema,
  type ReviewBatch,
  type ReviewBatchStatus,
} from "../../shared/review-batch";
import { createMutex, type Mutex } from "../util/mutex";

/** Envelope version written to disk. */
export const REVIEW_BATCH_VERSION = 2;
const LEGACY_REVIEW_BATCH_VERSION = 1;

export type ReviewBatchEnvelope = {
  version: typeof REVIEW_BATCH_VERSION;
  batches: ReviewBatch[];
};

export const DEFAULT_REVIEW_BATCH_PATH = join(homedir(), ".paseo", "review-deck", "review-batches.json");

export type ReviewBatchStoreOptions = {
  /** Store file; defaults to the user's Review Deck directory. */
  storagePath?: string;
};

/**
 * A batch store (or payload) that could not be read, parsed, validated, or
 * updated without breaking an invariant.
 *
 * Deliberately not swallowed: a damaged or future-version file stays on disk,
 * byte for byte, instead of being silently replaced by an empty store, and a
 * rejected `create`/`update` never partially lands. There is no implicit
 * recovery path — the operator inspects (or deletes) the file.
 */
export class ReviewBatchStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReviewBatchStoreError";
  }
}

/**
 * Which statuses count as "still in flight"; every other status is terminal.
 * Written out in full so a new status has to decide its side explicitly.
 */
const ACTIVE_BY_STATUS: Record<ReviewBatchStatus, boolean> = {
  draft: true,
  submitted: true,
  running: true,
  completed: false,
  partial: false,
  failed: false,
};

/**
 * Both supported on-disk envelopes are strict. Version 1 is read only to
 * migrate it; only version 2 is written.
 */
const reviewBatchEnvelopeV1Schema = z
  .object({ version: z.literal(LEGACY_REVIEW_BATCH_VERSION), batches: z.array(reviewBatchV1PayloadSchema) })
  .strict();
const reviewBatchEnvelopeSchema = z
  .object({ version: z.literal(REVIEW_BATCH_VERSION), batches: z.array(reviewBatchSchema) })
  .strict();

/** Minimal probe: does the document declare an envelope version at all? */
const reviewBatchVersionMarkerSchema = z.object({ version: z.number() });

/**
 * Reject a second in-flight batch for one workspace, agent, or comment id.
 * `others` is the rest of the store (the batch under inspection is excluded
 * by its caller), so the same rule serves both `create` and `update`.
 */
function assertActiveUniqueness(others: readonly ReviewBatch[], candidate: ReviewBatch, storagePath: string): void {
  if (!ACTIVE_BY_STATUS[candidate.status]) return;
  for (const other of others) {
    if (!ACTIVE_BY_STATUS[other.status]) continue;
    if (other.workspaceId === candidate.workspaceId) {
      throw new ReviewBatchStoreError(
        `ReviewBatch store at ${storagePath} already has active ReviewBatch ${other.id} for workspace ${candidate.workspaceId}; a second active batch was rejected and the store was left untouched.`,
      );
    }
    if (other.agentId === candidate.agentId) {
      throw new ReviewBatchStoreError(
        `ReviewBatch store at ${storagePath} already has active ReviewBatch ${other.id} for agent ${candidate.agentId}; a second active batch was rejected and the store was left untouched.`,
      );
    }
  }
  const claimed = new Set(candidate.commentIds);
  for (const other of others) {
    if (!ACTIVE_BY_STATUS[other.status]) continue;
    const overlap = other.commentIds.find((commentId) => claimed.has(commentId));
    if (overlap !== undefined) {
      throw new ReviewBatchStoreError(
        `ReviewBatch store at ${storagePath} already has active ReviewBatch ${other.id} covering comment ${overlap}; a second active claim was rejected and the store was left untouched.`,
      );
    }
  }
}

/**
 * Persistence for ReviewBatches: one JSON file holding every batch, oldest
 * first, terminal batches included.
 *
 * The strict version-2 envelope is the only format this build writes. A
 * validated version-1 store is copied byte-for-byte to
 * `review-batches.json.v1.bak` before it is atomically rewritten; malformed,
 * unsupported, or damaged data is never replaced.
 *
 * Every operation runs inside one critical section. Writes use a UUID temp
 * file in the same directory and atomically rename it into place. Batch ids
 * and persisted message ids are unique; once created, a message id cannot
 * change or be removed. At most one in-flight (`draft`/`submitted`/`running`)
 * batch may exist per workspace, Agent, or comment id.
 */
export class ReviewBatchStore {
  private readonly storagePath: string;
  private readonly mutex: Mutex = createMutex();

  constructor(options: ReviewBatchStoreOptions | string = {}) {
    const resolved = typeof options === "string" ? { storagePath: options } : options;
    this.storagePath = resolved.storagePath ?? DEFAULT_REVIEW_BATCH_PATH;
  }

  /** Every stored batch, oldest first, terminal batches included. */
  list(): Promise<ReviewBatch[]> {
    return this.mutex.run(() => this.read());
  }

  /** Every stored batch of one project, terminal batches included. */
  listByProject(projectId: string): Promise<ReviewBatch[]> {
    return this.mutex.run(async () => (await this.read()).filter((batch) => batch.projectId === projectId));
  }

  /** The in-flight (`draft`/`submitted`/`running`) batches of one project. */
  listActiveByProject(projectId: string): Promise<ReviewBatch[]> {
    return this.mutex.run(async () =>
      (await this.read()).filter((batch) => batch.projectId === projectId && ACTIVE_BY_STATUS[batch.status]),
    );
  }

  /** The one in-flight batch owned by an agent, or null. */
  findActiveForAgent(agentId: string): Promise<ReviewBatch | null> {
    return this.mutex.run(async () => {
      const active = (await this.read()).find((batch) => batch.agentId === agentId && ACTIVE_BY_STATUS[batch.status]);
      return active ?? null;
    });
  }

  /**
   * Append one batch. The payload is validated before the store is read, so an
   * invalid batch never touches (or creates) the file. A duplicate batch or
   * message id, a second in-flight batch for the same agent, or an in-flight
   * batch that already claims one of this batch's comments is rejected without a write.
   */
  create(batch: ReviewBatch): Promise<ReviewBatch> {
    const parsed = reviewBatchSchema.safeParse(batch);
    if (!parsed.success) {
      return Promise.reject(
        new ReviewBatchStoreError(
          `ReviewBatch for ${this.storagePath} failed validation; the store was left untouched.`,
          { cause: parsed.error },
        ),
      );
    }
    const created = parsed.data;
    return this.mutex.run(async () => {
      const batches = await this.read();
      if (batches.some((stored) => stored.id === created.id)) {
        throw new ReviewBatchStoreError(
          `ReviewBatch store at ${this.storagePath} already stores ReviewBatch ${created.id}; the store was left untouched.`,
        );
      }
      if (
        created.delivery &&
        batches.some((stored) => stored.delivery?.messageId === created.delivery?.messageId)
      ) {
        throw new ReviewBatchStoreError(
          `ReviewBatch store at ${this.storagePath} already uses message id ${created.delivery.messageId}; the store was left untouched.`,
        );
      }
      assertActiveUniqueness(batches, created, this.storagePath);
      await this.write([...batches, created]);
      return created;
    });
  }

  /**
   * Replace one stored batch with the result of `transform`, or resolve null
   * when no batch has that id (no write happens in that case). The transformed
   * batch is validated before writing, and the id, immutable message identity,
   * and active-claim invariants are re-checked so an update cannot mint a
   * second active claim or collide with another id.
   */
  update(
    id: string,
    transform: (batch: ReviewBatch) => ReviewBatch | Promise<ReviewBatch>,
  ): Promise<ReviewBatch | null> {
    return this.mutex.run(async () => {
      const batches = await this.read();
      const index = batches.findIndex((batch) => batch.id === id);
      if (index === -1) return null;
      const parsed = reviewBatchSchema.safeParse(await transform(batches[index]));
      if (!parsed.success) {
        throw new ReviewBatchStoreError(
          `ReviewBatch store at ${this.storagePath} refused the update of ${id}: the transformed batch failed validation and the store was left untouched.`,
          { cause: parsed.error },
        );
      }
      const updated = parsed.data;
      const others = batches.filter((_, otherIndex) => otherIndex !== index);
      if (others.some((other) => other.id === updated.id)) {
        throw new ReviewBatchStoreError(
          `ReviewBatch store at ${this.storagePath} already stores ReviewBatch ${updated.id}; the update was rejected and the store was left untouched.`,
        );
      }
      if (updated.delivery?.messageId !== batches[index]?.delivery?.messageId) {
        throw new ReviewBatchStoreError(
          `ReviewBatch ${id} cannot change or remove its persisted message id; the store was left untouched.`,
        );
      }
      if (
        updated.delivery &&
        others.some((other) => other.delivery?.messageId === updated.delivery?.messageId)
      ) {
        throw new ReviewBatchStoreError(
          `ReviewBatch store at ${this.storagePath} already uses message id ${updated.delivery.messageId}; the update was rejected.`,
        );
      }
      assertActiveUniqueness(others, updated, this.storagePath);
      const next = [...batches];
      next[index] = updated;
      await this.write(next);
      return updated;
    });
  }

  /** Read, validate, and migrate the store before exposing any records. */
  private async read(): Promise<ReviewBatch[]> {
    let raw: string;
    try {
      raw = await readFile(this.storagePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
      throw new ReviewBatchStoreError(`ReviewBatch store at ${this.storagePath} could not be read.`, {
        cause: error,
      });
    }
    const document = this.parse(raw);
    return document.version === LEGACY_REVIEW_BATCH_VERSION
      ? this.migrateLegacy(raw, document.batches)
      : document.batches;
  }

  /** Parse a strict v1 or v2 envelope without touching the file. */
  private parse(raw: string): { version: 1 | 2; batches: ReviewBatch[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ReviewBatchStoreError(
        `ReviewBatch store at ${this.storagePath} is not valid JSON; the file was left untouched.`,
        { cause: error },
      );
    }
    // An empty or whitespace-only file is malformed JSON; only ENOENT means empty.
    const marked = reviewBatchVersionMarkerSchema.safeParse(parsed);
    if (!marked.success) {
      throw new ReviewBatchStoreError(
        `ReviewBatch store at ${this.storagePath} has no supported version marker; the file was left untouched.`,
      );
    }

    let version: 1 | 2;
    let batches: ReviewBatch[];
    if (marked.data.version === LEGACY_REVIEW_BATCH_VERSION) {
      const legacy = reviewBatchEnvelopeV1Schema.safeParse(parsed);
      if (!legacy.success) {
        throw new ReviewBatchStoreError(
          `ReviewBatch store at ${this.storagePath} has an invalid version 1 envelope; the file was left untouched.`,
          { cause: legacy.error },
        );
      }
      version = LEGACY_REVIEW_BATCH_VERSION;
      batches = [];
      for (const legacyBatch of legacy.data.batches) {
        const validated = reviewBatchSchema.safeParse(legacyBatch);
        if (!validated.success) {
          throw new ReviewBatchStoreError(
            `ReviewBatch store at ${this.storagePath} has an invalid version 1 batch; the file was left untouched.`,
            { cause: validated.error },
          );
        }
        batches.push(validated.data);
      }
    } else if (marked.data.version === REVIEW_BATCH_VERSION) {
      const envelope = reviewBatchEnvelopeSchema.safeParse(parsed);
      if (!envelope.success) {
        throw new ReviewBatchStoreError(
          `ReviewBatch store at ${this.storagePath} has an invalid version ${REVIEW_BATCH_VERSION} envelope; the file was left untouched.`,
          { cause: envelope.error },
        );
      }
      version = REVIEW_BATCH_VERSION;
      batches = envelope.data.batches;
    } else {
      throw new ReviewBatchStoreError(
        `ReviewBatch store at ${this.storagePath} uses unsupported version ${marked.data.version}; this build reads versions ${LEGACY_REVIEW_BATCH_VERSION} and ${REVIEW_BATCH_VERSION} and left the file untouched.`,
      );
    }

    const seen = new Set<string>();
    const seenMessageIds = new Set<string>();
    for (const batch of batches) {
      if (seen.has(batch.id)) {
        throw new ReviewBatchStoreError(
          `ReviewBatch store at ${this.storagePath} repeats ReviewBatch id ${batch.id}; the file was left untouched.`,
        );
      }
      seen.add(batch.id);
      if (batch.delivery) {
        if (seenMessageIds.has(batch.delivery.messageId)) {
          throw new ReviewBatchStoreError(
            `ReviewBatch store at ${this.storagePath} repeats message id ${batch.delivery.messageId}; the file was left untouched.`,
          );
        }
        seenMessageIds.add(batch.delivery.messageId);
      }
    }
    return { version, batches };
  }

  /** Preserve the exact legacy bytes before atomically rewriting v2. */
  private async migrateLegacy(raw: string, batches: ReviewBatch[]): Promise<ReviewBatch[]> {
    let current: string;
    try {
      current = await readFile(this.storagePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
      throw new ReviewBatchStoreError(`ReviewBatch store at ${this.storagePath} could not be re-read for migration.`, {
        cause: error,
      });
    }
    if (current !== raw) {
      const latest = this.parse(current);
      if (latest.version === REVIEW_BATCH_VERSION) return latest.batches;
      throw new ReviewBatchStoreError(
        `ReviewBatch store at ${this.storagePath} changed during version 1 migration; the file was left untouched. Retry after inspecting the store.`,
      );
    }

    await this.backupLegacy(raw);
    let rechecked: string;
    try {
      rechecked = await readFile(this.storagePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
      throw new ReviewBatchStoreError(`ReviewBatch store at ${this.storagePath} could not be re-read for migration.`, {
        cause: error,
      });
    }
    if (rechecked !== raw) {
      const latest = this.parse(rechecked);
      if (latest.version === REVIEW_BATCH_VERSION) return latest.batches;
      throw new ReviewBatchStoreError(
        `ReviewBatch store at ${this.storagePath} changed during version 1 migration; the file was left untouched. Retry after inspecting the store.`,
      );
    }
    await this.write(batches);
    return batches;
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
      throw new ReviewBatchStoreError(`Version 1 backup for ${this.storagePath} could not be created.`, { cause: error });
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
      throw new ReviewBatchStoreError(`Version 1 backup for ${this.storagePath} could not be inspected.`, { cause: error });
    }
    if (!metadata.isFile() || (metadata.mode & 0o222) !== 0) {
      throw new ReviewBatchStoreError(
        `Version 1 backup for ${this.storagePath} already exists but is not a read-only regular file; migration was refused.`,
      );
    }
    let existing: string;
    try {
      existing = await readFile(backupPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return false;
      throw new ReviewBatchStoreError(`Version 1 backup for ${this.storagePath} could not be read.`, { cause: error });
    }
    if (existing !== raw) {
      throw new ReviewBatchStoreError(
        `Version 1 backup for ${this.storagePath} already exists with different contents; migration was refused.`,
      );
    }
    return true;
  }

  /** Write the envelope atomically: temp file in the same directory, renamed. */
  private async write(batches: ReviewBatch[]): Promise<void> {
    const envelope: ReviewBatchEnvelope = { version: REVIEW_BATCH_VERSION, batches };
    const temporary = `${this.storagePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.storagePath), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
      await rename(temporary, this.storagePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new ReviewBatchStoreError(`ReviewBatch store at ${this.storagePath} could not be written.`, {
        cause: error,
      });
    }
  }
}

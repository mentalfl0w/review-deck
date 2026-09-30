import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { reviewBatchSchema, type ReviewBatch, type ReviewBatchStatus } from "../../shared/review-batch";
import { createMutex, type Mutex } from "../util/mutex";

/** Envelope version written to disk. */
export const REVIEW_BATCH_VERSION = 1;

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
 * The version-1 envelope is strict: an unknown envelope key (or an unknown key
 * on a batch, which `reviewBatchSchema` already rejects) means the document was
 * written by something this build does not understand, so it fails closed
 * rather than being rewritten.
 */
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
 * The file is a strict version-1 envelope (`{ version: 1, batches }`); a
 * document that is not valid JSON, declares another version, or fails batch
 * validation raises `ReviewBatchStoreError` and is left untouched, so a damaged
 * store is visible instead of being quietly reset. Only `ENOENT` means "nothing
 * stored yet": an empty or whitespace-only file is malformed, exactly as it is
 * for the AI review cache.
 *
 * Every operation runs inside one critical section, so the read-modify-write
 * cycle is atomic within the process, and writes go to a UUID temp file in the
 * same directory that is renamed into place, so a crash can never leave a
 * truncated store. The critical section is per store instance: two instances
 * pointed at the same file serialize only against themselves, and the atomic
 * rename keeps the file valid (last writer wins) rather than corrupt. Two
 * invariants are enforced on write: batch ids are unique
 * across the file, and at most one in-flight (`draft`/`submitted`/`running`)
 * batch may exist per workspace, Agent, or comment id. Terminal batches stay
 * on disk for history and never block a new active batch.
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
   * invalid batch never touches (or creates) the file. A duplicate id, a second
   * in-flight batch for the same agent, or an in-flight batch that already
   * claims one of this batch's comments is rejected without a write.
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
      assertActiveUniqueness(batches, created, this.storagePath);
      await this.write([...batches, created]);
      return created;
    });
  }

  /**
   * Replace one stored batch with the result of `transform`, or resolve null
   * when no batch has that id (no write happens in that case). The transformed
   * batch is validated before writing, and the id and active-claim invariants
   * are re-checked, so an update can complete, fail, or advance a batch but can
   * never mint a second active claim or collide with another id.
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
      assertActiveUniqueness(others, updated, this.storagePath);
      const next = [...batches];
      next[index] = updated;
      await this.write(next);
      return updated;
    });
  }

  /** Read and validate the store; a missing file is an empty store. */
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
    return this.parse(raw);
  }

  /** Parse and validate a store document; throws without touching the file. */
  private parse(raw: string): ReviewBatch[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ReviewBatchStoreError(
        `ReviewBatch store at ${this.storagePath} is not valid JSON; the file was left untouched.`,
        { cause: error },
      );
    }
    // An empty or whitespace-only file is malformed JSON (JSON.parse already
    // rejected the truly empty case); only ENOENT means "nothing stored yet".
    const marked = reviewBatchVersionMarkerSchema.safeParse(parsed);
    if (!marked.success) {
      throw new ReviewBatchStoreError(
        `ReviewBatch store at ${this.storagePath} is not a version ${REVIEW_BATCH_VERSION} store; the file was left untouched.`,
      );
    }
    if (marked.data.version !== REVIEW_BATCH_VERSION) {
      throw new ReviewBatchStoreError(
        `ReviewBatch store at ${this.storagePath} uses unsupported version ${marked.data.version}; this build reads version ${REVIEW_BATCH_VERSION} and left the file untouched.`,
      );
    }
    const envelope = reviewBatchEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      throw new ReviewBatchStoreError(
        `ReviewBatch store at ${this.storagePath} has an invalid version ${REVIEW_BATCH_VERSION} envelope; the file was left untouched.`,
        { cause: envelope.error },
      );
    }
    const batches = envelope.data.batches;
    const seen = new Set<string>();
    for (const batch of batches) {
      if (seen.has(batch.id)) {
        throw new ReviewBatchStoreError(
          `ReviewBatch store at ${this.storagePath} repeats ReviewBatch id ${batch.id}; the file was left untouched.`,
        );
      }
      seen.add(batch.id);
    }
    return batches;
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

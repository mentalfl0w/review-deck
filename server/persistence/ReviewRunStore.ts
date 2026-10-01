import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  aiReviewBudgetPresetSchema,
  aiReviewDepthSchema,
  aiReviewModeSchema,
  aiReviewPermissionModeSchema,
  aiReviewResultSourceSchema,
  reviewLocaleSchema,
} from "../../shared/review";
import { createMutex, type Mutex } from "../util/mutex";

/** Envelope version written to disk. */
export const REVIEW_RUN_VERSION = 1;

export type ReviewRunEnvelope = {
  version: typeof REVIEW_RUN_VERSION;
  runs: ReviewRun[];
};

export const DEFAULT_REVIEW_RUN_PATH = join(homedir(), ".paseo", "review-deck", "runs.json");

export type ReviewRunStoreOptions = {
  /** Store file; defaults to the user's Review Deck directory. */
  storagePath?: string;
};

export const reviewRunStatusSchema = z.enum(["running", "completed", "failed", "abandoned"]);

/**
 * A run store (or payload) that could not be read, parsed, validated, or
 * updated without breaking an invariant.
 *
 * Deliberately not swallowed: a damaged or future-version file stays on disk
 * byte for byte instead of being silently replaced by an empty store, and a
 * rejected `create`/`update` never partially lands. There is no implicit
 * recovery path — the operator inspects (or deletes) the file.
 */
export class ReviewRunStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReviewRunStoreError";
  }
}

/**
 * One transient AI review run: where the review is running, and just enough
 * non-content metadata to rebuild the in-memory transient entry after a plugin
 * reload. Prompt text, diff patches, review output, and cached result bodies
 * are never stored here — recovery re-reads the reviewer configuration and the
 * Agent timeline instead.
 *
 * `childAgentId` is the reviewer Agent the review runs on, `parentAgentId` the
 * workspace Agent whose stream shows the result. `promptVersion`/`schemaVersion`
 * pin the prompt/schema pair the run was started under: a run whose versions no
 * longer match the running build is recovered as abandoned rather than parsed
 * with the wrong contract. `startedAt` is an ISO timestamp so the file stays
 * readable without a clock, while TTL comparisons re-parse it.
 *
 * Known fields are type-checked (a truncated or hand-edited file is rejected
 * rather than loaded half-parsed) and unknown fields are rejected too: strict
 * means a key this build does not know was written by a build that does, so the
 * document fails closed rather than being rewritten.
 */
export const reviewRunSchema = z
  .object({
    requestId: z.string().min(1),
    childAgentId: z.string().min(1).nullable(),
    parentAgentId: z.string().min(1),
    workspaceId: z.string().min(1),
    cacheKey: z.string().min(1),
    mode: aiReviewModeSchema,
    status: reviewRunStatusSchema,
    resultSource: aiReviewResultSourceSchema,
    startedAt: z.iso.datetime(),
    locale: reviewLocaleSchema.optional(),
    provider: z.string().min(1),
    model: z.string().nullable(),
    thinkingOptionId: z.string().nullable(),
    reviewerPermissionMode: aiReviewPermissionModeSchema,
    depth: aiReviewDepthSchema.optional(),
    reviewPreset: aiReviewBudgetPresetSchema.optional(),
    cacheEnabled: z.boolean(),
    inputFingerprint: z.string().min(1).optional(),
    // Recovery compares these against the running build, so a float, a string,
    // or 0 (which no prompt/schema pair uses) is a damaged record.
    promptVersion: z.number().int().positive(),
    schemaVersion: z.number().int().positive(),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.resultSource === "cached") {
      if (run.childAgentId !== null) {
        context.addIssue({ code: "custom", path: ["childAgentId"], message: "Cached runs cannot have a child Agent." });
      }
      if (run.status !== "completed") {
        context.addIssue({ code: "custom", path: ["status"], message: "Cached runs must already be completed." });
      }
    } else if (run.childAgentId === null && run.status === "completed") {
      context.addIssue({ code: "custom", path: ["childAgentId"], message: "A completed fresh run requires its child Agent id." });
    }
  });

export type ReviewRun = z.infer<typeof reviewRunSchema>;

/**
 * The version-1 envelope is strict for the same reason as each run: an unknown
 * envelope key means a build this one does not understand wrote the file.
 */
const reviewRunEnvelopeSchema = z
  .object({ version: z.literal(REVIEW_RUN_VERSION), runs: z.array(reviewRunSchema) })
  .strict();

/** Minimal probe: does the document declare an envelope version at all? */
const reviewRunVersionMarkerSchema = z.object({ version: z.number() });

/**
 * Persistence for transient AI review runs: one JSON file holding every run,
 * oldest first, terminal runs included until the caller removes them.
 *
 * The file is a strict version-1 envelope (`{ version: 1, runs }`); a document
 * that is not valid JSON, declares another version, or fails run validation
 * raises `ReviewRunStoreError` and is left untouched, so a damaged store is
 * visible instead of being quietly reset. Only `ENOENT` means "nothing stored
 * yet": an empty or whitespace-only file is malformed, exactly as it is for the
 * batch store and the AI review cache.
 *
 * Every operation runs inside one critical section, so the read-modify-write
 * cycle is atomic within the process, and writes go to a UUID temp file in the
 * same directory that is renamed into place, so a crash can never leave a
 * truncated store. The critical section is per store instance: two instances
 * pointed at the same file serialize only against themselves, and the atomic
 * rename keeps the file valid (last writer wins) rather than corrupt. Run
 * request ids are unique across the file, and `update`/`remove` of an absent id
 * is a no-op that returns null without rewriting — and therefore without
 * touching — the unrelated runs the file holds.
 */
export class ReviewRunStore {
  private readonly storagePath: string;
  private readonly mutex: Mutex = createMutex();

  constructor(options: ReviewRunStoreOptions | string = {}) {
    const resolved = typeof options === "string" ? { storagePath: options } : options;
    this.storagePath = resolved.storagePath ?? DEFAULT_REVIEW_RUN_PATH;
  }

  /** Every stored run, oldest first, terminal runs included. */
  list(): Promise<ReviewRun[]> {
    return this.mutex.run(() => this.read());
  }

  /** One stored run by request id, or null. */
  get(requestId: string): Promise<ReviewRun | null> {
    return this.mutex.run(async () => (await this.read()).find((run) => run.requestId === requestId) ?? null);
  }

  /**
   * Append one run. The payload is validated before the store is read, so an
   * invalid run never touches (or creates) the file, and a repeated request id
   * is rejected without a write.
   */
  create(run: ReviewRun): Promise<ReviewRun> {
    const parsed = reviewRunSchema.safeParse(run);
    if (!parsed.success) {
      return Promise.reject(
        new ReviewRunStoreError(
          `ReviewRun for ${this.storagePath} failed validation; the store was left untouched.`,
          { cause: parsed.error },
        ),
      );
    }
    const created = parsed.data;
    return this.mutex.run(async () => {
      const runs = await this.read();
      if (runs.some((stored) => stored.requestId === created.requestId)) {
        throw new ReviewRunStoreError(
          `ReviewRun store at ${this.storagePath} already stores run ${created.requestId}; the store was left untouched.`,
        );
      }
      await this.write([...runs, created]);
      return created;
    });
  }

  /**
   * Replace one stored run with the result of `transform`, or resolve null when
   * no run has that request id (no write happens in that case, so an absent id
   * never disturbs the stored runs). The transformed run is validated before
   * writing and its request id is re-checked, so an update can complete, fail,
   * or abandon a run but can never collide with another id.
   */
  update(
    requestId: string,
    transform: (run: ReviewRun) => ReviewRun | Promise<ReviewRun>,
  ): Promise<ReviewRun | null> {
    return this.mutex.run(async () => {
      const runs = await this.read();
      const index = runs.findIndex((run) => run.requestId === requestId);
      if (index === -1) return null;
      const parsed = reviewRunSchema.safeParse(await transform(runs[index]));
      if (!parsed.success) {
        throw new ReviewRunStoreError(
          `ReviewRun store at ${this.storagePath} refused the update of ${requestId}: the transformed run failed validation and the store was left untouched.`,
          { cause: parsed.error },
        );
      }
      const updated = parsed.data;
      if (runs.some((other, otherIndex) => otherIndex !== index && other.requestId === updated.requestId)) {
        throw new ReviewRunStoreError(
          `ReviewRun store at ${this.storagePath} already stores run ${updated.requestId}; the update was rejected and the store was left untouched.`,
        );
      }
      const next = [...runs];
      next[index] = updated;
      await this.write(next);
      return updated;
    });
  }

  /**
   * Drop one stored run and return it, or resolve null when no run has that
   * request id (no write happens in that case). Cleanup after a finished or
   * abandoned review goes through here, so the caller decides whether a
   * terminal run is deleted or kept as history.
   */
  remove(requestId: string): Promise<ReviewRun | null> {
    return this.mutex.run(async () => {
      const runs = await this.read();
      const index = runs.findIndex((run) => run.requestId === requestId);
      if (index === -1) return null;
      const [removed] = runs.splice(index, 1);
      await this.write(runs);
      return removed;
    });
  }

  /** Read and validate the store; a missing file is an empty store. */
  private async read(): Promise<ReviewRun[]> {
    let raw: string;
    try {
      raw = await readFile(this.storagePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
      throw new ReviewRunStoreError(`ReviewRun store at ${this.storagePath} could not be read.`, {
        cause: error,
      });
    }
    return this.parse(raw);
  }

  /** Parse and validate a store document; throws without touching the file. */
  private parse(raw: string): ReviewRun[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ReviewRunStoreError(
        `ReviewRun store at ${this.storagePath} is not valid JSON; the file was left untouched.`,
        { cause: error },
      );
    }
    // An empty or whitespace-only file is malformed JSON (JSON.parse already
    // rejected the truly empty case); only ENOENT means "nothing stored yet".
    const marked = reviewRunVersionMarkerSchema.safeParse(parsed);
    if (!marked.success) {
      throw new ReviewRunStoreError(
        `ReviewRun store at ${this.storagePath} is not a version ${REVIEW_RUN_VERSION} store; the file was left untouched.`,
      );
    }
    if (marked.data.version !== REVIEW_RUN_VERSION) {
      throw new ReviewRunStoreError(
        `ReviewRun store at ${this.storagePath} uses unsupported version ${marked.data.version}; this build reads version ${REVIEW_RUN_VERSION} and left the file untouched.`,
      );
    }
    const envelope = reviewRunEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      throw new ReviewRunStoreError(
        `ReviewRun store at ${this.storagePath} has an invalid version ${REVIEW_RUN_VERSION} envelope; the file was left untouched.`,
        { cause: envelope.error },
      );
    }
    const runs = envelope.data.runs;
    const seen = new Set<string>();
    for (const run of runs) {
      if (seen.has(run.requestId)) {
        throw new ReviewRunStoreError(
          `ReviewRun store at ${this.storagePath} repeats run request id ${run.requestId}; the file was left untouched.`,
        );
      }
      seen.add(run.requestId);
    }
    return runs;
  }

  /** Write the envelope atomically: temp file in the same directory, renamed. */
  private async write(runs: ReviewRun[]): Promise<void> {
    const envelope: ReviewRunEnvelope = { version: REVIEW_RUN_VERSION, runs };
    const temporary = `${this.storagePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.storagePath), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
      await rename(temporary, this.storagePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new ReviewRunStoreError(`ReviewRun store at ${this.storagePath} could not be written.`, {
        cause: error,
      });
    }
  }
}

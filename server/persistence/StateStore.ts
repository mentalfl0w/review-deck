import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { reviewAnchorSchema, reviewScopeSchema, type ReviewAnchor, type ReviewScope } from "../../shared/review";
import { createMutex, type Mutex } from "../util/mutex";

export type StateEntry = {
  id?: string;
  projectId?: string;
  projectName?: string;
  projectRootPath?: string;
  workspaceId?: string;
  targetFingerprint?: string;
  hunkId: string;
  hunkFingerprint?: string;
  contentId?: string;
  filePath?: string;
  hunkHeader?: string;
  hunkPatch?: string;
  decision: "reviewed" | "commented";
  comment?: string;
  savedAt: string;
  cwd?: string;
  scope?: ReviewScope;
  baseRef?: string;
  headRef?: string;
  anchor?: ReviewAnchor;
};

export type StateFile = Record<string, StateEntry[]>;

export const DEFAULT_STATE_PATH = join(homedir(), ".paseo", "review-deck", "reviews.json");

/** Envelope version written to disk. Version 1 is the bare `StateFile` map. */
export const STATE_VERSION = 2;
const LEGACY_STATE_VERSION = 1;

export type StateEnvelope = {
  version: typeof STATE_VERSION;
  targets: StateFile;
};

/**
 * A state file that exists but could not be read, parsed, or validated. The
 * file on disk is never overwritten or rewritten when this is raised, so a
 * damaged store stays available for inspection and repair instead of being
 * silently replaced by an empty one.
 */
export class StateStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StateStoreError";
  }
}

/**
 * Entry validation. Known fields are type-checked (a truncated or hand-edited
 * file is rejected rather than loaded half-parsed); unknown fields are kept, so
 * the migration rewrite never drops data written by another plugin version.
 */
const stateEntrySchema = z
  .object({
    id: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    projectName: z.string().min(1).optional(),
    projectRootPath: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    targetFingerprint: z.string().min(1).optional(),
    hunkId: z.string().min(1),
    hunkFingerprint: z.string().min(1).optional(),
    contentId: z.string().min(1).optional(),
    filePath: z.string().min(1).optional(),
    hunkHeader: z.string().optional(),
    hunkPatch: z.string().optional(),
    decision: z.enum(["reviewed", "commented"]),
    comment: z.string().optional(),
    savedAt: z.string().min(1),
    cwd: z.string().min(1).optional(),
    scope: reviewScopeSchema.optional(),
    baseRef: z.string().min(1).optional(),
    headRef: z.string().min(1).optional(),
    anchor: reviewAnchorSchema.optional(),
  })
  .loose();

const stateFileSchema = z.record(z.string(), z.array(stateEntrySchema));
const stateEnvelopeSchema = z.object({ version: z.literal(STATE_VERSION), targets: stateFileSchema }).loose();
/** Minimal probe: does the document declare an envelope version at all? */
const stateVersionMarkerSchema = z.object({ version: z.number() });

/**
 * Persistence for saved hunk decisions: one JSON file holding every bucket of
 * decisions, keyed by target fingerprint.
 *
 * The file is a versioned envelope (`{ version: 2, targets }`); the previous
 * layout (the bare bucket map) is still read and is rewritten in place, once,
 * by the load that encounters it — after validating it, so a corrupt legacy
 * file is surfaced instead of being discarded. Every read and write of the
 * file runs inside one critical section (`runExclusive` callers re-enter it),
 * which is what makes a read-modify-write cycle atomic within the process and
 * keeps a stale legacy read from overwriting a concurrent save. Writes go to a
 * temp file and are renamed into place, so a crash can never leave a truncated
 * store. The storage path is constructor-injected so tests can point the store
 * at a temp file.
 */
export class StateStore {
  private readonly storagePath: string;
  private readonly mutex: Mutex = createMutex();
  /** Marks execution inside the critical section so nested calls re-enter it. */
  private readonly section = new AsyncLocalStorage<true>();

  constructor(storagePath: string = DEFAULT_STATE_PATH) {
    this.storagePath = storagePath;
  }

  async load(): Promise<StateFile> {
    return this.locked(async () => {
      const raw = await this.readFile();
      // Only ENOENT means "no decisions yet"; an existing empty or whitespace
      // file is malformed JSON and must not be treated as an empty store.
      if (raw === null) return {};
      const document = this.parseDocument(raw);
      if (document.version === STATE_VERSION) return document.file;
      return this.migrate(raw, document.file);
    });
  }

  async save(next: StateFile): Promise<void> {
    const document = stateEnvelopeSchema.safeParse({ version: STATE_VERSION, targets: next });
    if (!document.success) {
      throw new StateStoreError(
        `Review state for ${this.storagePath} failed validation; the file was left untouched.`,
        { cause: document.error },
      );
    }
    await this.locked(() => this.write(document.data as StateEnvelope));
  }

  /** Serialize read-modify-write cycles through the store's critical section. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.locked(fn);
  }

  /**
   * Run fn with exclusive access to the state file. A call made from inside the
   * critical section (a `load`/`save` issued by a `runExclusive` callback) runs
   * inline: the caller already holds the lock, and re-acquiring it would
   * deadlock.
   */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    if (this.section.getStore() === true) return fn();
    return this.section.run(true, () => this.mutex.run(fn));
  }

  private async readFile(): Promise<string | null> {
    try {
      return await readFile(this.storagePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
      throw new StateStoreError(`Review state at ${this.storagePath} could not be read.`, { cause: error });
    }
  }

  /** Parse and validate a store document; throws without touching the file. */
  private parseDocument(raw: string): { file: StateFile; version: number } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new StateStoreError(
        `Review state at ${this.storagePath} is not valid JSON; the file was left untouched.`,
        { cause: error },
      );
    }
    // A legacy bucket may itself be named "version"; only a numeric version
    // field marks the envelope, so such a store still reads as v1.
    const marked = stateVersionMarkerSchema.safeParse(parsed);
    if (marked.success) {
      const { version } = marked.data;
      if (version !== STATE_VERSION) {
        throw new StateStoreError(
          `Review state at ${this.storagePath} uses unsupported version ${version}; this build reads version ${STATE_VERSION} and left the file untouched.`,
        );
      }
      const envelope = stateEnvelopeSchema.safeParse(parsed);
      if (!envelope.success) {
        throw new StateStoreError(
          `Review state at ${this.storagePath} has an invalid version ${STATE_VERSION} envelope; the file was left untouched.`,
          { cause: envelope.error },
        );
      }
      return { file: envelope.data.targets as StateFile, version };
    }
    const legacy = stateFileSchema.safeParse(parsed);
    if (!legacy.success) {
      throw new StateStoreError(
        `Review state at ${this.storagePath} is neither a valid version ${LEGACY_STATE_VERSION} nor version ${STATE_VERSION} store; the file was left untouched.`,
        { cause: legacy.error },
      );
    }
    return { file: legacy.data as StateFile, version: LEGACY_STATE_VERSION };
  }

  /**
   * Wrap a validated legacy store in the current envelope and write it back
   * atomically. The file is re-read first: if another writer replaced it since
   * the initial read, that newer content wins and the stale snapshot is never
   * written.
   */
  private async migrate(raw: string, file: StateFile): Promise<StateFile> {
    const current = await this.readFile();
    if (current !== null && current !== raw) {
      return current.trim() === "" ? {} : this.parseDocument(current).file;
    }
    await this.write({ version: STATE_VERSION, targets: file });
    return file;
  }

  private async write(document: StateEnvelope): Promise<void> {
    const temporary = `${this.storagePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.storagePath), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      await rename(temporary, this.storagePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new StateStoreError(`Review state at ${this.storagePath} could not be written.`, { cause: error });
    }
  }
}

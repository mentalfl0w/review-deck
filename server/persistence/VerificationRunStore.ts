import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  reviewRequestSchema,
  reviewVerificationSuggestionSchema,
  verificationCommandSchema,
  verificationFailureCodeSchema,
  verificationRunStatusSchema,
} from "../../shared/review";
import { createMutex, type Mutex } from "../util/mutex";

/** Envelope version written to disk. Version 2 stores status-only runs: no
 * marker, deadline, exit code, verified fact, or terminal output exists. */
export const VERIFICATION_RUN_VERSION = 2;

export type VerificationRunEnvelope = {
  version: typeof VERIFICATION_RUN_VERSION;
  runs: VerificationRunRecord[];
};

export const DEFAULT_VERIFICATION_RUN_PATH = join(homedir(), ".paseo", "review-deck", "verification", "verification-runs.json");

const execFileAsync = promisify(execFile);
let currentWindowsSid: Promise<string> | null = null;

async function getCurrentWindowsSid(): Promise<string> {
  if (currentWindowsSid) return currentWindowsSid;
  currentWindowsSid = (async () => {
    const root = process.env.SystemRoot ?? process.env.WINDIR;
    if (!root) throw new Error("SystemRoot is unavailable; cannot secure the verification store ACL.");
    const { stdout } = await execFileAsync(join(root, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const sid = String(stdout).match(/\bS-1-(?:\d+-)+\d+\b/)?.[0];
    if (!sid) throw new Error("whoami did not return the current Windows user SID.");
    return sid;
  })();
  return currentWindowsSid;
}

/** Restrict Windows ACLs as well as POSIX mode bits; child_process.execFile
 * keeps every path and SID an argv value rather than shell source. */
async function applyWindowsOwnerOnlyAcl(targetPath: string, kind: "directory" | "file"): Promise<void> {
  if (process.platform !== "win32") return;
  const root = process.env.SystemRoot ?? process.env.WINDIR;
  if (!root) throw new Error("SystemRoot is unavailable; cannot secure the verification store ACL.");
  const sid = await getCurrentWindowsSid();
  const inheritance = kind === "directory" ? "(OI)(CI)F" : "F";
  await execFileAsync(
    join(root, "System32", "icacls.exe"),
    [targetPath, "/inheritance:r", "/grant:r", `*${sid}:${inheritance}`],
    { encoding: "utf8", windowsHide: true },
  );
}
export type VerificationRunStoreOptions = {
  /** Store file; defaults to the user's Review Deck directory. */
  storagePath?: string;
};

/**
 * A verification run store (or payload) that could not be read, parsed,
 * validated, or updated without breaking an invariant.
 *
 * Deliberately not swallowed: a damaged or future-version file stays on disk
 * byte for byte instead of being silently replaced by an empty store, and a
 * rejected `create`/`update` never partially lands.
 */
export class VerificationRunStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VerificationRunStoreError";
  }
}

/**
 * One verification run's metadata: where it runs, what it runs, which target it
 * was bound to, and which state its workspace terminal was last seen in.
 * Terminal output is deliberately absent — a poll copies a bounded tail into
 * its own response and never hands it to this store.
 *
 * The invariants below are what keep a stored run from lying: there is no
 * field for an exit code, a verified fact, or terminal output at all, and the
 * strict schema rejects any document that tries to smuggle one in. An `open`
 * run has neither a completion time nor a failure, and every finished state
 * carries exactly the failure code that explains why it stopped being open.
 */
export const verificationRunRecordSchema = z
  .object({
    runId: z.string().min(1),
    workspaceId: z.string().min(1),
    projectId: z.string().min(1),
    /** Reviewed worktree the command runs in; the workspace must still resolve
     * to this directory for the run to stay valid. */
    cwd: z.string().min(1),
    /** Exact review scope and filters bound to the target fingerprint. */
    request: reviewRequestSchema,
    /** The exact review binding the run started with. */
    targetFingerprint: z.string().min(1),
    /** The structured AI finding suggestion the user saw and confirmed. */
    suggestion: reviewVerificationSuggestionSchema,
    command: verificationCommandSchema,
    commandPreview: z.string().min(1),
    terminalId: z.string().min(1),
    status: verificationRunStatusSchema,
    startedAt: z.iso.datetime(),
    /** Set once the run leaves `open`. */
    completedAt: z.iso.datetime().optional(),
    /** Why the run stopped being open; never a command verdict. */
    failureCode: verificationFailureCodeSchema.optional(),
  })
  .strict()
  .superRefine((run, context) => {
    const addIssue = (path: string, message: string) => {
      context.addIssue({ code: "custom", path: [path], message });
    };
    if (
      run.suggestion.command.executable !== run.command.executable ||
      run.suggestion.command.args.length !== run.command.args.length ||
      run.suggestion.command.args.some((arg, index) => arg !== run.command.args[index])
    ) {
      addIssue("suggestion", "The stored suggestion must carry the exact run command.");
    }
    if (run.suggestion.commandPreview !== run.commandPreview) {
      addIssue("suggestion", "The stored suggestion must carry the exact run preview.");
    }
    if (run.suggestion.label.length === 0) addIssue("suggestion", "The run must remain associated with a finding.");
  })
  .superRefine((run, context) => {
    const addIssue = (path: string, message: string) => {
      context.addIssue({ code: "custom", path: [path], message });
    };
    if (run.status === "open") {
      if (run.completedAt !== undefined) addIssue("completedAt", "An open verification has no completion time.");
      if (run.failureCode !== undefined) addIssue("failureCode", "An open verification has no failure.");
      return;
    }
    if (run.completedAt === undefined) addIssue("completedAt", "A finished verification requires its completion time.");
    switch (run.status) {
      case "closed":
        if (run.failureCode !== "terminal_closed") addIssue("failureCode", "A closed verification records terminal_closed.");
        break;
      case "unavailable":
        if (run.failureCode !== "terminal_unavailable") addIssue("failureCode", "An unavailable verification records terminal_unavailable.");
        break;
      case "error":
        if (run.failureCode !== "invalid_binding") addIssue("failureCode", "An errored verification records invalid_binding.");
        break;
    }
  });

export type VerificationRunRecord = z.infer<typeof verificationRunRecordSchema>;

/**
 * The version-2 envelope is strict for the same reason as each run: an unknown
 * envelope key means a build this one does not understand wrote the file.
 */
const verificationRunEnvelopeSchema = z
  .object({ version: z.literal(VERIFICATION_RUN_VERSION), runs: z.array(verificationRunRecordSchema) })
  .strict();

/** Minimal probe: does the document declare an envelope version at all? */
const verificationRunVersionMarkerSchema = z.object({ version: z.number() });

/**
 * Persistence for Verification Terminal runs: one JSON file holding every run,
 * oldest first, finished runs included until they are pruned.
 *
 * The file is a strict version-2 envelope (`{ version: 2, runs }`); a document
 * that is not valid JSON, declares another version (including the superseded
 * marker store), or fails run validation raises `VerificationRunStoreError`
 * and is left untouched, so a damaged store is visible instead of being
 * quietly reset. Only `ENOENT` means "nothing stored yet".
 *
 * Writes go to a UUID temp file in the same directory that is renamed into
 * place, and every read-modify-write cycle runs inside one mutex, so a crash can
 * never leave a truncated store.
 */
export class VerificationRunStore {
  private readonly storagePath: string;
  private readonly mutex: Mutex = createMutex();
  private permissionsReady: Promise<void> | null = null;

  constructor(options: VerificationRunStoreOptions | string = {}) {
    const resolved = typeof options === "string" ? { storagePath: options } : options;
    this.storagePath = resolved.storagePath ?? DEFAULT_VERIFICATION_RUN_PATH;
  }
  private ensurePrivateStorage(): Promise<void> {
    if (!this.permissionsReady) this.permissionsReady = this.securePrivateStorage();
    return this.permissionsReady;
  }

  private async securePrivateStorage(): Promise<void> {
    const directory = dirname(this.storagePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await applyWindowsOwnerOnlyAcl(directory, "directory");
    try {
      await stat(this.storagePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return;
      throw error;
    }
    await chmod(this.storagePath, 0o600);
    await applyWindowsOwnerOnlyAcl(this.storagePath, "file");
  }


  /** Every stored run, oldest first. */
  list(): Promise<VerificationRunRecord[]> {
    return this.mutex.run(() => this.read());
  }

  /** One stored run by id, or null. */
  get(runId: string): Promise<VerificationRunRecord | null> {
    return this.mutex.run(async () => (await this.read()).find((run) => run.runId === runId) ?? null);
  }

  /** Append one run; a repeated run id is rejected without a write. */
  create(run: VerificationRunRecord): Promise<VerificationRunRecord> {
    const parsed = verificationRunRecordSchema.safeParse(run);
    if (!parsed.success) {
      return Promise.reject(
        new VerificationRunStoreError(
          `VerificationRun for ${this.storagePath} failed validation; the store was left untouched.`,
          { cause: parsed.error },
        ),
      );
    }
    const created = parsed.data;
    return this.mutex.run(async () => {
      const runs = await this.read();
      if (runs.some((stored) => stored.runId === created.runId)) {
        throw new VerificationRunStoreError(
          `VerificationRun store at ${this.storagePath} already stores run ${created.runId}; the store was left untouched.`,
        );
      }
      await this.write([...runs, created]);
      return created;
    });
  }

  /** Replace one stored run with the result of `transform`, or resolve null
   * when no run has that id (no write happens in that case). */
  update(
    runId: string,
    transform: (run: VerificationRunRecord) => VerificationRunRecord | Promise<VerificationRunRecord>,
  ): Promise<VerificationRunRecord | null> {
    return this.mutex.run(async () => {
      const runs = await this.read();
      const index = runs.findIndex((run) => run.runId === runId);
      if (index === -1) return null;
      const parsed = verificationRunRecordSchema.safeParse(await transform(runs[index]));
      if (!parsed.success) {
        throw new VerificationRunStoreError(
          `VerificationRun store at ${this.storagePath} refused the update of ${runId}: the transformed run failed validation and the store was left untouched.`,
          { cause: parsed.error },
        );
      }
      const updated = parsed.data;
      if (runs.some((other, otherIndex) => otherIndex !== index && other.runId === updated.runId)) {
        throw new VerificationRunStoreError(
          `VerificationRun store at ${this.storagePath} already stores run ${updated.runId}; the update was rejected and the store was left untouched.`,
        );
      }
      const next = [...runs];
      next[index] = updated;
      await this.write(next);
      return updated;
    });
  }

  /** Drop one stored run and return it, or resolve null when no run has that
   * id (no write happens in that case). */
  remove(runId: string): Promise<VerificationRunRecord | null> {
    return this.mutex.run(async () => {
      const runs = await this.read();
      const index = runs.findIndex((run) => run.runId === runId);
      if (index === -1) return null;
      const [removed] = runs.splice(index, 1);
      await this.write(runs);
      return removed;
    });
  }

  /**
   * Drop every run started before `cutoff` (an ISO timestamp) and return how
   * many were removed. A run's terminal is long gone by then, so the record can
   * no longer be inspected; the file is only rewritten when something was
   * actually pruned.
   */
  pruneStartedBefore(cutoff: string): Promise<number> {
    return this.mutex.run(async () => {
      const runs = await this.read();
      const kept = runs.filter((run) => run.startedAt >= cutoff);
      const removed = runs.length - kept.length;
      if (removed > 0) await this.write(kept);
      return removed;
    });
  }

  /** Read and validate the store; a missing file is an empty store. */
  private async read(): Promise<VerificationRunRecord[]> {
    try {
      await this.ensurePrivateStorage();
    } catch (error) {
      throw new VerificationRunStoreError(`VerificationRun store at ${this.storagePath} permissions could not be secured.`, {
        cause: error,
      });
    }
    let raw: string;
    try {
      raw = await readFile(this.storagePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
      throw new VerificationRunStoreError(`VerificationRun store at ${this.storagePath} could not be read.`, {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new VerificationRunStoreError(
        `VerificationRun store at ${this.storagePath} is not valid JSON; the file was left untouched.`,
        { cause: error },
      );
    }
    const marked = verificationRunVersionMarkerSchema.safeParse(parsed);
    if (!marked.success) {
      throw new VerificationRunStoreError(
        `VerificationRun store at ${this.storagePath} is not a version ${VERIFICATION_RUN_VERSION} store; the file was left untouched.`,
      );
    }
    if (marked.data.version !== VERIFICATION_RUN_VERSION) {
      throw new VerificationRunStoreError(
        `VerificationRun store at ${this.storagePath} uses unsupported version ${marked.data.version}; this build reads version ${VERIFICATION_RUN_VERSION} and left the file untouched.`,
      );
    }
    const envelope = verificationRunEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      throw new VerificationRunStoreError(
        `VerificationRun store at ${this.storagePath} has an invalid version ${VERIFICATION_RUN_VERSION} envelope; the file was left untouched.`,
        { cause: envelope.error },
      );
    }
    const runs = envelope.data.runs;
    const seen = new Set<string>();
    for (const run of runs) {
      if (seen.has(run.runId)) {
        throw new VerificationRunStoreError(
          `VerificationRun store at ${this.storagePath} repeats run id ${run.runId}; the file was left untouched.`,
        );
      }
      seen.add(run.runId);
    }
    return runs;
  }

  /** Write the envelope atomically: temp file in the same directory, renamed. */
  private async write(runs: VerificationRunRecord[]): Promise<void> {
    const envelope: VerificationRunEnvelope = { version: VERIFICATION_RUN_VERSION, runs };
    const temporary = `${this.storagePath}.${randomUUID()}.tmp`;
    try {
      await this.ensurePrivateStorage();
      await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await applyWindowsOwnerOnlyAcl(temporary, "file");
      await chmod(temporary, 0o600);
      await rename(temporary, this.storagePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new VerificationRunStoreError(`VerificationRun store at ${this.storagePath} could not be written.`, {
        cause: error,
      });
    }
  }
}

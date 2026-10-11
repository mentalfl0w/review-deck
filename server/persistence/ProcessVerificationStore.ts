import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  processVerificationErrorCodeSchema,
  processVerificationHumanDecisionSchema,
  processVerificationStatusSchema,
  reviewScopeSchema,
  verificationCommandSchema,
} from "../../shared/review";
import { createMutex, type Mutex } from "../util/mutex";

/**
 * Persistence for captured verification process runs (RD-213).
 *
 * One store file holds every captured process run in creation order. The
 * strict version-1 envelope is the only format this build writes, and a run
 * record is metadata only: where and what it ran, which target it was bound
 * to, and the completion the OS reported. There is deliberately no field for
 * stdout, stderr, environment variables, prompts, or patches — the strict
 * schema rejects any document that tries to smuggle one in.
 *
 * A file that is malformed, corrupt, or from a future version is never
 * repaired, truncated, or replaced: every operation fails closed and leaves
 * the bytes exactly as they were. Reads and read-modify-writes are serialized
 * per store instance, and writes land through a same-directory temp file
 * renamed into place, so concurrent creates cannot lose entries.
 *
 * Which lifecycle transition a record may take is enforced by the caller's
 * service. Lifecycle and human-decision fields may change; target, command,
 * workspace, Finding, and review-run bindings never change after creation.
 * Stored completions must always be states the OS actually reported.
 */

/** Envelope version written to disk. */
export const PROCESS_VERIFICATION_VERSION = 1;
/** Hard cap on retained process metadata; live runs are never evicted. */
export const MAX_PROCESS_VERIFICATION_RUNS = 256;

export type ProcessVerificationEnvelope = {
  version: typeof PROCESS_VERIFICATION_VERSION;
  runs: ProcessVerificationRecord[];
};

export const DEFAULT_PROCESS_VERIFICATION_PATH = join(
  homedir(),
  ".paseo",
  "review-deck",
  "verification",
  "process-verification-runs.json",
);

export type ProcessVerificationStoreOptions = {
  /** Store file; defaults to the user's Review Deck verification directory. */
  storagePath?: string;
};

/**
 * A process verification store (or payload) that could not be read, parsed,
 * validated, or updated without breaking an invariant.
 *
 * Deliberately not swallowed: a damaged or future-version file stays on disk,
 * byte for byte, instead of being silently replaced by an empty store, and a
 * rejected `create`/`update` never partially lands.
 */
export class ProcessVerificationStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProcessVerificationStoreError";
  }
}

/**
 * The lifecycle of one captured process run. `pending` has not started,
 * `running` is in flight, and the rest are terminal: `exited` was observed by
 * the OS (with an exit code, a signal, or both), `timed_out`/`canceled` were
 * terminated by Review Deck, `abandoned` was never observed to finish (host
 * restart, disconnection), and `error` could not start or could not be
 * observed. `exit_0` is never implied by any status here.
 */
export { processVerificationErrorCodeSchema, processVerificationStatusSchema };
export type ProcessVerificationStatus = z.infer<typeof processVerificationStatusSchema>;
export type ProcessVerificationErrorCode = z.infer<typeof processVerificationErrorCodeSchema>;

/** Static table so a new status has to decide its side explicitly. */
const TERMINAL_BY_STATUS: Record<ProcessVerificationStatus, boolean> = {
  pending: false,
  running: false,
  exited: true,
  timed_out: true,
  canceled: true,
  abandoned: true,
  error: true,
};

/**
 * One captured process run's metadata. `command` is the exact executable plus
 * argv (the shared verification command contract, so a shell launcher can
 * never be stored), `commandHash`/`commandPreview` are what the user
 * confirmed, and timestamps/status/exit data are what was observed.
 *
 * The invariants below are what keep a stored record from lying: `pending` and
 * `running` carry no completion data, every terminal status carries a
 * completion time, `exited` must say how it exited, and `abandoned` — an
 * unobserved fate — can never carry an exit code, a signal, or an error code.
 */
export const processVerificationRecordSchema = z
  .object({
    runId: z.string().min(1),
    workspaceId: z.string().min(1),
    projectId: z.string().min(1),
    /** Workspace-resolved directory the process ran in. */
    cwd: z.string().min(1),
    /** Reviewed target the run was bound to; evidence never crosses targets. */
    targetFingerprint: z.string().min(1),
    /** The AI/rule finding this run was launched from, if any. */
    findingId: z.string().min(1).optional(),
    reviewRunId: z.string().min(1).optional(),
    /** The interactive verification run this captured process belongs to, if any. */
    verificationRunId: z.string().min(1).optional(),
    commandHash: z.string().min(1),
    commandPreview: z.string().min(1),
    command: verificationCommandSchema,
    scope: reviewScopeSchema.optional(),
    baseRef: z.string().min(1).optional(),
    headRef: z.string().min(1).optional(),
    filePath: z.string().min(1).optional(),
    hunkId: z.string().min(1).optional(),
    /** Latest server observation compared with the target bound at creation. */
    observedTargetFingerprint: z.string().min(1).optional(),
    targetChanged: z.boolean().optional(),
    createdAt: z.iso.datetime(),
    /** Set once the process has started. */
    startedAt: z.iso.datetime().optional(),
    /** Set once the run reaches a terminal status. */
    completedAt: z.iso.datetime().optional(),
    status: processVerificationStatusSchema,
    /** The OS exit code, present only when the OS reported one. */
    exitCode: z.number().int().optional(),
    /** The OS signal name, present only when the OS reported one. */
    signal: z.string().min(1).optional(),
    errorCode: processVerificationErrorCodeSchema.optional(),
    humanDecision: processVerificationHumanDecisionSchema.optional(),
    decisionAt: z.iso.datetime().optional(),
  })
  .strict()
  .superRefine((run, context) => {
    const fail = (field: string, message: string): void => {
      context.addIssue({ code: "custom", path: [field], message });
    };
    const terminal = TERMINAL_BY_STATUS[run.status];

    if (run.status === "pending" || run.status === "running") {
      if (run.completedAt !== undefined) {
        fail("completedAt", `A ${run.status} run has not completed and cannot carry a completion time.`);
      }
      if (run.exitCode !== undefined) {
        fail("exitCode", `A ${run.status} run has no observed exit code.`);
      }
      if (run.signal !== undefined) {
        fail("signal", `A ${run.status} run has no observed signal.`);
      }
      if (run.errorCode !== undefined) {
        fail("errorCode", `A ${run.status} run has no error code.`);
      }
    }
    if (run.status === "pending" && run.startedAt !== undefined) {
      fail("startedAt", "A pending run has not started and cannot carry a start time.");
    }
    if (run.status === "running" && run.startedAt === undefined) {
      fail("startedAt", "A running run must carry its start time.");
    }
    if (terminal && run.completedAt === undefined) {
      fail("completedAt", `A ${run.status} run must carry its completion time.`);
    }
    if (run.status === "exited" && run.exitCode === undefined && run.signal === undefined) {
      fail("exitCode", "An exited run must carry the exit code or signal the OS reported.");
    }
    if (run.status !== "exited" && run.exitCode !== undefined) {
      fail("exitCode", "Only an OS-observed exited run may carry an exit code.");
    }
    if (run.status === "abandoned") {
      if (run.exitCode !== undefined) {
        fail("exitCode", "An abandoned run was never observed to finish; it cannot carry an exit code.");
      }
      if (run.signal !== undefined) {
        fail("signal", "An abandoned run was never observed to finish; it cannot carry a signal.");
      }
      if (run.errorCode !== undefined) {
        fail("errorCode", "An abandoned run was never observed to finish; it cannot carry an error code.");
      }
    }

    const createdAt = Date.parse(run.createdAt);
    if (run.startedAt !== undefined && Date.parse(run.startedAt) < createdAt) {
      fail("startedAt", "A run cannot start before it was created.");
    }
    if (run.completedAt !== undefined && Date.parse(run.completedAt) < createdAt) {
      fail("completedAt", "A run cannot complete before it was created.");
    }
    if (
      run.startedAt !== undefined &&
      run.completedAt !== undefined &&
      Date.parse(run.completedAt) < Date.parse(run.startedAt)
    ) {
      fail("completedAt", "A run cannot complete before it started.");
    }
    if ((run.humanDecision === undefined) !== (run.decisionAt === undefined)) {
      fail("humanDecision", "A human decision and its timestamp must be stored together.");
    }
    if (run.humanDecision !== undefined && (run.status === "pending" || run.status === "running")) {
      fail("humanDecision", "A human decision can only be recorded after a run reaches a terminal status.");
    }
    if (
      run.observedTargetFingerprint !== undefined &&
      run.observedTargetFingerprint !== run.targetFingerprint &&
      run.targetChanged !== true
    ) {
      fail("targetChanged", "A different observed target fingerprint must be marked stale.");
    }
  });

export type ProcessVerificationRecord = z.infer<typeof processVerificationRecordSchema>;

/** The one supported on-disk envelope is strict: nothing else is written or read. */
const processVerificationEnvelopeSchema = z
  .object({
    version: z.literal(PROCESS_VERIFICATION_VERSION),
    runs: z.array(processVerificationRecordSchema),
  })
  .strict();

/** Minimal probe: does the document declare an envelope version at all? */
const processVerificationVersionMarkerSchema = z.object({ version: z.number() });

/**
 * What a run is — its identity, target binding, and exact command — must never
 * change after creation; only lifecycle and link fields may be updated. A
 * store that allowed a rebind could show one command's exit evidence against
 * another command or target.
 */
function assertBindingUnchanged(
  previous: ProcessVerificationRecord,
  updated: ProcessVerificationRecord,
  storagePath: string,
): void {
  const changed: string[] = [];
  if (updated.runId !== previous.runId) changed.push("runId");
  if (updated.createdAt !== previous.createdAt) changed.push("createdAt");
  if (updated.workspaceId !== previous.workspaceId) changed.push("workspaceId");
  if (updated.projectId !== previous.projectId) changed.push("projectId");
  if (updated.cwd !== previous.cwd) changed.push("cwd");
  if (updated.targetFingerprint !== previous.targetFingerprint) changed.push("targetFingerprint");
  if (updated.commandHash !== previous.commandHash) changed.push("commandHash");
  if (updated.commandPreview !== previous.commandPreview) changed.push("commandPreview");
  if (updated.command.executable !== previous.command.executable) changed.push("command.executable");
  if (
    updated.command.args.length !== previous.command.args.length ||
    updated.command.args.some((arg, index) => arg !== previous.command.args[index])
  ) {
    changed.push("command.args");
  }
  if (updated.scope !== previous.scope) changed.push("scope");
  if (updated.baseRef !== previous.baseRef) changed.push("baseRef");
  if (updated.headRef !== previous.headRef) changed.push("headRef");
  if (updated.filePath !== previous.filePath) changed.push("filePath");
  if (updated.hunkId !== previous.hunkId) changed.push("hunkId");
  if (updated.findingId !== previous.findingId) changed.push("findingId");
  if (updated.reviewRunId !== previous.reviewRunId) changed.push("reviewRunId");
  if (updated.verificationRunId !== previous.verificationRunId) changed.push("verificationRunId");
  if (changed.length > 0) {
    throw new ProcessVerificationStoreError(
      `ProcessVerification store at ${storagePath} refused the update of ${previous.runId}: the run's binding (${changed.join(", ")}) is immutable and the store was left untouched.`,
    );
  }
}

/**
 * Persistence for captured process runs: one JSON file holding every run in
 * creation order, terminal runs included. Every operation runs inside one
 * critical section; writes use a UUID temp file in the same directory and
 * atomically rename it into place.
 */
export class ProcessVerificationStore {
  private readonly storagePath: string;
  private readonly mutex: Mutex = createMutex();
  private permissionsReady: Promise<void> | null = null;

  constructor(options: ProcessVerificationStoreOptions | string = {}) {
    const resolved = typeof options === "string" ? { storagePath: options } : options;
    this.storagePath = resolved.storagePath ?? DEFAULT_PROCESS_VERIFICATION_PATH;
  }

  /** Every stored run, oldest first, terminal runs included. */
  list(): Promise<ProcessVerificationRecord[]> {
    return this.mutex.run(() => this.read());
  }

  /** One stored run by id, or null. */
  get(runId: string): Promise<ProcessVerificationRecord | null> {
    return this.mutex.run(async () => (await this.read()).find((run) => run.runId === runId) ?? null);
  }

  /**
   * Append one run. The payload is validated before the store is read, so an
   * invalid run never touches (or creates) the file, and a repeated run id is
   * rejected without a write.
   */
  create(run: ProcessVerificationRecord): Promise<ProcessVerificationRecord> {
    const parsed = processVerificationRecordSchema.safeParse(run);
    if (!parsed.success) {
      return Promise.reject(
        new ProcessVerificationStoreError(
          `ProcessVerification run for ${this.storagePath} failed validation; the store was left untouched.`,
          { cause: parsed.error },
        ),
      );
    }
    const created = parsed.data;
    return this.mutex.run(async () => {
      const runs = await this.read();
      if (runs.some((stored) => stored.runId === created.runId)) {
        throw new ProcessVerificationStoreError(
          `ProcessVerification store at ${this.storagePath} already stores run ${created.runId}; the store was left untouched.`,
        );
      }
      const next = [...runs, created];
      if (next.length > MAX_PROCESS_VERIFICATION_RUNS) {
        const terminal = next
          .filter((run) => run.status !== "pending" && run.status !== "running")
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        while (next.length > MAX_PROCESS_VERIFICATION_RUNS && terminal.length > 0) {
          const oldestId = terminal.shift()!.runId;
          const index = next.findIndex((run) => run.runId === oldestId);
          if (index !== -1) next.splice(index, 1);
        }
        if (next.length > MAX_PROCESS_VERIFICATION_RUNS) {
          throw new ProcessVerificationStoreError(
            `ProcessVerification store at ${this.storagePath} has ${MAX_PROCESS_VERIFICATION_RUNS} active runs; no run was evicted.`,
          );
        }
      }
      await this.write(next);
      return created;
    });
  }

  /**
   * Replace one stored run with the result of `transform`, or resolve null
   * when no run has that id (no write happens in that case). The transformed
   * run is validated and its binding re-checked, so an update can never change
   * what the run was or claim a completion the schema does not allow.
   */
  update(
    runId: string,
    transform: (run: ProcessVerificationRecord) => ProcessVerificationRecord | Promise<ProcessVerificationRecord>,
  ): Promise<ProcessVerificationRecord | null> {
    return this.mutex.run(async () => {
      const runs = await this.read();
      const index = runs.findIndex((run) => run.runId === runId);
      if (index === -1) return null;
      const previous = runs[index];
      const parsed = processVerificationRecordSchema.safeParse(await transform(previous));
      if (!parsed.success) {
        throw new ProcessVerificationStoreError(
          `ProcessVerification store at ${this.storagePath} refused the update of ${runId}: the transformed run failed validation and the store was left untouched.`,
          { cause: parsed.error },
        );
      }
      const updated = parsed.data;
      assertBindingUnchanged(previous, updated, this.storagePath);
      const next = [...runs];
      next[index] = updated;
      await this.write(next);
      return updated;
    });
  }
  /** Drop terminal runs older than the retention cutoff; live runs are never pruned. */
  pruneCompletedBefore(cutoff: string): Promise<number> {
    if (!Number.isFinite(Date.parse(cutoff))) {
      return Promise.reject(new ProcessVerificationStoreError("The captured process retention cutoff is invalid."));
    }
    return this.mutex.run(async () => {
      const runs = await this.read();
      const kept = runs.filter((run) =>
        run.status === "pending" ||
        run.status === "running" ||
        Date.parse(run.createdAt) >= Date.parse(cutoff),
      );
      const removed = runs.length - kept.length;
      if (removed === 0) return 0;
      await this.write(kept);
      return removed;
    });
  }


  /** Read and validate the store; a missing file is an empty store, nothing else is. */
  private async read(): Promise<ProcessVerificationRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.storagePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
      throw new ProcessVerificationStoreError(`ProcessVerification store at ${this.storagePath} could not be read.`, {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ProcessVerificationStoreError(
        `ProcessVerification store at ${this.storagePath} is not valid JSON; the file was left untouched.`,
        { cause: error },
      );
    }
    const marked = processVerificationVersionMarkerSchema.safeParse(parsed);
    if (!marked.success) {
      throw new ProcessVerificationStoreError(
        `ProcessVerification store at ${this.storagePath} has no supported version marker; the file was left untouched.`,
      );
    }
    if (marked.data.version !== PROCESS_VERIFICATION_VERSION) {
      throw new ProcessVerificationStoreError(
        `ProcessVerification store at ${this.storagePath} uses unsupported version ${marked.data.version}; this build reads version ${PROCESS_VERIFICATION_VERSION} and left the file untouched.`,
      );
    }
    const envelope = processVerificationEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      throw new ProcessVerificationStoreError(
        `ProcessVerification store at ${this.storagePath} has an invalid version ${PROCESS_VERIFICATION_VERSION} envelope; the file was left untouched.`,
        { cause: envelope.error },
      );
    }
    const runs = envelope.data.runs;
    const seen = new Set<string>();
    for (const run of runs) {
      if (seen.has(run.runId)) {
        throw new ProcessVerificationStoreError(
          `ProcessVerification store at ${this.storagePath} repeats run id ${run.runId}; the file was left untouched.`,
        );
      }
      seen.add(run.runId);
    }
    return runs;
  }

  /** Write the envelope atomically: temp file in the same directory, renamed. */
  private async write(runs: ProcessVerificationRecord[]): Promise<void> {
    const envelope: ProcessVerificationEnvelope = { version: PROCESS_VERIFICATION_VERSION, runs };
    const temporary = `${this.storagePath}.${randomUUID()}.tmp`;
    try {
      await this.ensurePrivateStorage();
      await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      await rename(temporary, this.storagePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new ProcessVerificationStoreError(`ProcessVerification store at ${this.storagePath} could not be written.`, {
        cause: error,
      });
    }
  }

  /** Restrict the store directory to its owner before anything is written. */
  private ensurePrivateStorage(): Promise<void> {
    if (!this.permissionsReady) {
      this.permissionsReady = (async () => {
        const directory = dirname(this.storagePath);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
      })().catch((error: unknown) => {
        this.permissionsReady = null;
        throw error;
      });
    }
    return this.permissionsReady;
  }
}

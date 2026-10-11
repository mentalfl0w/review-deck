import { spawn } from "node:child_process";

/**
 * Non-interactive verification process execution (RD-213).
 *
 * Review Deck's interactive terminal never reports an exit verdict, so this
 * module adds a second, explicitly confirmed mode: one exact executable plus
 * argv (`shell: false`, no shell anywhere) run detached as its own POSIX
 * process group, reporting what the OS actually observed — an exit code, a
 * signal, a timeout, a cancellation, or a failure to start. Nothing here
 * interprets that evidence as a verdict, and nothing here is persisted: the
 * bounded output tail lives in the completion object only.
 *
 * Fail closed: only platforms whose process-group termination semantics
 * Review Deck has verified may start anything, a refused start never touches
 * the OS, and a process-group kill that cannot be confirmed is an error, never
 * a success. A timeout/cancellation remains an unknown command result even if
 * the process group is confirmed gone. User confirmation, command safety,
 * workspace/target binding, concurrency limits, and persisted lifecycle
 * transitions are enforced by the caller, not here.
 */

/** Platforms whose process-group semantics Review Deck has verified. */
const SUPPORTED_PLATFORMS: Partial<Record<NodeJS.Platform, true>> = { darwin: true };

/**
 * Whether the non-interactive runner may start processes on `platform`.
 * Linux, Windows, and every other platform fail closed until their termination
 * semantics (process groups, TERM then KILL) are tested and verified.
 */
export function processRunnerSupported(platform: NodeJS.Platform): boolean {
  return SUPPORTED_PLATFORMS[platform] === true;
}

/** Combined stdout/stderr capture bound: at most this many bytes are retained. */
export const PROCESS_OUTPUT_CAPTURE_MAX_BYTES = 32 * 1024;
/** The retained capture is projected to at most this many trailing lines. */
export const PROCESS_OUTPUT_TAIL_MAX_LINES = 200;
/** Grace after SIGTERM before the process group is SIGKILLed. */
export const PROCESS_KILL_GRACE_MS = 2_000;
/** Window after SIGKILL in which process-group liveness must confirm termination. */
export const PROCESS_KILL_CONFIRM_MS = 5_000;

/** Where a run ended: on its own, by timeout, by cancellation, or unobservably. */
export type ProcessCompletionStatus = "exited" | "timed_out" | "canceled" | "error";

/**
 * `spawn_failed` — no process was started, or none was observed to have
 * started. `process_killed` — the runner terminated the process group or
 * killed it without ever observing its close.
 */
export type ProcessCompletionErrorCode = "spawn_failed" | "process_killed";

/** One exact command to run: an executable plus argv, never a shell line. */
export type ProcessInvocation = {
  /** Caller-owned run id; unique among this runner's live runs. */
  runId: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  /** Kill the process group after this many milliseconds; omitted means no limit. */
  timeoutMs?: number;
};

/**
 * One observed completion. `exitCode` is present only when the OS reported a
 * numeric exit code and `signal` only when it reported a signal. Timeout and
 * cancellation can settle after the process group is gone without an observed
 * leader exit; that is not a success. A group that remains unconfirmed is an
 * error. Output is bounded and never persisted by this module.
 */
export type ProcessCompletion = {
  status: ProcessCompletionStatus;
  exitCode?: number;
  signal?: string;
  outputTail: string[];
  outputTruncated: boolean;
  errorCode?: ProcessCompletionErrorCode;
};

/** A started (or refused) run: its completion plus a cancel switch for it. */
export type ProcessRunHandle = {
  completion: Promise<ProcessCompletion>;
  cancel(): void;
};

/** The data/error surface of one child stdio pipe (a `Readable` in practice). */
export type ProcessOutputStream = {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

/**
 * The minimal child surface the runner uses. `node:child_process`'s
 * `ChildProcess` satisfies it, and tests can supply a deterministic fake
 * without casts.
 */
export type ProcessChild = {
  readonly pid?: number;
  readonly stdout: ProcessOutputStream | null;
  readonly stderr: ProcessOutputStream | null;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
};

/** Exactly the options the runner hands to spawn; no shell, group leader, piped output. */
export type ProcessSpawnOptions = {
  cwd: string;
  shell: false;
  detached: boolean;
  stdio: ["ignore", "pipe", "pipe"];
};

export type ProcessSpawn = (
  executable: string,
  args: readonly string[],
  options: ProcessSpawnOptions,
) => ProcessChild;

/** Injectable one-shot timer; the returned function cancels the pending call. */
export type ProcessTimers = {
  setTimer(callback: () => void, delayMs: number): () => void;
};

export type ProcessRunnerOptions = {
  /** Injectable for tests; defaults to `node:child_process.spawn`. */
  spawn?: ProcessSpawn;
  /** Injectable for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Injectable for tests; defaults to real timers. */
  timers?: ProcessTimers;
  /** Injectable process-group liveness probe for deterministic termination tests. */
  isProcessGroupAlive?: (child: ProcessChild) => boolean;
};

const defaultTimers: ProcessTimers = {
  setTimer: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

/**
 * Ring buffer holding at most `capacity` bytes of the combined output, so a
 * chatty child can never grow memory without bound; the last bytes are always
 * the ones kept.
 */
class BoundedCapture {
  private readonly buffer: Buffer;
  private readonly capacity: number;
  private start = 0;
  private length = 0;
  private totalBytes = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = Buffer.alloc(capacity);
  }

  append(chunk: Buffer): void {
    this.totalBytes += chunk.byteLength;
    if (chunk.byteLength === 0) return;
    if (chunk.byteLength >= this.capacity) {
      chunk.copy(this.buffer, 0, chunk.byteLength - this.capacity);
      this.start = 0;
      this.length = this.capacity;
      return;
    }
    const writeAt = (this.start + this.length) % this.capacity;
    const firstSpan = Math.min(chunk.byteLength, this.capacity - writeAt);
    chunk.copy(this.buffer, writeAt, 0, firstSpan);
    if (firstSpan < chunk.byteLength) chunk.copy(this.buffer, 0, firstSpan);
    const overflow = Math.max(0, this.length + chunk.byteLength - this.capacity);
    this.length = Math.min(this.capacity, this.length + chunk.byteLength);
    if (overflow > 0) this.start = (this.start + overflow) % this.capacity;
  }

  /** The retained bytes in order, plus whether anything was dropped. */
  tail(): { text: string; truncated: boolean } {
    const dropped = this.totalBytes > this.length;
    if (this.length === 0) return { text: "", truncated: dropped };
    const bytes = Buffer.allocUnsafe(this.length);
    const firstSpan = Math.min(this.length, this.capacity - this.start);
    this.buffer.copy(bytes, 0, this.start, this.start + firstSpan);
    if (firstSpan < this.length) this.buffer.copy(bytes, firstSpan, 0, this.length - firstSpan);
    return { text: bytes.toString("utf8"), truncated: dropped };
  }
}

/** Project the retained capture into a bounded tail of trailing lines. */
function projectOutputTail(
  text: string,
  captureTruncated: boolean,
): { outputTail: string[]; outputTruncated: boolean } {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const droppedLines = Math.max(0, lines.length - PROCESS_OUTPUT_TAIL_MAX_LINES);
  return {
    outputTail: droppedLines > 0 ? lines.slice(droppedLines) : lines,
    outputTruncated: captureTruncated || droppedLines > 0,
  };
}

/**
 * The completion of a start that never reached the OS: unsupported platform,
 * invalid invocation, an id that is already live, or a shut-down runner.
 * Nothing was spawned, so `spawn_failed` is the only honest code.
 */
function refusedCompletion(): ProcessCompletion {
  return { status: "error", errorCode: "spawn_failed", outputTail: [], outputTruncated: false };
}

/**
 * Signal the child's whole process group: the child is detached, so it leads
 * its own group and the group id equals its pid. Falls back to the child
 * itself when the group is already gone or cannot be signalled.
 */
function signalProcessGroup(child: ProcessChild, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The group is gone (ESRCH) or unsignalable (EPERM): try the child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Nothing left to signal; the close event or confirm window settles the run.
  }
}
/** Best-effort liveness check for the detached process group. */
function processGroupExists(child: ProcessChild): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
  }
}

/** One live run and everything needed to settle it exactly once. */
type LiveRun = {
  readonly invocation: ProcessInvocation;
  readonly child: ProcessChild;
  readonly capture: BoundedCapture;
  readonly completion: Promise<ProcessCompletion>;
  readonly resolve: (completion: ProcessCompletion) => void;
  readonly cancelTimers: Array<() => void>;
  settled: boolean;
  termination: "canceled" | "timed_out" | null;
  leaderExit?: { exitCode?: number; signal?: string };
};

/** The fields a settle carries before the output tail is projected onto it. */
type CompletionOutcome = {
  status: ProcessCompletionStatus;
  exitCode?: number;
  signal?: string;
  errorCode?: ProcessCompletionErrorCode;
};

/**
 * Starts one captured process at a time per run id, and only on platforms it
 * supports. `start` never throws: any invocation it cannot run safely (or at
 * all) is refused with an already-settled `spawn_failed` error and no OS
 * interaction. Every run settles its completion exactly once; timeouts and
 * cancellations signal the process group TERM, then KILL after a bounded
 * grace, and an exit that is never observed settles as an error.
 */
export class ProcessRunner {
  private readonly spawnProcess: ProcessSpawn;
  private readonly platform: NodeJS.Platform;
  private readonly timers: ProcessTimers;
  private readonly isProcessGroupAlive: (child: ProcessChild) => boolean;
  private readonly live = new Map<string, LiveRun>();
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: ProcessRunnerOptions = {}) {
    this.spawnProcess = options.spawn ?? spawn;
    this.platform = options.platform ?? process.platform;
    this.timers = options.timers ?? defaultTimers;
    this.isProcessGroupAlive = options.isProcessGroupAlive ?? processGroupExists;
  }

  /**
   * Start one process and return its handle. The process is spawned directly
   * (executable plus argv, `shell: false`), detached as its own POSIX process
   * group, with stdin ignored and stdout/stderr piped into one bounded
   * capture. A refused start — unsupported platform, invalid invocation, an
   * already-live `runId`, or a runner that has been shut down — returns a
   * handle whose completion is already the `spawn_failed` error and never
   * touches the OS.
   */
  start(invocation: ProcessInvocation): ProcessRunHandle {
    if (!this.canStart(invocation)) {
      return { completion: Promise.resolve(refusedCompletion()), cancel: () => undefined };
    }

    const { promise: completion, resolve: resolveCompletion } = Promise.withResolvers<ProcessCompletion>();

    let child: ProcessChild;
    try {
      child = this.spawnProcess(invocation.executable, invocation.args, {
        cwd: invocation.cwd,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // `spawn` throws only for an invalid call, but the runner still fails
      // closed instead of letting a start escape as a rejection.
      resolveCompletion(refusedCompletion());
      return { completion, cancel: () => undefined };
    }

    const run: LiveRun = {
      invocation,
      child,
      capture: new BoundedCapture(PROCESS_OUTPUT_CAPTURE_MAX_BYTES),
      completion,
      resolve: resolveCompletion,
      cancelTimers: [],
      settled: false,
      termination: null,
    };
    this.live.set(invocation.runId, run);

    captureStream(run, child.stdout);
    captureStream(run, child.stderr);
    child.on("error", () => this.completeWithSpawnFailure(run));
    child.once("close", (code, signal) => this.completeFromClose(run, code, signal));

    if (invocation.timeoutMs !== undefined) {
      run.cancelTimers.push(this.timers.setTimer(() => this.requestTermination(run, "timed_out"), invocation.timeoutMs));
    }

    return { completion, cancel: () => this.requestTermination(run, "canceled") };
  }

  /**
   * Cancel the live run with this id by terminating its process group; false
   * when no such run is live (it may have settled, or never existed).
   */
  cancel(runId: string): boolean {
    const run = this.live.get(runId);
    if (!run) return false;
    this.requestTermination(run, "canceled");
    return true;
  }

  /**
   * Terminate every live run's process group and wait until all their
   * completions have settled (a TERM-immune group is SIGKILLed after the
   * bounded grace, and an unconfirmed kill settles as an error). After
   * `shutdown` starts, every further start is refused. Idempotent, and
   * concurrent calls share one shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise === null) {
      const runs = [...this.live.values()];
      const settlements = runs.map((run) => run.completion);
      this.shutdownPromise = (async () => {
        for (const run of runs) this.requestTermination(run, "canceled");
        await Promise.allSettled(settlements);
      })();
    }
    await this.shutdownPromise;
  }

  /** Everything a start may or may not do, checked before any OS interaction. */
  private canStart(invocation: ProcessInvocation): boolean {
    if (!processRunnerSupported(this.platform)) return false;
    if (this.shutdownPromise !== null) return false;
    if (typeof invocation.runId !== "string" || invocation.runId.length === 0) return false;
    if (typeof invocation.executable !== "string" || invocation.executable.length === 0) return false;
    if (typeof invocation.cwd !== "string" || invocation.cwd.length === 0) return false;
    if (!Array.isArray(invocation.args) || !invocation.args.every((arg) => typeof arg === "string")) return false;
    if (
      invocation.timeoutMs !== undefined &&
      (typeof invocation.timeoutMs !== "number" || !Number.isFinite(invocation.timeoutMs) || invocation.timeoutMs <= 0)
    ) {
      return false;
    }
    return !this.live.has(invocation.runId);
  }

  /**
   * Request process-group termination for timeout or cancellation, at most
   * once per run: TERM now, KILL after the grace window, then wait for the
   * original process group to disappear or an error-confirmation deadline.
   */
  private requestTermination(run: LiveRun, reason: "canceled" | "timed_out"): void {
    if (run.settled || run.termination !== null) return;
    run.termination = reason;
    signalProcessGroup(run.child, "SIGTERM");
    run.cancelTimers.push(
      this.timers.setTimer(() => {
        if (run.settled) return;
        signalProcessGroup(run.child, "SIGKILL");
        if (!this.isProcessGroupAlive(run.child)) {
          this.completeTermination(run);
          return;
        }
        run.cancelTimers.push(
          this.timers.setTimer(() => {
            if (run.settled) return;
            if (!this.isProcessGroupAlive(run.child)) {
              this.completeTermination(run);
              return;
            }
            this.complete(run, { status: "error", errorCode: "process_killed" });
          }, PROCESS_KILL_CONFIRM_MS),
        );
      }, PROCESS_KILL_GRACE_MS),
    );
  }

  /**
   * Settle a run whose process was never observed to start. A process that
   * already had a pid is killed best-effort first so it cannot outlive an
   * error completion nobody will observe.
   */
  private completeWithSpawnFailure(run: LiveRun): void {
    if (run.settled) return;
    if (run.child.pid !== undefined) signalProcessGroup(run.child, "SIGKILL");
    this.complete(run, { status: "error", errorCode: "spawn_failed" });
  }

  /** Settle from the close event: the only place a real exit is observed. */
  private completeFromClose(run: LiveRun, code: number | null, signal: NodeJS.Signals | null): void {
    if (run.settled) return;
    if (run.child.pid === undefined) {
      // No process ever started (a failed spawn closes with code -2); that is
      // never an exit.
      this.complete(run, { status: "error", errorCode: "spawn_failed" });
      return;
    }
    if (run.termination !== null) {
      run.leaderExit = {
        ...(code !== null ? { exitCode: code } : {}),
        ...(signal !== null ? { signal } : {}),
      };
      if (!this.isProcessGroupAlive(run.child)) this.completeTermination(run);
      return;
    }
    if (code === null && signal === null) {
      // Neither an exit code nor a signal: the completion was not observed.
      this.complete(run, { status: "error", errorCode: "spawn_failed" });
      return;
    }
    this.complete(run, { status: "exited", exitCode: code ?? undefined, signal: signal ?? undefined });
  }

  /** Do not settle a requested cancellation until the original process group is gone. */
  private completeTermination(run: LiveRun): void {
    if (run.settled) return;
    this.complete(run, {
      status: run.termination ?? "error",
      ...(run.leaderExit?.exitCode !== undefined ? { exitCode: run.leaderExit.exitCode } : {}),
      ...(run.leaderExit?.signal !== undefined ? { signal: run.leaderExit.signal } : {}),
      errorCode: "process_killed",
    });
  }

  /** Remove a run, cancel its timers, and resolve its completion exactly once. */
  private complete(run: LiveRun, outcome: CompletionOutcome): void {
    if (run.settled) return;
    run.settled = true;
    this.live.delete(run.invocation.runId);
    for (const cancelTimer of run.cancelTimers) cancelTimer();
    run.cancelTimers.length = 0;
    const { text, truncated } = run.capture.tail();
    const { outputTail, outputTruncated } = projectOutputTail(text, truncated);
    const completion: ProcessCompletion = { status: outcome.status, outputTail, outputTruncated };
    if (outcome.exitCode !== undefined) completion.exitCode = outcome.exitCode;
    if (outcome.signal !== undefined) completion.signal = outcome.signal;
    if (outcome.errorCode !== undefined) completion.errorCode = outcome.errorCode;
    run.resolve(completion);
  }
}

/** Feed one stdio pipe into the run's bounded capture; never let it throw. */
function captureStream(run: LiveRun, stream: ProcessOutputStream | null): void {
  if (!stream) return;
  stream.on("data", (chunk) => run.capture.append(chunk));
  // A stdio stream error does not change what the process did; it must not
  // surface as an unhandled 'error' event either.
  stream.on("error", () => undefined);
}

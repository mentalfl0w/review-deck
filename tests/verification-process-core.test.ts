/**
 * ProcessRunner and ProcessVerificationStore core contract (RD-213).
 *
 * The runner is exercised with real, controlled child processes for exit
 * codes, combined output, bounded capture, timeout, cancellation, process
 * group termination, and spawn failures — and with an injected fake
 * child/clock for what a real process cannot schedule deterministically
 * (TERM → grace → KILL sequencing, single settle, kill watchdog, refusal
 * without any spawn). The store is exercised for strict validation, atomic
 * writes, mutex serialization, binding immutability, and fail-closed reads:
 * corrupt, malformed, and future-version bytes must survive untouched, and
 * no stdout/stderr/env ever reaches the file.
 *
 * Run: node --experimental-strip-types tests/verification-process-core.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { PassThrough } from "node:stream";
import type {
  ProcessInvocation,
  ProcessRunnerOptions,
  ProcessRunHandle,
  ProcessSpawn,
  ProcessSpawnOptions,
  ProcessTimers,
} from "../server/verification/ProcessRunner";
import type { ProcessVerificationRecord, ProcessVerificationStoreOptions } from "../server/persistence/ProcessVerificationStore";

// Production modules use bundler-style extensionless imports, which node's
// type stripping does not resolve; this test loads the real server modules, so
// relative specifiers without an extension get the .ts extension here.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && extname(specifier) === "") {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

// The domain types come from the type-only imports above (erased at runtime,
// checked by tsc); the runtime values are required at their real paths.
const requireFromRepo = createRequire(import.meta.url);
const {
  PROCESS_KILL_CONFIRM_MS,
  PROCESS_KILL_GRACE_MS,
  PROCESS_OUTPUT_CAPTURE_MAX_BYTES,
  PROCESS_OUTPUT_TAIL_MAX_LINES,
  ProcessRunner,
  processRunnerSupported,
} = requireFromRepo("../server/verification/ProcessRunner.ts") as {
  PROCESS_KILL_CONFIRM_MS: number;
  PROCESS_KILL_GRACE_MS: number;
  PROCESS_OUTPUT_CAPTURE_MAX_BYTES: number;
  PROCESS_OUTPUT_TAIL_MAX_LINES: number;
  ProcessRunner: new (options?: ProcessRunnerOptions) => Runner;
  processRunnerSupported: (platform: NodeJS.Platform) => boolean;
};

const {
  DEFAULT_PROCESS_VERIFICATION_PATH,
  MAX_PROCESS_VERIFICATION_RUNS,
  PROCESS_VERIFICATION_VERSION,
  ProcessVerificationStore,
  ProcessVerificationStoreError,
} = requireFromRepo("../server/persistence/ProcessVerificationStore.ts") as {
  DEFAULT_PROCESS_VERIFICATION_PATH: string;
  MAX_PROCESS_VERIFICATION_RUNS: number;
  PROCESS_VERIFICATION_VERSION: number;
  ProcessVerificationStore: new (options?: ProcessVerificationStoreOptions | string) => Store;
  ProcessVerificationStoreError: new (message: string, options?: ErrorOptions) => Error;
};

type Runner = {
  start(invocation: ProcessInvocation): ProcessRunHandle;
  cancel(runId: string): boolean;
  shutdown(): Promise<void>;
};

type Store = {
  list(): Promise<ProcessVerificationRecord[]>;
  get(runId: string): Promise<ProcessVerificationRecord | null>;
  create(run: ProcessVerificationRecord): Promise<ProcessVerificationRecord>;
  update(
    runId: string,
    transform: (run: ProcessVerificationRecord) => ProcessVerificationRecord | Promise<ProcessVerificationRecord>,
  ): Promise<ProcessVerificationRecord | null>;
  pruneCompletedBefore(cutoff: string): Promise<number>;
};

/**
 * A deterministic child: no OS process at all. Its pid is deliberately far
 * above any real pid_max, so a signal "sent" during a test can never hit a
 * real process group; `kill` records what the runner tried to send.
 */
class FakeChild extends EventEmitter {
  pid: number | undefined = 2_000_000_000;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
}

/** A fake child whose spawn failed: no pid, so nothing may be signalled. */
class UnstartedFakeChild extends FakeChild {
  pid: number | undefined = undefined;
}

type ScheduledTimer = { at: number; callback: () => void; canceled: boolean };

/** Deterministic timers: the test decides when the timeout/kill windows elapse. */
function createFakeClock() {
  let now = 0;
  const scheduled: ScheduledTimer[] = [];
  const timers: ProcessTimers = {
    setTimer(callback, delayMs) {
      const timer: ScheduledTimer = { at: now + delayMs, callback, canceled: false };
      scheduled.push(timer);
      return () => {
        timer.canceled = true;
      };
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = scheduled
        .filter((timer) => !timer.canceled && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      scheduled.splice(scheduled.indexOf(due), 1);
      now = due.at;
      due.callback();
    }
    now = target;
  };
  return { timers, advance };
}

/**
 * Poll for readiness that only exists in another OS process (a file a real
 * child writes). No in-process signal can be awaited for that, so this
 * integration test keeps one genuine, short, bounded delay — the runner's own
 * timers are driven by the injected clock instead.
 */
async function waitFor(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 8_000): Promise<void> {
  const deadlineMs = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadlineMs) throw new Error(`waitFor timed out: ${label}`);
    const slept = Promise.withResolvers<void>();
    setTimeout(slept.resolve, 20);
    await slept.promise;
  }
}

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The exact executable-plus-argv pair for a one-line node script. */
const nodeEval = (script: string): { executable: string; args: string[] } => ({
  executable: process.execPath,
  args: ["-e", script],
});

const isStoreError = (error: unknown): boolean =>
  error instanceof ProcessVerificationStoreError && error.name === "ProcessVerificationStoreError";

const ISO = "2026-01-01T00:00:00.000Z";
const STARTED = "2026-01-01T00:00:05.000Z";
const FINISHED = "2026-01-01T00:10:00.000Z";

const record = (runId: string, overrides: Partial<ProcessVerificationRecord> = {}): ProcessVerificationRecord => ({
  runId,
  workspaceId: `workspace-${runId}`,
  projectId: "project-1",
  cwd: "/tmp/review-worktree",
  targetFingerprint: `fingerprint-${runId}`,
  commandHash: `hash-${runId}`,
  commandPreview: "node --test",
  command: { executable: "node", args: ["--test"] },
  createdAt: ISO,
  status: "pending",
  ...overrides,
});

const root = await mkdtemp(join(tmpdir(), "review-deck-process-core-"));
const storePath = join(root, "stores", "process-verification-runs.json");
const store = (path: string = storePath) => new ProcessVerificationStore(path);

const readStoreFile = async (path: string = storePath) => {
  const raw = await readFile(path, "utf8");
  // Test-side view of a file this test's store wrote; the store parses with Zod.
  const document = JSON.parse(raw) as { version: number; runs: ProcessVerificationRecord[] };
  return { raw, document };
};

const tempFiles = async (path: string): Promise<string[]> => {
  try {
    return (await readdir(dirname(path))).filter((name) => name.endsWith(".tmp"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

try {
  // -------------------------------------------------------------------------
  // 0. Constants and the platform gate.
  // -------------------------------------------------------------------------
  assert.ok(processRunnerSupported("darwin"));
  assert.ok(!processRunnerSupported("linux"));
  for (const platform of ["linux", "win32", "freebsd", "openbsd", "sunos", "aix", "cygwin", "android"] as NodeJS.Platform[]) {
    assert.ok(!processRunnerSupported(platform), `${platform} must fail closed`);
  }
  assert.strictEqual(PROCESS_OUTPUT_CAPTURE_MAX_BYTES, 32 * 1024);
  assert.ok(PROCESS_OUTPUT_TAIL_MAX_LINES >= 1);
  assert.ok(PROCESS_KILL_GRACE_MS > 0);
  assert.ok(PROCESS_KILL_CONFIRM_MS > 0);
  assert.strictEqual(PROCESS_VERIFICATION_VERSION, 1);
  assert.ok(DEFAULT_PROCESS_VERIFICATION_PATH.endsWith(join("review-deck", "verification", "process-verification-runs.json")));
  assert.ok(new ProcessVerificationStore() instanceof ProcessVerificationStore);

  // -------------------------------------------------------------------------
  // 1. Refused starts never reach the OS and are already-settled errors.
  // -------------------------------------------------------------------------
  const spawnCalls: ProcessSpawnOptions[] = [];
  const spySpawn: ProcessSpawn = (_executable, _args, options) => {
    spawnCalls.push(options);
    return new FakeChild();
  };
  const refused = async (handle: ProcessRunHandle): Promise<void> => {
    const completion = await handle.completion;
    assert.strictEqual(completion.status, "error");
    assert.strictEqual(completion.errorCode, "spawn_failed");
    assert.strictEqual(completion.exitCode, undefined);
    assert.strictEqual(completion.signal, undefined);
    assert.deepStrictEqual(completion.outputTail, []);
    assert.strictEqual(completion.outputTruncated, false);
  };

  const unsupported = new ProcessRunner({ platform: "win32", spawn: spySpawn });
  await refused(unsupported.start({ runId: "win-refused", executable: "tool", args: [], cwd: "/tmp" }));
  assert.strictEqual(spawnCalls.length, 0);

  const invalidRunner = new ProcessRunner({ platform: "darwin", spawn: spySpawn });
  await refused(invalidRunner.start({ runId: "", executable: "tool", args: [], cwd: "/tmp" }));
  await refused(invalidRunner.start({ runId: "bad-executable", executable: "", args: [], cwd: "/tmp" }));
  await refused(invalidRunner.start({ runId: "bad-cwd", executable: "tool", args: [], cwd: "" }));
  // Deliberately malformed argv: the runner must refuse before spawning.
  await refused(
    invalidRunner.start({ runId: "bad-args", executable: "tool", args: [42] as unknown as string[], cwd: "/tmp" }),
  );
  await refused(invalidRunner.start({ runId: "bad-timeout", executable: "tool", args: [], cwd: "/tmp", timeoutMs: 0 }));
  await refused(
    invalidRunner.start({ runId: "bad-timeout-2", executable: "tool", args: [], cwd: "/tmp", timeoutMs: Number.NaN }),
  );
  await refused(
    invalidRunner.start({
      runId: "bad-timeout-3",
      executable: "tool",
      args: [],
      cwd: "/tmp",
      timeoutMs: Number.POSITIVE_INFINITY,
    }),
  );
  assert.strictEqual(spawnCalls.length, 0);

  // A duplicate live run id is refused while the first run stays cancellable.
  const duplicateChild = new FakeChild();
  const duplicateRunner = new ProcessRunner({ platform: "darwin", spawn: () => duplicateChild });
  const first = duplicateRunner.start({ runId: "same-id", executable: "tool", args: [], cwd: "/tmp" });
  await refused(duplicateRunner.start({ runId: "same-id", executable: "tool", args: [], cwd: "/tmp" }));
  assert.strictEqual(duplicateRunner.cancel("same-id"), true);
  duplicateChild.emit("close", null, "SIGTERM");
  assert.strictEqual((await first.completion).status, "canceled");

  // After shutdown, every start is refused without spawning.
  const shutChild = new FakeChild();
  let shutSpawnCount = 0;
  const shutRunner = new ProcessRunner({
    platform: "darwin",
    spawn: () => {
      shutSpawnCount++;
      return shutChild;
    },
  });
  const shutHandle = shutRunner.start({ runId: "shut-1", executable: "tool", args: [], cwd: "/tmp" });
  const shutdownOnce = shutRunner.shutdown();
  shutChild.emit("close", null, "SIGTERM");
  await shutdownOnce;
  assert.strictEqual((await shutHandle.completion).status, "canceled");
  await refused(shutRunner.start({ runId: "shut-2", executable: "tool", args: [], cwd: "/tmp" }));
  assert.strictEqual(shutSpawnCount, 1);
  await shutRunner.shutdown();

  // -------------------------------------------------------------------------
  // 2. Spawn call shape: exact argv, no shell, detached group, piped output.
  // -------------------------------------------------------------------------
  const shapeChild = new FakeChild();
  let seenExecutable = "";
  let seenArgs: readonly string[] = [];
  let seenOptions: ProcessSpawnOptions | null = null;
  const shapeRunner = new ProcessRunner({
    platform: "darwin",
    spawn: (executable, args, options) => {
      seenExecutable = executable;
      seenArgs = args;
      seenOptions = options;
      return shapeChild;
    },
  });
  const shapeHandle = shapeRunner.start({
    runId: "shape-1",
    executable: "/usr/bin/tool",
    args: ["--flag", "value; rm -rf / | cat $(whoami)"],
    cwd: "/tmp/a cwd with spaces",
  });
  assert.strictEqual(seenExecutable, "/usr/bin/tool");
  assert.deepStrictEqual(seenArgs, ["--flag", "value; rm -rf / | cat $(whoami)"]);
  assert.deepStrictEqual(seenOptions, {
    cwd: "/tmp/a cwd with spaces",
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  shapeChild.stdout.write(Buffer.from("out\n"));
  shapeChild.stderr.write(Buffer.from("err\n"));
  // Flowing pipes deliver their data events before the close event below.
  const flushed = Promise.withResolvers<void>();
  setImmediate(flushed.resolve);
  await flushed.promise;
  shapeChild.emit("close", 0, null);
  const shapeCompletion = await shapeHandle.completion;
  assert.strictEqual(shapeCompletion.status, "exited");
  assert.strictEqual(shapeCompletion.exitCode, 0);
  assert.strictEqual(shapeCompletion.signal, undefined);
  assert.strictEqual(shapeCompletion.errorCode, undefined);
  assert.deepStrictEqual(shapeCompletion.outputTail, ["out", "err"]);
  assert.strictEqual(shapeCompletion.outputTruncated, false);

  // -------------------------------------------------------------------------
  // 3. Completion mapping and single settle on the fake child.
  // -------------------------------------------------------------------------
  // A signal observed without any runner involvement is an exited run with a
  // signal, never an exit code; nothing here is ever treated as success.
  const signalChild = new FakeChild();
  const signalRunner = new ProcessRunner({ platform: "darwin", spawn: () => signalChild });
  const signalHandle = signalRunner.start({ runId: "signal-1", executable: "tool", args: [], cwd: "/tmp" });
  signalChild.emit("close", null, "SIGSEGV");
  const signalCompletion = await signalHandle.completion;
  assert.strictEqual(signalCompletion.status, "exited");
  assert.strictEqual(signalCompletion.exitCode, undefined);
  assert.strictEqual(signalCompletion.signal, "SIGSEGV");

  // A close with neither code nor signal is an unobserved completion: an error.
  const bareChild = new FakeChild();
  const bareRunner = new ProcessRunner({ platform: "darwin", spawn: () => bareChild });
  const bareHandle = bareRunner.start({ runId: "bare-1", executable: "tool", args: [], cwd: "/tmp" });
  bareChild.emit("close", null, null);
  const bareCompletion = await bareHandle.completion;
  assert.strictEqual(bareCompletion.status, "error");
  assert.strictEqual(bareCompletion.errorCode, "spawn_failed");

  // A spawn error settles immediately as spawn_failed; a later close and a
  // repeated error must not settle the run a second time.
  const failChild = new UnstartedFakeChild();
  const failRunner = new ProcessRunner({ platform: "darwin", spawn: () => failChild });
  const failHandle = failRunner.start({ runId: "fail-1", executable: "tool", args: [], cwd: "/tmp" });
  failChild.emit("error", new Error("spawn ENOENT"));
  const failCompletion = await failHandle.completion;
  assert.strictEqual(failCompletion.status, "error");
  assert.strictEqual(failCompletion.errorCode, "spawn_failed");
  assert.deepStrictEqual(failChild.signals, []);
  failChild.emit("close", -2, null);
  failChild.emit("error", new Error("late"));
  assert.strictEqual((await failHandle.completion).status, "error");
  assert.deepStrictEqual(failChild.signals, []);

  // A failed spawn observed only through the close event (code -2) is still a
  // spawn failure, never an exit.
  const closeOnlyChild = new UnstartedFakeChild();
  const closeOnlyRunner = new ProcessRunner({ platform: "darwin", spawn: () => closeOnlyChild });
  const closeOnlyHandle = closeOnlyRunner.start({ runId: "close-only", executable: "tool", args: [], cwd: "/tmp" });
  closeOnlyChild.emit("close", -2, null);
  const closeOnlyCompletion = await closeOnlyHandle.completion;
  assert.strictEqual(closeOnlyCompletion.status, "error");
  assert.strictEqual(closeOnlyCompletion.errorCode, "spawn_failed");
  assert.strictEqual(closeOnlyCompletion.exitCode, undefined);

  // -------------------------------------------------------------------------
  // 4. Deterministic TERM → grace → KILL sequencing and cancellation.
  // -------------------------------------------------------------------------
  const timeoutClock = createFakeClock();
  const stubborn = new FakeChild();
  const timeoutGroupAlive = { value: true };
  const timeoutRunner = new ProcessRunner({
    platform: "darwin",
    spawn: () => stubborn,
    timers: timeoutClock.timers,
    isProcessGroupAlive: () => timeoutGroupAlive.value,
  });
  const timeoutHandle = timeoutRunner.start({
    runId: "kill-seq",
    executable: "tool",
    args: [],
    cwd: "/tmp",
    timeoutMs: 50,
  });
  timeoutClock.advance(50);
  assert.deepStrictEqual(stubborn.signals, ["SIGTERM"]);
  timeoutClock.advance(PROCESS_KILL_GRACE_MS);
  assert.deepStrictEqual(stubborn.signals, ["SIGTERM", "SIGKILL"]);
  timeoutGroupAlive.value = false;
  stubborn.emit("close", null, "SIGKILL");
  const timeoutCompletion = await timeoutHandle.completion;
  assert.strictEqual(timeoutCompletion.status, "timed_out");
  assert.strictEqual(timeoutCompletion.exitCode, undefined);
  assert.strictEqual(timeoutCompletion.signal, "SIGKILL");
  assert.strictEqual(timeoutCompletion.errorCode, "process_killed");
  // Timers and repeated close/error events after settlement change nothing.
  timeoutClock.advance(PROCESS_KILL_CONFIRM_MS);
  stubborn.emit("close", 0, null);
  stubborn.emit("error", new Error("late"));
  assert.deepStrictEqual(stubborn.signals, ["SIGTERM", "SIGKILL"]);
  assert.strictEqual((await timeoutHandle.completion).status, "timed_out");

  // A group that never closes after SIGKILL settles as an unobserved error.
  // A leader that exits on TERM must not settle while another member remains
  // in the original process group; the grace-period KILL still has to run.
  const leaderCloseClock = createFakeClock();
  const leaderCloseChild = new FakeChild();
  let leaderGroupAlive = true;
  const leaderCloseRunner = new ProcessRunner({
    platform: "darwin",
    spawn: () => leaderCloseChild,
    timers: leaderCloseClock.timers,
    isProcessGroupAlive: () => leaderGroupAlive,
  });
  const leaderCloseHandle = leaderCloseRunner.start({ runId: "leader-close", executable: "tool", args: [], cwd: "/tmp" });
  leaderCloseHandle.cancel();
  leaderCloseChild.emit("close", 0, null);
  let leaderCloseSettled = false;
  void leaderCloseHandle.completion.then(() => {
    leaderCloseSettled = true;
  });
  await Promise.resolve();
  assert.equal(leaderCloseSettled, false, "leader close cannot cancel group escalation while a descendant remains");
  leaderCloseClock.advance(PROCESS_KILL_GRACE_MS);
  assert.deepStrictEqual(leaderCloseChild.signals, ["SIGTERM", "SIGKILL"]);
  leaderGroupAlive = false;
  leaderCloseClock.advance(PROCESS_KILL_CONFIRM_MS);
  const leaderCloseCompletion = await leaderCloseHandle.completion;
  assert.equal(leaderCloseCompletion.status, "canceled");
  assert.equal(leaderCloseCompletion.exitCode, 0);
  assert.equal(leaderCloseCompletion.errorCode, "process_killed");

  const watchdogClock = createFakeClock();
  const deaf = new FakeChild();
  const watchdogRunner = new ProcessRunner({
    platform: "darwin",
    spawn: () => deaf,
    timers: watchdogClock.timers,
    isProcessGroupAlive: () => true,
  });
  const watchdogHandle = watchdogRunner.start({
    runId: "watchdog",
    executable: "tool",
    args: [],
    cwd: "/tmp",
    timeoutMs: 10,
  });
  watchdogClock.advance(10);
  watchdogClock.advance(PROCESS_KILL_GRACE_MS);
  watchdogClock.advance(PROCESS_KILL_CONFIRM_MS);
  const watchdogCompletion = await watchdogHandle.completion;
  assert.strictEqual(watchdogCompletion.status, "error");
  assert.strictEqual(watchdogCompletion.errorCode, "process_killed");
  assert.deepStrictEqual(deaf.signals, ["SIGTERM", "SIGKILL"]);

  // The handle's own cancel() terminates with TERM; a second cancel by id
  // after settlement reports false.
  const cancelClock = createFakeClock();
  const cancelFake = new FakeChild();
  const cancelGroupAlive = { value: true };
  const cancelRunner = new ProcessRunner({
    platform: "darwin",
    spawn: () => cancelFake,
    timers: cancelClock.timers,
    isProcessGroupAlive: () => cancelGroupAlive.value,
  });
  const cancelHandle = cancelRunner.start({ runId: "cancel-me", executable: "tool", args: [], cwd: "/tmp" });
  cancelHandle.cancel();
  assert.deepStrictEqual(cancelFake.signals, ["SIGTERM"]);
  cancelGroupAlive.value = false;
  cancelFake.emit("close", null, "SIGTERM");
  const cancelCompletion = await cancelHandle.completion;
  assert.strictEqual(cancelCompletion.status, "canceled");
  assert.strictEqual(cancelCompletion.errorCode, "process_killed");
  assert.strictEqual(cancelCompletion.signal, "SIGTERM");
  assert.strictEqual(cancelRunner.cancel("cancel-me"), false);
  assert.strictEqual(cancelRunner.cancel("never-existed"), false);

  // Shutdown cancels every live run; a TERM-immune group is SIGKILLed after
  // the grace window and settles from the watchdog. Starts are refused after.
  const shutdownClock = createFakeClock();
  const stuckChildren = [new FakeChild(), new FakeChild()];
  let stuckIndex = 0;
  let stuckSpawnCount = 0;
  const shutdownRunner = new ProcessRunner({
    platform: "darwin",
    spawn: () => {
      stuckSpawnCount++;
      return stuckChildren[stuckIndex++];
    },
    timers: shutdownClock.timers,
    isProcessGroupAlive: () => true,
  });
  const stuckFirst = shutdownRunner.start({ runId: "stuck-1", executable: "tool", args: [], cwd: "/tmp" });
  const stuckSecond = shutdownRunner.start({ runId: "stuck-2", executable: "tool", args: [], cwd: "/tmp" });
  const shutdownPromise = shutdownRunner.shutdown();
  shutdownClock.advance(PROCESS_KILL_GRACE_MS);
  assert.deepStrictEqual(stuckChildren[0].signals, ["SIGTERM", "SIGKILL"]);
  assert.deepStrictEqual(stuckChildren[1].signals, ["SIGTERM", "SIGKILL"]);
  shutdownClock.advance(PROCESS_KILL_CONFIRM_MS);
  await shutdownPromise;
  const stuckCompletions = await Promise.all([stuckFirst.completion, stuckSecond.completion]);
  assert.deepStrictEqual(
    stuckCompletions.map((completion) => [completion.status, completion.errorCode]),
    [
      ["error", "process_killed"],
      ["error", "process_killed"],
    ],
  );
  await shutdownRunner.shutdown();
  const postShutdown = shutdownRunner.start({ runId: "stuck-3", executable: "tool", args: [], cwd: "/tmp" });
  assert.strictEqual((await postShutdown.completion).status, "error");
  assert.strictEqual(stuckSpawnCount, 2);

  // -------------------------------------------------------------------------
  // 5. Real child processes: exit codes, output, timeout, cancel, group kill.
  // -------------------------------------------------------------------------
  const runner = new ProcessRunner();
  try {
    // Exit 0 with combined stdout/stderr and a shell-metacharacter argv that
    // must arrive verbatim (argv is never re-parsed by any shell).
    const verbatim = "value; rm -rf / | cat $(whoami)";
    const exitZeroHandle = runner.start({
      runId: "real-exit-0",
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write('alpha');process.stderr.write('beta\\n');process.stdout.write(process.argv[1])",
        verbatim,
      ],
      cwd: root,
      timeoutMs: 10_000,
    });
    const exitZero = await exitZeroHandle.completion;
    assert.strictEqual(exitZero.status, "exited");
    assert.strictEqual(exitZero.exitCode, 0);
    assert.strictEqual(exitZero.signal, undefined);
    assert.strictEqual(exitZero.errorCode, undefined);
    assert.strictEqual(exitZero.outputTruncated, false);
    const exitZeroTail = exitZero.outputTail.join("\n");
    assert.ok(exitZeroTail.includes("alpha"), exitZeroTail);
    assert.ok(exitZeroTail.includes("beta"), exitZeroTail);
    assert.ok(exitZeroTail.includes(verbatim), exitZeroTail);

    // A non-zero exit is reported as-is, never as a success or a failure verdict.
    const exitTwoHandle = runner.start({
      runId: "real-exit-2",
      ...nodeEval("process.exit(2)"),
      cwd: root,
      timeoutMs: 10_000,
    });
    const exitTwo = await exitTwoHandle.completion;
    assert.strictEqual(exitTwo.status, "exited");
    assert.strictEqual(exitTwo.exitCode, 2);
    assert.deepStrictEqual(exitTwo.outputTail, []);

    // Missing executables and unreadable cwds fail closed without a process.
    const missingExecutable = runner.start({
      runId: "real-missing-executable",
      executable: join(root, "no-such-verification-binary"),
      args: [],
      cwd: root,
      timeoutMs: 10_000,
    });
    const missingExecutableCompletion = await missingExecutable.completion;
    assert.strictEqual(missingExecutableCompletion.status, "error");
    assert.strictEqual(missingExecutableCompletion.errorCode, "spawn_failed");
    assert.strictEqual(missingExecutableCompletion.exitCode, undefined);

    const missingCwd = runner.start({
      runId: "real-missing-cwd",
      ...nodeEval("0"),
      cwd: join(root, "no-such-directory"),
      timeoutMs: 10_000,
    });
    const missingCwdCompletion = await missingCwd.completion;
    assert.strictEqual(missingCwdCompletion.status, "error");
    assert.strictEqual(missingCwdCompletion.errorCode, "spawn_failed");

    // The runner's own timeout is real platform behavior here: a genuine
    // short delay terminates the real process group with SIGTERM.
    const timeoutReal = runner.start({
      runId: "real-timeout",
      ...nodeEval("setInterval(() => {}, 1000)"),
      cwd: root,
      timeoutMs: 250,
    });
    const timeoutKilled = await timeoutReal.completion;
    assert.strictEqual(timeoutKilled.status, "timed_out");
    assert.strictEqual(timeoutKilled.errorCode, "process_killed");
    assert.strictEqual(timeoutKilled.exitCode, undefined);
    assert.strictEqual(timeoutKilled.signal, "SIGTERM");

    // Cancellation by run id terminates a running real process.
    const readyFile = join(root, "cancel-ready.txt");
    const cancelRealHandle = runner.start({
      runId: "real-cancel",
      ...nodeEval(
        `require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready');setInterval(() => {}, 1000)`,
      ),
      cwd: root,
    });
    await waitFor(async () => {
      try {
        await readFile(readyFile, "utf8");
        return true;
      } catch {
        return false;
      }
    }, "real-cancel child ready");
    assert.strictEqual(runner.cancel("real-cancel"), true);
    const cancelReal = await cancelRealHandle.completion;
    assert.strictEqual(cancelReal.status, "canceled");
    assert.strictEqual(cancelReal.errorCode, "process_killed");
    assert.strictEqual(cancelReal.signal, "SIGTERM");
    assert.strictEqual(runner.cancel("real-cancel"), false);

    // A TERM-immune group (child plus grandchild) is SIGKILLed as a group.
    // The kill windows are driven by the injected clock, so the grace period
    // costs no real time; the signals themselves are real OS signals.
    const groupDir = join(root, "group");
    await mkdir(groupDir, { recursive: true });
    const groupScriptPath = join(groupDir, "group-child.cjs");
    const pidFile = join(groupDir, "grandchild.pid");
    const grandchildReady = join(groupDir, "grandchild.ready");
    const grandchildScript =
      "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000);";
    const groupScript = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      "const [pidFile, grandchildReady] = process.argv.slice(2);",
      'process.on("SIGTERM", () => {});',
      `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}, grandchildReady], { stdio: "ignore" });`,
      'fs.writeFileSync(pidFile, String(grandchild.pid));',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    await writeFile(groupScriptPath, groupScript, "utf8");
    const groupClock = createFakeClock();
    const groupRunner = new ProcessRunner({ timers: groupClock.timers });
    try {
      const groupHandle = groupRunner.start({
        runId: "real-group",
        executable: process.execPath,
        args: [groupScriptPath, pidFile, grandchildReady],
        cwd: groupDir,
      });
      await waitFor(async () => {
        try {
          await readFile(pidFile, "utf8");
          await readFile(grandchildReady, "utf8");
          return true;
        } catch {
          return false;
        }
      }, "group child and grandchild ready");
      const grandchildPid = Number((await readFile(pidFile, "utf8")).trim());
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
      assert.ok(processExists(grandchildPid), "grandchild should be running before cancellation");
      assert.strictEqual(groupRunner.cancel("real-group"), true);
      groupClock.advance(PROCESS_KILL_GRACE_MS);
      await waitFor(() => !processExists(grandchildPid), "grandchild dies with the process group");
      groupClock.advance(PROCESS_KILL_CONFIRM_MS);
      const groupCompletion = await groupHandle.completion;
      assert.ok(groupCompletion.status === "canceled" || groupCompletion.status === "error", "group termination is never reported as a successful exit");
      assert.equal(groupCompletion.errorCode, "process_killed");
    } finally {
      const settled = groupRunner.shutdown();
      groupClock.advance(2 * (PROCESS_KILL_GRACE_MS + PROCESS_KILL_CONFIRM_MS));
      await settled;
    }

    // Shutdown cancels live real runs and starts after it are refused.
    const shutdownRealRunner = new ProcessRunner();
    try {
      const sleepers = ["real-shutdown-1", "real-shutdown-2"].map((runId) =>
        shutdownRealRunner.start({ runId, ...nodeEval("setInterval(() => {}, 1000)"), cwd: root }),
      );
      await shutdownRealRunner.shutdown();
      const sleeperCompletions = await Promise.all(sleepers.map((handle) => handle.completion));
      assert.deepStrictEqual(
        sleeperCompletions.map((completion) => [completion.status, completion.errorCode]),
        [
          ["canceled", "process_killed"],
          ["canceled", "process_killed"],
        ],
      );
      const refusedAfterShutdown = await shutdownRealRunner.start({
        runId: "real-after-shutdown",
        ...nodeEval("0"),
        cwd: root,
      }).completion;
      assert.strictEqual(refusedAfterShutdown.errorCode, "spawn_failed");
    } finally {
      await shutdownRealRunner.shutdown();
    }

    // -----------------------------------------------------------------------
    // 6. Bounded capture on real children.
    // -----------------------------------------------------------------------
    const overflowHandle = runner.start({
      runId: "real-output-overflow",
      ...nodeEval("process.stdout.write('x'.repeat(96000));process.stdout.write('\\nTAIL-MARKER\\n')"),
      cwd: root,
      timeoutMs: 10_000,
    });
    const overflow = await overflowHandle.completion;
    assert.strictEqual(overflow.status, "exited");
    assert.strictEqual(overflow.outputTail.length, 2);
    assert.strictEqual(overflow.outputTail[1], "TAIL-MARKER");
    // The last 32768 bytes were kept, minus the dropped trailing newline.
    assert.strictEqual(Buffer.byteLength(overflow.outputTail.join("\n")), PROCESS_OUTPUT_CAPTURE_MAX_BYTES - 1);
    assert.strictEqual(overflow.outputTruncated, true);

    const manyLinesHandle = runner.start({
      runId: "real-output-lines",
      ...nodeEval("process.stdout.write(Array.from({ length: 250 }, (_, i) => 'L' + i).join('\\n'))"),
      cwd: root,
      timeoutMs: 10_000,
    });
    const manyLines = await manyLinesHandle.completion;
    assert.strictEqual(manyLines.status, "exited");
    assert.strictEqual(manyLines.outputTail.length, PROCESS_OUTPUT_TAIL_MAX_LINES);
    assert.strictEqual(manyLines.outputTail[0], "L50");
    assert.strictEqual(manyLines.outputTail[PROCESS_OUTPUT_TAIL_MAX_LINES - 1], "L249");
    assert.strictEqual(manyLines.outputTruncated, true);

    // -----------------------------------------------------------------------
    // 7. Cross-module: a real completion flows into the store's strict metadata.
    // -----------------------------------------------------------------------
    const crossPath = join(root, "cross", "process-verification-runs.json");
    const crossStore = store(crossPath);
    const sentinel = "SENTINEL-OUTPUT-DO-NOT-PERSIST";
    const crossScriptPath = join(root, "cross-captured-output.js");
    await writeFile(crossScriptPath, `process.stdout.write(${JSON.stringify(sentinel)})`, "utf8");
    const crossHandle = runner.start({
      runId: "cross-run",
      executable: process.execPath,
      args: [crossScriptPath],
      cwd: root,
      timeoutMs: 10_000,
    });
    const crossCompletion = await crossHandle.completion;
    assert.strictEqual(crossCompletion.status, "exited");
    assert.strictEqual(crossCompletion.exitCode, 0);
    assert.strictEqual(crossCompletion.outputTail.join("\n"), sentinel);
    await crossStore.create(
      record("cross-run", {
        cwd: root,
        targetFingerprint: "fingerprint-cross",
        commandHash: "hash-cross",
        commandPreview: "node -e <captured verification command>",
        command: { executable: process.execPath, args: [crossScriptPath] },
        status: "running",
        startedAt: STARTED,
      }),
    );
    const crossFinished = await crossStore.update("cross-run", (run) => ({
      ...run,
      status: crossCompletion.status,
      completedAt: FINISHED,
      ...(crossCompletion.exitCode !== undefined ? { exitCode: crossCompletion.exitCode } : {}),
      ...(crossCompletion.signal !== undefined ? { signal: crossCompletion.signal } : {}),
      ...(crossCompletion.errorCode !== undefined ? { errorCode: crossCompletion.errorCode } : {}),
    }));
    assert.strictEqual(crossFinished?.status, "exited");
    assert.strictEqual(crossFinished?.exitCode, 0);
    assert.strictEqual(crossFinished?.signal, undefined);
    assert.strictEqual(crossFinished?.errorCode, undefined);
    const crossRaw = await readFile(crossPath, "utf8");
    assert.ok(!crossRaw.includes(sentinel), "captured output must never be persisted");
    assert.ok(!crossRaw.includes("stdout") && !crossRaw.includes("outputTail"));
  } finally {
    await runner.shutdown();
  }

  // -------------------------------------------------------------------------
  // 8. Store: create/list/get, atomic writes, serialization, private mode.
  // -------------------------------------------------------------------------
  const fresh = store();
  assert.deepStrictEqual(await fresh.list(), []);
  assert.strictEqual(await fresh.get("missing"), null);
  await assert.rejects(readFile(storePath, "utf8"), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");

  const created = await fresh.create(record("run-1", { status: "running", startedAt: STARTED }));
  assert.strictEqual(created.runId, "run-1");
  await fresh.create(record("run-2", { status: "exited", startedAt: STARTED, completedAt: FINISHED, exitCode: 0 }));
  const listed = await fresh.list();
  assert.deepStrictEqual(
    listed.map((run) => run.runId),
    ["run-1", "run-2"],
  );
  assert.strictEqual((await fresh.get("run-2"))?.exitCode, 0);
  const stored = await readStoreFile();
  assert.strictEqual(stored.document.version, PROCESS_VERIFICATION_VERSION);
  assert.deepStrictEqual(stored.document.runs, listed);
  assert.deepStrictEqual(await tempFiles(storePath), []);
  assert.strictEqual((await stat(storePath)).mode & 0o777, 0o600);
  assert.strictEqual((await stat(dirname(storePath))).mode & 0o777, 0o700);
  const reloaded = store();
  assert.deepStrictEqual(
    (await reloaded.list()).map((run) => run.runId),
    ["run-1", "run-2"],
  );

  // Concurrent creates are serialized: every run lands, none is lost.
  const concurrentPath = join(root, "concurrent", "process-verification-runs.json");
  const concurrentStore = store(concurrentPath);
  const parallelIds = Array.from({ length: 12 }, (_, index) => `parallel-${index}`);
  await Promise.all(parallelIds.map((runId) => concurrentStore.create(record(runId))));
  assert.deepStrictEqual(
    (await concurrentStore.list()).map((run) => run.runId),
    parallelIds,
  );
  assert.deepStrictEqual(await tempFiles(concurrentPath), []);

  // -------------------------------------------------------------------------
  // 9. Store: validation rejects without touching (or creating) the file.
  // -------------------------------------------------------------------------
  const validationPath = join(root, "validation", "process-verification-runs.json");
  const validationStore = store(validationPath);
  // Each payload below is type-valid but breaks a stored-record invariant.
  await assert.rejects(validationStore.create(record("bad-1", { status: "running" })), isStoreError);
  await assert.rejects(
    validationStore.create(record("bad-2", { status: "exited", startedAt: STARTED, completedAt: FINISHED })),
    isStoreError,
  );
  await assert.rejects(
    validationStore.create(record("bad-3", { status: "abandoned", completedAt: FINISHED, exitCode: 0 })),
    isStoreError,
  );
  await assert.rejects(validationStore.create(record("bad-4", { status: "pending", startedAt: STARTED })), isStoreError);
  await assert.rejects(
    validationStore.create(record("bad-5", { status: "pending", completedAt: FINISHED })),
    isStoreError,
  );
  await assert.rejects(
    validationStore.create(record("bad-6", { status: "canceled", startedAt: STARTED, completedAt: ISO })),
    isStoreError,
  );
  // A deliberately smuggled field must be rejected by the strict schema.
  await assert.rejects(
    validationStore.create({ ...record("bad-7"), stdout: "leaked" } as unknown as ProcessVerificationRecord),
    isStoreError,
  );
  // The shared command contract keeps a shell launcher out of the store.
  await assert.rejects(
    validationStore.create(record("bad-8", { command: { executable: "bash", args: ["-c", "rm -rf /"] } })),
    isStoreError,
  );
  await assert.rejects(readFile(validationPath, "utf8"), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");

  // Duplicate run ids are rejected without a second write.
  const duplicateStore = store(join(root, "duplicate", "process-verification-runs.json"));
  await duplicateStore.create(record("duplicate-1"));
  await assert.rejects(duplicateStore.create(record("duplicate-1")), isStoreError);
  assert.deepStrictEqual(
    (await duplicateStore.list()).map((run) => run.runId),
    ["duplicate-1"],
  );

  // -------------------------------------------------------------------------
  // 10. Store: update lifecycle, binding immutability, validation.
  // -------------------------------------------------------------------------
  const updatePath = join(root, "update", "process-verification-runs.json");
  const updateStore = store(updatePath);
  assert.strictEqual(await updateStore.update("missing", (run) => run), null);
  await assert.rejects(readFile(updatePath, "utf8"), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");

  await updateStore.create(record("life-1", { findingId: "finding-9", reviewRunId: "review-run-9", verificationRunId: "interactive-run-9" }));
  const running = await updateStore.update("life-1", (run) => ({ ...run, status: "running", startedAt: STARTED }));
  assert.strictEqual(running?.status, "running");
  const exited = await updateStore.update("life-1", (run) => ({
    ...run,
    status: "exited",
    completedAt: FINISHED,
    exitCode: 2,
  }));
  assert.strictEqual(exited?.exitCode, 2);
  assert.strictEqual((await store(updatePath).get("life-1"))?.status, "exited");

  const decided = await updateStore.update("life-1", (run) => ({
    ...run,
    humanDecision: "accepted",
    decisionAt: FINISHED,
  }));
  assert.strictEqual(decided?.humanDecision, "accepted");
  assert.strictEqual(decided?.decisionAt, FINISHED);
  const beforeImmutable = await readFile(updatePath, "utf8");
  await assert.rejects(updateStore.update("life-1", (run) => ({ ...run, findingId: "other-finding" })), isStoreError);
  await assert.rejects(updateStore.update("life-1", (run) => ({ ...run, verificationRunId: "other-run" })), isStoreError);
  await assert.rejects(updateStore.update("life-1", (run) => ({ ...run, reviewRunId: "other-review" })), isStoreError);
  await assert.rejects(updateStore.update("life-1", (run) => ({ ...run, cwd: "/tmp/other-worktree" })), isStoreError);
  await assert.rejects(
    updateStore.update("life-1", (run) => ({ ...run, command: { executable: "node", args: ["--test", "--rebind"] } })),
    isStoreError,
  );
  await assert.rejects(updateStore.update("life-1", (run) => ({ ...run, commandHash: "other-hash" })), isStoreError);
  await assert.rejects(updateStore.update("life-1", (run) => ({ ...run, createdAt: FINISHED })), isStoreError);
  await assert.rejects(updateStore.update("life-1", (run) => ({ ...run, runId: "renamed" })), isStoreError);
  assert.strictEqual(await readFile(updatePath, "utf8"), beforeImmutable);
  // A transformed run that breaks a schema invariant is refused as well.
  await assert.rejects(
    updateStore.update("life-1", (run) => ({ ...run, status: "canceled", completedAt: undefined })),
    isStoreError,
  );
  assert.strictEqual(await readFile(updatePath, "utf8"), beforeImmutable);
  assert.strictEqual((await updateStore.get("life-1"))?.status, "exited");

  // Terminal metadata is retained only within the configured cutoff; live runs
  // survive pruning even when their creation time is older.
  const pruneStore = store(join(root, "prune", "process-verification-runs.json"));
  await pruneStore.create(record("expired-run", {
    status: "exited",
    createdAt: "2025-12-01T00:00:00.000Z",
    startedAt: "2025-12-01T00:00:01.000Z",
    completedAt: "2025-12-01T00:00:02.000Z",
    exitCode: 1,
  }));
  await pruneStore.create(record("live-run", {
    status: "running",
    createdAt: "2025-12-01T00:00:00.000Z",
    startedAt: "2025-12-01T00:00:01.000Z",
  }));
  await pruneStore.create(record("fresh-run", {
    status: "canceled",
    createdAt: "2026-01-02T00:00:00.000Z",
    startedAt: "2026-01-02T00:00:01.000Z",
    completedAt: "2026-01-02T00:00:02.000Z",
  }));
  assert.equal(await pruneStore.pruneCompletedBefore("2026-01-01T00:00:00.000Z"), 1);
  assert.deepEqual((await pruneStore.list()).map((run) => run.runId), ["live-run", "fresh-run"]);

  // Adding a pending run evicts the oldest terminal metadata but never a live run.
  const capPath = join(root, "cap", "process-verification-runs.json");
  await mkdir(dirname(capPath), { recursive: true });
  const terminalRuns = Array.from({ length: MAX_PROCESS_VERIFICATION_RUNS - 2 }, (_, index) => {
    const createdAt = new Date(Date.parse("2025-12-01T00:00:00.000Z") + index * 1_000).toISOString();
    return record(`cap-${index}`, {
      status: "exited",
      createdAt,
      startedAt: new Date(Date.parse(createdAt) + 100).toISOString(),
      completedAt: new Date(Date.parse(createdAt) + 200).toISOString(),
      exitCode: 1,
    });
  });
  const fullRuns = [
    ...terminalRuns,
    record("active-one", { status: "running", startedAt: STARTED }),
    record("active-two", { status: "running", startedAt: STARTED }),
  ];
  await writeFile(capPath, JSON.stringify({ version: PROCESS_VERIFICATION_VERSION, runs: fullRuns }), "utf8");
  const capStore = store(capPath);
  await capStore.create(record("new-pending"));
  const cappedRuns = await capStore.list();
  assert.equal(cappedRuns.length, MAX_PROCESS_VERIFICATION_RUNS);
  assert.equal(cappedRuns.some((run) => run.runId === "cap-0"), false);
  assert.ok(cappedRuns.some((run) => run.runId === "active-one"));
  assert.ok(cappedRuns.some((run) => run.runId === "active-two"));
  assert.ok(cappedRuns.some((run) => run.runId === "new-pending"));

  // -------------------------------------------------------------------------
  // 11. Store: corrupt, malformed, and future bytes stay untouched.
  // -------------------------------------------------------------------------
  const corruptPath = join(root, "corrupt", "process-verification-runs.json");
  const corruptRaw = "{ this is not json at all";
  await mkdir(dirname(corruptPath), { recursive: true });
  await writeFile(corruptPath, corruptRaw, "utf8");
  const corruptStore = store(corruptPath);
  await assert.rejects(corruptStore.list(), isStoreError);
  await assert.rejects(corruptStore.get("anything"), isStoreError);
  await assert.rejects(corruptStore.create(record("corrupt-1")), isStoreError);
  await assert.rejects(corruptStore.update("corrupt-1", (run) => run), isStoreError);
  assert.strictEqual(await readFile(corruptPath, "utf8"), corruptRaw);

  const futurePath = join(root, "future", "process-verification-runs.json");
  const futureRaw = `${JSON.stringify({ version: 2, runs: [] }, null, 2)}\n`;
  await mkdir(dirname(futurePath), { recursive: true });
  await writeFile(futurePath, futureRaw, "utf8");
  const futureStore = store(futurePath);
  await assert.rejects(futureStore.list(), isStoreError);
  await assert.rejects(futureStore.create(record("future-1")), isStoreError);
  await assert.rejects(futureStore.update("future-1", (run) => run), isStoreError);
  assert.strictEqual(await readFile(futurePath, "utf8"), futureRaw);

  const markerlessPath = join(root, "markerless", "process-verification-runs.json");
  const markerlessRaw = `${JSON.stringify({ runs: [] }, null, 2)}\n`;
  await mkdir(dirname(markerlessPath), { recursive: true });
  await writeFile(markerlessPath, markerlessRaw, "utf8");
  await assert.rejects(store(markerlessPath).list(), isStoreError);
  assert.strictEqual(await readFile(markerlessPath, "utf8"), markerlessRaw);

  const smuggledPath = join(root, "smuggled", "process-verification-runs.json");
  const smuggledRaw = `${JSON.stringify(
    {
      version: 1,
      runs: [{ ...record("smuggle-1"), stdout: "leaked output", env: { TOKEN: "secret" }, patch: "diff" }],
    },
    null,
    2,
  )}\n`;
  await mkdir(dirname(smuggledPath), { recursive: true });
  await writeFile(smuggledPath, smuggledRaw, "utf8");
  await assert.rejects(store(smuggledPath).list(), isStoreError);
  assert.strictEqual(await readFile(smuggledPath, "utf8"), smuggledRaw);

  // A terminal-mode status must not leak into process-mode storage.
  const terminalStatusPath = join(root, "terminal-status", "process-verification-runs.json");
  const terminalStatusRaw = `${JSON.stringify(
    { version: 1, runs: [{ ...record("terminal-1"), status: "open" }] },
    null,
    2,
  )}\n`;
  await mkdir(dirname(terminalStatusPath), { recursive: true });
  await writeFile(terminalStatusPath, terminalStatusRaw, "utf8");
  await assert.rejects(store(terminalStatusPath).list(), isStoreError);
  assert.strictEqual(await readFile(terminalStatusPath, "utf8"), terminalStatusRaw);

  const duplicateIdsPath = join(root, "duplicate-ids", "process-verification-runs.json");
  const duplicateIdsRaw = `${JSON.stringify({ version: 1, runs: [record("twice"), record("twice")] }, null, 2)}\n`;
  await mkdir(dirname(duplicateIdsPath), { recursive: true });
  await writeFile(duplicateIdsPath, duplicateIdsRaw, "utf8");
  await assert.rejects(store(duplicateIdsPath).list(), isStoreError);
  assert.strictEqual(await readFile(duplicateIdsPath, "utf8"), duplicateIdsRaw);
} finally {
  await rm(root, { recursive: true, force: true });
}

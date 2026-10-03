/**
 * Verification Terminal backend (v2.0).
 *
 * The pieces that must never lie are pinned here:
 *
 * - the command contract (executable + argv, never a shell string; launchers,
 *   builtins, and evaluators are refused),
 * - the invocation quoting (each token becomes one literal word of the
 *   interactive shell line, so no argument can inject shell syntax),
 * - the run state machine (a terminal that exists is `open`, a terminal that is
 *   gone is `closed`, an unreadable workspace is `unavailable`, a rebound
 *   binding is `error` — and captured output never decides any of that),
 * - the run store (metadata and status only; a stored run can never carry
 *   output, an exit code, or a verified fact),
 * - the sections path (a structured finding's command reaches the UI as a
 *   suggestion; the Markdown fallback's machine-readable command section is
 *   parsed strictly or omitted, and never leaks into a prose section).
 *
 * Run: node --experimental-strip-types tests/verification-terminal.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type * as LifecycleModule from "../server/verification/lifecycle";
import type * as WrapperModule from "../server/verification/wrapper";
import type * as VerificationServiceModule from "../server/verification/VerificationService";
import type * as VerificationStoreModule from "../server/persistence/VerificationRunStore";
import type { VerificationRunRecord } from "../server/persistence/VerificationRunStore";
import type * as StructuredReviewModule from "../server/structured-review";
import type * as SharedReviewModule from "../shared/review";
import type { StructuredReviewResult } from "../shared/review";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

// Production modules use bundler-style extensionless imports, which node's
// type stripping does not resolve; this test loads the real modules, so
// relative specifiers without an extension get the .ts extension here.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && extname(specifier) === "") {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const requireFromRepo = createRequire(import.meta.url);
const shared: typeof SharedReviewModule = requireFromRepo("../shared/review.ts");
const wrapperModule: typeof WrapperModule = requireFromRepo("../server/verification/wrapper.ts");
const lifecycle: typeof LifecycleModule = requireFromRepo("../server/verification/lifecycle.ts");
const verificationServiceModule: typeof VerificationServiceModule = requireFromRepo("../server/verification/VerificationService.ts");
const storeModule: typeof VerificationStoreModule = requireFromRepo("../server/persistence/VerificationRunStore.ts");
const structuredReview: typeof StructuredReviewModule = requireFromRepo("../server/structured-review.ts");

const {
  verificationCommandSchema,
  verificationCommandProblem,
  formatVerificationCommand,
  structuredReviewResultSchema,
  reviewSectionsSchema,
  verificationRunResultSchema,
  VERIFICATION_OUTPUT_TAIL_MAX_LINES,
  VERIFICATION_OUTPUT_TAIL_LINE_MAX_LENGTH,
} = shared;
const {
  verificationShell,
  quotePosixToken,
  quotePowerShellToken,
  formatPosixInvocation,
  formatPowerShellInvocation,
  formatVerificationInvocation,
} = wrapperModule;
const { verificationRunCompletion, boundedVerificationOutputTail, verificationFailure, VERIFICATION_RUN_TTL_MS } = lifecycle;
const { VerificationRunStore, VerificationRunStoreError, DEFAULT_VERIFICATION_RUN_PATH, VERIFICATION_RUN_VERSION } = storeModule;
const { VerificationService } = verificationServiceModule;
const { parseStructuredReviewResult, normalizeStructuredReviewResult, parseFallbackVerificationSection, reviewSectionsFromMarkdown } = structuredReview;

type CommandCandidate = { executable: string; args: string[] };

// ---------------------------------------------------------------------------
// 1. Command contract: one executable plus argv, strict about both.
// ---------------------------------------------------------------------------
assert.equal(verificationCommandSchema.safeParse({ executable: "npm", args: ["run", "test"] }).success, true);
assert.equal(verificationCommandSchema.safeParse({ executable: "  ./gradlew  ", args: ["test"] }).data?.executable, "./gradlew");
assert.equal(verificationCommandSchema.safeParse({ executable: "npm", args: [] }).success, true);
// Arguments may hold shell-looking characters: they are argv, then quoted for
// the interactive shell, never parsed as source.
assert.equal(verificationCommandSchema.safeParse({ executable: "node", args: ["-e", "1|2; rm -rf /"] }).success, true);
assert.equal(verificationCommandProblem({ executable: "npm", args: ["--grep=a|b"] }), null);

const rejectedCommands: Array<[string, unknown]> = [
  ["a whole command line pasted as the executable", { executable: "npm run test", args: [] }],
  ["a shell operator", { executable: "npm;rm", args: [] }],
  ["a pipe", { executable: "cat|sh", args: [] }],
  ["a redirect", { executable: "echo>x", args: [] }],
  ["a substitution", { executable: "$(which npm)", args: [] }],
  ["a glob in the executable", { executable: "np*", args: [] }],
  ["a bracket class in the executable", { executable: "[a-z]test", args: [] }],
  ["a grouping character", { executable: "npm(1)", args: [] }],
  ["a shell launcher", { executable: "sh", args: ["-c", "npm test"] }],
  ["a launcher by path", { executable: "/bin/bash", args: ["-c", "npm test"] }],
  ["a windows launcher", { executable: "cmd.exe", args: ["/c", "npm test"] }],
  ["the POSIX eval builtin", { executable: "eval", args: ["npm test"] }],
  ["the POSIX source builtin", { executable: "source", args: ["./run.sh"] }],
  ["the POSIX dot-source builtin", { executable: ".", args: ["./run.sh"] }],
  ["the POSIX exec builtin", { executable: "exec", args: ["node", "test.js"] }],
  ["the POSIX command builtin", { executable: "command", args: ["eval", "npm test"] }],
  ["the POSIX colon builtin", { executable: ":", args: [] }],
  ["the POSIX test builtin", { executable: "[", args: ["-f", "x"] }],
  ["the POSIX echo builtin", { executable: "echo", args: ["done"] }],
  ["the POSIX export builtin", { executable: "export", args: ["CI=1"] }],
  ["the POSIX alias builtin", { executable: "alias", args: ["t=npm"] }],
  ["the PowerShell IEX alias", { executable: "iex", args: ["Write-Output", "pass"] }],
  ["the PowerShell ICM alias", { executable: "icm", args: ["Get-Process"] }],
  ["the PowerShell IWR alias", { executable: "iwr", args: ["https://example.test"] }],
  ["the PowerShell curl alias", { executable: "curl", args: ["https://example.test"] }],
  ["the PowerShell wget alias", { executable: "wget", args: ["https://example.test"] }],
  ["the PowerShell Start-Process alias", { executable: "start", args: ["powershell.exe", "-Command", "Get-Process"] }],
  ["the PowerShell SAPS alias", { executable: "saps", args: ["powershell.exe", "-Command", "Get-Process"] }],
  ["the PowerShell SAJB alias", { executable: "sajb", args: ["-ScriptBlock", "Get-Process"] }],
  ["the PowerShell Invoke-Expression cmdlet", { executable: "Invoke-Expression", args: ["Write-Output pass"] }],
  ["the PowerShell Invoke-Command cmdlet", { executable: "Invoke-Command", args: ["Write-Output pass"] }],
  ["a privilege escalator", { executable: "sudo", args: ["npm", "test"] }],
  ["an empty executable", { executable: "   ", args: [] }],
  ["a control character", { executable: "npm\nrm", args: [] }],
  ["a tab in an argument", { executable: "npm", args: ["test\tcase"] }],
  ["a newline in an argument", { executable: "npm", args: ["test\nrm -rf /"] }],
  ["an EOT in an argument", { executable: "npm", args: ["test\u0004"] }],
  ["an ESC in an argument", { executable: "npm", args: ["\u001b[31mred"] }],
  ["a C1 terminal control in an argument", { executable: "npm", args: ["test\u0085case"] }],
  ["bidi formatting in executable", { executable: "npm\u202e", args: [] }],
  ["bidi formatting in an argument", { executable: "npm", args: ["test\u202e"] }],
];
for (const [label, candidate] of rejectedCommands) {
  // The cast is the point of the negative test: a rejected command is exactly
  // the malformed payload the schema must refuse at runtime.
  const command = candidate as CommandCandidate;
  assert.equal(verificationCommandSchema.safeParse(command).success, false, `must reject ${label}`);
  assert.notEqual(verificationCommandProblem(command), null, `must report ${label}`);
}
// An unknown key is refused by the strict schema rather than by the problem
// scan, which only judges the executable and the argv.
assert.equal(verificationCommandSchema.safeParse({ executable: "npm", args: ["test"], shell: true }).success, false);
assert.equal(verificationCommandProblem({ executable: "npm", args: ["test"] }), null);

// Preview is display-only, unambiguous, and identical for identical commands.
assert.equal(formatVerificationCommand({ executable: "npm", args: ["run", "test"] }), "npm run test");
assert.equal(formatVerificationCommand({ executable: "npm", args: ["test", "a b", 'x"y'] }), 'npm test "a b" "x\\"y"');
const confusableExecutable = "./pоwershell.exe";
assert.equal(verificationCommandSchema.safeParse({ executable: confusableExecutable, args: [] }).success, true);
assert.equal(
  formatVerificationCommand({ executable: confusableExecutable, args: [] }),
  '"./p\\u{43E}wershell.exe"',
  "non-ASCII executable characters are escaped in the confirmation preview",
);
assert.equal(
  formatVerificationCommand({ executable: "npm", args: ["test\u202e"] }),
  'npm "test\\u{202E}"',
  "bidi controls are escaped in display-only command previews",
);

// ---------------------------------------------------------------------------
// 2. Invocation: every token is one literal word of the interactive shell
//    line, and the shell itself never exits after the command.
// ---------------------------------------------------------------------------
assert.deepEqual(verificationShell("darwin"), { command: "/bin/sh", args: ["-i"], family: "posix" });
assert.deepEqual(verificationShell("linux"), verificationShell("darwin"));
const windowsShell = verificationShell("win32");
assert.deepEqual(windowsShell, { command: "powershell.exe", args: ["-NoLogo", "-NoProfile"], family: "powershell" });
assert.ok(!windowsShell.args.includes("-NonInteractive"), "the Windows shell must stay interactive so the user can inspect it");

assert.equal(quotePosixToken("npm"), "'npm'");
assert.equal(quotePosixToken("a b"), "'a b'");
assert.equal(quotePosixToken("it's"), "'it'\\''s'", "a single quote is closed, escaped, and reopened");
assert.equal(quotePosixToken("$HOME`id`;|&*?"), "'$HOME`id`;|&*?'");
assert.equal(quotePosixToken(""), "''");
assert.equal(quotePowerShellToken("npm"), "'npm'");
assert.equal(quotePowerShellToken("it's"), "'it''s'", "PowerShell doubles the embedded quote");
assert.equal(quotePowerShellToken("$env:PATH; & evil"), "'$env:PATH; & evil'");

const invocationCommand = { executable: "npm", args: ["run", "test", "--", "a b", "x'y"] };
assert.equal(formatPosixInvocation(invocationCommand), `'npm' 'run' 'test' '--' 'a b' 'x'\\''y'`);
assert.equal(formatPowerShellInvocation(invocationCommand), "& 'npm' 'run' 'test' '--' 'a b' 'x''y'");
assert.equal(formatPowerShellInvocation({ executable: "C:\\tools\\npm.cmd", args: ["test"] }), "& 'C:\\tools\\npm.cmd' 'test'");
assert.equal(formatVerificationInvocation(invocationCommand, "darwin"), formatPosixInvocation(invocationCommand));
assert.equal(formatVerificationInvocation(invocationCommand, "win32"), formatPowerShellInvocation(invocationCommand));

// The quoted line really is one command with literal arguments: a POSIX shell
// executes it and echoes each hostile token back unchanged, and a `;` inside an
// argument spawns nothing. (Skipped where /bin/sh does not exist.)
if (process.platform !== "win32") {
  const hostileTokens = ["a b", "x'y", "$HOME", "`id`", "semi;colon", "pipe|char", "amp&&ersand", "star*glob", 'double"quote'];
  const executed = execFileSync(
    "/bin/sh",
    ["-c", formatPosixInvocation({ executable: "printf", args: ["%s\n", ...hostileTokens] })],
    { encoding: "utf8" },
  );
  assert.deepEqual(executed.replace(/\n$/, "").split("\n"), hostileTokens, "quoted tokens stay one literal argument each");

  const injected = execFileSync(
    "/bin/sh",
    ["-c", formatPosixInvocation({ executable: "printf", args: ["%s\n", "one; printf INJECTED"] })],
    { encoding: "utf8" },
  );
  assert.equal(injected, "one; printf INJECTED\n", "a command separator inside an argument stays inside that argument");
}

// ---------------------------------------------------------------------------
// 3. Lifecycle: terminal existence decides the state, output never does.
// ---------------------------------------------------------------------------
assert.deepEqual(verificationRunCompletion({ kind: "missing" }), { status: "closed", failureCode: "terminal_closed" });
assert.deepEqual(verificationRunCompletion({ kind: "unobservable" }), { status: "unavailable", failureCode: "terminal_unavailable" });
assert.deepEqual(verificationRunCompletion({ kind: "invalid_binding" }), { status: "error", failureCode: "invalid_binding" });

// The transient tail is bounded by lines, by line length, and by total size;
// the newest lines win.
assert.deepEqual(boundedVerificationOutputTail(["one", "two"]), ["one", "two"]);
assert.deepEqual(boundedVerificationOutputTail([]), []);
const longLine = "x".repeat(VERIFICATION_OUTPUT_TAIL_LINE_MAX_LENGTH + 25);
const boundedLong = boundedVerificationOutputTail([longLine]);
assert.equal(boundedLong[0]?.length, VERIFICATION_OUTPUT_TAIL_LINE_MAX_LENGTH);
assert.ok(boundedLong[0]?.endsWith("…"), "a truncated line is marked");
const manyLines = Array.from({ length: VERIFICATION_OUTPUT_TAIL_MAX_LINES + 25 }, (_, index) => `line ${index}`);
const boundedMany = boundedVerificationOutputTail(manyLines);
assert.equal(boundedMany.length, VERIFICATION_OUTPUT_TAIL_MAX_LINES);
assert.equal(boundedMany[0], "line 25");
assert.equal(boundedMany[boundedMany.length - 1], `line ${VERIFICATION_OUTPUT_TAIL_MAX_LINES + 24}`);
const wideLines = Array.from({ length: 40 }, () => "y".repeat(VERIFICATION_OUTPUT_TAIL_LINE_MAX_LENGTH));
const boundedWide = boundedVerificationOutputTail(wideLines);
assert.equal(boundedWide.length, Math.floor(shared.VERIFICATION_OUTPUT_TAIL_MAX_CHARACTERS / (VERIFICATION_OUTPUT_TAIL_LINE_MAX_LENGTH + 1)));
assert.equal(boundedWide[boundedWide.length - 1], wideLines[wideLines.length - 1], "the newest line is always kept");

// Every failure is a localized reason about the terminal, never a verdict.
assert.equal(VERIFICATION_RUN_TTL_MS, 24 * 60 * 60_000);
for (const code of ["terminal_closed", "terminal_unavailable", "invalid_binding"] as const) {
  for (const locale of ["en", "zh"] as const) {
    const failure = verificationFailure(code, locale);
    assert.equal(failure.code, code);
    assert.ok(failure.message.length > 0);
  }
}
assert.ok(!/exit code|passed|failed/i.test(verificationFailure("terminal_closed", "en").message), "no verdict language");
assert.match(verificationFailure("terminal_closed", "en").message, /does not determine/);
assert.match(verificationFailure("terminal_unavailable", "zh").message, /不会判断/);

// ---------------------------------------------------------------------------
// 4. Run store: metadata and status only. Output, exit codes, markers, and
//    verified facts can never be stored.
// ---------------------------------------------------------------------------
const directory = await mkdtemp(join(tmpdir(), "review-deck-verification-"));
const storageDirectory = join(directory, "verification-store");
await mkdir(storageDirectory, { mode: 0o755 });
await chmod(storageDirectory, 0o755);
const storagePath = join(storageDirectory, "verification-runs.json");
assert.notEqual(storagePath, DEFAULT_VERIFICATION_RUN_PATH);
const store = new VerificationRunStore({ storagePath });

const finishedAt = "2026-10-01T00:00:10.000Z";
const storeSuggestion = {
  id: "VC-store123456",
  evidenceKind: "human_verification_recommended" as const,
  label: "**HIGH · cryptography_algorithm** — src/crypto.ts · H-abc123",
  filePath: "src/crypto.ts",
  hunkId: "H-abc123",
  command: { executable: "npm", args: ["run", "test"] },
  commandPreview: "npm run test",
};
const openRun = {
  runId: "run-1",
  workspaceId: "workspace-1",
  projectId: "project-1",
  cwd: "/repo",
  request: { cwd: "/repo", scope: "working" as const },
  targetFingerprint: "fingerprint-1",
  suggestion: storeSuggestion,
  command: storeSuggestion.command,
  commandPreview: storeSuggestion.commandPreview,
  terminalId: "terminal-1",
  status: "open" as const,
  startedAt: "2026-10-01T00:00:00.000Z",
};
const closedRun = { ...openRun, status: "closed" as const, completedAt: finishedAt, failureCode: "terminal_closed" as const };

await store.create(openRun);
if (process.platform !== "win32") {
  assert.equal((await stat(storageDirectory)).mode & 0o777, 0o700, "the verification subdirectory is owner-only");
  assert.equal((await stat(storagePath)).mode & 0o777, 0o600, "the run file is owner-only");
}
assert.deepEqual(await store.get("run-1"), openRun);
assert.deepEqual((await store.list()).map((run) => run.runId), ["run-1"]);
await assert.rejects(() => store.create(openRun), VerificationRunStoreError, "a repeated run id is refused");

const updated = await store.update("run-1", () => closedRun);
assert.deepEqual(updated, closedRun);
assert.equal(await store.update("run-absent", (run) => run), null);
assert.deepEqual(await store.get("run-1"), closedRun);
const persisted = await readFile(storagePath, "utf8");
assert.ok(
  !persisted.includes("outputTail") && !persisted.includes('"lines"') && !persisted.includes("verifiedFact") && !persisted.includes("exitCode"),
  "no terminal output, exit code, or verdict is persisted",
);

const invalidRuns: Array<[string, unknown]> = [
  ["an open run with a completion time", { ...openRun, completedAt: finishedAt }],
  ["an open run with a failure", { ...openRun, failureCode: "terminal_closed" }],
  ["a closed run without a completion time", { ...closedRun, completedAt: undefined }],
  ["a closed run with the wrong failure code", { ...closedRun, failureCode: "terminal_unavailable" }],
  ["an unavailable run with the closed failure code", { ...openRun, status: "unavailable", completedAt: finishedAt, failureCode: "terminal_closed" }],
  ["an errored run without a failure", { ...openRun, status: "error", completedAt: finishedAt }],
  ["the old running status", { ...openRun, status: "running" }],
  ["the old passed status", { ...openRun, status: "passed", completedAt: finishedAt, exitCode: 0 }],
  ["the old failed status", { ...openRun, status: "failed", completedAt: finishedAt, exitCode: 2, failureCode: "nonzero_exit" }],
  ["an exit code", { ...closedRun, exitCode: 0 }],
  ["a verified fact", {
    ...closedRun,
    verifiedFact: { evidenceKind: "verified_fact", source: "verification_run", exitCode: 0 },
  }],
  ["a persisted terminal output tail", { ...openRun, outputTail: ["npm test", "all good"] }],
  ["the old wrapper marker", { ...openRun, marker: "RDV:0123456789abcdef" }],
  ["the old deadline", { ...openRun, deadlineAt: "2026-10-01T00:10:00.000Z" }],
  ["a suggestion command that differs from the executed command", {
    ...openRun,
    suggestion: { ...storeSuggestion, command: { executable: "npm", args: ["run", "lint"] }, commandPreview: "npm run lint" },
  }],
  ["a shell string as the command", { ...openRun, command: { executable: "npm run test", args: [] } }],
  ["an unknown envelope field", { ...openRun, verdict: "passed" }],
];
for (const [label, candidate] of invalidRuns) {
  // Deliberately invalid records: the store's runtime schema is what must
  // refuse them, so the cast is the point of the negative test.
  const record = candidate as VerificationRunRecord;
  await assert.rejects(() => store.create(record), VerificationRunStoreError, `the store must refuse ${label}`);
}
assert.deepEqual(await store.get("run-1"), closedRun, "a refused write leaves the stored run untouched");

// A missing store is empty; a damaged one is refused byte for byte.
const damagedPath = join(directory, "damaged.json");
const damagedStore = new VerificationRunStore(damagedPath);
assert.deepEqual(await damagedStore.list(), []);
await writeFile(damagedPath, "{ not json", "utf8");
await assert.rejects(() => damagedStore.list(), VerificationRunStoreError);
assert.equal(await readFile(damagedPath, "utf8"), "{ not json");
await writeFile(damagedPath, JSON.stringify({ version: VERIFICATION_RUN_VERSION + 1, runs: [] }), "utf8");
await assert.rejects(() => damagedStore.list(), new RegExp(`unsupported version ${VERIFICATION_RUN_VERSION + 1}`));
await writeFile(damagedPath, JSON.stringify({ version: 1, runs: [] }), "utf8");
await assert.rejects(() => damagedStore.list(), /unsupported version 1/, "the superseded marker store is refused, not misread");
await writeFile(damagedPath, JSON.stringify({ version: VERIFICATION_RUN_VERSION, runs: [openRun, openRun] }), "utf8");
await assert.rejects(() => damagedStore.list(), /repeats run id/);
await writeFile(damagedPath, JSON.stringify({ version: VERIFICATION_RUN_VERSION, runs: [], extra: true }), "utf8");
await assert.rejects(() => damagedStore.list(), new RegExp(`invalid version ${VERIFICATION_RUN_VERSION} envelope`));

// Pruning removes only runs started before the cutoff.
const pruneStore = new VerificationRunStore({ storagePath: join(directory, "prune.json") });
await pruneStore.create(openRun);
await pruneStore.create({ ...closedRun, runId: "run-2", startedAt: "2026-10-02T00:00:00.000Z" });
assert.equal(await pruneStore.pruneStartedBefore("2026-10-01T12:00:00.000Z"), 1);
assert.deepEqual((await pruneStore.list()).map((run) => run.runId), ["run-2"]);
assert.equal((await pruneStore.remove("run-2"))?.runId, "run-2");
assert.equal(await pruneStore.remove("run-2"), null);
assert.deepEqual(await pruneStore.list(), []);
await rm(directory, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 5. Sections: a structured command becomes a suggestion; the fallback's
//    machine-readable section is parsed strictly, or omitted.
// ---------------------------------------------------------------------------
const structuredWithCommand: StructuredReviewResult = {
  summary: "Cache identity ignores the mode.",
  findings: [
    {
      hunkId: "H-0123456789ab",
      filePath: "server/cache.ts",
      severity: "high",
      evidenceKind: "ai_inference",
      category: "stale cache",
      summary: "The cache key omits the provider mode.",
      detail: "A read-only and writable reviewer configuration share a cache entry.",
      suggestedCheck: "Add the selected mode to the cache-key inputs.",
      verificationCommand: { executable: "npm", args: ["run", "test", "--", "cache"] },
    },
    {
      filePath: "client/review.ts",
      severity: "low",
      evidenceKind: "human_verification_recommended",
      category: "docs",
      summary: "The comment is stale.",
      detail: "It still describes the removed queue.",
      verificationCommand: { executable: "node", args: ["--experimental-strip-types", "tests/docs.test.ts"] },
    },
    {
      filePath: "server/run.ts",
      severity: "critical",
      evidenceKind: "verified_fact",
      category: "already verified",
      summary: "The guard exists.",
      detail: "Read from the workspace.",
      verificationCommand: { executable: "npm", args: ["test"] },
    },
  ],
};
const parsedStructured = parseStructuredReviewResult(JSON.stringify(structuredWithCommand));
assert.deepEqual(parsedStructured, structuredWithCommand);
// The strict validator accepts the optional command, and the JSON Schema the
// host offers a provider carries it as optional too.
assert.equal(
  structuredReviewResultSchema.safeParse({ findings: [structuredWithCommand.findings[0]] }).success,
  true,
);
const outputSchema = structuredReview.AI_REVIEW_OUTPUT_SCHEMA as {
  properties?: { findings?: { items?: { properties?: Record<string, unknown>; required?: string[] } } };
};
assert.ok(outputSchema.properties?.findings?.items?.properties?.verificationCommand, "the provider output schema offers the optional command");
assert.ok(!outputSchema.properties?.findings?.items?.required?.includes("verificationCommand"), "and never requires it");
const normalized = normalizeStructuredReviewResult(parsedStructured);
const suggestions = normalized.sections.verificationCommands ?? [];
assert.equal(suggestions.length, 2, "a command never decorates a reported verified fact");
assert.equal(suggestions[0]?.evidenceKind, "ai_inference");
assert.equal(suggestions[0]?.hunkId, "H-0123456789ab");
assert.equal(suggestions[0]?.filePath, "server/cache.ts");
assert.equal(suggestions[0]?.label, "HIGH · stale cache — server/cache.ts · H-0123456789ab");
assert.deepEqual(suggestions[0]?.command, { executable: "npm", args: ["run", "test", "--", "cache"] });
assert.equal(suggestions[0]?.commandPreview, "npm run test -- cache");
assert.match(suggestions[0]?.id ?? "", /^VC-[0-9a-f]{12}$/);
assert.equal(suggestions[1]?.evidenceKind, "human_verification_recommended");
assert.equal(suggestions[1]?.commandPreview, "node --experimental-strip-types tests/docs.test.ts");
assert.ok(normalized.review.includes("Verification command: npm run test -- cache"));
assert.equal(reviewSectionsSchema.safeParse(normalized.sections).success, true);
// The suggestion id is stable for the same suggestion and different for a
// different command.
assert.equal(normalizeStructuredReviewResult(parsedStructured).sections.verificationCommands?.[0]?.id, suggestions[0]?.id);
assert.notEqual(
  normalizeStructuredReviewResult({
    findings: [{ ...structuredWithCommand.findings[0], verificationCommand: { executable: "npm", args: ["run", "lint"] } }],
  }).sections.verificationCommands?.[0]?.id,
  suggestions[0]?.id,
);
// One unrunnable command rejects the whole structured result (fail closed).
assert.equal(
  parseStructuredReviewResult(JSON.stringify({
    findings: [{ ...structuredWithCommand.findings[0], verificationCommand: { executable: "sh", args: ["-c", "npm test"] } }],
  })),
  null,
);

const fallback = [
  "## Summary",
  "The queue can stall.",
  "",
  "### Human Verification Recommended",
  "- Re-run the batch tests",
  "",
  "### Verification Commands",
  "```json",
  JSON.stringify([
    { executable: "npm", args: ["run", "test", "--", "batch"], label: "Batch tests", hunkId: "H-0123456789ab" },
    { executable: "node", args: ["tests/queue.smoke.ts"] },
  ]),
  "```",
  "",
  "### AI Inference",
  "- The queue retries forever",
].join("\n");
const fallbackSection = parseFallbackVerificationSection(fallback);
assert.equal(fallbackSection.suggestions.length, 2);
assert.equal(fallbackSection.suggestions[0]?.label, "Batch tests");
assert.equal(fallbackSection.suggestions[1]?.label, "node tests/queue.smoke.ts", "the preview captions an unlabeled command");
assert.equal(fallbackSection.suggestions[1]?.evidenceKind, "human_verification_recommended");
const sections = reviewSectionsFromMarkdown(fallback);
assert.deepEqual(sections.humanVerificationRecommended, ["Re-run the batch tests"]);
assert.deepEqual(sections.aiInference, ["The queue retries forever"]);
assert.equal(sections.verificationCommands?.length, 2);
assert.ok(!JSON.stringify(sections).includes("```"), "the machine-readable block never leaks into a section");

// Strict fallback parsing: anything unexpected omits the commands entirely.
const fallbackCases: Array<[string, string]> = [
  ["no heading", "### AI Inference\n- inferred"],
  ["no JSON block", "### Verification Commands\nrun npm test"],
  ["malformed JSON", "### Verification Commands\n```json\n[{ \"executable\": }]\n```"],
  ["an object instead of an array", `### Verification Commands\n\`\`\`json\n${JSON.stringify({ executable: "npm", args: [] })}\n\`\`\``],
  ["an empty array", "### Verification Commands\n```json\n[]\n```"],
  ["an unknown key", `### Verification Commands\n\`\`\`json\n${JSON.stringify([{ executable: "npm", args: [], shell: true }])}\n\`\`\``],
  ["a verified fact", `### Verification Commands\n\`\`\`json\n${JSON.stringify([{ executable: "npm", args: [], evidenceKind: "verified_fact" }])}\n\`\`\``],
  ["a launcher", `### Verification Commands\n\`\`\`json\n${JSON.stringify([{ executable: "bash", args: ["-c", "npm test"] }])}\n\`\`\``],
  ["a builtin", `### Verification Commands\n\`\`\`json\n${JSON.stringify([{ executable: "eval", args: ["npm test"] }])}\n\`\`\``],
  ["one bad entry among good ones", `### Verification Commands\n\`\`\`json\n${JSON.stringify([{ executable: "npm", args: ["test"] }, { executable: "npm run test", args: [] }])}\n\`\`\``],
];
for (const [label, text] of fallbackCases) {
  assert.deepEqual(parseFallbackVerificationSection(text).suggestions, [], `must omit commands: ${label}`);
  assert.equal(reviewSectionsFromMarkdown(text).verificationCommands, undefined, `must not attach commands: ${label}`);
}
// A zh heading works too, a fence is optional, and a fallback without a
// command section leaves the sections untouched.
const zhFallback = `### 验证命令\n\`\`\`json\n${JSON.stringify([{ executable: "cargo", args: ["test"] }])}\n\`\`\``;
assert.equal(parseFallbackVerificationSection(zhFallback).suggestions.length, 1);
const bareFallback = `### Verification Commands\n${JSON.stringify([{ executable: "pytest", args: ["-q"] }])}\n\n### AI Inference\n- inferred`;
assert.equal(parseFallbackVerificationSection(bareFallback).suggestions.length, 1);
assert.deepEqual(reviewSectionsFromMarkdown(bareFallback).aiInference, ["inferred"]);
assert.equal(reviewSectionsFromMarkdown("### AI Inference\n- inferred").verificationCommands, undefined);

// ---------------------------------------------------------------------------
// 6. The service flow against a fake Paseo terminal API: the command is typed
//    into an interactive shell, the terminal stays open, and no state is ever
//    derived from captured output.
// ---------------------------------------------------------------------------
type FakeTerminalApi = {
  created: Array<{ cwd: string; name: string; command: string; args: string[] }>;
  writes: string[];
  keys: string[][];
  lines: string[];
  missing: boolean;
  failList: boolean;
  failCapture: boolean;
  kills: number;
};

function fakeContext(terminal: FakeTerminalApi): PluginHandlerContext {
  // A structural stand-in for the daemon surface the service touches. The cast
  // is the test seam: the real PaseoApi is not available in a unit test.
  return {
    paseo: {
      workspaces: {
        ref: () => ({
          terminals: {
            create: async (options: { cwd: string; name?: string; command?: string; args?: string[] }) => {
              terminal.created.push({
                cwd: options.cwd,
                name: options.name ?? "",
                command: options.command ?? "",
                args: options.args ?? [],
              });
              return {
                id: "terminal-1",
                write: (data: string) => {
                  terminal.writes.push(data);
                  return data.length;
                },
                sendKeys: (keys: readonly string[]) => {
                  terminal.keys.push([...keys]);
                  return keys.join("").length;
                },
              };
            },
            list: async () => {
              if (terminal.failList) throw new Error("simulated terminal list failure");
              return {
                entries: terminal.missing
                  ? []
                  : [{ id: "terminal-1", workspaceId: "workspace-1", cwd: "/repo", name: "Review Deck" }],
                requestId: "request-1",
              };
            },
          },
        }),
      },
      terminals: {
        ref: (terminalId: string) => ({
          capture: async () => {
            if (terminal.failCapture) throw new Error("simulated capture failure");
            return { terminalId, lines: [...terminal.lines], totalLines: terminal.lines.length, requestId: "request-1" };
          },
          kill: async () => {
            terminal.kills += 1;
          },
        }),
      },
    },
  } as unknown as PluginHandlerContext;
}

const flowDirectory = await mkdtemp(join(tmpdir(), "review-deck-verification-flow-"));
const flowStorePath = join(flowDirectory, "runs.json");
const flowStore = new VerificationRunStore({ storagePath: flowStorePath });
const terminal: FakeTerminalApi = { created: [], writes: [], keys: [], lines: [], missing: false, failList: false, failCapture: false, kills: 0 };
const context = fakeContext(terminal);
let targetFingerprint = "fingerprint-1";
let workspaceDirectory = "/repo";
let workspaceUnavailable = false;
const projectId = "project-1";
const service = new VerificationService({
  store: flowStore,
  reviewedTarget: async () => ({ targetFingerprint, worktreePath: "/repo" }),
  sameDirectory: async (left, right) => left === right,
  workspaceIdentity: async () => {
    if (workspaceUnavailable) throw new Error("simulated workspace outage");
    return { projectId, directory: workspaceDirectory };
  },
});
const flowCommand = { executable: "npm", args: ["run", "test"] };
const flowSuggestion = {
  id: "VC-flow123456",
  evidenceKind: "human_verification_recommended" as const,
  label: "**HIGH · cryptography_algorithm** — src/crypto.ts · H-flow123456",
  filePath: "src/crypto.ts",
  hunkId: "H-flow123456",
  command: flowCommand,
  commandPreview: formatVerificationCommand(flowCommand),
};
const flowInput = {
  workspaceId: "workspace-1",
  request: { cwd: "/repo", scope: "working" as const },
  expectedTargetFingerprint: "fingerprint-1",
  suggestion: flowSuggestion,
  confirmed: true as const,
};

// Start: the confirmed command is typed into an interactive shell terminal.
const started = await service.start(flowInput, context);
assert.equal(started.status, "open");
assert.equal(started.workspaceId, "workspace-1");
assert.equal(started.targetFingerprint, "fingerprint-1");
assert.equal(started.commandPreview, "npm run test");
assert.equal(started.suggestionId, flowSuggestion.id);
assert.equal(started.label, flowSuggestion.label);
assert.equal(started.terminalId, "terminal-1");
assert.equal(started.completedAt, undefined);
assert.equal(started.failure, undefined);
assert.equal(started.outputTail, undefined);
assert.equal(verificationRunResultSchema.safeParse(started).success, true);
assert.equal(terminal.created.length, 1);
assert.equal(terminal.created[0]?.cwd, "/repo", "the command runs in the reviewed worktree");
if (process.platform === "win32") {
  assert.equal(terminal.created[0]?.command, "powershell.exe");
  assert.deepEqual(terminal.created[0]?.args, ["-NoLogo", "-NoProfile"]);
  assert.equal(terminal.writes[0], "& 'npm' 'run' 'test'");
} else {
  assert.equal(terminal.created[0]?.command, "/bin/sh");
  assert.deepEqual(terminal.created[0]?.args, ["-i"]);
  assert.equal(terminal.writes[0], "'npm' 'run' 'test'");
}
assert.deepEqual(terminal.keys[0], ["Enter"], "the typed line is submitted with Enter");
const storedRun = await flowStore.get(started.runId);
assert.equal(storedRun?.status, "open");
assert.equal(storedRun?.projectId, "project-1");
// The stored run is metadata and status only: no terminal line, no output, no
// marker, no deadline, no exit code, no verdict.
assert.deepEqual(Object.keys(storedRun ?? {}).sort(), [
  "command",
  "commandPreview",
  "cwd",
  "projectId",
  "request",
  "runId",
  "startedAt",
  "status",
  "suggestion",
  "targetFingerprint",
  "terminalId",
  "workspaceId",
]);

const startFlowRun = async (
  command = flowInput.suggestion.command,
): Promise<string> => {
  terminal.lines = [];
  const suggestion = { ...flowInput.suggestion, command, commandPreview: formatVerificationCommand(command) };
  const startedRun = await service.start({ ...flowInput, suggestion }, context);
  return startedRun.runId;
};

// Output text never decides anything — not even text that looks like a result.
terminal.lines = ["FAIL src/x.test.ts", "exit code 1", "3 passing", "PASS", "0 failed"];
const openState = await service.poll({ runId: started.runId, workspaceId: "workspace-1" }, context);
assert.equal(openState.status, "open");
assert.equal(openState.completedAt, undefined);
assert.equal(openState.failure, undefined);
assert.deepEqual(openState.outputTail, terminal.lines, "the transient tail is returned verbatim while the terminal exists");
assert.equal("verifiedFact" in openState, false);
assert.equal("exitCode" in openState, false);
assert.equal(verificationRunResultSchema.safeParse(openState).success, true);
assert.equal(verificationRunResultSchema.safeParse({ ...openState, status: "passed" }).success, false, "no passed status exists");
assert.equal(
  verificationRunResultSchema.safeParse({ ...openState, outputTail: ["z".repeat(VERIFICATION_OUTPUT_TAIL_LINE_MAX_LENGTH + 1)] }).success,
  false,
  "an over-long tail line breaks the wire contract",
);

// The tail is bounded, and a capture failure is not a state change.
terminal.lines = [
  ...Array.from({ length: VERIFICATION_OUTPUT_TAIL_MAX_LINES + 5 }, (_, index) => `line ${index}`),
  "x".repeat(VERIFICATION_OUTPUT_TAIL_LINE_MAX_LENGTH + 25),
];
const boundedState = await service.poll({ runId: started.runId, workspaceId: "workspace-1" }, context);
assert.equal(boundedState.status, "open");
assert.equal(boundedState.outputTail?.length, VERIFICATION_OUTPUT_TAIL_MAX_LINES);
assert.equal(
  boundedState.outputTail?.[VERIFICATION_OUTPUT_TAIL_MAX_LINES - 1]?.length,
  VERIFICATION_OUTPUT_TAIL_LINE_MAX_LENGTH,
  "the newest line is kept, truncated to the line bound",
);
terminal.lines = [];
terminal.failCapture = true;
const captureFailed = await service.poll({ runId: started.runId, workspaceId: "workspace-1" }, context);
assert.equal(captureFailed.status, "open", "a failed capture never invents a result");
assert.equal(captureFailed.outputTail, undefined);
terminal.failCapture = false;

// Nothing captured is ever written to the store.
const flowRaw = await readFile(flowStorePath, "utf8");
assert.ok(!flowRaw.includes("outputTail") && !flowRaw.includes("exit code 1"), "captured output never reaches the store");

// A terminal that is gone becomes `closed`, with no verdict, and stays closed.
const goneRun = await startFlowRun();
terminal.missing = true;
const closedState = await service.poll({ runId: goneRun, workspaceId: "workspace-1" }, context);
assert.equal(closedState.status, "closed");
assert.equal(closedState.failure?.code, "terminal_closed");
assert.match(closedState.failure?.message ?? "", /does not determine/);
assert.equal(closedState.outputTail, undefined);
assert.ok(closedState.completedAt);
assert.equal((await flowStore.get(goneRun))?.status, "closed");
terminal.missing = false;
terminal.lines = ["npm test", "more output"];
const repeatedClosed = await service.poll({ runId: goneRun, workspaceId: "workspace-1" }, context);
assert.equal(repeatedClosed.status, "closed", "a finished run is never moved by a later poll");
assert.equal(repeatedClosed.outputTail, undefined);
assert.equal(repeatedClosed.completedAt, closedState.completedAt);

// A workspace that cannot be read becomes `unavailable`, not `closed`.
const unreadableRun = await startFlowRun();
workspaceUnavailable = true;
const unavailableState = await service.poll({ runId: unreadableRun, workspaceId: "workspace-1" }, context);
assert.equal(unavailableState.status, "unavailable");
assert.equal(unavailableState.failure?.code, "terminal_unavailable");
workspaceUnavailable = false;
assert.equal((await flowStore.get(unreadableRun))?.status, "unavailable");
const repeatedUnavailable = await service.poll({ runId: unreadableRun, workspaceId: "workspace-1" }, context);
assert.equal(repeatedUnavailable.status, "unavailable");

// A listing failure is `unavailable` too: existence is unknown, not gone.
const listingRun = await startFlowRun();
terminal.failList = true;
const listingState = await service.poll({ runId: listingRun, workspaceId: "workspace-1" }, context);
assert.equal(listingState.status, "unavailable");
terminal.failList = false;
assert.equal((await flowStore.get(listingRun))?.status, "unavailable");

// A workspace whose binding moved is refused, and its terminal is left alone
// for the user to inspect or close.
const reboundRun = await startFlowRun();
workspaceDirectory = "/somewhere-else";
const killsBeforeReboundPoll = terminal.kills;
const reboundState = await service.poll({ runId: reboundRun, workspaceId: "workspace-1" }, context);
assert.equal(reboundState.status, "error");
assert.equal(reboundState.failure?.code, "invalid_binding");
assert.equal(terminal.kills, killsBeforeReboundPoll, "the plugin never kills the user's terminal");
assert.equal((await flowStore.get(reboundRun))?.status, "error");
workspaceDirectory = "/repo";

// List: only the requested current target and workspace binding are reported,
// and an open run is polled for its live tail. A target/workspace race fails
// closed with an empty list instead of surfacing as a Review Deck-wide error.
const listedRun = await startFlowRun();
terminal.lines = ["listed output"];
const listed = await service.list({
  workspaceId: "workspace-1",
  request: flowInput.request,
  expectedTargetFingerprint: "fingerprint-1",
}, context);
assert.equal(listed.targetChanged, false);
assert.ok(listed.runs.some((run) => run.runId === listedRun && run.status === "open"));
assert.equal(listed.runs.find((run) => run.runId === listedRun)?.outputTail?.[0], "listed output");
for (const run of listed.runs) {
  assert.equal(run.workspaceId, "workspace-1");
  assert.equal(run.targetFingerprint, "fingerprint-1");
  assert.ok(["open", "closed", "unavailable", "error"].includes(run.status));
  assert.equal("verifiedFact" in run, false);
}
assert.equal(verificationRunResultSchema.safeParse(listed.runs[0]).success, true);
const staleFingerprintList = await service.list({
  workspaceId: "workspace-1",
  request: flowInput.request,
  expectedTargetFingerprint: "fingerprint-2",
}, context);
assert.deepEqual(staleFingerprintList, { runs: [], targetChanged: true });
workspaceDirectory = "/somewhere-else";
const movedWorkspaceList = await service.list({
  workspaceId: "workspace-1",
  request: flowInput.request,
  expectedTargetFingerprint: "fingerprint-1",
}, context);
assert.deepEqual(movedWorkspaceList, { runs: [], targetChanged: true });
workspaceDirectory = "/repo";

// Starts are refused before anything runs: a changed target, a moved workspace
// directory, a denied command, and a preview that does not match its argv.
const createdBefore = terminal.created.length;
await assert.rejects(
  () => service.start({ ...flowInput, expectedTargetFingerprint: "fingerprint-2" }, context),
  /review target changed/,
);
workspaceDirectory = "/somewhere-else";
await assert.rejects(() => service.start(flowInput, context), /is not the directory of workspace/);
workspaceDirectory = "/repo";
await assert.rejects(() => service.start({
  ...flowInput,
  suggestion: {
    ...flowInput.suggestion,
    command: { executable: "sh", args: ["-c", "npm test"] },
    commandPreview: 'sh -c "npm test"',
  },
}, context));
await assert.rejects(() => service.start({
  ...flowInput,
  suggestion: { ...flowInput.suggestion, commandPreview: "npm run lint" },
}, context), /preview does not match/);
assert.equal(terminal.created.length, createdBefore, "a refused start creates no terminal");

// Poll refusals: an unknown run or a workspace mismatch is refused outright.
await assert.rejects(() => service.poll({ runId: started.runId, workspaceId: "another-workspace" }, context), /no longer available/);
await assert.rejects(() => service.poll({ runId: "run-unknown", workspaceId: "workspace-1" }, context), /no longer available/);

// Teardown refuses new runs but leaves open terminals alone for inspection.
const interruptedRun = await startFlowRun();
const killsBeforeStop = terminal.kills;
await service.stop();
assert.equal(terminal.kills, killsBeforeStop, "teardown does not kill the user's terminal");
assert.equal((await flowStore.get(interruptedRun))?.status, "open");
await assert.rejects(() => service.start(flowInput, context), /stopping/);

// Retention: an ancient run is pruned; recent ones are kept.
const ancient = await flowStore.get(interruptedRun);
assert.ok(ancient);
await flowStore.create({ ...ancient, runId: "run-ancient", terminalId: "terminal-ancient", startedAt: "2020-01-01T00:00:00.000Z" });
assert.equal(await service.prune(VERIFICATION_RUN_TTL_MS), 1);
assert.equal(await flowStore.get("run-ancient"), null);

await rm(flowDirectory, { recursive: true, force: true });

console.log("verification-terminal: all assertions passed");

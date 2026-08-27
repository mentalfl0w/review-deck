import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin";
import { homedir } from "node:os";
import type {
  ExplainHunkAiResult,
  ProcessProjectReviewResult,
  ProjectReviewComment,
  ProjectReviewCommentOutcome,
  ProjectReviewSummary,
  ReviewRequest,
  ReviewSections,
  ReviewScope,
  ReviewSnapshot,
} from "./review.shared";
type Hunk = ReviewSnapshot["files"][number]["hunks"][number];
type Finding = Hunk["findings"][number];
type StateEntry = {
  id?: string;
  projectId?: string;
  projectName?: string;
  projectRootPath?: string;
  workspaceId?: string;
  targetFingerprint?: string;
  hunkId: string;
  hunkFingerprint?: string;
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
};
type StateFile = Record<string, StateEntry[]>;
interface ReviewTarget {
  repositoryPath: string;
  worktreePath: string;
  gitDir: string;
  baseRef: string | null;
  headRef: string;
  baseSha: string | null;
  headSha: string | null;
}

const STATE_PATH = join(homedir(), ".paseo", "review-deck", "reviews.json");
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function runGit(
  cwd: string,
  args: string[],
  options: { stdin?: string; acceptableExitCodes?: readonly number[] } = {},
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr || (options.stdin !== undefined && !child.stdin)) {
    child.kill();
    throw new Error("Review Deck could not open a Git subprocess stream.");
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputLength = 0;
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    outputLength += chunk.length;
    if (outputLength <= MAX_GIT_OUTPUT) target.push(chunk);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  child.on("error", reject);
  child.on("close", (code) => {
    if (outputLength > MAX_GIT_OUTPUT) {
      reject(new Error("Git output exceeded Review Deck's 8 MiB snapshot limit."));
      return;
    }
    const output = Buffer.concat(stdout).toString("utf8");
    if (code === 0 || options.acceptableExitCodes?.includes(code ?? -1)) {
      resolve(output);
      return;
    }
    reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `git ${args.join(" ")} failed`));
  });
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  return promise;
}

async function gitOptional(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await runGit(cwd, args)).trim() || null;
  } catch {
    return null;
  }
}

async function resolveBaseRef(cwd: string, requested?: string): Promise<string | null> {
  if (requested) return requested;
  const originHead = await gitOptional(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (originHead) return originHead.replace(/^refs\/remotes\//, "");
  for (const candidate of ["main", "master"]) {
    if (await gitOptional(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`])) return candidate;
  }
  return null;
}

function validatePathSpec(filePath: string | undefined): void {
  if (!filePath) return;
  if (
    filePath.includes("\u0000") ||
    isAbsolute(filePath) ||
    win32.isAbsolute(filePath) ||
    filePath.split(/[\\/]/).includes("..") ||
    filePath.startsWith(":")
  ) {
    throw new Error(
      "Review Deck requires a repository-relative, literal file path (rejected: absolute path, '..' traversal, NUL, or pathspec magic).",
    );
  }
}

async function resolveReviewTarget(request: ReviewRequest): Promise<ReviewTarget> {
  validatePathSpec(request.filePath);
  const [repositoryPath, gitDir] = await Promise.all([
    runGit(request.cwd, ["rev-parse", "--show-toplevel"]),
    runGit(request.cwd, ["rev-parse", "--absolute-git-dir"]),
  ]);
  const worktreePath = await realpath(repositoryPath.trim());
  const baseRef = request.scope === "working" || request.scope === "staged"
    ? "HEAD"
    : await resolveBaseRef(worktreePath, request.baseRef);
  const headRef = request.scope === "commits" ? request.headRef ?? "HEAD" : "HEAD";
  const [baseSha, headSha] = await Promise.all([
    baseRef ? gitOptional(worktreePath, ["rev-parse", "--verify", baseRef]) : Promise.resolve(null),
    gitOptional(worktreePath, ["rev-parse", "--verify", headRef]),
  ]);
  return { repositoryPath: worktreePath, worktreePath, gitDir: gitDir.trim(), baseRef, headRef, baseSha, headSha };
}

async function collectUntrackedPatches(repositoryPath: string, request: ReviewRequest): Promise<string[]> {
  const pathspec = request.filePath ? ["--", request.filePath] : [];
  const listed = await runGit(repositoryPath, ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec]);
  const paths = listed.split("\u0000").filter((path) => path.length > 0);
  const patches = await Promise.all(
    paths.map((path) =>
      runGit(repositoryPath, ["diff", "--binary", "--no-index", "--", "/dev/null", path], {
        acceptableExitCodes: [0, 1],
      }),
    ),
  );
  return patches.filter((patch) => patch.includes("\n@@ ") || patch.includes("GIT binary patch"));
}

async function diffFor(request: ReviewRequest, target: ReviewTarget, untracked: readonly string[]): Promise<string> {
  const pathspec = request.filePath ? ["--", request.filePath] : [];
  switch (request.scope) {
    case "working": {
      const tracked = await runGit(target.repositoryPath, ["diff", "--binary", "--no-ext-diff", "HEAD", ...pathspec]);
      return `${tracked}${untracked.join("")}`;
    }
    case "staged":
      return runGit(target.repositoryPath, ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD", ...pathspec]);
    case "branch": {
      if (!target.baseRef) throw new Error("Review Deck could not determine a base branch. Select one explicitly.");
      const base = await runGit(target.repositoryPath, ["merge-base", target.baseRef, "HEAD"]);
      return runGit(target.repositoryPath, ["diff", "--binary", "--no-ext-diff", base.trim(), "HEAD", ...pathspec]);
    }
    case "commits": {
      if (!request.baseRef || !request.headRef) throw new Error("Commit comparison requires baseRef and headRef.");
      return runGit(target.repositoryPath, ["diff", "--binary", "--no-ext-diff", request.baseRef, request.headRef, ...pathspec]);
    }
  }
}

function parseRange(header: string): { oldStart: number; oldCount: number; newStart: number; newCount: number } {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) throw new Error(`Unsupported hunk header: ${header}`);
  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? 1),
  };
}

function unquoteGitPath(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "\\") {
      bytes.push(value.charCodeAt(i));
      continue;
    }
    const next = value[i + 1];
    const escapes: Record<string, string> = {
      a: "\u0007",
      b: "\b",
      t: "\t",
      n: "\n",
      v: "\v",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\",
      "0": "\u0000",
    };
    if (next !== undefined && escapes[next] !== undefined) {
      for (const byte of Buffer.from(escapes[next], "utf8")) bytes.push(byte);
      i++;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(value.slice(i + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += octal[0].length;
      continue;
    }
    bytes.push(value.charCodeAt(i + 1));
    i++;
  }
  return Buffer.from(bytes).toString("utf8");
}

function filePathFromDiffHeader(line: string): { oldPath?: string; path: string } | null {
  if (!line.startsWith("diff --git ")) return null;
  const rest = line.slice("diff --git ".length);
  const quoted = /^"a\/((?:[^"\\]|\\.)*)" "b\/((?:[^"\\]|\\.)*)"$/.exec(rest);
  if (quoted) {
    const oldPath = unquoteGitPath(quoted[1]);
    const path = unquoteGitPath(quoted[2]);
    return { path, ...(oldPath === path ? {} : { oldPath }) };
  }
  const unquoted = /^a\/(.+) b\/(.+)$/.exec(rest);
  if (unquoted) {
    const oldPath = unquoted[1];
    const path = unquoted[2];
    return { path, ...(oldPath === path ? {} : { oldPath }) };
  }
  return null;
}

function severityRank(severity: Finding["severity"]): number {
  return { critical: 5, high: 4, medium: 3, low: 2, informational: 1 }[severity];
}

function detectFindings(lines: string[]): Finding[] {
  const changed = lines.filter((line) => line.startsWith("+")).join("\n");
  const removed = lines.filter((line) => line.startsWith("-")).join("\n");
  const findings: Finding[] = [];
  const add = (category: string, severity: Finding["severity"], summary: string, detail: string, check?: string) => {
    findings.push({ id: randomUUID(), category, severity, evidenceKind: "verified_fact", summary, detail, ...(check ? { suggestedCheck: check } : {}) });
  };
  if (/\b(public|export|pub\s+|extern\s+|interface\s+|class\s+)/.test(changed)) {
    add("breaking_api_change", "high", "Public surface may have changed", "Added lines contain a public/exported declaration.", "Check callers and compatibility commitments.");
  }
  if (/\b(mutex|lock_guard|rwlock|synchronized|atomic|await\s+.*lock|lock\s*\()/.test(changed)) {
    add("concurrency", "high", "Synchronization code changed", "Added lines contain lock, mutex, atomic, or synchronization constructs.", "Check lock ordering, scope, cancellation, and race coverage.");
  }
  if (/\b(crypto|cipher|curve|scalar|nonce|hash|sign|verify|constant[_-]?time|mod(?:ulo)?\b)/i.test(changed)) {
    add("cryptography_algorithm", "high", "Cryptographic or algorithmic code changed", "Added lines match cryptography or arithmetic vocabulary.", "Compare against the specification and known-answer test vectors.");
  }
  if (/\b(catch|throw|Error\b|Exception\b|Result<|Err\(|panic!|unwrap\()/.test(changed) || /\b(catch|throw|Error\b|Exception\b)/.test(removed)) {
    add("error_handling", "medium", "Error-handling behavior changed", "Changed lines contain error handling constructs.", "Check error mapping, cleanup, retry behavior, and observable status codes.");
  }
  if (/\b(migration|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE|schema\b)/i.test(changed)) {
    add("database_migration", "high", "Database or schema change detected", "Added lines match migration or schema operations.", "Check upgrade, rollback, backfill, locking, and deployed compatibility.");
  }
  if (/\b(for|while)\b/.test(changed) && /\b(sort|collect|clone|alloc|push_back|append)\b/.test(changed)) {
    add("performance_regression", "medium", "Loop with allocation or collection change", "Added lines contain a loop and allocation/collection vocabulary.", "Check complexity and benchmark hot paths.");
  }
  if (findings.length === 0) {
    findings.push({
      id: randomUUID(),
      category: "behavior_semantic_change",
      severity: "informational",
      evidenceKind: "verified_fact",
      summary: "Source behavior changed",
      detail: "This hunk contains source additions/removals but no high-signal deterministic category.",
    });
  }
  return findings;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  rs: "rs",
  go: "go",
  py: "py",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  java: "java",
  kt: "kt",
  kts: "kt",
  swift: "swift",
  rb: "rb",
  php: "php",
  cs: "cs",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  sql: "sql",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  css: "css",
  md: "md",
};

const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  rs: "rust",
  go: "go",
  py: "python",
  c: "c",
  cpp: "c++",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  cs: "c#",
  sh: "shell",
  sql: "sql",
  json: "json",
  yaml: "yaml",
  html: "html",
  css: "css",
  md: "markdown",
};

function languageFromPath(path: string): string | undefined {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return LANGUAGE_BY_EXTENSION[base.slice(dot + 1).toLowerCase()];
}

function displayLanguage(language: string): string {
  return LANGUAGE_DISPLAY_NAMES[language] ?? language;
}

const DECLARATION_KEYWORDS: Record<string, true> = {
  function: true, fn: true, func: true, def: true, class: true, struct: true, enum: true,
  trait: true, impl: true, interface: true, type: true, protocol: true, extension: true,
  namespace: true, mod: true,
};

const CONTROL_KEYWORDS: Record<string, true> = {
  if: true, for: true, while: true, switch: true, catch: true, match: true, return: true,
  else: true, do: true, case: true, try: true, finally: true, guard: true, where: true,
  with: true, new: true, throw: true, await: true, yield: true, import: true, from: true,
  use: true, break: true, continue: true, delete: true, typeof: true, instanceof: true,
  void: true, in: true, of: true, as: true, is: true, select: true, defer: true, go: true,
};

const PAREN_SKIP_KEYWORDS: Record<string, true> = {
  ...CONTROL_KEYWORDS,
  ...DECLARATION_KEYWORDS,
  const: true, let: true, var: true, pub: true, static: true, async: true, export: true,
  default: true, public: true, private: true, protected: true, extern: true, unsafe: true,
  abstract: true, final: true, sealed: true, override: true, inline: true, virtual: true,
  template: true, typename: true, mutable: true, auto: true, lock: true, expect: true,
  assert: true, describe: true, it: true, test: true, should: true, Object: true, JSON: true,
  Math: true, Promise: true, Array: true, String: true, Number: true, Date: true, Boolean: true,
  Symbol: true, console: true, document: true, window: true, process: true, Buffer: true,
  require: true, define: true, setTimeout: true, setInterval: true, fetch: true, Error: true,
  map: true, filter: true, reduce: true, forEach: true, then: true, some: true, every: true,
};

const DECLARATION_PREFIX = new RegExp(
  `^(?:(?:export|default|async|static|abstract|final|sealed|public|private|protected|override|virtual|inline|unsafe|extern|pub(?:\\([^)]*\\))?|global|readonly|mut|const|let|var)\\s+)*(${Object.keys(DECLARATION_KEYWORDS).join("|")})\\b`,
);

// Reduce an extracted function-context line to its bare symbol, e.g. "fn pointAdd(" -> "pointAdd()".
function symbolFromText(text: string): string {
  const trimmed = text.trim();
  const paren = /([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = paren.exec(trimmed)) !== null) {
    if (PAREN_SKIP_KEYWORDS[match[1]] === true) continue;
    return `${match[1]}()`;
  }
  const assigned = /(?:^|[\s=(,:])([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/.exec(trimmed);
  if (assigned) return `${assigned[1]}()`;
  return trimmed;
}

// Lightweight heuristic: does a single diff line (context, added, or removed) look like a
// function/type declaration? Returns the enclosing symbol or undefined. Never throws.
function enclosingSymbolFromLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  if (/^(?:\/\/|#|\/\*|\*|--)/.test(trimmed)) return undefined;
  const firstToken = /^[A-Za-z_$][\w$]*/.exec(trimmed)?.[0];
  if (firstToken && CONTROL_KEYWORDS[firstToken] === true) return undefined;
  const decl = DECLARATION_PREFIX.exec(trimmed);
  if (decl) {
    const rest = trimmed.slice(decl[0].length).trim();
    const name = /^[A-Za-z_$][\w$]*/.exec(rest)?.[0];
    if (name) {
      const keyword = decl[1];
      if (keyword === "function" || keyword === "fn" || keyword === "func" || keyword === "def") {
        return `${name}()`;
      }
      return name;
    }
    return symbolFromText(trimmed);
  }
  if (!trimmed.includes("{") && !trimmed.includes("=>")) return undefined;
  const paren = /([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = paren.exec(trimmed)) !== null) {
    const token = match[1];
    if (PAREN_SKIP_KEYWORDS[token] === true) continue;
    if (match.index > 0 && /[.\w$#]/.test(trimmed[match.index - 1])) continue;
    return `${token}()`;
  }
  if (trimmed.includes("=>")) {
    const assigned = /(?:^|[\s=(,:])([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/.exec(trimmed);
    if (assigned) return `${assigned[1]}()`;
  }
  return undefined;
}

function functionContextFromHeader(header: string): string | undefined {
  const match = /^@@ [^@]+ @@\s*(.*)$/.exec(header);
  const tail = match?.[1]?.trim();
  return tail || undefined;
}

function functionHintForHunk(header: string, lines: string[]): string | undefined {
  const tail = functionContextFromHeader(header);
  if (tail) return symbolFromText(tail);
  // No git function context: scan the hunk's own lines top-to-bottom (context, added, and
  // removed) for the nearest function-definition-shaped line. Safe degrade to undefined.
  for (const line of lines) {
    const hint = enclosingSymbolFromLine(line);
    if (hint !== undefined) return hint;
  }
  return undefined;
}

function parseDiff(raw: string, targetFingerprint: string): ReviewSnapshot["files"] {
  const files: ReviewSnapshot["files"] = [];
  const lines = raw.split("\n");
  let current: { path: string; oldPath?: string; prefix: string[]; hunks: Hunk[] } | null = null;
  let hunkHeader: string | null = null;
  let hunkLines: string[] = [];

  const flushHunk = () => {
    if (!current || !hunkHeader) return;
    const range = parseRange(hunkHeader);
    const patch = `${current.prefix.join("\n")}\n${hunkHeader}\n${hunkLines.join("\n")}\n`;
    const ordinal = current.hunks.length;
    const fingerprint = sha256(canonicalJson({ targetFingerprint, path: current.path, header: hunkHeader, patch, ordinal }));
    const id = `H-${fingerprint.slice(0, 10)}`;
    const language = languageFromPath(current.path);
    const functionHint = functionHintForHunk(hunkHeader, hunkLines);
    current.hunks.push({
      id,
      fingerprint,
      filePath: current.path,
      ...range,
      header: hunkHeader,
      patch,
      lines: [...hunkLines],
      findings: detectFindings(hunkLines),
      ...(functionHint ? { functionHint } : {}),
      ...(language ? { language } : {}),
    });
    hunkHeader = null;
    hunkLines = [];
  };
  const flushFile = () => {
    flushHunk();
    if (!current) return;
    const additions = current.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.startsWith("+")).length, 0);
    const deletions = current.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.startsWith("-")).length, 0);
    const language = languageFromPath(current.path);
    files.push({ path: current.path, ...(current.oldPath ? { oldPath: current.oldPath } : {}), ...(language ? { language } : {}), additions, deletions, hunks: current.hunks });
    current = null;
  };

  for (const line of lines) {
    const fileHeader = filePathFromDiffHeader(line);
    if (fileHeader) {
      flushFile();
      current = { path: fileHeader.path, oldPath: fileHeader.oldPath, prefix: [line], hunks: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@ ")) {
      flushHunk();
      hunkHeader = line;
      continue;
    }
    if (hunkHeader) hunkLines.push(line);
    else current.prefix.push(line);
  }
  flushFile();
  return files;
}

async function state(): Promise<StateFile> {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8")) as StateFile;
  } catch {
    return {};
  }
}

async function saveState(next: StateFile): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const temporary = `${STATE_PATH}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temporary, STATE_PATH);
}

function createMutex(): Mutex {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(() => fn());
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

const stateMutex = createMutex();

interface Mutex {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

const repoMutexes = new Map<string, Mutex>();

function withRepoMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let mutex = repoMutexes.get(key);
  if (!mutex) {
    let queued = 0;
    const fresh = createMutex();
    const trackedRun = <T2>(op: () => Promise<T2>): Promise<T2> => {
      queued++;
      const result = fresh.run(op);
      void result.then(
        () => {
          queued--;
          if (queued === 0 && repoMutexes.get(key) === fresh) repoMutexes.delete(key);
        },
        () => {
          queued--;
          if (queued === 0 && repoMutexes.get(key) === fresh) repoMutexes.delete(key);
        },
      );
      return result;
    };
    mutex = { run: trackedRun };
    repoMutexes.set(key, mutex);
  }
  return mutex.run(fn);
}

export async function createSnapshot(request: ReviewRequest): Promise<ReviewSnapshot> {
  const target = await resolveReviewTarget(request);
  const [indexDiff, worktreeDiff, status] = await Promise.all([
    runGit(target.repositoryPath, ["diff", "--cached", "--binary", "--no-ext-diff"]),
    runGit(target.repositoryPath, ["diff", "--binary", "--no-ext-diff"]),
    runGit(target.repositoryPath, ["status", "--porcelain=v2", "-z"]),
  ]);
  const untracked = request.scope === "working" ? await collectUntrackedPatches(target.repositoryPath, request) : [];
  const untrackedStateHash = untracked.length > 0 ? sha256(untracked.join("\u0000")) : "";
  const targetFingerprint = sha256(canonicalJson({
    repositoryPath: target.repositoryPath,
    worktreePath: target.worktreePath,
    gitDir: target.gitDir,
    scope: request.scope,
    baseRef: target.baseRef,
    headRef: target.headRef,
    baseSha: target.baseSha,
    headSha: target.headSha,
    indexStateHash: sha256(indexDiff),
    worktreeStateHash: sha256(`${status}\u0000${worktreeDiff}\u0000${untrackedStateHash}`),
    filePath: request.filePath ?? null,
  }));
  const files = parseDiff(await diffFor(request, target, untracked), targetFingerprint);
  const totalHunks = files.reduce((total, file) => total + file.hunks.length, 0);
  const priorityHunks = files.reduce(
    (total, file) => total + file.hunks.filter((hunk) => hunk.findings.some((finding) => severityRank(finding.severity) >= 4)).length,
    0,
  );
  return {
    repositoryPath: target.repositoryPath,
    worktreePath: target.worktreePath,
    scope: request.scope,
    baseRef: target.baseRef,
    headRef: target.headRef,
    baseSha: target.baseSha,
    headSha: target.headSha,
    targetFingerprint,
    files,
    totalHunks,
    priorityHunks,
    generatedAt: new Date().toISOString(),
  };
}

export function findHunk(snapshot: ReviewSnapshot, hunkId: string): Hunk {
  for (const file of snapshot.files) {
    const found = file.hunks.find((hunk) => hunk.id === hunkId);
    if (found) return found;
  }
  throw new Error(`Hunk ${hunkId} is no longer present in this review snapshot.`);
}

export async function recordDecision(input: {
  projectId: string;
  cwd: string;
  targetFingerprint: string;
  hunkId: string;
  hunkFingerprint: string;
  filePath: string;
  hunkHeader: string;
  hunkPatch: string;
  decision: StateEntry["decision"];
  scope: ReviewScope;
  projectName?: string;
  projectRootPath?: string;
  workspaceId?: string;
  baseRef?: string;
  headRef?: string;
  comment?: string;
}): Promise<string> {
  return stateMutex.run(async () => {
    const savedAt = new Date().toISOString();
    const file = await state();
    const entries = file[input.targetFingerprint] ?? [];
    const next = entries.filter((entry) => entry.hunkId !== input.hunkId);
    next.push({
      id: randomUUID(),
      projectId: input.projectId,
      hunkId: input.hunkId,
      decision: input.decision,
      ...(input.comment ? { comment: input.comment } : {}),
      cwd: input.cwd,
      scope: input.scope,
      targetFingerprint: input.targetFingerprint,
      hunkFingerprint: input.hunkFingerprint,
      filePath: input.filePath,
      hunkHeader: input.hunkHeader,
      hunkPatch: input.hunkPatch,
      ...(input.projectName ? { projectName: input.projectName } : {}),
      ...(input.projectRootPath ? { projectRootPath: input.projectRootPath } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      ...(input.headRef ? { headRef: input.headRef } : {}),
      savedAt,
    });
    file[input.targetFingerprint] = next;
    await saveState(file);
    return savedAt;
  });
}

export async function reviewState(targetFingerprint: string): Promise<StateEntry[]> {
  return (await state())[targetFingerprint] ?? [];
}
/**
 * Remove a single hunk's saved decision. Returns false when the target or the
 * hunk has no saved entry; the target key is dropped when its array empties.
 */
export async function clearHunkState(targetFingerprint: string, hunkId: string): Promise<boolean> {
  return stateMutex.run(async () => {
    const file = await state();
    const entries = file[targetFingerprint];
    if (!entries || entries.length === 0) return false;
    const next = entries.filter((entry) => entry.hunkId !== hunkId);
    if (next.length === entries.length) return false;
    if (next.length === 0) delete file[targetFingerprint];
    else file[targetFingerprint] = next;
    await saveState(file);
    return true;
  });
}

/** Remove every saved decision for one target fingerprint. Returns whether any existed. */
export async function clearReviewState(targetFingerprint: string): Promise<boolean> {
  return stateMutex.run(async () => {
    const file = await state();
    const entries = file[targetFingerprint];
    if (entries === undefined) return false;
    delete file[targetFingerprint];
    await saveState(file);
    return true;
  });
}

/**
 * Summarize the saved decisions of every target fingerprint. cwd/scope are taken
 * from the latest entry that carries them; lastSavedAt is the newest savedAt;
 * commentCount counts entries that store a comment.
 */
export async function listReviewStates(): Promise<
  Array<{
    targetFingerprint: string;
    cwd?: string;
    scope?: ReviewScope;
    decisionCount: number;
    commentCount: number;
    lastSavedAt: string;
  }>
> {
  const file = await state();
  return Object.entries(file).map(([targetFingerprint, entries]) => {
    let cwd: string | undefined;
    let scope: ReviewScope | undefined;
    let lastSavedAt = "";
    let commentCount = 0;
    for (const entry of [...entries].sort((left, right) => left.savedAt.localeCompare(right.savedAt))) {
      if (entry.savedAt > lastSavedAt) lastSavedAt = entry.savedAt;
      if (entry.cwd !== undefined) cwd = entry.cwd;
      if (entry.scope !== undefined) scope = entry.scope;
      if (entry.comment) commentCount += 1;
    }
    return {
      targetFingerprint,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(scope !== undefined ? { scope } : {}),
      decisionCount: entries.length,
      commentCount,
      lastSavedAt,
    };
  });
}

/** Wipe every saved decision; returns the number of targets that were cleared (0 when already empty). */
export async function clearAllReviewStates(): Promise<number> {
  return stateMutex.run(async () => {
    const file = await state();
    const count = Object.keys(file).length;
    if (count === 0) return 0;
    await saveState({});
    return count;
  });
}

function projectCommentFromEntry(entry: StateEntry, targetFingerprint: string, projectId: string): ProjectReviewComment | null {
  if (entry.projectId !== projectId || entry.decision !== "commented") return null;
  const comment = entry.comment?.trim();
  if (!comment) return null;
  if (!entry.id || !entry.filePath || !entry.hunkFingerprint || !entry.hunkHeader || !entry.hunkPatch || !entry.cwd || entry.scope === undefined) return null;
  return {
    id: entry.id,
    projectId,
    ...(entry.projectName ? { projectName: entry.projectName } : {}),
    ...(entry.projectRootPath ? { projectRootPath: entry.projectRootPath } : {}),
    ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
    targetFingerprint: entry.targetFingerprint ?? targetFingerprint,
    hunkId: entry.hunkId,
    hunkFingerprint: entry.hunkFingerprint,
    filePath: entry.filePath,
    hunkHeader: entry.hunkHeader,
    hunkPatch: entry.hunkPatch,
    cwd: entry.cwd,
    scope: entry.scope,
    ...(entry.baseRef ? { baseRef: entry.baseRef } : {}),
    ...(entry.headRef ? { headRef: entry.headRef } : {}),
    comment,
    savedAt: entry.savedAt,
  };
}

function projectComments(file: StateFile, projectId: string): ProjectReviewComment[] {
  const comments: ProjectReviewComment[] = [];
  for (const [targetFingerprint, entries] of Object.entries(file)) {
    for (const entry of entries) {
      const comment = projectCommentFromEntry(entry, targetFingerprint, projectId);
      if (comment) comments.push(comment);
    }
  }
  return comments;
}

function projectCommentIdentity(comments: readonly ProjectReviewComment[]): { projectName?: string; projectRootPath?: string } {
  let projectName: string | undefined;
  let projectRootPath: string | undefined;
  for (const comment of [...comments].sort((left, right) => left.savedAt.localeCompare(right.savedAt))) {
    if (comment.projectName !== undefined) projectName = comment.projectName;
    if (comment.projectRootPath !== undefined) projectRootPath = comment.projectRootPath;
  }
  return {
    ...(projectName !== undefined ? { projectName } : {}),
    ...(projectRootPath !== undefined ? { projectRootPath } : {}),
  };
}

function sortProjectComments(comments: ProjectReviewComment[]): ProjectReviewComment[] {
  return comments.sort(
    (left, right) => left.filePath.localeCompare(right.filePath) || left.savedAt.localeCompare(right.savedAt),
  );
}
/**
 * Fail-closed directory equality for the workspace-bound agent gate. Accepts
 * safe normalization differences (relative segments, duplicate separators,
 * trailing separators) and real-path equivalence (symlinks resolved on both
 * sides); anything that cannot be resolved is never accepted as equal, so a
 * different workspace can never pass as the selected one.
 */
async function directoriesMatch(left: string, right: string): Promise<boolean> {
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const normalize = (value: string) => {
    const resolved = resolve(value);
    return resolved.length > 1 && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved;
  };
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  if (fold(normalizedLeft) === fold(normalizedRight)) return true;
  try {
    return fold(await realpath(normalizedLeft)) === fold(await realpath(normalizedRight));
  } catch {
    // Fail closed: an unresolvable path never matches.
    return false;
  }
}

/**
 * List the saved review comments of one project, ordered by filePath then savedAt.
 * Returns null when the project has no comment records, so listings never expose
 * an empty project. fileCount/targetCount are computed from the comment records.
 */
export async function listProjectReviewComments(projectId: string): Promise<ProjectReviewSummary | null> {
  const file = await state();
  const comments = sortProjectComments(projectComments(file, projectId));
  if (comments.length === 0) return null;
  const { projectName, projectRootPath } = projectCommentIdentity(comments);
  return {
    projectId,
    ...(projectName !== undefined ? { projectName } : {}),
    ...(projectRootPath !== undefined ? { projectRootPath } : {}),
    commentCount: comments.length,
    fileCount: new Set(comments.map((comment) => comment.filePath)).size,
    targetCount: new Set(comments.map((comment) => comment.targetFingerprint)).size,
    comments,
  };
}

/**
 * Process every saved review comment of one project in a single agent run,
 * strictly bound to the workspace selected in the client UI.
 * The executing agent is refreshed and validated BEFORE anything runs: it must
 * exist, must belong to input.workspaceId, and its cwd must be the selected
 * workspace directory (real-path/normalization differences allowed, a foreign
 * workspace never accepted). Any mismatch throws a clear error — the server
 * never silently substitutes another agent.
 * The prompt embeds the executing agent's workspace id/cwd plus each comment's
 * file path, target/hunk fingerprints, hunk header, exact patch, human comment,
 * and its own worktree context (cwd, scope, refs, workspace id). Project
 * comments may span multiple worktrees; the agent must only touch the listed
 * files/hunks inside the comment's own cwd/worktree, verify fingerprints item by
 * item, and stop (reporting stale) any item whose target drifted. The agent must
 * end its response with a strict machine-parseable COMMENT OUTCOMES section.
 * processedCommentIds lists the comment ids actually sent — returned even when
 * the agent exits non-idle so the client can keep the records instead of
 * auto-clearing. completedCommentIds lists only ids the agent explicitly marked
 * COMPLETED and that survived server-side validation (parsed exactly once, known
 * id, agent idle); commentOutcomes covers every sent id in send order, defaulting
 * missing/duplicate/unknown entries to "unresolved". The result carries the
 * validated workspaceId/workspaceCwd so output ownership is unambiguous.
 */
export async function processProjectReview(
  input: { projectId: string; agentId: string; workspaceId: string; workspaceCwd: string },
  context: PluginHandlerContext,
): Promise<ProcessProjectReviewResult> {
  // Workspace-bound agent gate: refresh first so a deleted, replaced, or
  // re-bound agent can never be processed silently under a stale id.
  const handle = context.paseo.agents.ref(input.agentId);
  let agent: { workspaceId?: string; cwd?: string } | null | undefined;
  try {
    const fresh = await handle.refresh();
    agent = fresh?.agent ?? handle.current();
  } catch {
    agent = handle.current();
  }
  if (!agent) {
    throw new Error(
      `Processing agent ${input.agentId} does not exist. Select an agent of workspace ${input.workspaceId} and retry.`,
    );
  }
  if (agent.workspaceId !== input.workspaceId) {
    throw new Error(
      `Processing agent ${input.agentId} belongs to workspace ${agent.workspaceId ?? "(none)"}, not the selected workspace ${input.workspaceId}. Project comments can only be processed by an agent of the selected workspace; no other agent was substituted.`,
    );
  }
  if (!(await directoriesMatch(agent.cwd ?? "", input.workspaceCwd))) {
    throw new Error(
      `Processing agent ${input.agentId} runs in ${agent.cwd ?? "(unknown)"}, which is not the selected workspace directory ${input.workspaceCwd}. Refusing to process with an agent outside the selected workspace.`,
    );
  }
  const file = await state();
  const comments = sortProjectComments(projectComments(file, input.projectId));
  if (comments.length === 0) {
    throw new Error(`Project ${input.projectId} has no saved review comments. Save at least one commented hunk before processing.`);
  }
  const processedCommentIds = comments.map((comment) => comment.id);
  const { projectName, projectRootPath } = projectCommentIdentity(comments);
  const commentBlocks = comments.map(
    (comment, index) => [
      `[${index + 1}] Comment id: ${comment.id}`,
      `File: ${comment.filePath}`,
      `Comment cwd (worktree): ${comment.cwd}`,
      `Scope: ${comment.scope}`,
      `Base ref: ${comment.baseRef ?? "(repository default)"}`,
      `Head ref: ${comment.headRef ?? "(repository default)"}`,
      ...(comment.workspaceId !== undefined ? [`Workspace id: ${comment.workspaceId}`] : []),
      `Target fingerprint: ${comment.targetFingerprint}`,
      `Hunk fingerprint: ${comment.hunkFingerprint}`,
      `Hunk header: ${comment.hunkHeader}`,
      `Human comment: ${comment.comment}`,
      `Exact hunk patch:\n${comment.hunkPatch}`,
    ].join("\n"),
  );
  const prompt = [
    "Process every saved review comment below as one task.",
    "Each comment block carries its own cwd (the exact working directory of the worktree the comment came from), scope, refs, and workspace id. The project may span multiple worktrees: you MUST validate and modify every comment inside that comment's own cwd/workspace only, and never treat the project root path, the executing agent's own workspace, or any other worktree as the target of a comment. Every comment is validated against its own cwd, even when that cwd differs from the executing agent's workspace.",
    "You may edit the listed files and hunks to address the human comments, but never modify unrelated files or hunks, and never touch anything outside the comment's own cwd/worktree.",
    "Verify each comment against the current state before editing. If the target fingerprint or the exact hunk fingerprint no longer matches the current change (the target drifted), stop work on that comment, do not edit it, and report it as stale.",
    "For each matching comment, apply the requested change to exactly the listed hunk. Focused verification (running the relevant test or build for the code you changed) is allowed, but never claim that tests or builds passed unless you actually ran them.",
    "Use exactly these headings: VERIFIED FACTS, AI INFERENCE, HUMAN VERIFICATION RECOMMENDED.",
    "At the very end of your response, add a strict machine-parseable COMMENT OUTCOMES section with exactly one line per comment id, in this exact format:",
    "- <comment-id> | COMPLETED | optional short detail",
    "- <comment-id> | STALE | optional short detail",
    "- <comment-id> | FAILED | optional short detail",
    "- <comment-id> | UNRESOLVED | optional short detail",
    "Mark COMPLETED only for comments you actually finished editing. Mark STALE when the target drifted, FAILED when you tried but could not complete it, UNRESOLVED when you did not address it. A comment that is not explicitly marked COMPLETED must never be treated as completed.",
    `Project id: ${input.projectId}`,
    ...(projectName !== undefined ? [`Project name: ${projectName}`] : []),
    `Workspace: ${projectRootPath ?? comments[0].cwd}`,
    `Executing agent workspace id: ${input.workspaceId}`,
    `Executing agent workspace cwd: ${input.workspaceCwd}`,
    `Comments (${comments.length}):`,
    commentBlocks.join("\n\n"),
  ].join("\n\n");
  const result = await handle.run(prompt, { timeoutMs: 120_000 });
  const review = result.lastMessage ?? result.error ?? "The processing agent returned no text.";
  const { completedCommentIds, commentOutcomes } = parseCommentOutcomes(
    review,
    processedCommentIds,
    result.status === "idle",
    result.status,
  );
  const cleanReview = stripCommentOutcomes(review);
  let provider = input.agentId;
  let model = "unknown";
  try {
    const fresh = await handle.refresh();
    const freshAgent = fresh?.agent ?? handle.current();
    if (freshAgent) {
      provider = freshAgent.provider || input.agentId;
      model = freshAgent.model || "unknown";
    }
  } catch {
    // Provider/model keep their fallback values.
  }
  return {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    workspaceCwd: input.workspaceCwd,
    status: result.status,
    processedCommentIds,
    completedCommentIds,
    commentOutcomes,
    commentCount: processedCommentIds.length,
    review: cleanReview,
    sections: parseReviewSections(cleanReview),
    provider,
    model,
  };
}

/**
 * Remove saved project review comments. With commentIds only the listed comment
 * ids are removed (comments saved while processing keep their own ids and are
 * never touched); without commentIds every commented/has-comment record of the
 * project is removed. Reviewed records are preserved. Returns the number of
 * records actually cleared.
 */
export async function clearProjectReviewComments(projectId: string, commentIds?: readonly string[]): Promise<number> {
  return stateMutex.run(async () => {
    const file = await state();
    let cleared = 0;
    for (const [targetFingerprint, entries] of Object.entries(file)) {
      const next = entries.filter((entry) => {
        if (entry.projectId !== projectId) return true;
        if (commentIds !== undefined) return !(entry.id !== undefined && commentIds.includes(entry.id));
        return !(entry.decision === "commented" || (entry.comment?.trim() ?? "") !== "");
      });
      if (next.length === entries.length) continue;
      cleared += entries.length - next.length;
      if (next.length === 0) delete file[targetFingerprint];
      else file[targetFingerprint] = next;
    }
    if (cleared === 0) return 0;
    await saveState(file);
    return cleared;
  });
}
export async function reverseHunk(request: ReviewRequest, expectedTargetFingerprint: string, hunkId: string, expectedHunkFingerprint: string) {
  if (request.scope !== "working" && request.scope !== "staged") {
    throw new Error("Rejecting a hunk is only available for working-tree or staged review targets.");
  }
  const target = await resolveReviewTarget(request);
  return withRepoMutex(target.gitDir, async () => {
    const snapshot = await createSnapshot(request);
    if (snapshot.targetFingerprint !== expectedTargetFingerprint) {
      throw new Error("Review snapshot is stale: the Git target changed after this hunk was analyzed. Refresh before rejecting it.");
    }
    const hunk = findHunk(snapshot, hunkId);
    if (hunk.fingerprint !== expectedHunkFingerprint) {
      throw new Error("Hunk is stale: its exact patch no longer matches the reviewed change.");
    }
    if (hunk.patch.includes("GIT binary patch")) {
      throw new Error("Binary hunk rejection is not supported. Review and revert the file manually.");
    }
    const cachedArgs = request.scope === "staged" ? ["--cached"] : [];
    await runGit(snapshot.repositoryPath, ["apply", "--check", "--reverse", "--binary", ...cachedArgs, "-"], { stdin: hunk.patch });
    await runGit(snapshot.repositoryPath, ["apply", "--reverse", "--binary", ...cachedArgs, "-"], { stdin: hunk.patch });
    const refreshed = await createSnapshot(request);
    const remainingExactPatch = refreshed.files.some((file) =>
      file.hunks.some((candidate) => candidate.patch === hunk.patch),
    );
    if (refreshed.targetFingerprint === snapshot.targetFingerprint || remainingExactPatch) {
      throw new Error("Git accepted the patch but Review Deck could not verify that the reviewed hunk was removed. Refresh and inspect manually.");
    }
    return { targetFingerprint: refreshed.targetFingerprint, removedHunkId: hunk.id };
  });
}

export function explain(snapshot: ReviewSnapshot, hunk: Hunk): {
  hunkId: string;
  verifiedFacts: string[];
  aiInference: string[];
  humanVerificationRecommended: string[];
  revisionPrompt: string;
} {
  const facts = [
    `File: ${hunk.filePath}.`,
    ...(hunk.functionHint ? [`Enclosing symbol: ${hunk.functionHint}.`] : []),
    ...(hunk.language ? [`Language: ${displayLanguage(hunk.language)}.`] : []),
    `Changed range: ${hunk.header}.`,
    `The hunk adds ${hunk.lines.filter((line) => line.startsWith("+")).length} lines and removes ${hunk.lines.filter((line) => line.startsWith("-")).length} lines.`,
    ...hunk.findings.filter((finding) => finding.evidenceKind === "verified_fact").map((finding) => finding.detail),
  ];
  const highRisk = hunk.findings.filter((finding) => severityRank(finding.severity) >= 4);
  const humanChecks = highRisk.length > 0
    ? highRisk.map((finding) => finding.suggestedCheck ?? `Confirm the ${finding.category} implications.`)
    : ["Confirm the changed behavior against its callers and its nearest focused test."];
  const inference = ["The exact motivation is not proven by the diff alone; inspect the task context and surrounding call sites before accepting this change."];
  const revisionPrompt = [
    `Revise only ${hunk.id} in ${hunk.filePath}.`,
    ...(hunk.functionHint ? [`Enclosing symbol: ${hunk.functionHint}.`] : []),
    ...(hunk.language ? [`Language: ${displayLanguage(hunk.language)}.`] : []),
    `Review snapshot fingerprint: ${snapshot.targetFingerprint}.`,
    `Hunk fingerprint: ${hunk.fingerprint}.`,
    "Do not modify unrelated files or hunks.",
    "Before editing, stop and report if the current target fingerprint differs.",
    "Human checks:",
    ...humanChecks.map((check) => `- ${check}`),
  ].join("\n");
  return { hunkId: hunk.id, verifiedFacts: facts, aiInference: inference, humanVerificationRecommended: humanChecks, revisionPrompt };
}
export interface AgentReviewResult {
  status: "idle" | "error" | "permission" | "timeout";
  review: string;
  sections: ReviewSections;
}

const COMMENT_OUTCOME_STATUSES: Record<string, true> = {
  completed: true,
  stale: true,
  failed: true,
  unresolved: true,
};
const COMMENT_OUTCOME_STATUS = ["completed", "stale", "failed", "unresolved"] as const;
type CommentOutcomeStatus = (typeof COMMENT_OUTCOME_STATUS)[number];

function normalizedHeading(line: string): string {
  return line.trim().toUpperCase().replace(/^#+\s*/, "").replace(/:$/, "");
}

/**
 * Parse the machine-parseable COMMENT OUTCOMES section an agent appends to a
 * batch-processing response. Only ids in knownIds are considered; unknown ids
 * are ignored, an id listed more than once is treated as unresolved (never
 * completed), and ids with no parseable entry default to unresolved. When the
 * agent did not finish (agentIdle false) even an explicit COMPLETED entry is
 * downgraded to unresolved. The returned outcomes cover every known id, in
 * knownIds order; completedCommentIds is the subset explicitly marked
 * COMPLETED and accepted.
 */
function parseCommentOutcomes(
  text: string,
  knownIds: readonly string[],
  agentIdle: boolean,
  agentStatus: string,
): { completedCommentIds: string[]; commentOutcomes: ProjectReviewCommentOutcome[] } {
  const known = new Set(knownIds);
  const parsed = new Map<string, Array<{ status: CommentOutcomeStatus; detail?: string }>>();
  let inOutcomes = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const heading = normalizedHeading(trimmed);
    if (heading === "COMMENT OUTCOMES") {
      inOutcomes = true;
      continue;
    }
    if (!inOutcomes) continue;
    if (heading === "VERIFIED FACTS" || heading === "AI INFERENCE" || heading === "HUMAN VERIFICATION RECOMMENDED") {
      inOutcomes = false;
      continue;
    }
    const match = /^[-*]\s*(\S+)\s*\|\s*(\w+)(?:\s*\|\s*(.*))?$/.exec(trimmed);
    if (!match) continue;
    const id = match[1];
    const status = match[2].toLowerCase();
    if (!known.has(id) || COMMENT_OUTCOME_STATUSES[status] !== true) continue;
    const detail = match[3]?.trim() || undefined;
    const entries = parsed.get(id);
    if (entries) entries.push({ status: status as CommentOutcomeStatus, detail });
    else parsed.set(id, [{ status: status as CommentOutcomeStatus, detail }]);
  }
  const completedCommentIds: string[] = [];
  const commentOutcomes: ProjectReviewCommentOutcome[] = knownIds.map((id) => {
    const entries = parsed.get(id);
    if (!entries) return { id, status: "unresolved", detail: "No COMMENT OUTCOMES entry" };
    if (entries.length > 1) {
      return { id, status: "unresolved", detail: `Duplicate COMMENT OUTCOMES entry (${entries.length} lines); ignored` };
    }
    const entry = entries[0];
    if (entry.status === "completed" && !agentIdle) {
      return { id, status: "unresolved", detail: `Agent did not finish (status: ${agentStatus}); completed claim ignored` };
    }
    return { id, status: entry.status, ...(entry.detail ? { detail: entry.detail } : {}) };
  });
  for (const outcome of commentOutcomes) {
    if (outcome.status === "completed") completedCommentIds.push(outcome.id);
  }
  return { completedCommentIds, commentOutcomes };
}

/**
 * Remove the COMMENT OUTCOMES section from an agent response so the returned
 * review stays human-readable prose; the section is machine output consumed by
 * parseCommentOutcomes and never shown in the UI.
 */
function stripCommentOutcomes(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => normalizedHeading(line) === "COMMENT OUTCOMES");
  if (start === -1) return text;
  return lines.slice(0, start).join("\n").trimEnd();
}

export function parseReviewSections(text: string): ReviewSections {
  const sections: ReviewSections = {
    verifiedFacts: [],
    aiInference: [],
    humanVerificationRecommended: [],
  };
  let active: keyof ReviewSections | null = null;
  for (const line of text.split("\n")) {
    const heading = line.trim().toUpperCase().replace(/^#+\s*/, "").replace(/:$/, "");
    if (heading === "VERIFIED FACTS") active = "verifiedFacts";
    else if (heading === "AI INFERENCE") active = "aiInference";
    else if (heading === "HUMAN VERIFICATION RECOMMENDED") active = "humanVerificationRecommended";
    else if (active && line.trim()) sections[active].push(line.trim().replace(/^[-*]\s+/, ""));
  }
  if (sections.verifiedFacts.length === 0 && sections.aiInference.length === 0 && sections.humanVerificationRecommended.length === 0 && text.trim()) {
    sections.aiInference.push(text.trim());
  }
  return sections;
}

export async function runAgentReview(
  input: ReviewRequest & { agentId: string },
  context: PluginHandlerContext,
): Promise<AgentReviewResult> {
  const snapshot = await createSnapshot(input);
  const hunkContext = snapshot.files
    .flatMap((file) => file.hunks)
    .map((hunk) => `${hunk.id} ${hunk.filePath} ${hunk.header}${hunk.functionHint ? ` (enclosing: ${hunk.functionHint})` : ""}\n${hunk.patch}`)
    .join("\n")
    .slice(0, 160_000);
  const prompt = [
    "Review the current Git changeset for a human reviewer.",
    "Do not edit files. Inspect callers, callees, related tests, and the current files with your read-only tools.",
    "Use exactly these headings: VERIFIED FACTS, AI INFERENCE, HUMAN VERIFICATION RECOMMENDED.",
    "Only report VERIFIED FACTS that are directly supported by the supplied snapshot or commands you actually ran.",
    "Every finding must include a hunk id. Never claim that tests or builds passed unless you ran them.",
    `Workspace: ${snapshot.worktreePath}`,
    `Review fingerprint: ${snapshot.targetFingerprint}`,
    "Hunks:",
    hunkContext || "(No text hunks found.)",
  ].join("\n\n");
  const result = await context.paseo.agents.ref(input.agentId).run(prompt, { timeoutMs: 120_000 });
  const review = result.lastMessage ?? result.error ?? "The review agent returned no text.";
  return {
    status: result.status,
    review,
    sections: parseReviewSections(review),
  };
}
/**
 * AI-powered explanation of a single hunk, delegated to a concrete agent.
 * The prompt only asks for analysis of the given hunk — never to edit files.
 * Provider/model are read back from the agent handle; when unavailable the
 * provider falls back to the agent id and the model to "unknown".
 */
export async function explainHunkWithAgent(
  input: ReviewRequest & { hunkId: string; agentId: string },
  context: PluginHandlerContext,
): Promise<ExplainHunkAiResult> {
  const snapshot = await createSnapshot(input);
  const hunk = findHunk(snapshot, input.hunkId);
  const prompt = [
    "Explain this single hunk for a human reviewer.",
    "Do not edit any files.",
    "Use exactly these headings: VERIFIED FACTS, AI INFERENCE, HUMAN VERIFICATION RECOMMENDED.",
    "Only report VERIFIED FACTS that are directly supported by the supplied diff or commands you actually ran.",
    "Never claim that tests or builds passed unless you ran them.",
    `Workspace: ${snapshot.worktreePath}`,
    `Review fingerprint: ${snapshot.targetFingerprint}`,
    `Hunk id: ${hunk.id}`,
    `File: ${hunk.filePath}`,
    `Hunk header: ${hunk.header}`,
    `Exact hunk diff:\n${hunk.patch}`,
    ...(hunk.functionHint ? [`Enclosing symbol: ${hunk.functionHint}.`] : []),
    ...(hunk.language ? [`Language: ${displayLanguage(hunk.language)}.`] : []),
  ].join("\n\n");
  const result = await context.paseo.agents.ref(input.agentId).run(prompt, { timeoutMs: 120_000 });
  const review = result.lastMessage ?? result.error ?? "The explain agent returned no text.";
  let provider = input.agentId;
  let model = "unknown";
  try {
    const handle = context.paseo.agents.ref(input.agentId);
    const fresh = await handle.refresh();
    const agent = fresh?.agent ?? handle.current();
    if (agent) {
      provider = agent.provider || input.agentId;
      model = agent.model || "unknown";
    }
  } catch {
    // Provider/model keep their fallback values.
  }
  return {
    hunkId: hunk.id,
    ...parseReviewSections(review),
    revisionPrompt: [
      `Revise only ${hunk.id} in ${hunk.filePath} according to the AI explanation above.`,
      `Review snapshot fingerprint: ${snapshot.targetFingerprint}.`,
      `Hunk fingerprint: ${hunk.fingerprint}.`,
      "Do not modify unrelated files or hunks.",
      "Before editing, stop and report if the current target fingerprint differs.",
    ].join("\n"),
    status: result.status,
    provider,
    model,
  };
}

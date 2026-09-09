import { spawn } from "node:child_process";
import { isAbsolute, win32 } from "node:path";

const MAX_GIT_OUTPUT = 8 * 1024 * 1024;

export interface GitRunOptions {
  stdin?: string;
  acceptableExitCodes?: readonly number[];
}

/**
 * Runs `git -C <cwd> <args>` with Review Deck's output cap and prompt/lock
 * hardening. One instance is bound to a single working directory; callers
 * construct a runner per repository path they need.
 */
export class GitRunner {
  constructor(private readonly cwd: string) {}

  run(args: string[], options: GitRunOptions = {}): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const child = spawn("git", ["-C", this.cwd, ...args], {
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

  /** Run git and return trimmed output, or null when the command fails. */
  optional(args: string[]): Promise<string | null> {
    return this.run(args).then((output) => output.trim() || null).catch(() => null);
  }

  async resolveBaseRef(requested?: string): Promise<string | null> {
    if (requested) return requested;
    const originHead = await this.optional(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    if (originHead) return originHead.replace(/^refs\/remotes\//, "");
    for (const candidate of ["main", "master"]) {
      if (await this.optional(["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`])) return candidate;
    }
    return null;
  }

  /**
   * Rejects path specs that could escape the repository or smuggle pathspec
   * magic. The check is relative to this runner's working directory.
   */
  validatePathSpec(filePath: string | undefined): void {
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
}

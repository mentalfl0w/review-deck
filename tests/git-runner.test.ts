/**
 * GitRunner must hand the DiffParser a canonical `diff --git a/… b/…` header
 * no matter how the reviewing user configures their diff output.
 *
 * `diff.mnemonicPrefix`, `diff.noprefix` and `diff.srcPrefix`/`diff.dstPrefix`
 * all rewrite that header. The parser recovers the file path from it and
 * returns no files for a header it cannot split, so a snapshot silently comes
 * back empty instead of failing. The runner pins the prefixes with `-c`,
 * which outranks every config file and leaves the user's own `git diff`
 * untouched.
 *
 * Each test runs with an empty global/system Git config. The cases exercise
 * repository-local settings and a `GIT_CONFIG_COUNT` environment override.
 *
 * Run: node tests/git-runner.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRunner } from "../server/git/GitRunner";
import { DiffParser } from "../server/diff/DiffParser";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function withGitConfigEnvironment(
  overrides: Record<string, string>,
  action: () => Promise<void>,
): Promise<void> {
  const keys = new Set([
    ...Object.keys(process.env).filter((key) => key.startsWith("GIT_CONFIG_")),
    ...Object.keys(overrides),
  ]);
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  Object.assign(process.env, overrides);
  try {
    await action();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CASES: Array<{
  name: string;
  config: string[];
  environment?: Record<string, string>;
  expectedBareHeader?: string;
}> = [
  { name: "mnemonic prefixes", config: ["diff.mnemonicPrefix=true"] },
  { name: "no prefixes", config: ["diff.noprefix=true"] },
  { name: "custom src/dst prefixes", config: ["diff.srcPrefix=OLD/", "diff.dstPrefix=NEW/"] },
  { name: "combined", config: ["diff.mnemonicPrefix=true", "diff.noprefix=true"] },
  {
    name: "GIT_CONFIG_COUNT mnemonic prefix",
    config: [],
    environment: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "diff.mnemonicPrefix",
      GIT_CONFIG_VALUE_0: "true",
    },
    expectedBareHeader: "diff --git c/src/app.txt w/src/app.txt",
  },
];

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "review-deck-git-runner-"));
  try {
    const emptyGlobalConfig = join(root, "empty.gitconfig");
    await writeFile(emptyGlobalConfig, "", "utf8");
    for (const testCase of CASES) {
      const repo = join(root, testCase.name.replace(/\W+/g, "-"));
      await mkdir(join(repo, "src"), { recursive: true });
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "review-deck@example.com");
      git(repo, "config", "user.name", "Review Deck Tests");
      git(repo, "config", "commit.gpgsign", "false");
      for (const entry of testCase.config) {
        const separator = entry.indexOf("=");
        git(repo, "config", entry.slice(0, separator), entry.slice(separator + 1));
      }

      await writeFile(join(repo, "src", "app.txt"), "alpha\nbeta\n", "utf8");
      git(repo, "add", "src/app.txt");
      git(repo, "commit", "-q", "-m", "initial");
      await writeFile(join(repo, "src", "app.txt"), "alpha\nGAMMA\n", "utf8");

      const runner = new GitRunner(repo);
      await withGitConfigEnvironment(
        {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: emptyGlobalConfig,
          ...testCase.environment,
        },
        async () => {
          // Sanity check: without the runner the repository configuration really
          // does produce a header the parser cannot split, so a passing assertion
          // below cannot pass for the wrong reason.
          const bareHeader = git(repo, "diff", "HEAD").split("\n")[0];
          const raw = await runner.run(["diff", "--binary", "--no-ext-diff", "HEAD"]);
          const header = raw.split("\n")[0];

          assert.match(header, /^diff --git a\/src\/app\.txt b\/src\/app\.txt$/, `${testCase.name}: canonical header, got ${header}`);
          assert.notEqual(header, bareHeader, `${testCase.name}: the fixture must actually differ from the canonical header, got ${header}`);
          if (testCase.expectedBareHeader) {
            assert.equal(bareHeader, testCase.expectedBareHeader, `${testCase.name}: the injected Git config takes effect`);
          }

          const files = new DiffParser().parse(raw, "fingerprint", "en");
          assert.deepEqual(
            files.map((file) => file.path),
            ["src/app.txt"],
            `${testCase.name}: the parser recovers the file path`,
          );
          assert.equal(files[0]?.hunks.length, 1, `${testCase.name}: the edit is one hunk`);
          assert.equal(files[0]?.additions, 1, `${testCase.name}: one added line`);
          assert.equal(files[0]?.deletions, 1, `${testCase.name}: one deleted line`);

          // A path containing a space stays recoverable: Git leaves the `diff --git`
          // header ambiguous for such paths, and only the pinned prefixes keep the
          // `a/… b/…` split unambiguous.
          git(repo, "add", "-A");
          git(repo, "commit", "-q", "-m", "edit");
          await writeFile(join(repo, "src", "sp ace.txt"), "one\n", "utf8");
          git(repo, "add", "src/sp ace.txt");
          git(repo, "commit", "-q", "-m", "spaced path");
          await writeFile(join(repo, "src", "sp ace.txt"), "two\n", "utf8");
          const spacedRaw = await runner.run(["diff", "--binary", "--no-ext-diff", "HEAD"]);
          const spacedFiles = new DiffParser().parse(spacedRaw, "fingerprint", "en");
          assert.deepEqual(
            spacedFiles.map((file) => file.path),
            ["src/sp ace.txt"],
            `${testCase.name}: a path containing a space keeps its full name`,
          );
        },
      );
    }
    console.log(`git-runner: canonical diff prefixes hold under ${CASES.length} hostile configurations`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

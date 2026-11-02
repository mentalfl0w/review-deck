import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = join(repositoryRoot, "tests/fixtures/ui-demo");
const temporaryRoot = await mkdtemp(join(tmpdir(), "review-deck-ui-demo-"));
const projectPath = join(temporaryRoot, "Trail Cart Demo");

await mkdir(projectPath, { recursive: true });
await cp(join(fixtureRoot, "baseline"), projectPath, { recursive: true });

const runGit = (args) => execFileSync("git", args, { cwd: projectPath, stdio: "ignore" });
runGit(["init", "--quiet"]);
runGit(["config", "user.name", "Review Deck Demo"]);
runGit(["config", "user.email", "review-deck-demo@example.invalid"]);
runGit(["add", "."]);
runGit(["commit", "--quiet", "-m", "chore(demo): add starter checkout"]);

await cp(join(fixtureRoot, "working"), projectPath, { recursive: true });
console.log(projectPath);

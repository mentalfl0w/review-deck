import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} ${signal ? `stopped by ${signal}` : `exited with ${code}`}`));
    });
  });
}

await run(process.execPath, ["--experimental-strip-types", "tests/agent-message-stream.test.ts"]);
await run(process.execPath, ["--experimental-strip-types", "tests/readonly-review-routing.test.ts"]);
await run(process.execPath, ["--experimental-strip-types", "tests/review-settings-timeline.test.ts"]);

const outputDirectory = await mkdtemp(join(tmpdir(), "review-deck-tooltip-"));
try {
  await run(process.execPath, [
    tsc,
    "--outDir",
    outputDirectory,
    "--module",
    "commonjs",
    "--target",
    "ES2020",
    "--moduleResolution",
    "node",
    "--esModuleInterop",
    "--skipLibCheck",
    "--types",
    "node",
    "--lib",
    "ES2020",
    "client/components/tooltip.ts",
    "tests/tooltip-jitter.test.ts",
  ]);
  await run(process.execPath, [join(outputDirectory, "tests/tooltip-jitter.test.js")]);
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}

import { createHash } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Content identity of a hunk's patch: everything through the file-level
 * preamble (`diff --git`, `index`, `---`, `+++` — the `index` line embeds a
 * whole-file blob hash that drifts whenever the file changes elsewhere) and
 * every `@@ ` hunk header is dropped, so identical +/-/context lines produce
 * the same id regardless of line shifts or unrelated edits in the same file.
 */
export function hunkContentId(path: string, patch: string): string {
  const firstHeader = patch.indexOf("\n@@ ");
  const scoped = firstHeader >= 0 ? patch.slice(firstHeader + 1) : patch;
  const body = scoped.split("\n").filter((line) => !/^@@ /.test(line)).join("\n");
  return sha256(canonicalJson({ path, body }));
}
/**
 * Identity of a hunk's own change: only its added/removed lines (the "+" and
 * "-" lines after the hunk header), in body order. Context lines are omitted
 * because git re-derives the context window whenever neighboring changes in
 * the same file appear or disappear, while the changed lines of an untouched
 * hunk stay byte-identical. Used where a hunk must be recognized across
 * target drift (revert skip lists).
 */
export function hunkChangeId(path: string, patch: string): string {
  const lines = patch.split("\n");
  const headerAt = lines.findIndex((line) => line.startsWith("@@ "));
  const changes = (headerAt === -1 ? lines : lines.slice(headerAt + 1)).filter(
    (line) => line.startsWith("+") || line.startsWith("-"),
  );
  return sha256(canonicalJson({ path, changes }));
}

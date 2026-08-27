import type { ReviewSnapshot } from "../../review.shared";
import { canonicalJson, sha256 } from "../util/crypto.server";
import { detectFindings } from "./FindingDetector.server";
import { functionHintForHunk, languageFromPath } from "../lang/languages.server";

 export type Hunk = ReviewSnapshot["files"][number]["hunks"][number];
export function hunkFingerprint(
  targetFingerprint: string,
  path: string,
  header: string,
  patch: string,
  ordinal: number,
): string {
  return sha256(canonicalJson({ targetFingerprint, path, header, patch, ordinal }));
}

export function parseRange(header: string): { oldStart: number; oldCount: number; newStart: number; newCount: number } {
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

/**
 * Parses raw unified-diff text into Review Deck's snapshot file/hunk structure.
 * Pure with respect to its inputs: the only outside state read is the
 * language/symbol heuristics, and every hunk fingerprint is derived from the
 * target fingerprint plus the hunk's own content.
 */
export class DiffParser {
  parse(raw: string, targetFingerprint: string): ReviewSnapshot["files"] {
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
      const fingerprint = hunkFingerprint(targetFingerprint, current.path, hunkHeader, patch, ordinal);
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
}

import type { SelectedHunk } from "./tools";

export type DiffLineKind = "add" | "del" | "context";

export type SideLine = { kind: DiffLineKind; content: string; lineNo: number };

export type DiffPair = { old: SideLine | null; new: SideLine | null };

/**
 * Derive aligned old/new line pairs from the unified hunk body, deterministically.
 * Context lines pair 1:1; a run of deletions followed by a run of additions zips
 * in order; surplus single-side lines keep an empty opposite side.
 */
export function derivePairs(hunk: SelectedHunk): DiffPair[] {
  const pairs: DiffPair[] = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  let pendingDel: SideLine[] = [];
  let pendingAdd: SideLine[] = [];
  const flush = () => {
    const count = Math.max(pendingDel.length, pendingAdd.length);
    for (let index = 0; index < count; index++) {
      pairs.push({ old: pendingDel[index] ?? null, new: pendingAdd[index] ?? null });
    }
    pendingDel = [];
    pendingAdd = [];
  };
  for (const line of hunk.lines) {
    if (line.startsWith("+")) {
      pendingAdd.push({ kind: "add", content: line.slice(1), lineNo: newNo });
      newNo += 1;
    } else if (line.startsWith("-")) {
      pendingDel.push({ kind: "del", content: line.slice(1), lineNo: oldNo });
      oldNo += 1;
    } else {
      flush();
      const content = line.startsWith(" ") ? line.slice(1) : line;
      pairs.push({
        old: { kind: "context", content, lineNo: oldNo },
        new: { kind: "context", content, lineNo: newNo },
      });
      oldNo += 1;
      newNo += 1;
    }
  }
  flush();
  return pairs;
}

export type UnifiedRow = { sign: "+" | "-" | " "; kind: DiffLineKind; content: string; oldNo: number | null; newNo: number | null };

/** Flatten aligned pairs back into unified presentation order (- then + per replacement). */
export function deriveUnifiedRows(pairs: DiffPair[]): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  for (const pair of pairs) {
    if (pair.old && pair.new && pair.old.kind === "context") {
      rows.push({ sign: " ", kind: "context", content: pair.old.content, oldNo: pair.old.lineNo, newNo: pair.new.lineNo });
    } else {
      if (pair.old) rows.push({ sign: "-", kind: "del", content: pair.old.content, oldNo: pair.old.lineNo, newNo: null });
      if (pair.new) rows.push({ sign: "+", kind: "add", content: pair.new.content, oldNo: null, newNo: pair.new.lineNo });
    }
  }
  return rows;
}

/** Split "@@ -a,b +c,d @@" into the range token and the trailing function context, if any. */
export function hunkHeaderParts(header: string): { range: string; context: string | null } {
  const second = header.indexOf("@@", 2);
  if (second === -1) return { range: header, context: null };
  const range = header.slice(0, second + 2);
  const context = header.slice(second + 2).trim();
  return { range, context: context.length > 0 ? context : null };
}


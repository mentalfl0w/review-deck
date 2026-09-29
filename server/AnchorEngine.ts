/**
 * Deterministic re-anchor engine for saved review anchors (roadmap v1.3 §6).
 *
 * A saved entry is a claim about a piece of the reviewed source captured under
 * an old target fingerprint: a hunk anchor (file + hunk identity) or a line
 * range anchor (a side, an absolute line span, and hashes of the selected text
 * and its surrounding context). When the Git target drifts, this module answers
 * the only question re-anchoring is allowed to answer — "where does that claim
 * point now?" — without ever weakening the fail-closed write paths: reject and
 * revert re-validate the exact target and hunk fingerprints on their own.
 *
 * Resolution is layered, most specific first (roadmap §6.2):
 *
 * 1. Exact fingerprint: the entry was saved under this very target and its
 *    stored hunk fingerprint still matches a current hunk.
 * 2. Content identity: the entry's patch is byte-identical to a current hunk's
 *    patch once the file preamble and hunk headers are dropped. Renames are
 *    recognized ONLY through the current file's `oldPath` alias, and the
 *    hashes are recomputed against the current path, so a rename whose content
 *    is untouched matches. `full` drift mode additionally accepts change
 *    identity (identical +/- lines with re-derived context).
 * 3. Context match (line range anchors, `full` drift mode): the selected text
 *    and context are searched across the complete current file view, then
 *    accepted only when the selected range still belongs to one reviewable hunk.
 *    Partial/binary views can produce manual candidates but never auto-relocate.
 * 4. Ambiguous / stale: two or more matches are AMBIGUOUS, no match is STALE.
 *    Neither is ever auto-selected; the caller surfaces the candidates and the
 *    user decides.
 *
 * Rewrites never touch the identity hashes (selectedTextHash, the context
 * hashes, and the preview): they describe the text the human commented on. A
 * relocation only moves the anchor's position fields (filePath, line span, hunk
 * id/fingerprint/contentId) — except that a rename rewrites filePath, which the
 * whole identity is keyed on.
 */
import type {
  AnchorState,
  FileViewRow,
  HunkReviewAnchor,
  LineRangeReviewAnchor,
  LineRangeSelection,
  ReviewAnchor,
  ReviewScope,
  ReviewStateCurrentHunk,
} from "../shared/review";
import { hunkFingerprint, parseRange } from "./diff/DiffParser";
import type { StateEntry } from "./persistence/StateStore";
import { canonicalJson, hunkChangeId, hunkContentId, sha256 } from "./util/crypto";

/** Lines of before/after context captured with a range anchor (roadmap §6.2). */
export const ANCHOR_CONTEXT_LINES = 3;
/** Upper bound on the candidate positions returned for an ambiguous anchor. */
const ANCHOR_MAX_CANDIDATES = 8;
/** selectedTextPreview is a display hint; it is never an identity input. */
const ANCHOR_PREVIEW_LIMIT = 300;
/** Lines one whole-view window scan may hash before it stops and reports no
 * automatic match: a multi-thousand-line selection against a huge view is
 * resolved manually, and the scan must never stall the reader. */
const ANCHOR_SCAN_LINE_BUDGET = 1_000_000;

export type AnchorSide = "old" | "new";

/** The candidate union frozen in shared/review.ts: hunk and range anchors only. */
export type ReviewAnchorCandidate = HunkReviewAnchor | LineRangeReviewAnchor;

/** Hash of one anchor text block (selected text, or a context window). */
export function anchorTextHash(lines: readonly string[]): string {
  return sha256(canonicalJson([...lines]));
}

/** One side of a hunk's patch as contiguous absolute line numbers. */
export type HunkSideLines = {
  side: AnchorSide;
  /** Absolute line number (old or new file) of the first line. */
  start: number;
  lines: readonly string[];
};

export type HunkRange = { oldStart: number; oldCount: number; newStart: number; newCount: number };

/** A current hunk plus every precomputed identity and side view re-anchoring needs. */
export type HunkDescriptor = {
  hunk: ReviewStateCurrentHunk;
  /** Position of the hunk within its file, as hunkFingerprint consumes it. */
  ordinal: number;
  fingerprint: string;
  contentId: string;
  changeId: string;
  range: HunkRange;
  oldSide: HunkSideLines;
  newSide: HunkSideLines;
};
export type ReviewAnchorFileView = {
  filePath: string;
  oldPath?: string;
  /** True only when source content was read and the row list was not truncated. */
  complete: boolean;
  binary: boolean;
  truncated: boolean;
  rows: readonly FileViewRow[];
};

/**
 * The body lines of the patch's FIRST hunk (a hunk patch carries exactly one
 * `@@` section; a second one is ignored rather than mis-attributed to the
 * first). Trailing empty lines and the `\ No newline at end of file` marker
 * carry no line content and are dropped.
 */
function patchBodyLines(patch: string): string[] {
  const lines = patch.split("\n");
  const headerAt = lines.findIndex((line) => line.startsWith("@@ "));
  if (headerAt === -1) return [];
  const body: string[] = [];
  for (let index = headerAt + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith("@@ ")) break;
    if (line === "" || line.startsWith("\\")) continue;
    body.push(line);
  }
  return body;
}

/**
 * One side of a hunk's patch: context lines and that side's own +/- lines, in
 * file order, which is exactly a contiguous run of absolute line numbers
 * starting at the side's start line in the hunk header.
 */
function sideLinesFor(range: HunkRange, patch: string, side: AnchorSide): HunkSideLines {
  const lines: string[] = [];
  for (const line of patchBodyLines(patch)) {
    const prefix = line[0];
    if (prefix === " ") lines.push(line.slice(1));
    else if (side === "old" ? prefix === "-" : prefix === "+") lines.push(line.slice(1));
  }
  return { side, start: side === "old" ? range.oldStart : range.newStart, lines };
}

/** Parse one hunk header and return its side view, or null when it cannot be trusted. */
function hunkSideLines(header: string, patch: string, side: AnchorSide): HunkSideLines | null {
  let range: HunkRange;
  try {
    range = parseRange(header);
  } catch {
    return null;
  }
  return sideLinesFor(range, patch, side);
}

/**
 * Describe the hunks a client currently shows: target-derived hunk fingerprints
 * (same ordinal rule as the snapshot parser) plus content identity, change
 * identity, range, and both side views. A hunk whose header cannot be parsed is
 * dropped: it can anchor nothing.
 */
export function currentHunkDescriptors(
  targetFingerprint: string,
  hunks: readonly ReviewStateCurrentHunk[],
): HunkDescriptor[] {
  const ordinals = new Map<string, number>();
  const descriptors: HunkDescriptor[] = [];
  for (const hunk of hunks) {
    const ordinal = ordinals.get(hunk.filePath) ?? 0;
    ordinals.set(hunk.filePath, ordinal + 1);
    let range: HunkRange;
    try {
      range = parseRange(hunk.hunkHeader);
    } catch {
      continue;
    }
    descriptors.push({
      hunk,
      ordinal,
      fingerprint: hunkFingerprint(targetFingerprint, hunk.filePath, hunk.hunkHeader, hunk.hunkPatch, ordinal),
      contentId: hunkContentId(hunk.filePath, hunk.hunkPatch),
      changeId: hunkChangeId(hunk.filePath, hunk.hunkPatch),
      range,
      oldSide: sideLinesFor(range, hunk.hunkPatch, "old"),
      newSide: sideLinesFor(range, hunk.hunkPatch, "new"),
    });
  }
  return descriptors;
}

/**
 * Build the validated line range anchor of one decision: the requested side and
 * line span must be fully present in the hunk patch the decision was taken
 * from, and the captured hashes are derived from that patch alone. Throws a
 * clear error instead of storing an anchor that cannot be re-anchored later.
 */
export function buildLineRangeAnchor(input: {
  filePath: string;
  hunkId: string;
  hunkFingerprint: string;
  contentId: string;
  hunkHeader: string;
  hunkPatch: string;
  selection: LineRangeSelection;
}): LineRangeReviewAnchor {
  const side = hunkSideLines(input.hunkHeader, input.hunkPatch, input.selection.side);
  if (!side) {
    throw new Error(
      `Line range selection failed: hunk ${input.hunkId} does not carry a parseable unified-diff header.`,
    );
  }
  if (side.lines.length === 0) {
    throw new Error(
      `Line range selection failed: hunk ${input.hunkId} has no ${input.selection.side}-side lines to select.`,
    );
  }
  const start = input.selection.startLine - side.start;
  const end = input.selection.endLine - side.start;
  if (start < 0 || end >= side.lines.length || start > end) {
    const last = side.start + side.lines.length - 1;
    throw new Error(
      `Line range selection failed: lines ${input.selection.startLine}-${input.selection.endLine} are outside the ${input.selection.side}-side window ${side.start}-${last} of hunk ${input.hunkId}.`,
    );
  }
  const selected = side.lines.slice(start, end + 1);
  const preview = selected.join("\n");
  return {
    kind: "range",
    filePath: input.filePath,
    side: input.selection.side,
    startLine: input.selection.startLine,
    endLine: input.selection.endLine,
    hunkId: input.hunkId,
    hunkFingerprint: input.hunkFingerprint,
    contentId: input.contentId,
    selectedTextHash: anchorTextHash(selected),
    selectedTextPreview: preview.length > ANCHOR_PREVIEW_LIMIT
      ? `${preview.slice(0, ANCHOR_PREVIEW_LIMIT)}…`
      : preview,
    contextBeforeHash: anchorTextHash(side.lines.slice(Math.max(0, start - ANCHOR_CONTEXT_LINES), start)),
    contextAfterHash: anchorTextHash(side.lines.slice(end + 1, end + 1 + ANCHOR_CONTEXT_LINES)),
  };
}

/**
 * The anchor one entry claims, normalized for re-anchoring. A v1.2 entry always
 * stored an anchor; an older entry still carries the hunk identity fields, so
 * its view is derived from those and enriched with whatever content identity
 * the stored patch allows. Returns null when the entry's file is unknown: a
 * claim without a file can never be re-anchored.
 */
export type AnchorEntryView =
  | { kind: "file"; filePath: string }
  | {
    kind: "hunk";
    filePath: string;
    hunkId: string;
    hunkFingerprint?: string;
    contentId?: string;
  }
  | {
    kind: "range";
    filePath: string;
    side: AnchorSide;
    startLine: number;
    endLine: number;
    hunkId: string;
    hunkFingerprint?: string;
    contentId?: string;
    selectedTextHash: string;
    selectedTextPreview?: string;
    contextBeforeHash: string;
    contextAfterHash: string;
  };

export function anchorView(entry: StateEntry): AnchorEntryView | null {
  const anchor = entry.anchor;
  if (anchor) {
    if (anchor.kind === "file") return { kind: "file", filePath: anchor.filePath };
    if (anchor.kind === "hunk") {
      return {
        kind: "hunk",
        filePath: anchor.filePath,
        hunkId: anchor.hunkId,
        hunkFingerprint: anchor.hunkFingerprint,
        contentId: anchor.contentId,
      };
    }
    return {
      kind: "range",
      filePath: anchor.filePath,
      side: anchor.side,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      hunkId: anchor.hunkId,
      hunkFingerprint: anchor.hunkFingerprint,
      contentId: anchor.contentId,
      selectedTextHash: anchor.selectedTextHash,
      ...(anchor.selectedTextPreview !== undefined ? { selectedTextPreview: anchor.selectedTextPreview } : {}),
      contextBeforeHash: anchor.contextBeforeHash,
      contextAfterHash: anchor.contextAfterHash,
    };
  }
  if (entry.filePath === undefined) return null;
  return {
    kind: "hunk",
    filePath: entry.filePath,
    hunkId: entry.hunkId,
    ...(entry.hunkFingerprint !== undefined ? { hunkFingerprint: entry.hunkFingerprint } : {}),
    ...(entry.contentId !== undefined ? { contentId: entry.contentId } : {}),
  };
}

/** One remembered source file is matched by its current path or its rename alias. */
function descriptorOwnsFile(descriptor: HunkDescriptor, filePath: string): boolean {
  return descriptor.hunk.filePath === filePath || descriptor.hunk.oldPath === filePath;
}

export type AnchorWindow = { startLine: number; endLine: number };

/**
 * Every window of `length` lines on one side whose text hashes to
 * selectedTextHash. When context hashes are supplied, the window must also
 * carry context matching them: the stored hash covers "up to
 * ANCHOR_CONTEXT_LINES" lines, so any prefix (before) or suffix (after) window
 * of at most that many lines is accepted. An empty stored context matches the
 * empty window — it means the anchor was captured at the side's edge, and the
 * selected-text hash still has to line up for the window to be a candidate.
 *
 * The stored preview is compared first: identical text always produces an
 * identical preview, so a mismatching preview can never be the selected window
 * and the full-text hash is only paid for positions that still can be. A scan
 * whose hashed lines exceed the budget stops and reports no window, which
 * degrades a pathologically large selection to manual candidates.
 */
function findRangeWindows(input: {
  side: HunkSideLines;
  length: number;
  selectedTextHash: string;
  /** Absent on legacy anchors: every position is hashed then. */
  selectedTextPreview?: string;
  contextBeforeHash?: string;
  contextAfterHash?: string;
}): AnchorWindow[] {
  const { side, length, selectedTextHash } = input;
  if (length <= 0 || length > side.lines.length) return [];
  const windows: AnchorWindow[] = [];
  let hashedLines = 0;
  for (let start = 0; start + length <= side.lines.length; start++) {
    if (input.selectedTextPreview !== undefined && anchorPreviewOf(side.lines, start, length) !== input.selectedTextPreview) continue;
    if (hashedLines + length > ANCHOR_SCAN_LINE_BUDGET) return [];
    hashedLines += length;
    if (anchorTextHash(side.lines.slice(start, start + length)) !== selectedTextHash) continue;
    if (input.contextBeforeHash !== undefined && !contextPrefixMatches(side.lines, start, input.contextBeforeHash)) continue;
    if (input.contextAfterHash !== undefined && !contextSuffixMatches(side.lines, start + length, input.contextAfterHash)) continue;
    windows.push({ startLine: side.start + start, endLine: side.start + start + length - 1 });
  }
  return windows;
}

/** The preview buildLineRangeAnchor stores for a side window: the joined text
 * truncated at ANCHOR_PREVIEW_LIMIT with an ellipsis marker. Built lazily, so
 * the comparison stops as soon as it can answer. */
function anchorPreviewOf(lines: readonly string[], start: number, length: number): string {
  let text = "";
  for (let index = start; index < start + length; index++) {
    if (index > start) text += "\n";
    text += lines[index];
    if (text.length > ANCHOR_PREVIEW_LIMIT) return `${text.slice(0, ANCHOR_PREVIEW_LIMIT)}…`;
  }
  return text;
}

function contextPrefixMatches(lines: readonly string[], before: number, hash: string): boolean {
  for (let length = 0; length <= ANCHOR_CONTEXT_LINES && length <= before; length++) {
    if (anchorTextHash(lines.slice(before - length, before)) === hash) return true;
  }
  return false;
}

function contextSuffixMatches(lines: readonly string[], after: number, hash: string): boolean {
  for (let length = 0; length <= ANCHOR_CONTEXT_LINES && after + length <= lines.length; length++) {
    if (anchorTextHash(lines.slice(after, after + length)) === hash) return true;
  }
  return false;
}
type NumberedFileRow = { lineNumber: number; text: string; hunkId: string | null };
type FileRangeMatch = { window: AnchorWindow; descriptor?: HunkDescriptor };

function fileSideSegments(fileView: ReviewAnchorFileView, side: AnchorSide): NumberedFileRow[][] {
  const rows = fileView.rows
    .map((row): NumberedFileRow | null => {
      const lineNumber = side === "old" ? row.oldLine : row.newLine;
      return lineNumber === null ? null : { lineNumber, text: row.text, hunkId: row.hunkId };
    })
    .filter((row): row is NumberedFileRow => row !== null)
    .sort((left, right) => left.lineNumber - right.lineNumber);
  const segments: NumberedFileRow[][] = [];
  let segment: NumberedFileRow[] = [];
  for (const row of rows) {
    const previous = segment[segment.length - 1];
    if (previous && row.lineNumber !== previous.lineNumber + 1) {
      segments.push(segment);
      segment = [];
    }
    segment.push(row);
  }
  if (segment.length > 0) segments.push(segment);
  return segments;
}

function findFileRangeMatches(input: {
  fileView: ReviewAnchorFileView;
  side: AnchorSide;
  length: number;
  selectedTextHash: string;
  selectedTextPreview?: string;
  contextBeforeHash?: string;
  contextAfterHash?: string;
  descriptors: readonly HunkDescriptor[];
}): FileRangeMatch[] {
  const matches: FileRangeMatch[] = [];
  for (const segment of fileSideSegments(input.fileView, input.side)) {
    const firstLine = segment[0].lineNumber;
    const windows = findRangeWindows({
      side: { side: input.side, start: firstLine, lines: segment.map((row) => row.text) },
      length: input.length,
      selectedTextHash: input.selectedTextHash,
      selectedTextPreview: input.selectedTextPreview,
      contextBeforeHash: input.contextBeforeHash,
      contextAfterHash: input.contextAfterHash,
    });
    for (const window of windows) {
      const offset = window.startLine - firstLine;
      const selected = segment.slice(offset, offset + input.length);
      const hunkId = selected[0]?.hunkId ?? null;
      const descriptor = hunkId !== null && selected.every((row) => row.hunkId === hunkId)
        ? input.descriptors.find((candidate) => candidate.hunk.hunkId === hunkId)
        : undefined;
      matches.push({ window, descriptor });
    }
  }
  return matches;
}

/** Identity constraints of one review request; an unknown field never constrains. */
export type OwnershipConstraints = {
  projectId?: string;
  workspaceId?: string;
  cwd?: string;
  scope?: ReviewScope;
};

export type OwnershipMismatch = "project" | "workspace" | "cwd" | "scope";

/** Trailing separators and platform case are spelling, not identity. */
function normalizeDirectory(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/**
 * Whether a stored entry belongs to the review being resolved. A field the
 * caller or the entry does not define is unknown and never blocks (older
 * builds did not record every field); a field both sides define must be equal.
 * This is what keeps one worktree's, project's, or scope's comments from
 * migrating into another's review.
 */
export function ownershipMismatch(entry: StateEntry, constraints: OwnershipConstraints): OwnershipMismatch | null {
  if (constraints.projectId !== undefined && entry.projectId !== undefined && entry.projectId !== constraints.projectId) {
    return "project";
  }
  if (constraints.workspaceId !== undefined && entry.workspaceId !== undefined && entry.workspaceId !== constraints.workspaceId) {
    return "workspace";
  }
  if (constraints.cwd !== undefined && entry.cwd !== undefined && normalizeDirectory(entry.cwd) !== normalizeDirectory(constraints.cwd)) {
    return "cwd";
  }
  if (constraints.scope !== undefined && entry.scope !== undefined && entry.scope !== constraints.scope) {
    return "scope";
  }
  return null;
}

export type AnchorResolution = {
  state: AnchorState;
  /** The current hunk the anchor resolves to (exact and relocated only). */
  descriptor?: HunkDescriptor;
  /** The anchor rewritten for the current target (relocated only). */
  anchor?: ReviewAnchor;
  /** Current positions an ambiguous anchor might refer to; empty otherwise. */
  candidates: ReviewAnchorCandidate[];
  /** Total file matches, including occurrences outside a reviewable hunk. */
  matchCount?: number;
};

export type ResolveAnchorInput = {
  entry: StateEntry;
  descriptors: readonly HunkDescriptor[];
  /** Whether the entry is stored under the target being resolved right now. */
  sameTarget: boolean;
  /**
   * Comments take every drift level (content, change identity, context match);
   * reviewed records keep the v1.2 semantics — exact fingerprint or content
   * identity only — so an existing reviewed mark never wanders further than it
   * used to.
   */
  fullDrift: boolean;
  /** Complete source-side rows used to validate a unique context match. */
  fileViews?: readonly ReviewAnchorFileView[];
};

function hunkAnchorOf(descriptor: HunkDescriptor): HunkReviewAnchor {
  return {
    kind: "hunk",
    filePath: descriptor.hunk.filePath,
    hunkId: descriptor.hunk.hunkId,
    hunkFingerprint: descriptor.fingerprint,
    contentId: descriptor.contentId,
  };
}

function rangeAnchorOf(
  descriptor: HunkDescriptor,
  view: Extract<AnchorEntryView, { kind: "range" }>,
  window: AnchorWindow,
): LineRangeReviewAnchor {
  return {
    kind: "range",
    filePath: descriptor.hunk.filePath,
    side: view.side,
    startLine: window.startLine,
    endLine: window.endLine,
    hunkId: descriptor.hunk.hunkId,
    hunkFingerprint: descriptor.fingerprint,
    contentId: descriptor.contentId,
    selectedTextHash: view.selectedTextHash,
    ...(view.selectedTextPreview !== undefined ? { selectedTextPreview: view.selectedTextPreview } : {}),
    contextBeforeHash: view.contextBeforeHash,
    contextAfterHash: view.contextAfterHash,
  };
}


function relocateToDescriptor(
  view: AnchorEntryView,
  descriptor: HunkDescriptor,
): AnchorResolution {
  if (view.kind !== "range") {
    return { state: "relocated", descriptor, anchor: hunkAnchorOf(descriptor), candidates: [] };
  }
  const length = view.endLine - view.startLine + 1;
  const side = view.side === "old" ? descriptor.oldSide : descriptor.newSide;
  const windows = findRangeWindows({ side, length, selectedTextHash: view.selectedTextHash, selectedTextPreview: view.selectedTextPreview });
  if (windows.length === 1) {
    return { state: "relocated", descriptor, anchor: rangeAnchorOf(descriptor, view, windows[0]), candidates: [] };
  }
  if (windows.length > 1) {
    return {
      state: "ambiguous",
      descriptor,
      candidates: windows.slice(0, ANCHOR_MAX_CANDIDATES).map((window) => rangeAnchorOf(descriptor, view, window)),
      matchCount: windows.length,
    };
  }
  // The hunk identity survived, but the selected text did not: keep the hunk
  // as a manual candidate rather than rebinding to lines selected by a delta.
  return { state: "ambiguous", descriptor, candidates: [hunkAnchorOf(descriptor)] };
}

/**
 * Resolve one stored entry against the hunks a client currently shows. Pure:
 * it reads no clock, no file system, and no Git state, so identical inputs
 * always produce identical output.
 */
export function resolveAnchor(input: ResolveAnchorInput): AnchorResolution {
  const { entry, descriptors, sameTarget, fullDrift } = input;
  const view = anchorView(entry);
  if (!view) {
    // A legacy entry without a file path can only be placed by an exact identity hit.
    const match = sameTarget
      ? descriptors.find((descriptor) => descriptor.hunk.hunkId === entry.hunkId
        || (entry.hunkFingerprint !== undefined && descriptor.fingerprint === entry.hunkFingerprint))
      : undefined;
    return match ? { state: "exact", descriptor: match, candidates: [] } : { state: "stale", candidates: [] };
  }
  if (view.kind === "file") {
    const match = descriptors.find((descriptor) => descriptorOwnsFile(descriptor, view.filePath));
    if (!match) return { state: "stale", candidates: [] };
    return sameTarget && match.hunk.filePath === view.filePath
      ? { state: "exact", descriptor: match, candidates: [] }
      : {
        state: "relocated",
        descriptor: match,
        anchor: { kind: "file", filePath: match.hunk.filePath },
        candidates: [],
      };
  }
  // Level 1: exact fingerprint of the target the entry was saved under.
  if (sameTarget) {
    if (view.hunkFingerprint !== undefined) {
      const match = descriptors.find((descriptor) => descriptor.fingerprint === view.hunkFingerprint);
      if (match) return { state: "exact", descriptor: match, candidates: [] };
    } else {
      const match = descriptors.find((descriptor) => descriptor.hunk.hunkId === view.hunkId);
      if (match) return { state: "exact", descriptor: match, candidates: [] };
    }
  }
  const files = descriptors.filter((descriptor) => descriptorOwnsFile(descriptor, view.filePath));
  // Level 2: content identity (identical patch body), then change identity
  // (identical +/- lines, re-derived context) for comments.
  const patch = entry.hunkPatch;
  let identityResolution: AnchorResolution | null = null;
  if (patch !== undefined && patch.length > 0) {
    const contentMatches = files.filter((descriptor) => hunkContentId(descriptor.hunk.filePath, patch) === descriptor.contentId);
    const matches = contentMatches.length > 0
      ? contentMatches
      : fullDrift
        ? files.filter((descriptor) => hunkChangeId(descriptor.hunk.filePath, patch) === descriptor.changeId)
        : [];
    if (matches.length === 1) {
      const resolution = relocateToDescriptor(view, matches[0]);
      if (resolution.state === "relocated") return resolution;
      identityResolution = resolution;
    } else if (matches.length > 1) {
      identityResolution = {
        state: "ambiguous",
        candidates: matches.slice(0, ANCHOR_MAX_CANDIDATES).map(hunkAnchorOf),
        matchCount: matches.length,
      };
    }
  }
  // Level 3: confirm context matches against the whole current file. Matches
  // outside a hunk count toward ambiguity but cannot become review anchors.
  if (fullDrift && view.kind === "range") {
    const length = view.endLine - view.startLine + 1;
    const fileView = input.fileViews?.find((candidate) =>
      files.some((descriptor) =>
        candidate.filePath === descriptor.hunk.filePath ||
        candidate.filePath === descriptor.hunk.oldPath ||
        candidate.oldPath === descriptor.hunk.filePath));
    if (fileView?.complete && !fileView.binary && !fileView.truncated) {
      const windows = findFileRangeMatches({
        fileView,
        side: view.side,
        length,
        selectedTextHash: view.selectedTextHash,
        selectedTextPreview: view.selectedTextPreview,
        contextBeforeHash: view.contextBeforeHash,
        contextAfterHash: view.contextAfterHash,
        descriptors: files,
      });
      if (windows.length === 1 && windows[0].descriptor) {
        return {
          state: "relocated",
          descriptor: windows[0].descriptor,
          anchor: rangeAnchorOf(windows[0].descriptor, view, windows[0].window),
          candidates: [],
        };
      }
      if (windows.length === 1) {
        // The only file-wide window lies outside a reviewable hunk: report the
        // L2 candidates unchanged. Spreading a "1 match" count over 2+ rows
        // would contradict the candidates the card lists beside it.
        return identityResolution ?? { state: "stale", candidates: [], matchCount: 1 };
      }
      if (windows.length > 1) {
        const candidates = windows.flatMap(({ descriptor, window }) =>
          descriptor ? [rangeAnchorOf(descriptor, view, window)] : []);
        return {
          state: "ambiguous",
          candidates: candidates.length > 0
            ? candidates.slice(0, ANCHOR_MAX_CANDIDATES)
            : identityResolution?.candidates ?? [],
          matchCount: windows.length,
        };
      }
      if (identityResolution) return identityResolution;
      return { state: "stale", candidates: [] };
    }
    // Without a complete file we can show patch-local matches for manual
    // selection, but cannot prove they are unique across the file.
    const localMatches: FileRangeMatch[] = [];
    for (const descriptor of files) {
      const side = view.side === "old" ? descriptor.oldSide : descriptor.newSide;
      for (const window of findRangeWindows({
        side,
        length,
        selectedTextHash: view.selectedTextHash,
        selectedTextPreview: view.selectedTextPreview,
        contextBeforeHash: view.contextBeforeHash,
        contextAfterHash: view.contextAfterHash,
      })) {
        localMatches.push({ window, descriptor });
      }
    }
    if (localMatches.length > 0) {
      return {
        state: "ambiguous",
        candidates: localMatches.slice(0, ANCHOR_MAX_CANDIDATES)
          .map(({ descriptor, window }) => rangeAnchorOf(descriptor!, view, window)),
        matchCount: localMatches.length,
      };
    }
    if (identityResolution) return identityResolution;
  }
  return identityResolution ?? { state: "stale", candidates: [] };
}

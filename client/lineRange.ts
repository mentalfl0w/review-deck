/**
 * Pure line-range selection logic for the v1.3 diff UI, kept free of React,
 * react-native and DOM imports so it can be unit-tested deterministically
 * under plain Node (see tests/line-range-selection.test.ts).
 *
 * One selection lives inside ONE rendered hunk and ONE side: the old side
 * numbers select deleted/context lines as they were, the new side numbers
 * select added/context lines as they are. The machine below is the whole
 * interaction model:
 *
 * - Desktop/web plain click on a line number: a definitive single line
 *   selection. A following Shift+click on the same side extends it from the
 *   clicked anchor; a Shift+click on the other side restarts a single-line
 *   selection there (a range never spans sides, because the two sides are
 *   different line spaces).
 * - Compact/mobile: taps never carry a modifier, so the first tap places the
 *   start and leaves the selection awaiting its end, the second tap on the
 *   same side completes the range, and any further tap restarts from scratch.
 *
 * The selection is scope-bound: a hunk or target change must clear it, which
 * is expressed as a pure key guard (`lineSelectionScopeKey` /
 * `scopedLineSelection`) instead of a render-then-clear effect, so a stale
 * range can never be observed against the new hunk even for one frame.
 */
import type { LineRangeSelection, ReviewAnchor } from "../shared/review";
import type { StringKey, TFunc } from "./i18n";
import { hunkHeaderParts } from "./diffView";

/** The diff side a line number belongs to: old numbers address the pre-change
 * file, new numbers the post-change file. */
export type LineSide = "old" | "new";

/** The live selection: `anchorLine` is the line the user first pointed at,
 * `activeLine` the line they moved to. `awaitingEnd` is the compact
 * first-tap state (start placed, end still missing). */
export type LineSelectionState = {
  side: LineSide;
  anchorLine: number;
  activeLine: number;
  awaitingEnd: boolean;
} | null;

export type LineSelectionAction =
  /** Plain desktop click on a line number. */
  | { type: "click"; side: LineSide; line: number }
  /** Compact tap on a line number: the two-tap start/end pairing. */
  | { type: "tap"; side: LineSide; line: number }
  /** Shift+click on a line number: extends the current same-side selection. */
  | { type: "extend"; side: LineSide; line: number }
  | { type: "clear" };

/** The state after one interaction. Deterministic: identical state and action
 * always produce an identical result. */
export function reduceLineSelection(
  state: LineSelectionState,
  action: LineSelectionAction,
): LineSelectionState {
  if (action.type === "clear") return null;
  // Extending keeps the existing anchor when the side matches; a different
  // side (or no selection at all) starts a fresh single line there.
  if (action.type === "extend") {
    if (state && state.side === action.side) {
      return {
        side: action.side,
        anchorLine: state.anchorLine,
        activeLine: action.line,
        awaitingEnd: false,
      };
    }
    return { side: action.side, anchorLine: action.line, activeLine: action.line, awaitingEnd: false };
  }
  // Compact second tap of the same side completes the pending range.
  if (action.type === "tap") {
    if (state && state.side === action.side && state.awaitingEnd) {
      return {
        side: action.side,
        anchorLine: state.anchorLine,
        activeLine: action.line,
        awaitingEnd: false,
      };
    }
    return { side: action.side, anchorLine: action.line, activeLine: action.line, awaitingEnd: true };
  }
  // A plain click is always definitive, even on the line the range ends on.
  return { side: action.side, anchorLine: action.line, activeLine: action.line, awaitingEnd: false };
}

/** The submit-ready range of the state, normalized so startLine <= endLine
 * (the shared schema's refine). While the compact pairing still awaits its end
 * tap it is the single-line range of the pending start, so combine it with
 * `awaitingEnd` before submitting. Null only when nothing is selected. */
export function lineSelectionRange(state: LineSelectionState): LineRangeSelection | null {
  if (!state) return null;
  return {
    side: state.side,
    startLine: Math.min(state.anchorLine, state.activeLine),
    endLine: Math.max(state.anchorLine, state.activeLine),
  };
}

/** Scope guard key: the identity a selection is allowed to live under. */
export function lineSelectionScopeKey(
  targetFingerprint: string | null | undefined,
  hunkId: string | null | undefined,
): string {
  return `${targetFingerprint ?? ""}\u0000${hunkId ?? ""}`;
}

/** The selection visible under `key`: a selection recorded under a different
 * hunk or target is already gone. */
export function scopedLineSelection(
  stored: { key: string; state: LineSelectionState },
  key: string,
): LineSelectionState {
  return stored.key === key ? stored.state : null;
}

/** True when the given line number of the given side falls inside the range. */
export function isLineSelected(
  range: LineRangeSelection | null,
  side: LineSide,
  line: number,
): boolean {
  if (!range || range.side !== side) return false;
  return line >= range.startLine && line <= range.endLine;
}

/** Shift modifier of a press event: react-native-web surfaces the DOM
 * modifier on the native event, the plain web event carries it directly.
 * Anything else (native runtimes, synthetic objects) reports false. */
export function pressShiftKey(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const candidates: unknown[] = ["nativeEvent" in event ? event.nativeEvent : undefined, event];
  return candidates.some((candidate) =>
    typeof candidate === "object" && candidate !== null && "shiftKey" in candidate && candidate.shiftKey === true);
}

/** Locale key + params for a range's text ("Lines 143–148" / "行 143–148"). */
export type LineRangeLabel =
  | { key: "lineSelectionLine"; params: { line: number } }
  | { key: "lineSelectionRange"; params: { start: number; end: number } };

export function lineSelectionLabel(range: LineRangeSelection): LineRangeLabel {
  if (range.startLine === range.endLine) {
    return { key: "lineSelectionLine", params: { line: range.startLine } };
  }
  return { key: "lineSelectionRange", params: { start: range.startLine, end: range.endLine } };
}

/** "行 143–148" — the range alone, without its side. */
export function lineSelectionText(t: TFunc, range: LineRangeSelection): string {
  const label = lineSelectionLabel(range);
  return t(label.key, label.params);
}

/** "旧" / "新" — the side of a line range. */
export function lineSelectionSideKey(side: LineSide): StringKey {
  return side === "old" ? "diffOld" : "diffNew";
}

/** "新 · 行 143–148" — the full location of a selection. */
export function lineSelectionLocationText(t: TFunc, range: LineRangeSelection): string {
  return `${t(lineSelectionSideKey(range.side))} · ${lineSelectionText(t, range)}`;
}

/** The location of a persisted anchor: a range reads as its exact lines, a
 * hunk as its header range when the hunk is still on screen (its id
 * otherwise), a file anchor as its path. */
export function anchorLocationText(
  t: TFunc,
  anchor: ReviewAnchor,
  hunkHeader?: string | null,
): string {
  if (anchor.kind === "file") return anchor.filePath;
  if (anchor.kind === "hunk") {
    return hunkHeader ? hunkHeaderParts(hunkHeader).range : anchor.hunkId;
  }
  return lineSelectionLocationText(t, anchor);
}

/** The anchor's line range, when it has one (range anchors only). */
export function anchorLineRange(anchor: ReviewAnchor): LineRangeSelection | null {
  return anchor.kind === "range"
    ? { side: anchor.side, startLine: anchor.startLine, endLine: anchor.endLine }
    : null;
}

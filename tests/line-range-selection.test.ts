/**
 * Contract test for the pure line-range selection machine in
 * client/lineRange.ts — the interaction model behind "select lines 143–148 of
 * this hunk, on this side", which the v1.3 diff UI drives from both desktop
 * (plain click + Shift+click) and compact (two-tap) input.
 *
 * Method: the module is pure and free of React/react-native/DOM imports, so
 * this test drives it under plain Node with programmatic top-level assertions
 * — no test framework, no fixtures, no timers. Its single runtime dependency
 * (./diffView) is loaded through the extensionless-import hook below, because
 * the repository's Bundler-resolution typecheck forbids ".ts" on relative
 * specifiers while Node's type stripping requires it: the runtime exports are
 * required at their real path, and the domain types come from the type-only
 * imports above (erased at runtime, checked by tsc).
 *
 * Each section pins one user-visible behavior: a plain click is a single line,
 * a Shift+click extends within the same side only, a selection always
 * serializes start <= end (the shared schema's refine would reject anything
 * else), a hunk/target change drops it, and compact taps pair start then end.
 *
 * Run: node --experimental-strip-types tests/line-range-selection.test.ts
 */
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { extname } from "node:path";
import type { LineRangeSelection } from "../shared/review";
import type {
  LineRangeLabel,
  LineSelectionAction,
  LineSelectionState,
  LineSide,
} from "../client/lineRange";

// The exact shape this test consumes: an export rename or signature drift makes
// the destructured binding unusable here, instead of failing deep inside a case.
type LineRangeModule = {
  reduceLineSelection(state: LineSelectionState, action: LineSelectionAction): LineSelectionState;
  lineSelectionRange(state: LineSelectionState): LineRangeSelection | null;
  lineSelectionScopeKey(
    targetFingerprint: string | null | undefined,
    hunkId: string | null | undefined,
  ): string;
  scopedLineSelection(
    stored: { key: string; state: LineSelectionState },
    key: string,
  ): LineSelectionState;
  isLineSelected(range: LineRangeSelection | null, side: LineSide, line: number): boolean;
  pressShiftKey(event: unknown): boolean;
  lineSelectionLabel(range: LineRangeSelection): LineRangeLabel;
};

// Production modules use bundler-style extensionless imports, which node's
// type stripping does not resolve; this test loads the real client module, so
// relative specifiers without an extension get the .ts extension here.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && extname(specifier) === "") {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

// The domain types come from the type-only imports above (erased at runtime,
// checked by tsc); the runtime values are required at their real path.
const requireFromRepo = createRequire(import.meta.url);
const {
  lineSelectionLabel,
  lineSelectionRange,
  lineSelectionScopeKey,
  isLineSelected,
  pressShiftKey,
  reduceLineSelection,
  scopedLineSelection,
} = requireFromRepo("../client/lineRange.ts") as LineRangeModule;

// The machine's state and range are both nullable by design; these helpers turn
// "expected a live selection" into a test failure at the call site instead of a
// non-null assertion scattered through every case.
function liveState(state: LineSelectionState): NonNullable<LineSelectionState> {
  assert.ok(state !== null, "expected a live line selection");
  return state;
}

function liveRange(range: LineRangeSelection | null): LineRangeSelection {
  assert.ok(range !== null, "expected a serializable line range");
  return range;
}

const click = (side: LineSide, line: number): LineSelectionState =>
  reduceLineSelection(null, { type: "click", side, line });
const extend = (state: LineSelectionState, side: LineSide, line: number): LineSelectionState =>
  reduceLineSelection(state, { type: "extend", side, line });
const tap = (state: LineSelectionState, side: LineSide, line: number): LineSelectionState =>
  reduceLineSelection(state, { type: "tap", side, line });

// ---------------------------------------------------------------------------
// 1. Desktop: a plain click on a line number selects exactly that one line.
// ---------------------------------------------------------------------------
const clicked = liveState(click("new", 143));
assert.strictEqual(clicked.awaitingEnd, false);
assert.deepStrictEqual(liveRange(lineSelectionRange(clicked)), {
  side: "new",
  startLine: 143,
  endLine: 143,
});

// ---------------------------------------------------------------------------
// 2. Desktop: Shift+click extends from the anchor in either direction and the
//    serialized range is always normalized (startLine <= endLine).
// ---------------------------------------------------------------------------
const anchoredAt143 = click("new", 143);
const extendedDown = liveState(extend(anchoredAt143, "new", 148));
assert.strictEqual(extendedDown.anchorLine, 143, "extension keeps the clicked anchor");
assert.deepStrictEqual(liveRange(lineSelectionRange(extendedDown)), {
  side: "new",
  startLine: 143,
  endLine: 148,
});

const anchoredAt148 = click("new", 148);
const extendedUp = liveState(extend(anchoredAt148, "new", 143));
assert.strictEqual(extendedUp.anchorLine, 148, "extension keeps the clicked anchor");
assert.deepStrictEqual(liveRange(lineSelectionRange(extendedUp)), {
  side: "new",
  startLine: 143,
  endLine: 148,
});

// ---------------------------------------------------------------------------
// 3. Desktop: Shift+click on the other side never extends across sides — the
//    two sides are different line spaces, so it starts there instead.
// ---------------------------------------------------------------------------
const crossedSide = liveState(extend(extendedDown, "old", 90));
assert.strictEqual(crossedSide.awaitingEnd, false);
assert.deepStrictEqual(liveRange(lineSelectionRange(crossedSide)), {
  side: "old",
  startLine: 90,
  endLine: 90,
});

// ---------------------------------------------------------------------------
// 4. Desktop: a plain click after a range collapses back to one line, and a
//    plain click on the other side switches sides.
// ---------------------------------------------------------------------------
const collapsed = liveState(reduceLineSelection(extendedUp, { type: "click", side: "new", line: 150 }));
assert.deepStrictEqual(liveRange(lineSelectionRange(collapsed)), {
  side: "new",
  startLine: 150,
  endLine: 150,
});

const switched = liveState(reduceLineSelection(collapsed, { type: "click", side: "old", line: 12 }));
assert.deepStrictEqual(liveRange(lineSelectionRange(switched)), {
  side: "old",
  startLine: 12,
  endLine: 12,
});

// ---------------------------------------------------------------------------
// 5. Compact: the first tap leaves the selection awaiting its end (still the
//    single start line), the second tap on the same side completes the range,
//    and any further tap restarts a fresh pending start.
// ---------------------------------------------------------------------------
const firstTap = liveState(tap(null, "new", 143));
assert.strictEqual(firstTap.awaitingEnd, true);
assert.deepStrictEqual(liveRange(lineSelectionRange(firstTap)), {
  side: "new",
  startLine: 143,
  endLine: 143,
});

const completed = liveState(tap(firstTap, "new", 148));
assert.strictEqual(completed.awaitingEnd, false);
assert.deepStrictEqual(liveRange(lineSelectionRange(completed)), {
  side: "new",
  startLine: 143,
  endLine: 148,
});

const restarted = liveState(tap(completed, "new", 200));
assert.strictEqual(restarted.awaitingEnd, true);
assert.deepStrictEqual(liveRange(lineSelectionRange(restarted)), {
  side: "new",
  startLine: 200,
  endLine: 200,
});

// A tap on the other side restarts there, even while the first pair is pending.
const restartedElsewhere = liveState(tap(firstTap, "old", 90));
assert.strictEqual(restartedElsewhere.side, "old");
assert.strictEqual(restartedElsewhere.awaitingEnd, true);
assert.deepStrictEqual(liveRange(lineSelectionRange(restartedElsewhere)), {
  side: "old",
  startLine: 90,
  endLine: 90,
});

// ---------------------------------------------------------------------------
// 6. Both boundary lines are selected; the lines just outside, the other side,
//    and a null range are not.
// ---------------------------------------------------------------------------
const boundaries = liveRange(
  lineSelectionRange(tap(tap(null, "new", 143), "new", 148)),
);
assert.strictEqual(isLineSelected(boundaries, "new", 143), true);
assert.strictEqual(isLineSelected(boundaries, "new", 148), true);
assert.strictEqual(isLineSelected(boundaries, "new", 142), false);
assert.strictEqual(isLineSelected(boundaries, "new", 149), false);
assert.strictEqual(isLineSelected(boundaries, "old", 145), false);
assert.strictEqual(isLineSelected(null, "new", 143), false);

// ---------------------------------------------------------------------------
// 7. Reverse-order input (tap 148 then 143; shift-click above the anchor) still
//    serializes startLine <= endLine — the shared schema's refine rejects
//    anything else, so a swapped range must be impossible.
// ---------------------------------------------------------------------------
const tappedBackwards = liveRange(lineSelectionRange(tap(tap(null, "new", 148), "new", 143)));
assert.deepStrictEqual(tappedBackwards, { side: "new", startLine: 143, endLine: 148 });

const shiftedBackwards = liveRange(lineSelectionRange(extend(click("old", 148), "old", 143)));
assert.deepStrictEqual(shiftedBackwards, { side: "old", startLine: 143, endLine: 148 });

// ---------------------------------------------------------------------------
// 8. Scope guard: the selection survives only under the identical hunk +
//    target key; a different hunk, a different target, or a null hunk drops it.
// ---------------------------------------------------------------------------
const scopeKey = lineSelectionScopeKey("sha256:target-a", "hunk-1");
const stored = { key: scopeKey, state: completed };
assert.strictEqual(scopedLineSelection(stored, scopeKey), completed);
assert.strictEqual(scopedLineSelection(stored, lineSelectionScopeKey("sha256:target-a", "hunk-2")), null);
assert.strictEqual(scopedLineSelection(stored, lineSelectionScopeKey("sha256:target-b", "hunk-1")), null);
assert.strictEqual(scopedLineSelection(stored, lineSelectionScopeKey("sha256:target-a", null)), null);

// ---------------------------------------------------------------------------
// 9. Clearing drops the selection, and clearing again is a no-op.
// ---------------------------------------------------------------------------
assert.strictEqual(reduceLineSelection(completed, { type: "clear" }), null);
assert.strictEqual(reduceLineSelection(null, { type: "clear" }), null);
assert.strictEqual(reduceLineSelection(reduceLineSelection(null, { type: "clear" }), { type: "clear" }), null);

// ---------------------------------------------------------------------------
// 10. Shift detection: react-native-web carries the DOM modifier on the native
//     event, the plain web event on the event itself, and everything else
//     (no modifier, non-objects) reports false.
// ---------------------------------------------------------------------------
assert.strictEqual(pressShiftKey({ nativeEvent: { shiftKey: true } }), true);
assert.strictEqual(pressShiftKey({ shiftKey: true }), true);
assert.strictEqual(pressShiftKey({ nativeEvent: { shiftKey: false } }), false);
assert.strictEqual(pressShiftKey({}), false);
assert.strictEqual(pressShiftKey(null), false);
assert.strictEqual(pressShiftKey(undefined), false);
assert.strictEqual(pressShiftKey("shift"), false);

// ---------------------------------------------------------------------------
// 11. The label names a single line as a line and a range as a range, with the
//     exact line numbers the visible text needs.
// ---------------------------------------------------------------------------
assert.deepStrictEqual(lineSelectionLabel({ side: "new", startLine: 143, endLine: 143 }), {
  key: "lineSelectionLine",
  params: { line: 143 },
});
assert.deepStrictEqual(lineSelectionLabel({ side: "old", startLine: 143, endLine: 148 }), {
  key: "lineSelectionRange",
  params: { start: 143, end: 148 },
});

console.log(
  "line-range-selection: click, shift-extension, side isolation, compact two-tap pairing, inclusive boundaries, ordering, scope guard, clear, shift detection, and label assertions passed.",
);

/**
 * The panel's one line-range selection: which lines, of which side, of the
 * currently selected change block are the comment target of the v1.3 diff UI.
 *
 * The state is scope-bound to (target fingerprint, hunk id) by a key guard
 * rather than by a reset effect: the moment the selection moves to another
 * change block or the Git target changes, the stored selection is already
 * unreadable, so a range drawn on the previous hunk can never leak into the
 * next one — not even for the frame before an effect would have run.
 */
import { useCallback, useMemo, useState } from "react";
import type { LineRangeSelection } from "../../shared/review";
import {
  lineSelectionRange,
  lineSelectionScopeKey,
  reduceLineSelection,
  scopedLineSelection,
  type LineSelectionAction,
  type LineSelectionState,
} from "../lineRange";

export function useLineSelection(params: { targetFingerprint: string | null; hunkId: string | null }) {
  const { targetFingerprint, hunkId } = params;
  const scopeKey = lineSelectionScopeKey(targetFingerprint, hunkId);
  const [stored, setStored] = useState<{ key: string; state: LineSelectionState }>({ key: scopeKey, state: null });
  const state = scopedLineSelection(stored, scopeKey);
  // Every interaction runs through the pure machine, checked against the
  // selection visible under the CURRENT scope key (never the raw stored one).
  const dispatch = useCallback((action: LineSelectionAction) => {
    setStored((current) => ({ key: scopeKey, state: reduceLineSelection(scopedLineSelection(current, scopeKey), action) }));
  }, [scopeKey]);
  const range = useMemo((): LineRangeSelection | null => lineSelectionRange(state), [state]);
  return { state, range, dispatch };
}

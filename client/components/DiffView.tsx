import { Pressable, Text, View } from "react-native";
import type { DiffPair, UnifiedRow } from "../diffView";
import type { DiffMode } from "../tools";
import type { TFunc } from "../i18n";
import type { PanelStyles } from "../styles";
import type { LineRangeSelection } from "../../shared/review";
import { isLineSelected, pressShiftKey, type LineSide } from "../lineRange";

/** The hunk diff body in split or unified presentation. Split keeps the old
 * per-cell line numbers; unified renders editor-style dual line-number
 * columns (old right-aligned, new left-aligned).
 *
 * Every real line number is a pressable gutter. On desktop a click selects the
 * line and Shift+click extends the range; on compact a tap places the start
 * and the next tap the end (the parent owns the machine, this view only
 * reports the press). The highlight is painted from the passed selection
 * alone: the code cells stay plain `selectable` text, so a gutter press never
 * depends on — or fights with — the browser's own text selection. */
export function DiffView({ t, styles, mode, pairs, rows, selection, compact, onLinePress, onLineTap }: {
  t: TFunc;
  styles: PanelStyles;
  mode: DiffMode;
  pairs: DiffPair[];
  rows: UnifiedRow[];
  selection: LineRangeSelection | null;
  compact: boolean;
  onLinePress: (side: LineSide, line: number, extend: boolean) => void;
  onLineTap: (side: LineSide, line: number) => void;
}) {
  // The pressable gutter owns the box (width, right padding, hit height); the
  // number inside carries only the text metrics of the passive gutter, so the
  // digits land on exactly the pixels they used to.
  const lineNoText = {
    color: styles.diffLineNo.color,
    fontFamily: styles.diffLineNo.fontFamily,
    fontSize: styles.diffLineNo.fontSize,
    lineHeight: styles.diffLineNo.lineHeight,
    textAlign: styles.diffLineNo.textAlign,
  };
  // One line-number gutter: a real number is pressable and reports the press
  // semantics of the current layout, an absent one (null) is the unchanged
  // spacer so both columns stay aligned.
  const lineNo = (side: LineSide, line: number) => {
    const selected = isLineSelected(selection, side, line);
    return (
      <Pressable
        accessibilityRole="button"
        style={[styles.diffLineNoPress, selected ? styles.diffLineNoSelected : null]}
        onPress={(event) => {
          if (compact) onLineTap(side, line);
          else onLinePress(side, line, pressShiftKey(event));
        }}
      >
        <Text style={selected ? [lineNoText, styles.diffLineNoSelectedText] : lineNoText}>{line}</Text>
      </Pressable>
    );
  };
  if (mode === "split") {
    return (
      <View style={styles.diffBox}>
        <View style={{ flexDirection: "row" }}>
          <View style={[styles.diffColHeader, styles.diffCellLeft, { flex: 1 }]}>
            <Text style={styles.diffColHeaderText}>{t("diffOld")}</Text>
          </View>
          <View style={[styles.diffColHeader, { flex: 1 }]}>
            <Text style={styles.diffColHeaderText}>{t("diffNew")}</Text>
          </View>
        </View>
        {pairs.map((pair, index) => (
          <View key={index} style={styles.diffRow}>
            <View style={[
              styles.diffCell,
              styles.diffCellLeft,
              pair.old === null ? styles.diffCellEmpty : pair.old.kind === "del" ? styles.diffCellDel : pair.old.kind === "add" ? styles.diffCellAdd : styles.diffCellContext,
            ]}>
              {pair.old ? (
                <View style={styles.diffCellInner}>
                  {lineNo("old", pair.old.lineNo)}
                  <Text selectable style={styles.diffCode}>{pair.old.content || "\u00A0"}</Text>
                </View>
              ) : null}
            </View>
            <View style={[
              styles.diffCell,
              pair.new === null ? styles.diffCellEmpty : pair.new.kind === "add" ? styles.diffCellAdd : pair.new.kind === "del" ? styles.diffCellDel : styles.diffCellContext,
            ]}>
              {pair.new ? (
                <View style={styles.diffCellInner}>
                  {lineNo("new", pair.new.lineNo)}
                  <Text selectable style={styles.diffCode}>{pair.new.content || "\u00A0"}</Text>
                </View>
              ) : null}
            </View>
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={styles.diffBox}>
      {rows.map((row, index) => (
        <View key={index} style={[
          styles.diffRow,
          row.kind === "add" ? styles.diffRowAdd : row.kind === "del" ? styles.diffRowDel : null,
        ]}>
          {row.oldNo === null ? <Text style={styles.diffLineNo}>{""}</Text> : lineNo("old", row.oldNo)}
          {row.newNo === null ? <Text style={styles.diffLineNo}>{""}</Text> : lineNo("new", row.newNo)}
          <Text style={[styles.diffSign, row.sign === "+" ? styles.diffSignAdd : row.sign === "-" ? styles.diffSignDel : styles.diffSignContext]}>{row.sign}</Text>
          <Text selectable style={styles.diffCode}>{row.content || "\u00A0"}</Text>
        </View>
      ))}
    </View>
  );
}

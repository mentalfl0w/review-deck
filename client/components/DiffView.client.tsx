import { Text, View } from "react-native";
import type { DiffPair, UnifiedRow } from "../diffView.client";
import type { DiffMode } from "../tools.client";
import type { TFunc } from "../i18n.client";
import type { PanelStyles } from "../styles.client";

/** The hunk diff body in split or unified presentation. Split keeps the old
 * per-cell line numbers; unified renders editor-style dual line-number
 * columns (old right-aligned, new left-aligned). */
export function DiffView({ t, styles, mode, pairs, rows }: {
  t: TFunc;
  styles: PanelStyles;
  mode: DiffMode;
  pairs: DiffPair[];
  rows: UnifiedRow[];
}) {
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
                  <Text style={styles.diffLineNo}>{pair.old.lineNo}</Text>
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
                  <Text style={styles.diffLineNo}>{pair.new.lineNo}</Text>
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
          <Text style={styles.diffLineNo}>{row.oldNo ?? ""}</Text>
          <Text style={styles.diffLineNo}>{row.newNo ?? ""}</Text>
          <Text style={[styles.diffSign, row.sign === "+" ? styles.diffSignAdd : row.sign === "-" ? styles.diffSignDel : styles.diffSignContext]}>{row.sign}</Text>
          <Text selectable style={styles.diffCode}>{row.content || "\u00A0"}</Text>
        </View>
      ))}
    </View>
  );
}

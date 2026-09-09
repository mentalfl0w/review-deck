import { Text, View } from "react-native";
import type { FileViewResult } from "../tools";
import type { TFunc } from "../i18n";
import type { PanelStyles } from "../styles";

/** Whole-file view rendered from the getFileView RPC: unified-style rows with
 * a single line-number column (del rows show oldLine, others show newLine,
 * null renders a blank placeholder), the current hunk's region highlighted,
 * add/del/context coloration, and binary/truncated/loading/error states
 * degrading to notice rows. */
export function FileView({ t, styles, result, loading, error, selectedHunkId }: {
  t: TFunc;
  styles: PanelStyles;
  result: FileViewResult | null;
  loading: boolean;
  error: string | null;
  selectedHunkId: string | null;
}) {
  if (error) {
    return (
      <View style={styles.errorCard}>
        <Text style={styles.errorText}>{t("fileViewError")}</Text>
      </View>
    );
  }
  if (!result) {
    if (!loading) return null;
    return <Text style={styles.muted}>{t("fileViewLoading")}</Text>;
  }
  return (
    <View style={{ gap: 8 }}>
      {result.binary || result.truncated ? (
        <View style={styles.fileViewNotice}>
          {result.binary ? <Text style={styles.fileViewNoticeText}>{t("fileViewBinary")}</Text> : null}
          {result.truncated ? <Text style={styles.fileViewNoticeText}>{t("fileViewTruncated")}</Text> : null}
        </View>
      ) : null}
      <View style={styles.diffBox}>
        {result.rows.map((row, index) => {
          const active = row.hunkId !== null && row.hunkId === selectedHunkId;
          const lineNo = row.kind === "del" ? (row.oldLine ?? null) : (row.newLine ?? null);
          return (
            <View key={index} style={[
              styles.diffRow,
              row.kind === "add" ? styles.fileViewRowAdd : row.kind === "del" ? styles.fileViewRowDel : styles.fileViewRowContext,
              active ? [styles.fileViewRowActive, row.kind === "del" ? styles.fileViewRowActiveDel : row.kind === "add" ? styles.fileViewRowActiveAdd : styles.fileViewRowActiveContext] : null,
            ]}>
              <Text style={styles.diffLineNo}>{lineNo ?? ""}</Text>
              <Text style={[
                styles.diffSign,
                row.kind === "add" ? styles.diffSignAdd : row.kind === "del" ? styles.diffSignDel : styles.diffSignContext,
              ]}>{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</Text>
              <Text selectable style={[
                styles.diffCode,
                row.kind === "del" ? styles.fileViewDelText : null,
              ]}>{row.text || "\u00A0"}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

import { Pressable, Text, View } from "react-native";
import type { ReviewAnchor, ReviewAnchorIssue } from "../../shared/review";
import { anchorLocationText, lineSelectionLocationText } from "../lineRange";
import {
  anchorStateBadgeKeys,
  anchorStateBadgeTextKeys,
  anchorStateLabelKeys,
  type PanelLayout,
  type PanelTheme,
} from "../tools";
import type { TFunc } from "../i18n";
import type { PanelStyles } from "../styles";
import { ActionButton } from "./ui";

/** The v1.3 re-anchor card: saved comments whose persisted anchor no longer
 * resolves against the current snapshot (ambiguous | stale), the candidate
 * positions the anchor resolver detected, and the two manual escapes — jump to
 * a candidate and re-anchor there, or re-anchor onto the live line selection in
 * the diff above.
 *
 * The card is deliberately write-free: every affordance reports intent through
 * a callback, because the pid/comment-file mutation lives in the panel owner
 * (one place, one lock, `busyIssueId` showing which issue is in flight).
 *
 * A candidate may point at a hunk the current snapshot no longer contains
 * (`hunkLabels` has no entry). It stays visible — the user needs to see that
 * position *existed* — but its re-anchor button is disabled: anchoring onto
 * geometry that is gone would silently persist a lie. The disabled reasons are
 * carried as tooltips so the button never fails without saying why.
 *
 * The parent has already filtered `issues` to `selectedFilePath` and already
 * decided whether the live selection belongs to that file; the component only
 * checks that *some* hunk is selected (`selectionHunkId`), never the file
 * policy. */
export function AnchorIssues({ theme, layout, t, styles, issues, hunkLabels, selectedFilePath, selectionHunkId, selectionLabel, selectionPending, busyIssueId, notice, onSelectCandidate, onReanchor }: {
  theme: PanelTheme;
  layout: PanelLayout;
  t: TFunc;
  styles: PanelStyles;
  issues: ReviewAnchorIssue[];
  hunkLabels: Record<string, string>;
  selectedFilePath: string;
  selectionHunkId: string | null;
  selectionLabel: string | null;
  selectionPending: boolean;
  busyIssueId: string | null;
  notice: string | null;
  onSelectCandidate: (issue: ReviewAnchorIssue, candidate: ReviewAnchor) => void;
  onReanchor: (issue: ReviewAnchorIssue, candidate: ReviewAnchor | null) => void;
}) {
  // A healed last issue empties the card, but its confirmation still has to
  // render: the notice is the only visible proof the re-anchor write landed.
  if (issues.length === 0) return notice === null ? null : <Text style={styles.feedbackSent}>✓ {notice}</Text>;
  return (
    <View style={styles.anchorIssuesCard}>
      <View style={{ gap: 2 }}>
        <Text style={styles.sectionTitle}>{t("anchorIssuesTitle")}</Text>
        <Text style={styles.sectionSummary}>{t("anchorIssuesSummary", { count: issues.length })}</Text>
      </View>
      {issues.map((issue) => {
        // The hunk the anchor came from: a hunk anchor names it directly, a
        // range anchor still remembers the block it was selected in. The label
        // is only rendered when that block survived into this snapshot.
        const anchorHunkId = issue.anchor.kind === "hunk" ? issue.anchor.hunkId : issue.sourceHunkId;
        const anchorHunkHeader = hunkLabels[anchorHunkId] ?? null;
        const needsLineSelection = issue.anchor.kind === "range";
        const selectionUnavailable = selectionHunkId === null || selectionPending ||
          (needsLineSelection && selectionLabel === null);
        const busy = busyIssueId === issue.id;
        return (
          <View key={issue.id} style={styles.anchorIssueRow}>
            <View style={styles.anchorIssueHeader}>
              <Text style={styles.anchorIssueWarning}>{t("anchorIssueWarning")}</Text>
              {/* Ambiguous and stale share the danger tone but keep separate
               * surfaces and wording: ambiguous means several equally good
               * positions were found (recovery is possible), stale means none
               * was (only the live selection is left). */}
              <View style={[styles.anchorStateBadge, styles[anchorStateBadgeKeys[issue.anchorState]]]}>
                <Text style={[styles.anchorStateBadgeText, styles[anchorStateBadgeTextKeys[issue.anchorState]]]}>
                  {t(anchorStateLabelKeys[issue.anchorState])}
                </Text>
              </View>
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Text selectable style={styles.anchorMeta}>
                {t("anchorIssueOriginal", { anchor: anchorLocationText(t, issue.anchor, anchorHunkHeader) })}
              </Text>
              <Text style={styles.routeMeta}>{t("fileCommentSavedAt", { savedAt: issue.savedAt })}</Text>
            </View>

            {/* The comment text is preserved verbatim: what the user wrote is
             * the only thing they can compare the candidates against. */}
            <View style={styles.anchorIssueComment}>
              <Text selectable numberOfLines={3} style={styles.body}>{issue.comment}</Text>
            </View>

            {issue.candidates.length > 0 ? (
              <>
                <Text style={styles.anchorMeta}>
                  {t("anchorIssueCandidates", { count: Math.max(issue.matchCount, issue.candidates.length) })}
                </Text>
                {issue.matchCount > issue.candidates.length ? (
                  <Text style={styles.muted}>{t("anchorIssueOutsideReviewableHunks", { count: issue.candidates.length })}</Text>
                ) : null}
                {issue.candidates.map((candidate, index) => {
                  const candidateHeader = hunkLabels[candidate.hunkId];
                  const candidateMissing = candidateHeader === undefined;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      key={`${candidate.kind}-${candidate.hunkId}-${index}`}
                      onPress={() => onSelectCandidate(issue, candidate)}
                      style={[styles.anchorCandidateRow, candidate.hunkId === selectionHunkId ? styles.anchorCandidateRowActive : null]}
                    >
                      <Text style={styles.anchorMeta}>
                        {t("anchorIssueCandidate", { index: index + 1 })} · {candidate.kind === "hunk"
                          ? candidateHeader ?? candidate.hunkId
                          : lineSelectionLocationText(t, candidate)}
                      </Text>
                      <ActionButton
                        variant="secondary"
                        label={t("reanchorHere")}
                        disabled={candidateMissing || busyIssueId !== null}
                        tooltip={candidateMissing ? t("reanchorCandidateMissingHint") : t("reanchorHere")}
                        onPress={() => onReanchor(issue, candidate)}
                        theme={theme}
                        layout={layout}
                      />
                    </Pressable>
                  );
                })}
              </>
            ) : (
              <Text style={styles.muted}>
                {issue.anchorState === "stale"
                  ? issue.matchCount > 0
                    ? t("anchorIssueFoundOutsideHunks", { count: issue.matchCount })
                    : t("anchorIssueStale")
                  : t("anchorIssueAmbiguousNoCandidate")}
              </Text>
            )}

            {/* The live target spelled out: "current selection" is only
             * meaningful next to the path and lines it points at, so the user
             * never re-anchors blind. Absent when nothing is selected — the
             * disabled button plus its tooltip already say that. */}
            {selectionLabel !== null ? (
              <Text numberOfLines={1} ellipsizeMode="middle" style={styles.anchorMeta}>
                {t("commentTargetTitle", { file: selectedFilePath, location: selectionLabel })}
              </Text>
            ) : null}

            <ActionButton
              variant="primary"
              label={t("reanchorToSelection")}
              disabled={busyIssueId !== null || selectionUnavailable}
              tooltip={selectionUnavailable ? t("reanchorNoSelectionHint") : t("reanchorToSelection")}
              onPress={() => onReanchor(issue, null)}
              theme={theme}
              layout={layout}
            />

            {busy ? <Text style={styles.statusText}>{t("reanchorBusy")}</Text> : null}
          </View>
        );
      })}
      {notice !== null ? <Text style={styles.feedbackSent}>✓ {notice}</Text> : null}
    </View>
  );
}

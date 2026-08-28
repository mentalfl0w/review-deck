import { useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin";
import { getFileView } from "../../review.shared";
import type { ReviewScope, ReviewSnapshot } from "../../review.shared";
import type { FileViewResult, ReviewFile } from "../tools.client";

/**
 * Whole-file view data: fetches the getFileView RPC for the selected file
 * while the panel is in a file-view mode (block file view or full changes
 * view). Every re-run (mode switch, fingerprint / scope / selected-file
 * change) supersedes in-flight responses via the monotonic run guard;
 * failures degrade to an error row instead of a crash.
 */
export function useFileView(params: {
  reviewCwd: string | null;
  scope: ReviewScope;
  baseRef: string;
  selectedHunkId: string | null;
  headRef: string;
  snapshot: ReviewSnapshot | null;
  selectedFile: ReviewFile | null;
  enabled: boolean;
  fullChanges: boolean;
}) {
  const { reviewCwd, scope, baseRef, headRef, snapshot, selectedFile, selectedHunkId, enabled, fullChanges } = params;
  const fileViewRpc = useRpc(getFileView);
  const [result, setResult] = useState<FileViewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic guard: any newer effect run (mode switch or refetch) supersedes
  // earlier in-flight responses, so a stale file view never lands out of order.
  const fileViewRunRef = useRef(0);
  // In full-changes mode the payload does not depend on the selected hunk, so
  // selection changes must not re-trigger the fetch.
  const focusedHunkId = fullChanges ? null : selectedHunkId;

  useEffect(() => {
    const run = ++fileViewRunRef.current;
    if (!enabled || !reviewCwd || !snapshot || !selectedFile) {
      setResult(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    (async () => {
      // Full changes view overlays every change block of the selected file;
      // block file view embeds exactly the selected hunk — other change
      // blocks of the same file render as plain resolved content
      // (expand-context semantics).
      let hunks: Array<{ hunkId: string; filePath: string; hunkHeader: string; hunkPatch: string }> | null;
      if (fullChanges) {
        hunks = selectedFile.hunks.map((hunk) => ({
          hunkId: hunk.id,
          filePath: selectedFile.path,
          hunkHeader: hunk.header,
          hunkPatch: hunk.patch,
        }));
      } else {
        const focused = selectedFile.hunks.find((hunk) => hunk.id === focusedHunkId);
        hunks = focused
          ? [
              {
                hunkId: focused.id,
                filePath: selectedFile.path,
                hunkHeader: focused.header,
                hunkPatch: focused.patch,
              },
            ]
          : null;
      }
      if (!hunks) {
        setResult(null);
        setLoading(false);
        setError(null);
        return;
      }
      try {
        const next = await fileViewRpc({
          cwd: reviewCwd,
          scope,
          ...(scope === "commits" ? { baseRef, headRef } : {}),
          filePath: selectedFile.path,
          targetFingerprint: snapshot.targetFingerprint,
          hunks,
        });
        if (run !== fileViewRunRef.current) return;
        setResult(next);
      } catch (error) {
        if (run !== fileViewRunRef.current) return;
        setError(error instanceof Error ? error.message : String(error));
        setResult(null);
      } finally {
        if (run === fileViewRunRef.current) setLoading(false);
      }
    })();
  }, [baseRef, enabled, fileViewRpc, focusedHunkId, fullChanges, headRef, reviewCwd, scope, selectedFile, snapshot]);

  return { result, loading, error };
}

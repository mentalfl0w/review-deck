/**
 * Project review-comment counts for the native entry points (workspace header
 * button labels, agent composer pills).
 *
 * Counts are project-scoped, exactly like the queue the panel shows, and are
 * the ONLY thing the entry points ever fetch: the badge is fed by the
 * count-only `review-deck.project-review-comment-count` RPC and by the
 * panel's own project-comment reads, never by a diff/snapshot request. A
 * failed count fetch leaves the last known count in place — a badge must never
 * disturb or block the review surface.
 *
 * Counts are shared across workspaces: two workspaces of one project show the
 * same badge, and a comment saved through any panel is visible to all of them
 * through the same store.
 */

export type ReviewCountFetcher = (projectId: string) => Promise<number>;

export type ReviewCountSnapshot = {
  readonly revision: number;
  readonly counts: ReadonlyMap<string, number>;
};

export type ReviewCountStore = {
  getSnapshot(): ReviewCountSnapshot;
  subscribe(listener: () => void): () => void;
  getCount(projectId: string): number | null;
  /**
   * Records an authoritative count the plugin just read itself (the panel's
   * project-comment refresh): no RPC, and any fetch already in flight for that
   * project is superseded so a slower response cannot undo the newer count.
   */
  setCount(projectId: string, commentCount: number): void;
  refresh(projectId: string): Promise<void>;
  refreshMany(projectIds: Iterable<string>): Promise<void>;
  /** Connects the count RPC; null detaches it on plugin teardown. */
  bindFetcher(fetcher: ReviewCountFetcher | null): void;
};

const EMPTY_COUNTS: ReadonlyMap<string, number> = new Map();

export function createReviewCountStore(): ReviewCountStore {
  const listeners = new Set<() => void>();
  let counts: Map<string, number> = new Map();
  let snapshot: ReviewCountSnapshot = { revision: 0, counts: EMPTY_COUNTS };
  const inFlight = new Map<string, Promise<void>>();
  // Per-project generation of the last local write: a fetch that started
  // before a local write must not land on top of it.
  const writes = new Map<string, number>();
  let fetcher: ReviewCountFetcher | null = null;

  const publish = (next: Map<string, number>): void => {
    counts = next;
    snapshot = { revision: snapshot.revision + 1, counts: next };
    for (const listener of [...listeners]) listener();
  };

  const applyCount = (projectId: string, commentCount: number): void => {
    if (!projectId) return;
    const normalized = Math.max(0, Math.trunc(commentCount));
    if (counts.get(projectId) === normalized) return;
    const next = new Map(counts);
    next.set(projectId, normalized);
    publish(next);
  };

  const refresh = (projectId: string): Promise<void> => {
    const active = inFlight.get(projectId);
    if (active) return active;
    if (!projectId || !fetcher) return Promise.resolve();
    const current = fetcher;
    const stamp = writes.get(projectId) ?? 0;
    const run = current(projectId).then(
      (commentCount) => {
        if (fetcher !== current) return;
        if ((writes.get(projectId) ?? 0) !== stamp) return;
        applyCount(projectId, commentCount);
      },
      () => {
        // Keep the last known count; the next event or panel refresh retries.
      },
    ).finally(() => {
      if (inFlight.get(projectId) === run) inFlight.delete(projectId);
    });
    inFlight.set(projectId, run);
    return run;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getCount: (projectId) => counts.get(projectId) ?? null,
    setCount: (projectId, commentCount) => {
      if (!projectId) return;
      writes.set(projectId, (writes.get(projectId) ?? 0) + 1);
      applyCount(projectId, commentCount);
    },
    refresh,
    refreshMany: async (projectIds) => {
      await Promise.all([...projectIds].map((projectId) => refresh(projectId)));
    },
    bindFetcher: (next) => {
      if (fetcher === next) return;
      fetcher = next;
      // A request from an unloaded plugin instance must not suppress the
      // replacement instance's first badge fetch.
      inFlight.clear();
    },
  };
}

let shared: ReviewCountStore | null = null;

/**
 * The plugin-wide count cache. Panels publish into it, entry points read it,
 * and the client contribution binds the count-only RPC to it — a plugin reload
 * simply re-binds a fresh fetcher.
 */
export function getReviewCountStore(): ReviewCountStore {
  if (!shared) shared = createReviewCountStore();
  return shared;
}

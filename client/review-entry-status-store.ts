import type { ReviewWorkspaceIndicators } from "../shared/review-activity";

export type ReviewEntryStatusFetcher = (workspaceId: string) => Promise<ReviewWorkspaceIndicators>;

export type ReviewEntryStatusSnapshot = {
  readonly revision: number;
  readonly statuses: ReadonlyMap<string, ReviewWorkspaceIndicators>;
};

export type ReviewEntryStatusStore = {
  getSnapshot(): ReviewEntryStatusSnapshot;
  subscribe(listener: () => void): () => void;
  getStatus(workspaceId: string): ReviewWorkspaceIndicators | null;
  setStatus(workspaceId: string, status: ReviewWorkspaceIndicators): void;
  refresh(workspaceId: string): Promise<void>;
  refreshMany(workspaceIds: Iterable<string>): Promise<void>;
  bindFetcher(fetcher: ReviewEntryStatusFetcher | null): void;
};

const EMPTY_STATUSES: ReadonlyMap<string, ReviewWorkspaceIndicators> = new Map();

export function createReviewEntryStatusStore(): ReviewEntryStatusStore {
  const listeners = new Set<() => void>();
  let statuses = new Map<string, ReviewWorkspaceIndicators>();
  let snapshot: ReviewEntryStatusSnapshot = { revision: 0, statuses: EMPTY_STATUSES };
  const inFlight = new Map<string, Promise<void>>();
  const writes = new Map<string, number>();
  let fetcher: ReviewEntryStatusFetcher | null = null;

  const equal = (left: ReviewWorkspaceIndicators | undefined, right: ReviewWorkspaceIndicators): boolean =>
    left !== undefined &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.projectPendingCommentCount === right.projectPendingCommentCount &&
    left.projectStaleCommentCount === right.projectStaleCommentCount &&
    left.workspacePendingCommentCount === right.workspacePendingCommentCount &&
    left.workspaceStaleCommentCount === right.workspaceStaleCommentCount &&
    left.activeBatchCount === right.activeBatchCount &&
    left.runningAiReviewCount === right.runningAiReviewCount &&
    left.unreadAiFindingCount === right.unreadAiFindingCount;

  const publish = (next: Map<string, ReviewWorkspaceIndicators>): void => {
    statuses = next;
    snapshot = { revision: snapshot.revision + 1, statuses: next };
    for (const listener of [...listeners]) listener();
  };

  const apply = (workspaceId: string, status: ReviewWorkspaceIndicators): void => {
    if (!workspaceId || status.workspaceId !== workspaceId || equal(statuses.get(workspaceId), status)) return;
    const next = new Map(statuses);
    next.set(workspaceId, status);
    publish(next);
  };

  const refresh = (workspaceId: string): Promise<void> => {
    const active = inFlight.get(workspaceId);
    if (active) return active;
    if (!workspaceId || !fetcher) return Promise.resolve();
    const currentFetcher = fetcher;
    const stamp = writes.get(workspaceId) ?? 0;
    const run = currentFetcher(workspaceId).then(
      (status) => {
        if (fetcher !== currentFetcher || (writes.get(workspaceId) ?? 0) !== stamp) return;
        apply(workspaceId, status);
      },
      () => {
        // Keep the last known indicators; the next host update or panel open retries.
      },
    ).finally(() => {
      if (inFlight.get(workspaceId) === run) inFlight.delete(workspaceId);
    });
    inFlight.set(workspaceId, run);
    return run;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getStatus: (workspaceId) => statuses.get(workspaceId) ?? null,
    setStatus: (workspaceId, status) => {
      if (!workspaceId || status.workspaceId !== workspaceId) return;
      writes.set(workspaceId, (writes.get(workspaceId) ?? 0) + 1);
      apply(workspaceId, status);
    },
    refresh,
    refreshMany: async (workspaceIds) => {
      await Promise.all([...new Set(workspaceIds)].map((workspaceId) => refresh(workspaceId)));
    },
    bindFetcher: (next) => {
      if (fetcher === next) return;
      fetcher = next;
      // A fetch started by a previous plugin entry must not suppress a new bind.
      inFlight.clear();
    },
  };
}

let shared: ReviewEntryStatusStore | null = null;

export function getReviewEntryStatusStore(): ReviewEntryStatusStore {
  if (!shared) shared = createReviewEntryStatusStore();
  return shared;
}

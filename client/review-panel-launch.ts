import { useSyncExternalStore } from "react";

export type ReviewPanelLaunchAction = "deck" | "queue" | "targeted";
export type ReviewPanelLaunchInput = {
  workspaceId: string;
  action: ReviewPanelLaunchAction;
  preferredAgentId?: string | null;
  location?: "workspace" | "explorer";
};
export type ReviewPanelLaunchRequest = ReviewPanelLaunchInput & {
  requestId: number;
  preferredAgentId: string | null;
};
export type ReviewPanelOpener = (panelId: string, options?: { location?: "workspace" | "explorer" }) => void;

const requests = new Map<string, ReviewPanelLaunchRequest>();
const listeners = new Set<() => void>();
let nextRequestId = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

export function requestReviewPanelLaunch(input: ReviewPanelLaunchInput): ReviewPanelLaunchRequest {
  const request: ReviewPanelLaunchRequest = {
    requestId: ++nextRequestId,
    workspaceId: input.workspaceId,
    action: input.action,
    preferredAgentId: input.preferredAgentId ?? null,
    ...(input.location ? { location: input.location } : {}),
  };
  requests.set(input.workspaceId, request);
  notify();
  return request;
}

export function getReviewPanelLaunch(workspaceId: string): ReviewPanelLaunchRequest | null {
  return requests.get(workspaceId) ?? null;
}

export function useReviewPanelLaunch(workspaceId: string): ReviewPanelLaunchRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getReviewPanelLaunch(workspaceId),
    () => null,
  );
}

export function consumeReviewPanelLaunch(workspaceId: string, requestId: number): void {
  if (requests.get(workspaceId)?.requestId !== requestId) return;
  requests.delete(workspaceId);
  notify();
}

export function clearReviewPanelLaunches(): void {
  if (requests.size === 0) return;
  requests.clear();
  notify();
}

/** Route every Review Deck action to the one deterministic workspace panel target. */
export function openReviewPanelInWorkspace(
  input: ReviewPanelLaunchInput,
  openPanel: ReviewPanelOpener,
): ReviewPanelLaunchRequest {
  const request = requestReviewPanelLaunch(input);
  openPanel("review-deck", { location: input.location ?? "workspace" });
  return request;
}

import type {
  PaseoApi,
  PaseoWorkspace,
  PaseoWorkspaceListResult,
} from "@getpaseo/client";
import type {
  PluginButtonRegistration,
  PluginClientOpenPanelOptions,
  PluginComposerPillContribution,
  PluginHeaderButtonContribution,
} from "@getpaseo/plugin/client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { openOwnedEntries, USABLE_AGENT_STATUSES, type AgentRegistry, type OwnedEntriesGateOptions } from "./agent-registry";
import type { ReviewCountStore } from "./review-count-store";

/**
 * Native Review Deck entry points:
 *
 * - one workspace header button per workspace,
 * - one composer pill per live agent.
 *
 * Both are driven by owned subscriptions — the shared agent registry and one
 * workspace list — so they appear and disappear with the host's real state
 * instead of a mount-time list. Labels show `Review` or `Review · N`, where N
 * is the project's pending-comment count read from the count-only store: this
 * module has no diff/snapshot RPC at all, so rendering a badge can never parse
 * Git.
 *
 * A click opens the same panels the command center opens: the workspace panel
 * for a header button, the agent-context panel for a pill. A pill requires a
 * workspace id by contract, so agents that name no workspace are skipped
 * (their composer has no workspace-bound Review surface to open).
 * An unreachable workspace list is retried in a bounded burst and, once that
 * burst is spent, re-armed at the retry policy's tail delay, so the headers
 * recover once the daemon answers again.
 * Every registration is removed on stop(), and a stop() racing the workspace
 * bootstrap leaves no subscription behind.
 */

const WORKSPACE_PANEL_ID = "review-deck";
const AGENT_PANEL_ID = "review-deck-agent";
const BUTTON_ICON = "ScanSearch";

/** The parts of PluginClientContext the entry points need (a structural seam
 * for tests; the real context satisfies it). */
export type ReviewEntryHost = {
  addHeaderButton(contribution: PluginHeaderButtonContribution): PluginButtonRegistration;
  addComposerPill(contribution: PluginComposerPillContribution): PluginButtonRegistration;
  openPanel(id: string, options: PluginClientOpenPanelOptions): void;
};

type Entry = {
  /** The project the badge counts; null until the workspace list resolves it. */
  projectId: string | null;
  label: string;
  registration: PluginButtonRegistration;
};

export type ReviewEntriesOptions = {
  client: ReviewEntryHost;
  paseo: PaseoApi;
  registry: AgentRegistry;
  counts: ReviewCountStore;
  /** Test seams for the workspace bootstrap; production uses the defaults. */
  retryDelaysMs?: readonly number[];
  schedule?: OwnedEntriesGateOptions<PaseoWorkspaceListResult>["schedule"];
};

export type ReviewEntries = { stop(): void };

/** Badge text: pending comments only, and no `Review · 0` noise. */
function reviewLabel(commentCount: number | null): string {
  return commentCount === null || commentCount <= 0 ? "Review" : `Review · ${commentCount}`;
}

/** Tail of the registry bootstrap backoff (agent-registry: 250→15000 ms), the
 * fallback cadence for the post-exhaustion re-arm. */
const RECOVERY_TAIL_DELAY_MS = 15000;

/** Production timer for the post-exhaustion re-arm: the same seam shape the
 * registry gate exposes, whose own default is module-private there. */
const defaultSchedule: NonNullable<ReviewEntriesOptions["schedule"]> = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

export function registerReviewEntries(options: ReviewEntriesOptions): ReviewEntries {
  const { client, paseo, registry, counts } = options;
  const headers = new Map<string, Entry>();
  const pills = new Map<string, Entry>();
  // Projects whose badge must stay fresh for the app's lifetime: refreshed
  // when first seen and again after every registry re-bootstrap (reconnect).
  const trackedProjects = new Set<string>();
  const workspaces = new Map<string, PaseoWorkspace>();
  let lastBootstraps = registry.getSnapshot().bootstraps;
  let stopped = false;

  const trackProject = (projectId: string | null): void => {
    if (!projectId || trackedProjects.has(projectId)) return;
    trackedProjects.add(projectId);
    void counts.refresh(projectId);
  };

  const applyLabels = (): void => {
    for (const entry of [...headers.values(), ...pills.values()]) {
      const next = reviewLabel(entry.projectId ? counts.getCount(entry.projectId) : null);
      if (next === entry.label) continue;
      entry.label = next;
      entry.registration.update({ title: next, label: next });
    }
  };

  const syncHeaders = (): void => {
    if (stopped) return;
    const wanted = new Map<string, string>();
    for (const workspace of workspaces.values()) {
      if (workspace.archivingAt) continue;
      // Same project key the panel derives for its queue.
      wanted.set(workspace.id, workspace.projectId || workspace.id);
    }
    for (const [workspaceId, entry] of [...headers]) {
      if (wanted.has(workspaceId)) continue;
      entry.registration.remove();
      headers.delete(workspaceId);
    }
    for (const [workspaceId, projectId] of wanted) {
      const existing = headers.get(workspaceId);
      if (existing) {
        if (existing.projectId !== projectId) {
          existing.projectId = projectId;
          trackProject(projectId);
        }
        continue;
      }
      const label = reviewLabel(counts.getCount(projectId));
      headers.set(workspaceId, {
        projectId,
        label,
        registration: client.addHeaderButton({
          id: `review-header-${workspaceId}`,
          workspaceId,
          button: {
            title: label,
            label,
            icon: BUTTON_ICON,
            behavior: {
              kind: "action",
              onPress: () => client.openPanel(WORKSPACE_PANEL_ID, { workspaceId }),
            },
          },
        }),
      });
      trackProject(projectId);
    }
    applyLabels();
  };

  const syncPills = (): void => {
    if (stopped) return;
    const wanted = new Map<string, { workspaceId: string; projectId: string | null }>();
    for (const agent of registry.getSnapshot().agents) {
      if (agent.archived || !agent.workspaceId || USABLE_AGENT_STATUSES[agent.status] !== true) continue;
      const workspace = workspaces.get(agent.workspaceId);
      wanted.set(agent.id, {
        workspaceId: agent.workspaceId,
        // Same project key the panel derives for its queue: the workspace's
        // project id, with the agent's own placement covering the window
        // before the workspace list arrives.
        projectId: workspace ? workspace.projectId || agent.workspaceId : agent.projectKey,
      });
    }
    for (const [agentId, entry] of [...pills]) {
      if (wanted.has(agentId)) continue;
      entry.registration.remove();
      pills.delete(agentId);
    }
    for (const [agentId, want] of wanted) {
      const existing = pills.get(agentId);
      if (existing) {
        if (existing.projectId !== want.projectId) {
          existing.projectId = want.projectId;
          trackProject(want.projectId);
        }
        continue;
      }
      const label = reviewLabel(want.projectId ? counts.getCount(want.projectId) : null);
      pills.set(agentId, {
        projectId: want.projectId,
        label,
        registration: client.addComposerPill({
          id: `review-pill-${agentId}`,
          workspaceId: want.workspaceId,
          agentId,
          button: {
            title: label,
            label,
            icon: BUTTON_ICON,
            behavior: {
              kind: "action",
              onPress: () => client.openPanel(AGENT_PANEL_ID, { workspaceId: want.workspaceId, agentId }),
            },
          },
        }),
      });
      trackProject(want.projectId);
    }
    applyLabels();
  };

  const replaceWorkspaces = (entries: Iterable<PaseoWorkspace>): void => {
    workspaces.clear();
    for (const entry of entries) workspaces.set(entry.id, entry);
    syncHeaders();
    syncPills();
  };

  const handleWorkspaceMessage = (message: SessionOutboundMessage): void => {
    if (message.type === "workspace_update") {
      const payload = message.payload;
      if (payload.kind === "upsert") workspaces.set(payload.workspace.id, payload.workspace);
      else workspaces.delete(payload.id);
      syncHeaders();
      syncPills();
      return;
    }
    if (message.type === "fetch_workspaces_response") {
      const payload = message.payload;
      // A change delta is merged; anything else is a complete snapshot.
      if (payload.sync?.mode === "changes") {
        for (const entry of payload.entries) workspaces.set(entry.id, entry);
        for (const removal of payload.sync.removals) workspaces.delete(removal.id);
        syncHeaders();
        syncPills();
        return;
      }
      replaceWorkspaces(payload.entries);
    }
  };

  const unsubscribeCounts = counts.subscribe(applyLabels);
  const unsubscribeRegistry = registry.subscribe(() => {
    const snapshot = registry.getSnapshot();
    if (snapshot.bootstraps !== lastBootstraps) {
      lastBootstraps = snapshot.bootstraps;
      void counts.refreshMany(trackedProjects);
    }
    syncPills();
  });

  const schedule = options.schedule ?? defaultSchedule;
  // The re-arm waits out the same backoff policy the gate's own retries use,
  // so a daemon that never came up is retried at the settled cadence.
  const recoveryDelayMs = options.retryDelaysMs?.at(-1) ?? RECOVERY_TAIL_DELAY_MS;
  let gate: { stop(): void } | null = null;
  let cancelRecovery: (() => void) | null = null;

  /** Opens (or, once the bounded burst is spent, re-opens) the single
   * workspace-list gate; any previous gate is stopped first, so parallel
   * duplicate subscriptions cannot exist. */
  const openGate = (): void => {
    gate?.stop();
    gate = openOwnedEntries<PaseoWorkspaceListResult>({
      open: () => paseo.workspaces.list({ subscribe: {} }),
      onSnapshot: (payload) => replaceWorkspaces(payload.entries),
      onUpdate: handleWorkspaceMessage,
      onError: () => {
        // The header buttons are a convenience: while the list is unreachable
        // the pills (which carry their own workspace id) stay in place. The
        // burst settles for good, though, so re-arm a fresh gate — otherwise
        // a daemon that came up late could never bring the headers back.
        if (stopped || cancelRecovery) return;
        cancelRecovery = schedule(() => {
          cancelRecovery = null;
          if (stopped) return;
          openGate();
        }, recoveryDelayMs);
      },
      retryDelaysMs: options.retryDelaysMs,
      schedule,
    });
  };

  openGate();

  // The registry may already hold agents (it is shared with the panel hooks),
  // so seed the pills before the workspace list answers.
  syncPills();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      // Cancel a scheduled re-arm before the gate, so a recovery that is
      // already pending can neither fire nor be replaced by a new gate.
      cancelRecovery?.();
      cancelRecovery = null;
      gate?.stop();
      gate = null;
      unsubscribeCounts();
      unsubscribeRegistry();
      for (const entry of headers.values()) entry.registration.remove();
      for (const entry of pills.values()) entry.registration.remove();
      headers.clear();
      pills.clear();
      trackedProjects.clear();
      workspaces.clear();
    },
  };
}

import type { ComponentType } from "react";
import type {
  PaseoApi,
  PaseoWorkspace,
  PaseoWorkspaceListResult,
} from "@getpaseo/client";
import type {
  PluginButton,
  PluginButtonBehavior,
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientOpenPanelOptions,
  PluginComposerPillContribution,
  PluginHeaderButtonContribution,
} from "@getpaseo/plugin/client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { ReviewWorkspaceIndicators } from "../shared/review-activity";
import { openOwnedEntries, USABLE_AGENT_STATUSES, type AgentRegistry, type OwnedEntriesGateOptions } from "./agent-registry";
import type { ReviewCountStore } from "./review-count-store";
import { createReviewEntryStatusStore, type ReviewEntryStatusStore } from "./review-entry-status-store";

/**
 * Native Review Deck entry points:
 *
 * - one workspace header button per workspace,
 * - one composer pill per live agent.
 *
 * Both are driven by owned subscriptions — the shared agent registry and one
 * workspace list — so they appear and disappear with the host's real state
 * instead of a mount-time list. Labels prioritize actionable project comments,
 * stale anchors, and unread AI findings. Badge refreshes use metadata-only RPCs;
 * Git snapshots are read only after the user opens the Header Popover.
 *
 * Header buttons open the native status popover. Composer pills open a
 * workspace-bound action menu and exist only for live Agents with a workspace.
 * The menu disables AI review and batch submission when the workspace, Agent,
 * diff target, or active-run state is not safe.
 * An unreachable workspace list is retried in a bounded burst and, once that
 * burst is spent, re-armed at the retry policy's tail delay, so the headers
 * recover once the daemon answers again.
 * Every registration is removed on stop(), and a stop() racing the workspace
 * bootstrap leaves no subscription behind.
 */

const WORKSPACE_PANEL_ID = "review-deck";
const WORKSPACE_QUEUE_PANEL_ID = "review-deck-queue";
const AGENT_PANEL_ID = "review-deck-agent";
const AGENT_QUEUE_PANEL_ID = "review-deck-agent-queue";
const AGENT_TARGETED_REVIEW_PANEL_ID = "review-deck-agent-targeted-review";
const BUTTON_ICON = "ScanSearch";

/** The parts of PluginClientContext the entry points need (a structural seam
 * for tests; the real context satisfies it). */
export type ReviewEntryHost = {
  addHeaderButton(contribution: PluginHeaderButtonContribution): PluginButtonRegistration;
  addComposerPill(contribution: PluginComposerPillContribution): PluginButtonRegistration;
  openPanel(id: string, options: PluginClientOpenPanelOptions): void;
  createHeaderPopover(workspaceId: string): ComponentType<PluginButtonContentProps>;
};

type Entry = {
  workspaceId: string;
  /** The project the badge counts; null until the workspace list resolves it. */
  projectId: string | null;
  label: string;
  registration: PluginButtonRegistration;
};

type PillEntry = Entry & {
  agentId: string;
  agentStatus: string;
  workspaceCwd: string | null;
  archiving: boolean;
  hasWorkingChanges: boolean;
  menuSignature: string;
};
type WantedPill = Omit<PillEntry, "label" | "menuSignature" | "registration">;

export type ReviewEntriesOptions = {
  client: ReviewEntryHost;
  paseo: PaseoApi;
  registry: AgentRegistry;
  counts: ReviewCountStore;
  statuses?: ReviewEntryStatusStore;
  labels?: ReviewEntryLabels;
  submitPendingComments?(input: { workspaceId: string; agentId: string }): Promise<void>;
  /** Test seams for the workspace bootstrap; production uses the defaults. */
  retryDelaysMs?: readonly number[];
  schedule?: OwnedEntriesGateOptions<PaseoWorkspaceListResult>["schedule"];
};

export type ReviewEntries = { stop(): void };
export type ReviewEntryLabels = {
  openDeck: string;
  openQueue: string;
  runTargeted: string;
  submitComments: string;
};

const DEFAULT_ENTRY_LABELS: ReviewEntryLabels = {
  openDeck: "Open Review Deck",
  openQueue: "Open Queue",
  runTargeted: "Run Targeted AI Review",
  submitComments: "Submit pending comments",
};

/** Prefer actionable comments, then stale anchors, then unread findings. */
function reviewLabel(commentCount: number | null, status: ReviewWorkspaceIndicators | null): string {
  const pending = status?.projectPendingCommentCount ?? commentCount ?? 0;
  if (pending > 0) return `Review · ${pending}`;
  if (status && status.projectStaleCommentCount > 0) return `Review ⚠ ${status.projectStaleCommentCount}`;
  if (status && status.unreadAiFindingCount > 0) return `Review · ${status.unreadAiFindingCount}`;
  return "Review";
}
type PillMenuTarget = {
  workspaceId: string;
  agentId: string;
  agentStatus: string;
  workspaceCwd: string | null;
  archiving: boolean;
  hasWorkingChanges: boolean;
};

function canSubmitPendingComments(
  status: ReviewWorkspaceIndicators | null,
  target: PillMenuTarget,
  hasSubmitAction: boolean,
): boolean {
  return (target.agentStatus === "idle" || target.agentStatus === "running") &&
    target.workspaceCwd !== null &&
    !target.archiving &&
    status !== null &&
    status.workspacePendingCommentCount + status.workspaceStaleCommentCount > 0 &&
    status.activeBatchCount === 0 &&
    hasSubmitAction;
}

function canRunTargetedReview(status: ReviewWorkspaceIndicators | null, target: PillMenuTarget): boolean {
  return (target.agentStatus === "idle" || target.agentStatus === "running") &&
    target.workspaceCwd !== null &&
    !target.archiving &&
    target.hasWorkingChanges &&
    status !== null &&
    status.runningAiReviewCount === 0;
}


function pillMenuSignature(
  status: ReviewWorkspaceIndicators | null,
  target: PillMenuTarget,
  hasSubmitAction: boolean,
): string {
  return `${canRunTargetedReview(status, target)}:${canSubmitPendingComments(status, target, hasSubmitAction)}`;
}

function pillMenuBehavior(
  client: ReviewEntryHost,
  target: PillMenuTarget,
  status: ReviewWorkspaceIndicators | null,
  labels: ReviewEntryLabels,
  refreshStatus: (workspaceId: string) => Promise<void>,
  submitPendingComments?: ReviewEntriesOptions["submitPendingComments"],
): PluginButtonBehavior {
  return {
    kind: "menu",
    items: [
      {
        kind: "item",
        id: "open-review-deck",
        title: labels.openDeck,
        icon: BUTTON_ICON,
        behavior: {
          kind: "action",
          onPress: () => client.openPanel(AGENT_PANEL_ID, {
            workspaceId: target.workspaceId,
            agentId: target.agentId,
            location: "workspace",
          }),
        },
      },
      {
        kind: "item",
        id: "open-queue",
        title: labels.openQueue,
        icon: "ListTodo",
        behavior: {
          kind: "action",
          onPress: () => client.openPanel(AGENT_QUEUE_PANEL_ID, {
            workspaceId: target.workspaceId,
            agentId: target.agentId,
            location: "workspace",
          }),
        },
      },
      {
        kind: "item",
        id: "run-targeted-ai-review",
        title: labels.runTargeted,
        icon: "Sparkles",
        disabled: !canRunTargetedReview(status, target),
        behavior: {
          kind: "action",
          onPress: () => client.openPanel(AGENT_TARGETED_REVIEW_PANEL_ID, {
            workspaceId: target.workspaceId,
            agentId: target.agentId,
            location: "workspace",
          }),
        },
      },
      { kind: "separator", id: "submit-divider" },
      {
        kind: "item",
        id: "submit-pending-comments",
        title: labels.submitComments,
        icon: "Send",
        disabled: !canSubmitPendingComments(status, target, Boolean(submitPendingComments)),
        behavior: {
          kind: "action",
          onPress: async () => {
            if (!submitPendingComments) throw new Error("Workspace comment submission is unavailable.");
            await submitPendingComments({ workspaceId: target.workspaceId, agentId: target.agentId });
            await refreshStatus(target.workspaceId);
          },
        },
      },
    ],
  };
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
  const statuses = options.statuses ?? createReviewEntryStatusStore();
  const headers = new Map<string, Entry>();
  const pills = new Map<string, PillEntry>();
  const trackedProjects = new Set<string>();
  const trackedWorkspaces = new Set<string>();
  const workspaces = new Map<string, PaseoWorkspace>();
  const labels = options.labels ?? DEFAULT_ENTRY_LABELS;
  let lastBootstraps = registry.getSnapshot().bootstraps;
  let stopped = false;

  const trackProject = (projectId: string | null): void => {
    if (!projectId || trackedProjects.has(projectId)) return;
    trackedProjects.add(projectId);
    void counts.refresh(projectId);
  };
  const trackWorkspace = (workspaceId: string): void => {
    if (!workspaceId || trackedWorkspaces.has(workspaceId)) return;
    trackedWorkspaces.add(workspaceId);
    void statuses.refresh(workspaceId);
  };
  const refreshWorkspaceStatus = (workspaceId: string): void => {
    if (!workspaceId) return;
    trackedWorkspaces.add(workspaceId);
    void statuses.refresh(workspaceId);
  };

  const applyLabels = (): void => {
    for (const entry of headers.values()) {
      const status = statuses.getStatus(entry.workspaceId);
      const next = reviewLabel(entry.projectId ? counts.getCount(entry.projectId) : null, status);
      if (next === entry.label) continue;
      entry.label = next;
      entry.registration.update({ title: next, label: next });
    }
    for (const entry of pills.values()) {
      const status = statuses.getStatus(entry.workspaceId);
      const next = reviewLabel(entry.projectId ? counts.getCount(entry.projectId) : null, status);
      const target: PillMenuTarget = {
        workspaceId: entry.workspaceId,
        agentId: entry.agentId,
        agentStatus: entry.agentStatus,
        workspaceCwd: entry.workspaceCwd,
        archiving: entry.archiving,
        hasWorkingChanges: entry.hasWorkingChanges,
      };
      const nextMenuSignature = pillMenuSignature(status, target, Boolean(options.submitPendingComments));
      const patch: Partial<PluginButton> = {};
      if (next !== entry.label) {
        entry.label = next;
        patch.title = next;
        patch.label = next;
      }
      if (nextMenuSignature !== entry.menuSignature) {
        entry.menuSignature = nextMenuSignature;
        patch.behavior = pillMenuBehavior(
          client,
          target,
          status,
          labels,
          (workspaceId) => statuses.refresh(workspaceId),
          options.submitPendingComments,
        );
      }
      if (Object.keys(patch).length > 0) entry.registration.update(patch);
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
          trackWorkspace(workspaceId);
        }
        continue;
      }
      const label = reviewLabel(counts.getCount(projectId), statuses.getStatus(workspaceId));
      headers.set(workspaceId, {
        workspaceId,
        projectId,
        label,
        registration: client.addHeaderButton({
          id: `review-header-${workspaceId}`,
          workspaceId,
          button: {
            title: label,
            label,
            icon: BUTTON_ICON,
            behavior: { kind: "popover", Content: client.createHeaderPopover(workspaceId) },
          },
        }),
      });
      trackProject(projectId);
      trackWorkspace(workspaceId);
    }
    applyLabels();
  };
  const syncPills = (): void => {
    if (stopped) return;
    const wanted = new Map<string, WantedPill>();
    for (const agent of registry.getSnapshot().agents) {
      if (agent.archived || !agent.workspaceId || USABLE_AGENT_STATUSES[agent.status] !== true) continue;
      const workspace = workspaces.get(agent.workspaceId);
      const workspaceCwd = workspace?.workspaceDirectory || agent.cwd || null;
      const diffStat = workspace?.diffStat;
      wanted.set(agent.id, {
        workspaceId: agent.workspaceId,
        projectId: workspace ? workspace.projectId || agent.workspaceId : agent.projectKey,
        agentId: agent.id,
        agentStatus: agent.status,
        workspaceCwd,
        archiving: Boolean(workspace?.archivingAt),
        hasWorkingChanges: Boolean(diffStat && (diffStat.additions > 0 || diffStat.deletions > 0)),
      });
    }
    for (const [agentId, entry] of [...pills]) {
      if (wanted.has(agentId)) continue;
      entry.registration.remove();
      pills.delete(agentId);
    }
    for (const [agentId, want] of wanted) {
      const existing = pills.get(agentId);
      if (
        existing &&
        existing.workspaceId === want.workspaceId &&
        existing.workspaceCwd === want.workspaceCwd
      ) {
        if (existing.projectId !== want.projectId) {
          existing.projectId = want.projectId;
          trackProject(want.projectId);
        }
        existing.agentStatus = want.agentStatus;
        existing.archiving = want.archiving;
        existing.hasWorkingChanges = want.hasWorkingChanges;
        continue;
      }
      if (existing) {
        existing.registration.remove();
        pills.delete(agentId);
      }
      const status = statuses.getStatus(want.workspaceId);
      const target = want as PillMenuTarget;
      const label = reviewLabel(want.projectId ? counts.getCount(want.projectId) : null, status);
      const menuSignature = pillMenuSignature(status, target, Boolean(options.submitPendingComments));
      const entry: PillEntry = {
        ...want,
        label,
        menuSignature,
        registration: client.addComposerPill({
          id: `review-pill-${agentId}`,
          workspaceId: want.workspaceId,
          agentId,
          button: {
            title: label,
            label,
            icon: BUTTON_ICON,
            behavior: pillMenuBehavior(
              client,
              target,
              status,
              labels,
              (workspaceId) => statuses.refresh(workspaceId),
              options.submitPendingComments,
            ),
          },
        }),
      };
      pills.set(agentId, entry);
      trackProject(want.projectId);
      trackWorkspace(want.workspaceId);
    }
    applyLabels();
  };

  const replaceWorkspaces = (entries: Iterable<PaseoWorkspace>): void => {
    workspaces.clear();
    for (const entry of entries) workspaces.set(entry.id, entry);
    syncHeaders();
    syncPills();
    void statuses.refreshMany(workspaces.keys());
  };
  const handleWorkspaceMessage = (message: SessionOutboundMessage): void => {
    if (message.type === "workspace_update") {
      const payload = message.payload;
      if (payload.kind === "upsert") {
        workspaces.set(payload.workspace.id, payload.workspace);
        refreshWorkspaceStatus(payload.workspace.id);
      } else {
        workspaces.delete(payload.id);
      }
      syncHeaders();
      syncPills();
      return;
    }
    if (message.type === "fetch_workspaces_response") {
      const payload = message.payload;
      // A change delta is merged; anything else is a complete snapshot.
      if (payload.sync?.mode === "changes") {
        for (const entry of payload.entries) {
          workspaces.set(entry.id, entry);
          refreshWorkspaceStatus(entry.id);
        }
        for (const removal of payload.sync.removals) workspaces.delete(removal.id);
        syncHeaders();
        syncPills();
        return;
      }
      replaceWorkspaces(payload.entries);
    }
  };

  const unsubscribeCounts = counts.subscribe(applyLabels);
  const unsubscribeStatuses = statuses.subscribe(applyLabels);
  const unsubscribeRegistry = registry.subscribe(() => {
    const snapshot = registry.getSnapshot();
    if (snapshot.bootstraps !== lastBootstraps) {
      lastBootstraps = snapshot.bootstraps;
      void counts.refreshMany(trackedProjects);
    }
    syncPills();
    void statuses.refreshMany(snapshot.agents.flatMap((agent) => agent.workspaceId ? [agent.workspaceId] : []));
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
      unsubscribeStatuses();
      unsubscribeRegistry();
      for (const entry of headers.values()) entry.registration.remove();
      for (const entry of pills.values()) entry.registration.remove();
      headers.clear();
      pills.clear();
      trackedProjects.clear();
      trackedWorkspaces.clear();
      workspaces.clear();
    },
  };
}

import type { PluginClientContext } from "@getpaseo/plugin/client";

type PluginPaseoApi = PluginClientContext["paseo"];
type AgentSnapshot = {
  id: string;
  provider: string;
  cwd: string;
  workspaceId?: string;
  model: string | null;
  status: string;
  title: string | null;
  archivedAt?: string | null;
};
type AgentListEntry = {
  agent: AgentSnapshot;
  project?: { projectKey?: string | null } | null;
};
type AgentListResult = { entries: readonly AgentListEntry[] };
type AgentListFrame = AgentListResult & {
  sync?: {
    mode?: string;
    removals?: readonly { id: string }[];
  };
};
type AgentRegistryUpdate =
  | {
      type: "agent_update";
      payload:
        | {
            kind: "upsert";
            agent: AgentSnapshot;
            project?: { projectKey?: string | null } | null;
          }
        | { kind: "remove"; agentId: string };
    }
  | { type: "fetch_agents_response"; payload: AgentListFrame };

type OwnedEntriesSubscription<Payload> = {
  subscribe(observer: {
    snapshot(snapshot: Payload): void;
    update(message: unknown): void;
    error?(error: unknown): void;
  }): () => void;
  release(): Promise<void>;
};

/**
 * The one live agent registry of this plugin.
 *
 * `paseo.agents.list({ subscribe: {} })` opens an owned subscription: the
 * daemon answers with an initial snapshot and then streams agent_update
 * frames (upsert/remove) for that subscription id. The registry keeps a local
 * copy of that snapshot and hands it to every consumer — the panel's hooks and
 * the composer/header entry registrations — through one shared subscription,
 * never one per hook. Transport reconnects are re-bootstrapped by the SDK,
 * which re-runs the request and delivers a fresh snapshot to the same
 * observer; a subscription that fails outright is re-established here with a
 * bounded backoff, because the SDK releases a failed subscription instead of
 * replaying it.
 *
 * The mapped records are deliberately free of SDK types: React consumers read
 * them through useSyncExternalStore and the button registrations diff them, so
 * identity-stable records keep both cheap.
 */

export type RegistryAgent = {
  id: string;
  workspaceId: string | null;
  cwd: string;
  status: string;
  provider: string;
  model: string | null;
  title: string | null;
  /** An archived agent keeps existing for bookkeeping but is not an entry point. */
  archived: boolean;
  /** The agent's project key (the project id), used to scope its comment badge. */
  projectKey: string | null;
};

export type AgentRegistrySnapshot = {
  readonly agents: readonly RegistryAgent[];
  /** True until the first bootstrap settles (successful or exhausted). */
  readonly loading: boolean;
  /** The last bootstrap error; cleared by the next successful snapshot. */
  readonly error: string | null;
  /** Bumped whenever the agent set actually changes. */
  readonly revision: number;
  /** Bumped on every fresh snapshot, including reconnect re-bootstraps. */
  readonly bootstraps: number;
};

export type AgentRegistry = {
  getSnapshot(): AgentRegistrySnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * Binds the registry to a Paseo API and (re)starts the shared subscription
   * when none is live. Idempotent: repeated binds of the same API are free.
   */
  bind(paseo: PluginPaseoApi): void;
  /** Releases the subscription and drops every listener. */
  stop(): void;
  readonly stopped: boolean;
};

/** Statuses kept visible in review surfaces; message dispatch has a stricter idle-only gate. */
export const USABLE_AGENT_STATUSES: Record<string, true> = {
  idle: true,
  running: true,
  initializing: true,
};

/** A Review Deck message may only be sent after the Agent is confirmed idle. */
export function isAgentIdleForReviewDispatch(status: string | null | undefined): boolean {
  return status === "idle";
}

/** Normalize a cwd for comparison: strip trailing separators (both platforms). */
function normalizeCwd(value: string | null | undefined): string | null {
  if (!value) return null;
  let out = value;
  while (out.length > 1 && (out.endsWith("/") || out.endsWith("\\"))) out = out.slice(0, -1);
  return out;
}

/**
 * Workspace-scoped agents: exact workspaceId match wins; agents without a
 * workspace id are admitted only when their (normalized) cwd is exactly the
 * bound workspace directory. An agent that names another workspace is never
 * admitted through its cwd, so sibling workspaces sharing a directory cannot
 * leak into each other's panel.
 */
export function selectWorkspaceAgents<T extends { workspaceId: string | null; cwd?: string | null; archived?: boolean }>(
  agents: readonly T[],
  params: { selectedWorkspaceId: string; reviewCwd: string | null },
): T[] {
  const review = normalizeCwd(params.reviewCwd);
  return agents.filter((agent) => {
    if (agent.archived) return false;
    if (agent.workspaceId) return agent.workspaceId === params.selectedWorkspaceId;
    const cwd = normalizeCwd(agent.cwd);
    return !!cwd && !!review && cwd === review;
  });
}

type Scheduler = (run: () => void, delayMs: number) => () => void;

const defaultScheduler: Scheduler = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

/**
 * Bootstrap retries: the first failure is usually a daemon that is still
 * starting, so retry quickly, then back off. After the budget is exhausted the
 * registry settles with an error and a later bind() re-arms it.
 */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 5000, 15000];

export type OwnedEntriesGateOptions<Payload extends { entries: readonly unknown[] }> = {
  /**
   * Opens the owned subscription. The signal is aborted by stop(); callers of
   * APIs that accept it must forward it so a pending bootstrap is cancelled.
   * APIs without a signal (the workspace list) still clean up through the
   * subscription release below.
   */
  open(signal: AbortSignal): Promise<Payload & { subscription: OwnedEntriesSubscription<Payload> }>;
  onSnapshot(payload: Payload): void;
  onUpdate(message: unknown): void;
  /** Called once the retry budget is exhausted with nothing live left. */
  onError(error: unknown): void;
  retryDelaysMs?: readonly number[];
  schedule?: Scheduler;
};

/**
 * One owned list subscription with bounded bootstrap retries and complete
 * teardown. stop() is safe at any point: a bootstrap still in flight is
 * abandoned and the subscription it eventually returns is released, so a
 * plugin reload can never leak a daemon subscription.
 */
export function openOwnedEntries<Payload extends { entries: readonly unknown[] }>(
  options: OwnedEntriesGateOptions<Payload>,
): { stop(): void } {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const schedule = options.schedule ?? defaultScheduler;
  const abort = new AbortController();
  let cancelRetry: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let ownedSubscription: OwnedEntriesSubscription<Payload> | null = null;
  let disposed = false;

  const detach = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    const subscription = ownedSubscription;
    ownedSubscription = null;
    if (subscription) void subscription.release().catch(() => {});
  };

  const exhaust = (error: unknown): void => {
    detach();
    options.onError(error);
  };

  const retryBootstrap = (index: number, error: unknown): void => {
    if (disposed) return;
    detach();
    const delay = delays[index];
    if (delay === undefined) {
      exhaust(error);
      return;
    }
    cancelRetry = schedule(() => {
      cancelRetry = null;
      attempt(index + 1);
    }, delay);
  };

  const failLiveSubscription = (): void => {
    // The subscription died after a successful bootstrap: the socket proved
    // reachable once, so restart the bootstrap with a fresh retry budget.
    if (disposed) return;
    detach();
    const delay = delays[0] ?? 0;
    cancelRetry = schedule(() => {
      cancelRetry = null;
      attempt(0);
    }, delay);
  };

  const attempt = (index: number): void => {
    if (disposed) return;
    let pending: Promise<Payload & { subscription: OwnedEntriesSubscription<Payload> }>;
    try {
      pending = options.open(abort.signal);
    } catch (error) {
      retryBootstrap(index, error);
      return;
    }
    pending.then(
      (payload) => {
        if (disposed) {
          // Torn down while the bootstrap was in flight: the subscription that
          // just arrived must not outlive the plugin.
          void payload.subscription.release().catch(() => {});
          return;
        }
        try {
          const subscription = payload.subscription;
          ownedSubscription = subscription;
          const stopObserving = subscription.subscribe({
            snapshot: (snapshot) => {
              if (!disposed) options.onSnapshot(snapshot);
            },
            update: (message) => {
              if (!disposed) options.onUpdate(message);
            },
            error: () => failLiveSubscription(),
          });
          // A subscription can fail synchronously while attaching. In that
          // case failLiveSubscription already detached and released it.
          if (disposed || ownedSubscription !== subscription) stopObserving();
          else unsubscribe = stopObserving;
        } catch (error) {
          // The subscription was released underneath the attach (a transport
          // failure raced the bootstrap): bootstrap again from scratch.
          retryBootstrap(index, error);
        }
      },
      (error: unknown) => retryBootstrap(index, error),
    );
  };

  attempt(0);

  return {
    stop: () => {
      if (disposed) return;
      disposed = true;
      detach();
      cancelRetry?.();
      cancelRetry = null;
      // Releases a live subscription and cancels a pending bootstrap for APIs
      // that observe the signal.
      abort.abort();
    },
  };
}

type RegistryAgentInput = AgentListEntry;

function sameAgent(a: RegistryAgent, b: RegistryAgent): boolean {
  return a.id === b.id &&
    a.workspaceId === b.workspaceId &&
    a.cwd === b.cwd &&
    a.status === b.status &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.title === b.title &&
    a.archived === b.archived &&
    a.projectKey === b.projectKey;
}

export type AgentRegistryOptions = {
  retryDelaysMs?: readonly number[];
  schedule?: Scheduler;
};

export function createAgentRegistry(options: AgentRegistryOptions = {}): AgentRegistry {
  const listeners = new Set<() => void>();
  let agents = new Map<string, RegistryAgent>();
  let snapshot: AgentRegistrySnapshot = { agents: [], loading: true, error: null, revision: 0, bootstraps: 0 };
  let paseo: PluginPaseoApi | null = null;
  let gate: { stop(): void } | null = null;
  let stopped = false;

  const publish = (next: Partial<AgentRegistrySnapshot>): void => {
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) listener();
  };

  const toRecord = (agent: AgentListEntry["agent"], projectKey: string | null, previous: RegistryAgent | undefined): RegistryAgent => {
    const record: RegistryAgent = {
      id: agent.id,
      workspaceId: agent.workspaceId ?? null,
      cwd: agent.cwd,
      status: agent.status,
      provider: agent.provider,
      model: agent.model ?? null,
      title: agent.title ?? null,
      archived: !!agent.archivedAt,
      projectKey,
    };
    return previous && sameAgent(previous, record) ? previous : record;
  };

  const fromEntry = (entry: RegistryAgentInput): RegistryAgent => {
    const previous = agents.get(entry.agent.id);
    return toRecord(entry.agent, entry.project?.projectKey ?? previous?.projectKey ?? null, previous);
  };

  /** Land a new registry map. A fresh snapshot re-arms loading/error and counts
   * a bootstrap; a delta frame only bumps the revision when something moved. */
  const apply = (next: Map<string, RegistryAgent>, fresh: boolean): void => {
    const changed = next.size !== agents.size ||
      [...next].some(([id, agent]) => agents.get(id) !== agent);
    agents = next;
    if (fresh) {
      publish({
        agents: changed ? [...next.values()] : snapshot.agents,
        loading: false,
        error: null,
        revision: snapshot.revision + (changed ? 1 : 0),
        bootstraps: snapshot.bootstraps + 1,
      });
      return;
    }
    if (changed) publish({ agents: [...next.values()], revision: snapshot.revision + 1 });
  };

  const applyChanges = (payload: AgentListFrame): void => {
    const next = new Map(agents);
    for (const entry of payload.entries) next.set(entry.agent.id, fromEntry(entry));
    for (const removal of payload.sync?.removals ?? []) next.delete(removal.id);
    apply(next, false);
  };

  const applySnapshot = (payload: { entries: readonly RegistryAgentInput[] }): void => {
    const next = new Map<string, RegistryAgent>();
    for (const entry of payload.entries) {
      const record = fromEntry(entry);
      next.set(record.id, record);
    }
    apply(next, true);
  };

  const handleMessage = (message: AgentRegistryUpdate): void => {
    if (message.type === "agent_update") {
      const payload = message.payload;
      if (payload.kind === "upsert") {
        const next = new Map(agents);
        const previous = agents.get(payload.agent.id);
        next.set(payload.agent.id, toRecord(payload.agent, payload.project?.projectKey ?? previous?.projectKey ?? null, previous));
        apply(next, false);
        return;
      }
      if (payload.kind === "remove" && agents.has(payload.agentId)) {
        const next = new Map(agents);
        next.delete(payload.agentId);
        apply(next, false);
      }
      return;
    }
    if (message.type === "fetch_agents_response") {
      const payload = message.payload;
      // A resend carrying a change delta (sync.mode === "changes") is a
      // partial frame: its entries are upserts and its removals are deletes.
      // Anything else is a complete snapshot and replaces the registry.
      if (payload.sync?.mode === "changes") applyChanges(payload);
      else applySnapshot(payload);
    }
  };

  const start = (): void => {
    if (stopped || gate || !paseo) return;
    const api = paseo;
    // A settled error is retried on the next bind: show the loading state
    // again instead of a stale "no agents" view.
    if (snapshot.error !== null) publish({ loading: true, error: null });
    gate = openOwnedEntries<AgentListResult>({
      open: (signal) => api.agents.list({ subscribe: {}, signal }),
      onSnapshot: (payload) => {
        if (!stopped) applySnapshot(payload);
      },
      onUpdate: (message) => {
        if (!stopped) handleMessage(message as AgentRegistryUpdate);
      },
      onError: (error) => {
        if (stopped) return;
        gate = null;
        publish({ loading: false, error: error instanceof Error ? error.message : String(error) });
      },
      retryDelaysMs: options.retryDelaysMs,
      schedule: options.schedule,
    });
  };

  return {
    get stopped() {
      return stopped;
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bind: (nextPaseo) => {
      if (stopped) return;
      if (paseo === nextPaseo) {
        start();
        return;
      }
      // A different API instance means a different host connection: move the
      // one shared subscription instead of opening a second one.
      gate?.stop();
      gate = null;
      paseo = nextPaseo;
      start();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      gate?.stop();
      gate = null;
      paseo = null;
      listeners.clear();
    },
  };
}

let shared: AgentRegistry | null = null;

/**
 * The plugin-wide registry. The contribution and every panel hook go through
 * this accessor, so exactly one agent subscription exists per app instance.
 */
export function getAgentRegistry(): AgentRegistry {
  if (!shared || shared.stopped) shared = createAgentRegistry();
  return shared;
}

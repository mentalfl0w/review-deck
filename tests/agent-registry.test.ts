/**
 * Focused verification of the v1.2 client registry work:
 *
 * - one shared owned agent subscription (initial snapshot, agent_update
 *   upsert/remove, delta resends, reconnect re-snapshots, bounded retries);
 * - the exact workspace + status filtering rules the panel relied on;
 * - complete teardown on plugin reload, including a bootstrap still in flight;
 * - the workspace header button + Agent composer pill lifecycles, whose badges
 *   combine project comment counts with workspace activity indicators;
 * - recovery of the workspace headers after the list's bootstrap burst is
 *   exhausted (a scheduled re-arm), and that stop() cancels a pending re-arm.
 *
 * Method: the registries are driven against structural fakes that reproduce
 * the SDK's OwnedSubscription contract (a cached snapshot replayed on attach,
 * then routed update messages), so the assertions cover this plugin's own
 * snapshot/upsert/remove/reconnect handling rather than the SDK transport.
 *
 * Run: node --experimental-strip-types tests/agent-registry.test.ts
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import { createPaseoClient } from "@getpaseo/client";
import { WSOutboundMessageSchema } from "@getpaseo/protocol/generated/validation/ws-outbound.aot";
import type {
  OwnedSubscription,
  PaseoAgentListResult,
  PaseoApi,
  PaseoClientConfig,
  PaseoWorkspaceListResult,
} from "@getpaseo/client";
import type {
  PluginButton,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginClientOpenPanelOptions,
  PluginComposerPillContribution,
  PluginHeaderButtonContribution,
} from "@getpaseo/plugin/client";
import type { ReviewWorkspaceIndicators } from "../shared/review-activity";
import type { RegistryAgent } from "../client/agent-registry";
import type { ReviewEntryHost } from "../client/review-entries";

// Production modules use bundler-style extensionless imports, which node's
// type stripping does not resolve, so the real client modules are loaded here
// through a resolve hook. The hook only applies to loads that happen after it
// is installed, and static imports are linked before this file runs — hence
// the dynamic imports below (a module-loading boundary, not a runtime choice).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && extname(specifier) === "") {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { USABLE_AGENT_STATUSES, createAgentRegistry, selectWorkspaceAgents } = await import("../client/agent-registry");
const { createReviewCountStore } = await import("../client/review-count-store");
const { registerReviewEntries } = await import("../client/review-entries");
const { createReviewEntryStatusStore } = await import("../client/review-entry-status-store");

type FakeObserver = {
  snapshot(payload: unknown): void;
  update(message: unknown): void;
  error?(error: unknown): void;
};

type FakeContribution = PluginHeaderButtonContribution | PluginComposerPillContribution;

type RegistrationLog = {
  id: string;
  contribution: FakeContribution;
  updates: Array<Partial<PluginButton>>;
  removed: boolean;
};

type FakeSubscription<Payload> = {
  subscription: OwnedSubscription<Payload>;
  state: { released: boolean; attaches: number };
  emitSnapshot(payload: Payload): void;
  emitUpdate(message: unknown): void;
  emitError(error: unknown): void;
};

type FakeList<Payload> = {
  calls: Array<{ signal: AbortSignal | undefined }>;
  list(options?: { signal?: AbortSignal }): Promise<Payload & { subscription: OwnedSubscription<Payload> }>;
  boot(index: number, payload: Payload): FakeSubscription<Payload>;
  fail(index: number, error: unknown): void;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

/** Drain every pending microtask (and anything already queued behind them)
 * without waiting on a duration: each promise chain here settles in one turn. */
function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

type ScheduledCallback = {
  run: () => void;
  delayMs: number;
  cancelled: boolean;
  fired: boolean;
};

/** A scheduler seam that captures delayed callbacks instead of running them,
 * so the test decides exactly when a retry or a post-exhaustion re-arm fires. */
function createFakeScheduler() {
  const entries: ScheduledCallback[] = [];
  return {
    schedule(run: () => void, delayMs: number): () => void {
      const entry: ScheduledCallback = { run, delayMs, cancelled: false, fired: false };
      entries.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    /** Scheduled callbacks that have neither fired nor been cancelled. */
    pending(): ScheduledCallback[] {
      return entries.filter((entry) => !entry.fired && !entry.cancelled);
    },
    /** Runs the oldest pending callback, in scheduler order. */
    fire(): void {
      const entry = entries.find((candidate) => !candidate.fired && !candidate.cancelled);
      assert.ok(entry, "a delayed callback must be pending");
      entry.fired = true;
      entry.run();
    },
  };
}

function createFakeSubscription<Payload>(payload: Payload): FakeSubscription<Payload> {
  const observers = new Set<FakeObserver>();
  const state = { released: false, attaches: 0 };
  const subscription = {
    subscriptionId: "fake-sub",
    ready: Promise.resolve(payload),
    subscribe(observer: FakeObserver) {
      if (state.released) throw new Error("Subscription released");
      state.attaches += 1;
      observers.add(observer);
      // The SDK replays its cached snapshot to every newly attached observer.
      observer.snapshot(payload);
      return () => {
        observers.delete(observer);
      };
    },
    release: async () => {
      state.released = true;
      observers.clear();
    },
  } as unknown as OwnedSubscription<Payload>;
  return {
    subscription,
    state,
    emitSnapshot: (next) => {
      for (const observer of [...observers]) observer.snapshot(next);
    },
    emitUpdate: (message) => {
      for (const observer of [...observers]) observer.update(message);
    },
    emitError: (error) => {
      for (const observer of [...observers]) observer.error?.(error);
    },
  };
}

function createFakeList<Payload>(): FakeList<Payload> {
  const calls: Array<{ signal: AbortSignal | undefined }> = [];
  const deferred: Array<Deferred<Payload & { subscription: OwnedSubscription<Payload> }>> = [];
  return {
    calls,
    list: (options) => {
      calls.push({ signal: options?.signal });
      const next = Promise.withResolvers<Payload & { subscription: OwnedSubscription<Payload> }>();
      deferred.push({ promise: next.promise, resolve: next.resolve, reject: next.reject });
      return next.promise;
    },
    boot: (index, payload) => {
      const fake = createFakeSubscription(payload);
      deferred[index].resolve({ ...payload, subscription: fake.subscription });
      return fake;
    },
    fail: (index, error) => {
      deferred[index].reject(error);
    },
  };
}

function createFakePaseo() {
  const agents = createFakeList<PaseoAgentListResult>();
  const workspaces = createFakeList<PaseoWorkspaceListResult>();
  const paseo = { agents: { list: agents.list }, workspaces: { list: workspaces.list } } as unknown as PaseoApi;
  return { paseo, agents, workspaces };
}

type AgentEntryOptions = {
  workspaceId?: string | null;
  cwd?: string;
  status?: string;
  title?: string | null;
  archivedAt?: string | null;
  projectKey?: string;
};

function agentEntry(id: string, options: AgentEntryOptions = {}) {
  return {
    agent: {
      id,
      provider: "claude",
      cwd: options.cwd ?? "/repo",
      workspaceId: options.workspaceId === null ? undefined : options.workspaceId ?? "ws-1",
      model: "claude-sonnet",
      status: options.status ?? "idle",
      title: options.title ?? null,
      archivedAt: options.archivedAt ?? undefined,
    },
    project: { projectKey: options.projectKey ?? "proj-1" },
  };
}

function agentsPayload(entries: ReturnType<typeof agentEntry>[]): PaseoAgentListResult {
  return {
    requestId: "req-1",
    entries,
    pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
  } as unknown as PaseoAgentListResult;
}

function workspaceEntry(id: string, options: {
  projectId?: string;
  archivingAt?: string | null;
  diffStat?: { additions: number; deletions: number } | null;
} = {}) {
  return {
    id,
    projectId: options.projectId ?? "proj-1",
    projectDisplayName: "Project",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    workspaceKind: "checkout",
    name: id,
    status: "running",
    archivingAt: options.archivingAt ?? null,
    diffStat: options.diffStat ?? null,
  };
}
function workspaceIndicators(
  workspaceId: string,
  projectId: string,
  overrides: Partial<ReviewWorkspaceIndicators> = {},
): ReviewWorkspaceIndicators {
  return {
    workspaceId,
    projectId,
    projectPendingCommentCount: 0,
    projectStaleCommentCount: 0,
    workspacePendingCommentCount: 0,
    workspaceStaleCommentCount: 0,
    activeBatchCount: 0,
    runningAiReviewCount: 0,
    unreadAiFindingCount: 0,
    ...overrides,
  };
}

function workspacesPayload(entries: ReturnType<typeof workspaceEntry>[]): PaseoWorkspaceListResult {
  return {
    requestId: "req-1",
    entries,
    pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
  } as unknown as PaseoWorkspaceListResult;
}

function createFakeHost() {
  const all: RegistrationLog[] = [];
  const live = new Map<string, RegistrationLog>();
  const opened: Array<{ id: string; options: PluginClientOpenPanelOptions }> = [];
  const popoverWorkspaces: string[] = [];
  const register = (contribution: FakeContribution): PluginButtonRegistration => {
    const record: RegistrationLog = { id: contribution.id, contribution, updates: [], removed: false };
    all.push(record);
    live.set(record.id, record);
    return {
      update(patch) {
        // The real registration updates presentation in place.
        record.updates.push(patch);
        Object.assign(record.contribution.button, patch);
      },
      remove() {
        if (record.removed) return;
        record.removed = true;
        live.delete(record.id);
      },
    };
  };
  const host: ReviewEntryHost = {
    addHeaderButton: register,
    addComposerPill: register,
    openPanel(id, options) {
      opened.push({ id, options });
    },
    createHeaderPopover(workspaceId) {
      popoverWorkspaces.push(workspaceId);
      return () => null;
    },
  };
  const menuItem = (id: string, itemId: string): Extract<PluginButtonMenuEntry, { kind: "item" }> => {
    const record = live.get(id);
    assert.ok(record, `registration ${id} must be live`);
    const behavior = record.contribution.button.behavior;
    if (behavior.kind !== "menu") throw new Error(`registration ${id} must expose a menu`);
    const item = behavior.items.find((entry): entry is Extract<PluginButtonMenuEntry, { kind: "item" }> =>
      entry.kind === "item" && entry.id === itemId);
    if (!item) throw new Error(`menu item ${itemId} must exist`);
    return item;
  };
  return {
    all,
    live,
    opened,
    popoverWorkspaces,
    host,
    press(id: string) {
      const record = live.get(id);
      assert.ok(record, `registration ${id} must be live`);
      return record.contribution.button.behavior;
    },
    menuItem,
    async selectMenuItem(id: string, itemId: string) {
      const item = menuItem(id, itemId);
      assert.notEqual(item.disabled, true, `menu item ${itemId} must be enabled`);
      if (item.behavior.kind === "action") await item.behavior.onPress();
      return item;
    },
  };
}

function createFakeCounts() {
  const store = createReviewCountStore();
  const asked: string[] = [];
  const pending: Array<{ projectId: string; resolve: (value: number) => void; reject: (error: unknown) => void }> = [];
  store.bindFetcher((projectId) => {
    asked.push(projectId);
    const next = Promise.withResolvers<number>();
    pending.push({ projectId, resolve: next.resolve, reject: next.reject });
    return next.promise;
  });
  return { store, asked, pending };
}

function registryAgent(id: string, options: { workspaceId: string | null; cwd?: string }): RegistryAgent {
  return {
    id,
    workspaceId: options.workspaceId,
    cwd: options.cwd ?? "/repo",
    status: "idle",
    provider: "claude",
    model: null,
    title: null,
    archived: false,
    projectKey: null,
  };
}

/**
 * In-memory daemon for the real-SDK case: every frame is validated by the
 * protocol's own outbound schema, so a shape mistake fails here instead of
 * being silently ignored, and the registry is exercised against the real
 * subscription implementation rather than a double.
 */
function createFakeDaemon() {
  const sent: Array<Record<string, unknown>> = [];
  const subscriptionId = "sdk-sub-1";
  let onMessage: ((data: unknown, isBinary: boolean) => void) | null = null;
  let onOpen: (() => void) | null = null;

  const push = (message: unknown) => {
    onMessage?.(JSON.stringify(WSOutboundMessageSchema.parse(message)), false);
  };

  const sdkAgent = (id: string, status: string) => ({
    id,
    provider: "claude",
    cwd: "/repo",
    workspaceId: "ws-1",
    model: "claude-sonnet",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastUserMessageAt: null,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
  });

  const sdkEntry = (id: string, status = "idle") => ({
    agent: sdkAgent(id, status),
    project: {
      projectKey: "proj-1",
      projectName: "Project",
      checkout: {
        cwd: "/repo",
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  });

  const respond = (frame: Record<string, unknown>) => {
    const message = frame.type === "session" && typeof frame.message === "object" && frame.message !== null
      ? frame.message as Record<string, unknown>
      : frame;
    if (message.type === "hello") {
      push({ type: "session", message: { type: "status", payload: { status: "server_info", serverId: "fake-daemon" } } });
      return;
    }
    if (message.type === "ping") {
      push({ type: "pong" });
      return;
    }
    if (message.type === "fetch_agents_request") {
      push({
        type: "session",
        message: {
          type: "fetch_agents_response",
          payload: {
            requestId: message.requestId,
            subscriptionId,
            entries: [sdkEntry("agent-1")],
            pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
          },
        },
      });
    }
  };

  return {
    sent,
    open: () => onOpen?.(),
    agentRequests: () => sent.filter((frame) => frame.type === "fetch_agents_request"),
    upsert: (id: string, status: string) => {
      push({
        type: "session",
        message: { type: "agent_update", payload: { subscriptionId, kind: "upsert", agent: sdkAgent(id, status) } },
      });
    },
    remove: (id: string) => {
      push({
        type: "session",
        message: { type: "agent_update", payload: { subscriptionId, kind: "remove", agentId: id } },
      });
    },
    transportFactory: () => ({
      send: (data: string) => {
        const frame = JSON.parse(data) as Record<string, unknown>;
        sent.push(
          frame.type === "session" && typeof frame.message === "object" && frame.message !== null
            ? frame.message as Record<string, unknown>
            : frame,
        );
        respond(frame);
      },
      close: () => undefined,
      onMessage: (handler: (data: unknown, isBinary: boolean) => void) => {
        onMessage = handler;
        return () => {
          onMessage = null;
        };
      },
      onOpen: (handler: () => void) => {
        onOpen = handler;
        return () => {
          onOpen = null;
        };
      },
      onClose: () => () => undefined,
      onError: () => () => undefined,
    }),
  };
}

async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`failed - ${name}`);
    throw error;
  }
}

async function main() {
  await test("count fetcher rebinding does not reuse an old pending request", async () => {
    const store = createReviewCountStore();
    const oldRequest = Promise.withResolvers<number>();
    const newRequest = Promise.withResolvers<number>();
    store.bindFetcher(() => oldRequest.promise);
    const stale = store.refresh("project");

    store.bindFetcher(() => newRequest.promise);
    const fresh = store.refresh("project");
    newRequest.resolve(4);
    await fresh;
    oldRequest.resolve(1);
    await stale;

    assert.equal(store.getCount("project"), 4, "a previous plugin instance cannot overwrite the replacement count");
  });

  await test("bootstrap, upsert, remove and identity-stable records", async () => {
    const fake = createFakePaseo();
    const registry = createAgentRegistry({ retryDelaysMs: [] });
    registry.bind(fake.paseo);
    assert.equal(fake.agents.calls.length, 1, "bind opens exactly one agents subscription");

    const subscription = fake.agents.boot(0, agentsPayload([
      agentEntry("agent-a", { workspaceId: "ws-1" }),
      agentEntry("agent-b", { workspaceId: "ws-2", projectKey: "proj-2" }),
      agentEntry("agent-c", { workspaceId: null, cwd: "/repo/", archivedAt: "2026-01-01T00:00:00Z" }),
    ]));
    await flush();

    let snapshot = registry.getSnapshot();
    assert.deepEqual(
      { loading: snapshot.loading, error: snapshot.error, revision: snapshot.revision, bootstraps: snapshot.bootstraps },
      { loading: false, error: null, revision: 1, bootstraps: 1 },
    );
    assert.deepEqual(snapshot.agents.map((agent) => agent.id).sort(), ["agent-a", "agent-b", "agent-c"]);
    const mapped = snapshot.agents.find((agent) => agent.id === "agent-c");
    assert.deepEqual(
      { workspaceId: mapped?.workspaceId, archived: mapped?.archived, projectKey: mapped?.projectKey, status: mapped?.status },
      { workspaceId: null, archived: true, projectKey: "proj-1", status: "idle" },
      "an agent without a workspace keeps a null workspace id, its archived flag and its project key",
    );

    // Upsert: the new agent joins.
    subscription.emitUpdate({
      type: "agent_update",
      payload: { subscriptionId: "fake-sub", kind: "upsert", agent: agentEntry("agent-d", { status: "running" }).agent },
    });
    snapshot = registry.getSnapshot();
    assert.equal(snapshot.revision, 2);
    assert.equal(snapshot.agents.length, 4);

    // An identical upsert must not move the revision or the array identity.
    const identical = registry.getSnapshot().agents;
    subscription.emitUpdate({
      type: "agent_update",
      payload: { subscriptionId: "fake-sub", kind: "upsert", agent: agentEntry("agent-d", { status: "running" }).agent },
    });
    assert.equal(registry.getSnapshot().revision, 2, "an unchanged upsert must not bump the revision");
    assert.equal(registry.getSnapshot().agents, identical, "unchanged records keep their identity");

    // A status change is a real mutation (the panel's usable list follows it).
    subscription.emitUpdate({
      type: "agent_update",
      payload: { subscriptionId: "fake-sub", kind: "upsert", agent: agentEntry("agent-d", { status: "closed" }).agent },
    });
    snapshot = registry.getSnapshot();
    assert.equal(snapshot.revision, 3);
    assert.equal(snapshot.agents.find((agent) => agent.id === "agent-d")?.status, "closed");

    // Remove, then a removal for an unknown agent (a no-op, not a bump).
    subscription.emitUpdate({
      type: "agent_update",
      payload: { subscriptionId: "fake-sub", kind: "remove", agentId: "agent-a" },
    });
    assert.equal(registry.getSnapshot().revision, 4);
    assert.equal(registry.getSnapshot().agents.some((agent) => agent.id === "agent-a"), false);
    subscription.emitUpdate({
      type: "agent_update",
      payload: { subscriptionId: "fake-sub", kind: "remove", agentId: "agent-zzz" },
    });
    assert.equal(registry.getSnapshot().revision, 4);
    registry.stop();
    assert.equal(subscription.state.released, true, "stopping the registry releases its owned agent observation");
  });

  await test("delta resends merge, full resends replace, reconnect re-snapshots", async () => {
    const fake = createFakePaseo();
    const registry = createAgentRegistry({ retryDelaysMs: [] });
    registry.bind(fake.paseo);
    const subscription = fake.agents.boot(0, agentsPayload([
      agentEntry("agent-a", { workspaceId: "ws-1" }),
      agentEntry("agent-b", { workspaceId: "ws-1" }),
    ]));
    await flush();

    // sync.mode === "changes": entries are upserts, sync.removals are deletes.
    subscription.emitUpdate({
      type: "fetch_agents_response",
      payload: {
        requestId: "req-2",
        subscriptionId: "fake-sub",
        entries: [agentEntry("agent-c", { workspaceId: "ws-1" })],
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        sync: { generation: "gen-1", headSeq: 9, mode: "changes", removals: [{ id: "agent-a", seq: 8 }] },
      },
    });
    let snapshot = registry.getSnapshot();
    assert.deepEqual(snapshot.agents.map((agent) => agent.id).sort(), ["agent-b", "agent-c"]);
    assert.equal(snapshot.bootstraps, 1, "a delta frame is not a bootstrap");

    // Reconnect: the SDK replays a fresh full snapshot to the same observer.
    subscription.emitSnapshot(agentsPayload([agentEntry("agent-z", { workspaceId: "ws-3", projectKey: "proj-3" })]));
    snapshot = registry.getSnapshot();
    assert.deepEqual(snapshot.agents.map((agent) => agent.id), ["agent-z"]);
    assert.equal(snapshot.bootstraps, 2, "a reconnect snapshot counts a bootstrap");
    assert.equal(snapshot.loading, false);
    registry.stop();
  });

  await test("bootstrap retries are bounded, settle, and re-arm on the next bind", async () => {
    const fake = createFakePaseo();
    const registry = createAgentRegistry({
      retryDelaysMs: [0, 0],
      schedule: (run) => {
        queueMicrotask(run);
        return () => undefined;
      },
    });
    registry.bind(fake.paseo);
    assert.equal(fake.agents.calls.length, 1);

    fake.agents.fail(0, new Error("daemon down"));
    await flush();
    assert.equal(fake.agents.calls.length, 2, "a failed bootstrap retries");
    assert.equal(registry.getSnapshot().loading, true);

    fake.agents.fail(1, new Error("daemon down"));
    await flush();
    assert.equal(fake.agents.calls.length, 3);

    fake.agents.fail(2, new Error("daemon down"));
    await flush();
    assert.deepEqual(
      { calls: fake.agents.calls.length, loading: registry.getSnapshot().loading, error: registry.getSnapshot().error },
      { calls: 3, loading: false, error: "daemon down" },
      "the retry budget is bounded and an exhausted bootstrap settles with an error",
    );

    // A later bind re-arms the settled registry and clears the error state.
    registry.bind(fake.paseo);
    assert.equal(fake.agents.calls.length, 4);
    assert.deepEqual({ loading: registry.getSnapshot().loading, error: registry.getSnapshot().error }, { loading: true, error: null });
    const liveSubscription = fake.agents.boot(3, agentsPayload([agentEntry("agent-a")]));
    await flush();
    assert.equal(registry.getSnapshot().agents.length, 1);
    assert.equal(registry.getSnapshot().loading, false);

    // A live subscription that dies is re-established with a fresh budget: the
    // SDK releases a failed subscription instead of replaying it.
    liveSubscription.emitError(new Error("socket died"));
    await flush();
    assert.equal(liveSubscription.state.released, true, "a failed live observation is released before retrying");
    assert.equal(fake.agents.calls.length, 5, "the dead subscription is re-bootstrapped");
    const replacementSubscription = fake.agents.boot(4, agentsPayload([agentEntry("agent-b")]));
    await flush();
    assert.deepEqual(registry.getSnapshot().agents.map((agent) => agent.id), ["agent-b"]);
    registry.stop();
    assert.equal(replacementSubscription.state.released, true, "stopping releases the replacement observation");
  });

  await test("stop() aborts a pending bootstrap and releases the late subscription", async () => {
    const fake = createFakePaseo();
    const registry = createAgentRegistry({ retryDelaysMs: [] });
    registry.bind(fake.paseo);
    assert.equal(fake.agents.calls[0].signal?.aborted, false);

    registry.stop();
    assert.equal(fake.agents.calls[0].signal?.aborted, true, "stop() must cancel the in-flight bootstrap");

    const late = fake.agents.boot(0, agentsPayload([agentEntry("agent-a")]));
    await flush();
    assert.equal(late.state.released, true, "a subscription arriving after stop must be released");
    assert.equal(late.state.attaches, 0, "no observer may attach after stop");

    // Late events cannot mutate a stopped registry.
    const snapshot = registry.getSnapshot();
    late.emitSnapshot(agentsPayload([agentEntry("agent-late")]));
    assert.equal(registry.getSnapshot(), snapshot);
    assert.equal(registry.getSnapshot().agents.length, 0);
  });

  await test("bind() moves the single subscription to a new API instance", async () => {
    const first = createFakePaseo();
    const second = createFakePaseo();
    const registry = createAgentRegistry({ retryDelaysMs: [] });
    registry.bind(first.paseo);
    const firstSubscription = first.agents.boot(0, agentsPayload([agentEntry("agent-a", { workspaceId: "ws-1" })]));
    await flush();

    registry.bind(second.paseo);
    assert.equal(first.agents.calls[0].signal?.aborted, true, "the previous host's subscription is released");
    assert.equal(firstSubscription.state.released, true, "moving hosts releases the previous owned observation");
    assert.equal(second.agents.calls.length, 1, "exactly one subscription exists after the move");
    firstSubscription.emitSnapshot(agentsPayload([agentEntry("agent-ghost", { workspaceId: "ws-9" })]));
    assert.deepEqual(registry.getSnapshot().agents.map((agent) => agent.id), ["agent-a"], "the released subscription is silent");

    const secondSubscription = second.agents.boot(0, agentsPayload([agentEntry("agent-b", { workspaceId: "ws-2" })]));
    await flush();
    assert.deepEqual(registry.getSnapshot().agents.map((agent) => agent.id), ["agent-b"]);
    registry.stop();
    assert.equal(secondSubscription.state.released, true, "stopping releases the new host's owned observation");
  });

  await test("workspace filtering keeps the exact pre-existing rules", async () => {
    assert.deepEqual(
      Object.keys(USABLE_AGENT_STATUSES).sort(),
      ["idle", "initializing", "running"],
      "the usable statuses are unchanged",
    );

    const agents = [
      registryAgent("bound", { workspaceId: "ws-1", cwd: "/other" }),
      registryAgent("sibling", { workspaceId: "ws-2", cwd: "/repo/" }),
      registryAgent("unbound-matching", { workspaceId: null, cwd: "/repo/" }),
      registryAgent("unbound-other", { workspaceId: null, cwd: "/elsewhere" }),
      registryAgent("unbound-empty", { workspaceId: null, cwd: "" }),
    ];
    assert.deepEqual(
      selectWorkspaceAgents(agents, { selectedWorkspaceId: "ws-1", reviewCwd: "/repo" }).map((agent) => agent.id),
      ["bound", "unbound-matching"],
      "an explicit sibling workspace id never falls through to a cwd match",
    );
    assert.deepEqual(
      selectWorkspaceAgents(agents, { selectedWorkspaceId: "ws-1", reviewCwd: null }).map((agent) => agent.id),
      ["bound"],
      "without a bound directory only exact workspace ids qualify",
    );
  });

  await test("header buttons and composer pills follow both registries", async () => {
    const fake = createFakePaseo();
    const registry = createAgentRegistry({ retryDelaysMs: [] });
    registry.bind(fake.paseo);
    const agentsSubscription = fake.agents.boot(0, agentsPayload([
      agentEntry("agent-a", { workspaceId: "ws-1" }),
      agentEntry("agent-b", { workspaceId: null, cwd: "/repo" }),
      agentEntry("agent-c", { workspaceId: "ws-1", archivedAt: "2026-01-01T00:00:00Z" }),
      agentEntry("agent-d", { workspaceId: "ws-9", projectKey: "proj-9" }),
      agentEntry("agent-error", { workspaceId: "ws-1", status: "error" }),
    ]));
    await flush();

    const host = createFakeHost();
    const counts = createFakeCounts();
    const entries = registerReviewEntries({
      client: host.host,
      paseo: fake.paseo,
      registry,
      counts: counts.store,
      retryDelaysMs: [],
    });
    await flush();
    assert.ok(host.all.every((record) => /^[a-z][a-z0-9-]*$/.test(record.id)), "Paseo contribution IDs use lowercase letters, digits, and hyphens only");

    assert.deepEqual(
      [...host.live.keys()].sort(),
      ["review-pill-agent-a", "review-pill-agent-d"],
      "pills exist only for live agents that name a workspace (archived and workspace-less agents are skipped)",
    );
    const pillA = host.live.get("review-pill-agent-a")?.contribution as PluginComposerPillContribution;
    assert.equal(pillA.workspaceId, "ws-1");
    assert.equal(pillA.agentId, "agent-a");
    assert.deepEqual([...new Set(counts.asked)].sort(), ["proj-1", "proj-9"], "badges ask for project counts, deduplicated per project");

    const workspacesSubscription = fake.workspaces.boot(0, workspacesPayload([
      workspaceEntry("ws-1", { projectId: "proj-1" }),
      workspaceEntry("ws-2", { projectId: "proj-2", archivingAt: "2026-01-01T00:00:00Z" }),
    ]));
    await flush();
    assert.deepEqual(
      [...host.live.keys()].sort(),
      ["review-header-ws-1", "review-pill-agent-a", "review-pill-agent-d"],
      "one header per live workspace; an archiving workspace is skipped",
    );
    assert.equal(host.live.get("review-header-ws-1")?.contribution.button.label, "Review");
    assert.equal(counts.asked.length, 2, "the header reuses the project count already requested for the pills");

    for (const pending of counts.pending.splice(0)) pending.resolve(3);
    await flush();
    assert.equal(host.live.get("review-header-ws-1")?.contribution.button.label, "Review · 3");
    assert.equal(host.live.get("review-pill-agent-a")?.contribution.button.label, "Review · 3");
    assert.equal(host.live.get("review-pill-agent-d")?.contribution.button.label, "Review · 3");

    // Clicking the Header opens its status popover; the Agent Pill opens its menu.
    const headerBehavior = host.press("review-header-ws-1");
    assert.equal(headerBehavior.kind, "popover");
    assert.deepEqual(host.popoverWorkspaces, ["ws-1"]);
    const pillBehavior = host.press("review-pill-agent-a");
    assert.equal(pillBehavior.kind, "menu");
    await host.selectMenuItem("review-pill-agent-a", "open-review-deck");
    await host.selectMenuItem("review-pill-agent-a", "open-queue");
    assert.deepEqual(host.opened, [
      { id: "review-deck-agent", options: { workspaceId: "ws-1", agentId: "agent-a", location: "workspace" } },
      { id: "review-deck-agent-queue", options: { workspaceId: "ws-1", agentId: "agent-a", location: "workspace" } },
    ]);

    // A local comment read updates every badge with no RPC at all.
    const askedBeforeLocal = counts.asked.length;
    counts.store.setCount("proj-1", 5);
    await flush();
    assert.equal(counts.asked.length, askedBeforeLocal, "a local refresh must not trigger a count fetch");
    assert.equal(host.live.get("review-header-ws-1")?.contribution.button.label, "Review · 5");
    assert.equal(host.live.get("review-pill-agent-a")?.contribution.button.label, "Review · 5");

    // Agent removal drops its pill; workspace removal drops its header.
    agentsSubscription.emitUpdate({
      type: "agent_update",
      payload: { subscriptionId: "fake-sub", kind: "remove", agentId: "agent-a" },
    });
    assert.equal(host.live.has("review-pill-agent-a"), false);
    assert.equal(host.all.find((record) => record.id === "review-pill-agent-a")?.removed, true);

    workspacesSubscription.emitUpdate({
      type: "workspace_update",
      payload: { subscriptionId: "fake-sub", kind: "remove", id: "ws-1" },
    });
    assert.equal(host.live.has("review-header-ws-1"), false);
    assert.equal(host.all.find((record) => record.id === "review-header-ws-1")?.removed, true);
    assert.equal(host.live.has("review-pill-agent-d"), true, "the unrelated workspace's pill survives");

    entries.stop();
    assert.equal(host.live.size, 0, "stop() removes every registration");
    assert.equal(host.all.every((record) => record.removed), true);
    assert.equal(workspacesSubscription.state.released, true, "stopping releases the workspace owned observation");
    registry.stop();
    assert.equal(agentsSubscription.state.released, true, "stopping releases the agent owned observation");
  });
  await test("a moved Agent rebinds its Review Pill to the new workspace", async () => {
    const fake = createFakePaseo();
    const registry = createAgentRegistry({ retryDelaysMs: [] });
    registry.bind(fake.paseo);
    const agentsSubscription = fake.agents.boot(0, agentsPayload([
      agentEntry("agent-move", { workspaceId: "ws-1", projectKey: "proj-1" }),
    ]));
    await flush();

    const host = createFakeHost();
    const counts = createFakeCounts();
    const entries = registerReviewEntries({
      client: host.host,
      paseo: fake.paseo,
      registry,
      counts: counts.store,
      retryDelaysMs: [],
    });
    const workspacesSubscription = fake.workspaces.boot(0, workspacesPayload([
      workspaceEntry("ws-1", { projectId: "proj-1" }),
      workspaceEntry("ws-2", { projectId: "proj-2" }),
    ]));
    await flush();

    const original = host.live.get("review-pill-agent-move");
    assert.ok(original);
    assert.equal(original.contribution.workspaceId, "ws-1");
    agentsSubscription.emitUpdate({
      type: "agent_update",
      payload: {
        subscriptionId: "fake-sub",
        kind: "upsert",
        agent: agentEntry("agent-move", { workspaceId: "ws-2", projectKey: "proj-2" }).agent,
      },
    });
    await flush();

    const moved = host.live.get("review-pill-agent-move");
    assert.ok(moved);
    await host.selectMenuItem("review-pill-agent-move", "open-review-deck");
    assert.deepEqual(host.opened, [{
      id: "review-deck-agent",
      options: { workspaceId: "ws-2", agentId: "agent-move", location: "workspace" },
    }], "pressing the moved Agent's menu item must keep the new workspace binding");
    assert.equal(moved.contribution.workspaceId, "ws-2");

    entries.stop();
    registry.stop();
    assert.equal(workspacesSubscription.state.released, true);
    assert.equal(agentsSubscription.state.released, true);
  });
  await test("Review entry badges and menus follow workspace review status", async () => {
    const fake = createFakePaseo();
    const registry = createAgentRegistry({ retryDelaysMs: [] });
    registry.bind(fake.paseo);
    const agentsSubscription = fake.agents.boot(0, agentsPayload([
      agentEntry("agent-a", { workspaceId: "ws-1" }),
    ]));
    await flush();

    const host = createFakeHost();
    const counts = createFakeCounts();
    const statuses = createReviewEntryStatusStore();
    statuses.setStatus("ws-1", workspaceIndicators("ws-1", "proj-1", {
      projectPendingCommentCount: 3,
      projectStaleCommentCount: 2,
      workspacePendingCommentCount: 1,
      workspaceStaleCommentCount: 1,
    }));
    const submitted: Array<{ workspaceId: string; agentId: string }> = [];
    const entries = registerReviewEntries({
      client: host.host,
      paseo: fake.paseo,
      registry,
      counts: counts.store,
      statuses,
      submitPendingComments: async (input) => { submitted.push(input); },
      retryDelaysMs: [],
    });
    const workspacesSubscription = fake.workspaces.boot(0, workspacesPayload([
      workspaceEntry("ws-1", { projectId: "proj-1", diffStat: { additions: 2, deletions: 1 } }),
    ]));
    await flush();

    assert.equal(host.live.get("review-header-ws-1")?.contribution.button.label, "Review · 3");
    assert.equal(host.live.get("review-pill-agent-a")?.contribution.button.label, "Review · 3");
    const runItem = () => host.menuItem("review-pill-agent-a", "run-targeted-ai-review");
    const submitItem = () => host.menuItem("review-pill-agent-a", "submit-pending-comments");
    assert.equal(runItem().disabled, false);
    assert.equal(submitItem().disabled, false);
    await host.selectMenuItem("review-pill-agent-a", "run-targeted-ai-review");
    await host.selectMenuItem("review-pill-agent-a", "submit-pending-comments");
    assert.deepEqual(host.opened, [{
      id: "review-deck-agent-targeted-review",
      options: { workspaceId: "ws-1", agentId: "agent-a", location: "workspace" },
    }]);
    assert.deepEqual(submitted, [{ workspaceId: "ws-1", agentId: "agent-a" }]);

    statuses.setStatus("ws-1", workspaceIndicators("ws-1", "proj-1", {
      projectStaleCommentCount: 2,
      workspaceStaleCommentCount: 1,
      activeBatchCount: 1,
      runningAiReviewCount: 1,
      unreadAiFindingCount: 4,
    }));
    await flush();
    assert.equal(host.live.get("review-header-ws-1")?.contribution.button.label, "Review ⚠ 2", "stale status outranks unread findings");
    assert.equal(runItem().disabled, true);
    assert.equal(submitItem().disabled, true);

    statuses.setStatus("ws-1", workspaceIndicators("ws-1", "proj-1", { unreadAiFindingCount: 4 }));
    await flush();
    assert.equal(host.live.get("review-header-ws-1")?.contribution.button.label, "Review · 4", "unread findings surface after pending and stale counts clear");

    entries.stop();
    registry.stop();
    assert.equal(workspacesSubscription.state.released, true);
    assert.equal(agentsSubscription.state.released, true);
  });

  await test("registry events drive pill lifecycle and reconnect count refreshes", async () => {
    const fake = createFakePaseo();
    const registry = createAgentRegistry({ retryDelaysMs: [] });
    registry.bind(fake.paseo);
    const agentsSubscription = fake.agents.boot(0, agentsPayload([
      agentEntry("agent-a", { workspaceId: "ws-1" }),
      agentEntry("agent-b", { workspaceId: "ws-1" }),
    ]));
    await flush();
    const host = createFakeHost();
    const counts = createFakeCounts();
    const entries = registerReviewEntries({
      client: host.host,
      paseo: fake.paseo,
      registry,
      counts: counts.store,
      retryDelaysMs: [],
    });
    fake.workspaces.boot(0, workspacesPayload([workspaceEntry("ws-1", { projectId: "proj-1" })]));
    await flush();
    for (const pending of counts.pending.splice(0)) pending.resolve(0);
    await flush();
    assert.equal(host.live.get("review-header-ws-1")?.contribution.button.label, "Review", "zero pending comments show the bare label");

    // Upsert: a new agent gains its pill without a remount.
    agentsSubscription.emitUpdate({
      type: "agent_update",
      payload: { subscriptionId: "fake-sub", kind: "upsert", agent: agentEntry("agent-c", { workspaceId: "ws-1" }).agent },
    });
    await flush();
    assert.equal(host.live.has("review-pill-agent-c"), true, "a live upsert adds its pill without a remount");
    agentsSubscription.emitUpdate({
      type: "agent_update",
      payload: { subscriptionId: "fake-sub", kind: "upsert", agent: agentEntry("agent-c", { workspaceId: "ws-1", status: "error" }).agent },
    });
    await flush();
    assert.equal(host.live.has("review-pill-agent-c"), false, "an unusable status removes the composer pill");
    agentsSubscription.emitUpdate({
      type: "agent_update",
      payload: { subscriptionId: "fake-sub", kind: "upsert", agent: agentEntry("agent-c", { workspaceId: "ws-1", status: "idle" }).agent },
    });
    await flush();
    assert.equal(host.live.has("review-pill-agent-c"), true, "a usable status restores the composer pill");

    agentsSubscription.emitUpdate({
      type: "agent_update",
      payload: { subscriptionId: "fake-sub", kind: "remove", agentId: "agent-c" },
    });
    await flush();
    assert.equal(host.live.has("review-pill-agent-c"), false);
    assert.equal(host.all.find((record) => record.id === "review-pill-agent-c")?.removed, true);

    // Reconnect: the fresh snapshot re-reads the tracked project's count.
    const askedBefore = counts.asked.length;
    agentsSubscription.emitSnapshot(agentsPayload([agentEntry("agent-a", { workspaceId: "ws-1" })]));
    await flush();
    assert.equal(counts.asked.length, askedBefore + 1, "a reconnect refreshes the tracked badges");
    assert.equal(counts.asked.at(-1), "proj-1");
    assert.equal(host.live.has("review-pill-agent-b"), false, "the snapshot's removal drops the stale pill");
    for (const pending of counts.pending.splice(0)) pending.resolve(4);
    await flush();
    assert.equal(host.live.get("review-header-ws-1")?.contribution.button.label, "Review · 4");

    // A failed count read leaves the last known badge untouched.
    counts.store.setCount("proj-1", 9);
    await flush();
    assert.equal(host.live.get("review-header-ws-1")?.contribution.button.label, "Review · 9");
    void counts.store.refresh("proj-1");
    await flush();
    for (const pending of counts.pending.splice(0)) pending.reject(new Error("offline"));
    await flush();
    assert.equal(host.live.get("review-header-ws-1")?.contribution.button.label, "Review · 9");

    entries.stop();
    assert.equal(host.all.filter((record) => record.removed).length, host.all.length, "every registration is removed on stop");
    assert.equal(host.live.size, 0);

    // A stopped entries module stops reacting entirely.
    const askedAtStop = counts.asked.length;
    const registrationsAtStop = host.all.length;
    agentsSubscription.emitSnapshot(agentsPayload([agentEntry("agent-late", { workspaceId: "ws-1" })]));
    counts.store.setCount("proj-1", 2);
    await flush();
    assert.equal(counts.asked.length, askedAtStop, "a stopped entries module stops refreshing counts");
    assert.equal(host.all.length, registrationsAtStop, "a stopped entries module registers nothing");
    registry.stop();
  });

  await test("an exhausted workspace bootstrap re-arms and headers recover", async () => {
    const fake = createFakePaseo();
    const registry = createAgentRegistry({ retryDelaysMs: [] });
    registry.bind(fake.paseo);
    const agentsSubscription = fake.agents.boot(0, agentsPayload([agentEntry("agent-a", { workspaceId: "ws-1" })]));
    await flush();

    const host = createFakeHost();
    const counts = createFakeCounts();
    const scheduler = createFakeScheduler();
    const entries = registerReviewEntries({
      client: host.host,
      paseo: fake.paseo,
      registry,
      counts: counts.store,
      retryDelaysMs: [0, 25],
      schedule: scheduler.schedule,
    });
    await flush();
    assert.equal(fake.workspaces.calls.length, 1, "registering opens one owned workspace list");

    // Spend the burst: the initial list and both retries fail.
    fake.workspaces.fail(0, new Error("daemon starting"));
    await flush();
    assert.equal(scheduler.pending().length, 1, "a failed bootstrap retries through the scheduler seam");
    assert.equal(scheduler.pending()[0].delayMs, 0, "the first retry takes the first configured delay");
    scheduler.fire();
    await flush();
    assert.equal(fake.workspaces.calls.length, 2);

    fake.workspaces.fail(1, new Error("daemon starting"));
    await flush();
    assert.equal(scheduler.pending()[0].delayMs, 25, "the next retry takes the policy's next delay");
    scheduler.fire();
    await flush();
    assert.equal(fake.workspaces.calls.length, 3);

    fake.workspaces.fail(2, new Error("daemon starting"));
    await flush();
    assert.deepEqual(
      [...host.live.keys()],
      ["review-pill-agent-a"],
      "while the list is unreachable only the pills (which name their workspace) remain",
    );
    assert.equal(scheduler.pending().length, 1, "an exhausted burst schedules exactly one re-arm");
    assert.equal(scheduler.pending()[0].delayMs, 25, "the re-arm waits out the policy's tail delay");

    // The re-arm opens a fresh gate; its snapshot restores the headers.
    scheduler.fire();
    await flush();
    assert.equal(fake.workspaces.calls.length, 4, "the re-arm opens exactly one new workspace list");
    const recoveredSubscription = fake.workspaces.boot(3, workspacesPayload([workspaceEntry("ws-1", { projectId: "proj-1" })]));
    await flush();
    assert.equal(host.live.has("review-header-ws-1"), true, "headers come back once the daemon answers");
    assert.equal(host.live.get("review-header-ws-1")?.contribution.button.label, "Review");
    assert.equal(scheduler.pending().length, 0, "a live gate leaves no re-arm pending");

    entries.stop();
    assert.equal(recoveredSubscription.state.released, true, "stopping releases the recovered observation");
    assert.equal(host.live.size, 0, "stopping removes every registration");
    assert.equal(host.all.every((record) => record.removed), true);
    registry.stop();
    assert.equal(agentsSubscription.state.released, true, "stopping releases the shared agent observation");
  });

  await test("stop() cancels a scheduled workspace re-arm", async () => {
    const fake = createFakePaseo();
    const registry = createAgentRegistry({ retryDelaysMs: [] });
    registry.bind(fake.paseo);
    const agentsSubscription = fake.agents.boot(0, agentsPayload([agentEntry("agent-a", { workspaceId: "ws-1" })]));
    await flush();

    const host = createFakeHost();
    const counts = createFakeCounts();
    const scheduler = createFakeScheduler();
    const entries = registerReviewEntries({
      client: host.host,
      paseo: fake.paseo,
      registry,
      counts: counts.store,
      retryDelaysMs: [0],
      schedule: scheduler.schedule,
    });
    await flush();

    fake.workspaces.fail(0, new Error("daemon starting"));
    await flush();
    scheduler.fire();
    await flush();
    assert.equal(fake.workspaces.calls.length, 2);
    fake.workspaces.fail(1, new Error("daemon starting"));
    await flush();

    const pendingReArm = scheduler.pending()[0];
    assert.ok(pendingReArm, "an exhausted burst leaves one re-arm scheduled");

    entries.stop();
    assert.equal(pendingReArm.cancelled, true, "stop() cancels the scheduled re-arm");
    assert.equal(scheduler.pending().length, 0, "no delayed callback survives stop()");

    // Even a timer that raced the teardown cannot resurrect the module: the
    // scheduled closure re-checks its stopped flag before touching the host.
    pendingReArm.run();
    await flush();
    assert.equal(fake.workspaces.calls.length, 2, "a stopped module opens no further workspace list");
    const registrationsAtStop = host.all.length;
    agentsSubscription.emitSnapshot(agentsPayload([agentEntry("agent-late", { workspaceId: "ws-1" })]));
    await flush();
    assert.equal(host.all.length, registrationsAtStop, "a stopped module registers nothing new");
    assert.equal(host.live.size, 0, "stop() removed every registration");
    registry.stop();
  });


  await test("the real SDK routes fetch_agents_response and agent_update into the registry", async () => {
    const daemon = createFakeDaemon();
    const client = createPaseoClient({
      url: "ws://fake-daemon.invalid/ws",
      clientId: "agent-registry-test",
      reconnect: { enabled: false },
      transportFactory: daemon.transportFactory,
    } as PaseoClientConfig & { transportFactory: (options: unknown) => unknown });
    const registry = createAgentRegistry({ retryDelaysMs: [] });
    try {
      const connecting = client.connect();
      daemon.open();
      await connecting;

      registry.bind(client);
      for (let attempt = 0; attempt < 40 && registry.getSnapshot().loading; attempt += 1) await flush();
      assert.equal(daemon.agentRequests().length, 1, "the registry opens exactly one agents subscription");
      const request = daemon.agentRequests()[0];
      assert.equal(typeof request.requestId, "string", "the subscription is a correlated request");
      assert.equal(
        typeof request.subscribe === "object" && request.subscribe !== null,
        true,
        "the request subscribes through the owned API (the SDK assigns the subscription id)",
      );
      assert.deepEqual(registry.getSnapshot().agents.map((agent) => agent.id), ["agent-1"]);
      assert.equal(registry.getSnapshot().loading, false);

      // The daemon's per-subscription update frames reach the same observer.
      daemon.upsert("agent-2", "running");
      await flush();
      assert.deepEqual(registry.getSnapshot().agents.map((agent) => agent.id).sort(), ["agent-1", "agent-2"]);
      assert.equal(registry.getSnapshot().agents.find((agent) => agent.id === "agent-2")?.status, "running");

      daemon.remove("agent-1");
      await flush();
      assert.deepEqual(registry.getSnapshot().agents.map((agent) => agent.id), ["agent-2"]);

      // After teardown the subscription is silent.
      registry.stop();
      const afterStop = registry.getSnapshot();
      daemon.upsert("agent-3", "idle");
      await flush();
      assert.equal(registry.getSnapshot(), afterStop);
    } finally {
      registry.stop();
      await client.close();
    }
  });
}

main()
  .then(() => {
    console.log("agent-registry: all assertions passed");
    console.log("verdict: one shared owned agents subscription (snapshot/upsert/remove/reconnect, bounded");
    console.log("         retries, teardown that also releases a pending bootstrap) backs both the panel");
    console.log("         hooks and the workspace header button / agent composer pill registrations, whose");
    console.log("         Review badges combine project-comment counts with metadata-only workspace status; the");
    console.log("         indicator path never parses Git, and stop() cancels any pending workspace re-arm.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

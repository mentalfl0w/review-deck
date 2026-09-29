/**
 * Test harness for client hooks under plain Node.
 *
 * Provides a minimal React hook runner (state, ref, memo, callback, effect),
 * CommonJS module doubles for `react` and `@getpaseo/plugin/client` (the two
 * modules the hooks import by name), a fake clock for interval-driven logic,
 * and `mountWatcher`.
 *
 * The doubles are installed as a side effect of importing this module: the
 * compiled CommonJS require order follows the import order, so a test must
 * import this harness BEFORE the hook under test, and the hook then resolves
 * `react` to the runner below. Both specifiers are static — the harness only
 * decides what they resolve to, not which module is loaded.
 */
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";

type HookCell = {
  kind: "state" | "ref" | "memo" | "callback" | "effect";
  deps?: readonly unknown[] | undefined;
  value?: unknown;
  initialized?: boolean;
  pending?: boolean;
  cleanup?: (() => void) | undefined;
};

let cells: HookCell[] = [];
let cursor = 0;
let scheduled = false;
let mountedHook: ((props: unknown) => unknown) | null = null;
let mountedProps: unknown;
let mountedValue: unknown = null;

function cell(kind: HookCell["kind"]): HookCell {
  const existing = cells[cursor];
  cursor += 1;
  if (existing === undefined) {
    const created: HookCell = { kind };
    cells.push(created);
    return created;
  }
  assert.equal(existing.kind, kind, `the hook order changed between renders (${existing.kind} -> ${kind})`);
  return existing;
}

function sameDeps(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function scheduleRender(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    if (!scheduled) return;
    scheduled = false;
    renderHarness();
  });
}

function flushEffects(): void {
  for (const slot of cells) {
    if (slot.kind !== "effect" || !slot.pending) continue;
    slot.pending = false;
    slot.cleanup?.();
    const cleanup = (slot.value as () => void | (() => void))();
    slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
  }
}

function renderHarness(): unknown {
  assert.ok(mountedHook !== null, "mount the harness before rendering");
  const hook = mountedHook;
  cursor = 0;
  mountedValue = hook(mountedProps);
  flushEffects();
  return mountedValue;
}

function unmountHarness(): void {
  for (const slot of cells) {
    if (slot.kind === "effect" && slot.initialized) slot.cleanup?.();
  }
  cells = [];
  cursor = 0;
  scheduled = false;
  mountedHook = null;
  mountedProps = undefined;
  mountedValue = null;
}

function memoizedCell<T>(kind: "memo" | "callback", factory: () => T, deps?: readonly unknown[]): T {
  const slot = cell(kind);
  if (!slot.initialized || !sameDeps(slot.deps, deps)) {
    slot.initialized = true;
    slot.deps = deps;
    slot.value = factory();
  }
  return slot.value as T;
}

const fakeReact = {
  useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] {
    const slot = cell("state");
    if (!slot.initialized) {
      slot.initialized = true;
      slot.value = typeof initial === "function" ? (initial as () => T)() : initial;
    }
    const setter = (next: T | ((previous: T) => T)) => {
      const value = typeof next === "function" ? (next as (previous: T) => T)(slot.value as T) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      scheduleRender();
    };
    return [slot.value as T, setter];
  },
  useRef<T>(initial: T): { current: T } {
    const slot = cell("ref");
    if (!slot.initialized) {
      slot.initialized = true;
      slot.value = { current: initial };
    }
    return slot.value as { current: T };
  },
  useMemo<T>(factory: () => T, deps?: readonly unknown[]): T {
    return memoizedCell("memo", factory, deps);
  },
  useCallback<T>(callback: T, deps?: readonly unknown[]): T {
    return memoizedCell("callback", () => callback, deps);
  },
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
    const slot = cell("effect");
    const shouldRun = !slot.initialized || deps === undefined || !sameDeps(slot.deps, deps);
    slot.initialized = true;
    slot.deps = deps;
    slot.value = effect;
    if (shouldRun) slot.pending = true;
  },
};

const rpcCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
const rpcStubs = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
const rpcClients = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();

const fakePluginClient = {
  // Mirrors the SDK's useRpc: one stable client per contract, memoized across
  // renders (hook effects depend on that stability).
  useRpc(contract: { name: string }): (input: Record<string, unknown>) => Promise<unknown> {
    let client = rpcClients.get(contract.name);
    if (client === undefined) {
      client = (input: Record<string, unknown>) => {
        rpcCalls.push({ name: contract.name, input });
        const stub = rpcStubs.get(contract.name);
        assert.ok(stub !== undefined, `no test double registered for ${contract.name}`);
        return stub(input);
      };
      rpcClients.set(contract.name, client);
    }
    return client;
  },
};

// Reason: the CJS module cache is not part of Node's public typings, and the
// doubles must replace the modules before any hook module is required.
const moduleInternals = Module as unknown as { _cache: Record<string, unknown> };
const requireFromHarness = createRequire(__filename);

function installModuleDouble(specifier: string, moduleExports: unknown): void {
  const resolved = requireFromHarness.resolve(specifier);
  moduleInternals._cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: moduleExports };
}

/** Install the module doubles; also runs as an import side effect. */
export function installModuleDoubles(): void {
  installModuleDouble("react", fakeReact);
  installModuleDouble("@getpaseo/plugin/client", fakePluginClient);
}

export function registerRpcStub(name: string, stub: (input: Record<string, unknown>) => Promise<unknown>): void {
  rpcStubs.set(name, stub);
}

export function rpcCallCount(name: string): number {
  return rpcCalls.filter((call) => call.name === name).length;
}

export function lastRpcInput(name: string): Record<string, unknown> | undefined {
  return [...rpcCalls].reverse().find((call) => call.name === name)?.input;
}

export function flushMicrotasks(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/** Fake clock for interval-driven hooks: only setInterval/clearInterval are
 * replaced (setImmediate stays real for flushMicrotasks). */
export function installFakeClock(): { advance(milliseconds: number): void; restore(): void } {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let now = 0;
  let nextId = 1;
  const intervals = new Map<number, { everyMs: number; nextAt: number; callback: () => void }>();
  globalThis.setInterval = ((callback: () => void, everyMs?: number) => {
    const period = everyMs ?? 1;
    const id = nextId++;
    intervals.set(id, { everyMs: period, nextAt: now + period, callback });
    return id;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id?: unknown) => {
    intervals.delete(Number(id));
  }) as unknown as typeof clearInterval;
  return {
    advance(milliseconds: number) {
      now += milliseconds;
      for (const [id, timer] of [...intervals]) {
        while (timer.nextAt <= now) {
          timer.nextAt += timer.everyMs;
          if (intervals.has(id)) timer.callback();
        }
      }
    },
    restore() {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    },
  };
}

/**
 * Render one hook function with real hook semantics, no renderer: effects run
 * after the render body in declaration order, state updates schedule a
 * microtask re-render, and refs/memos/callbacks keep their identity by deps.
 */
export function mountWatcher<Props, Api>(hook: (props: Props) => Api, props: Props): {
  value: Api;
  setProps(next: Props): void;
  unmount(): void;
} {
  unmountHarness();
  // Reason: the runner is hook-agnostic; the generic boundary retypes its
  // erased slots back to the hook's own Props/Api.
  mountedHook = hook as (props: unknown) => unknown;
  mountedProps = props;
  renderHarness();
  return {
    get value(): Api {
      assert.ok(mountedValue !== null, "no render has completed");
      return mountedValue as Api;
    },
    setProps(next: Props) {
      mountedProps = next;
      renderHarness();
    },
    unmount: unmountHarness,
  };
}

installModuleDoubles();

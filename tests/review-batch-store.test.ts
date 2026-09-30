/**
 * Persistence contract for ReviewBatches (v1.5).
 *
 * `review-batches.json` is a strict version-1 envelope
 * (`{ version: 1, batches }`) holding every batch, oldest first. A document
 * that is not valid JSON, declares another version, or fails batch validation
 * raises ReviewBatchStoreError and is left byte-identical, so a damaged store
 * is visible rather than quietly reset; only ENOENT means "nothing stored yet".
 *
 * Writes are serialized per store instance and land through a same-directory
 * temp file renamed into place, so concurrent creates cannot lose entries and
 * cannot leave `.tmp` files behind. Two invariants are enforced on write:
 * batch ids are unique, and at most one in-flight batch exists per workspace,
 * agent, or comment id. Terminal batches stay on disk but never count as active.
 *
 * Run: node tests/review-batch-store.test.ts
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import type { ReviewBatch } from "../shared/review-batch";
import type { ReviewBatchStoreOptions } from "../server/persistence/ReviewBatchStore";

type Store = {
  list(): Promise<ReviewBatch[]>;
  listByProject(projectId: string): Promise<ReviewBatch[]>;
  listActiveByProject(projectId: string): Promise<ReviewBatch[]>;
  findActiveForAgent(agentId: string): Promise<ReviewBatch | null>;
  create(batch: ReviewBatch): Promise<ReviewBatch>;
  update(id: string, transform: (batch: ReviewBatch) => ReviewBatch | Promise<ReviewBatch>): Promise<ReviewBatch | null>;
};

// Production modules use bundler-style extensionless imports, which node's
// type stripping does not resolve; this test loads the real server module, so
// relative specifiers without an extension get the .ts extension here.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && extname(specifier) === "") {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

// The domain types come from the type-only imports above (erased at runtime,
// checked by tsc); the runtime values are required at their real path.
const requireFromRepo = createRequire(import.meta.url);
const { DEFAULT_REVIEW_BATCH_PATH, REVIEW_BATCH_VERSION, ReviewBatchStore, ReviewBatchStoreError } =
  requireFromRepo("../server/persistence/ReviewBatchStore.ts") as {
    DEFAULT_REVIEW_BATCH_PATH: string;
    REVIEW_BATCH_VERSION: number;
    ReviewBatchStore: new (options?: ReviewBatchStoreOptions | string) => Store;
    ReviewBatchStoreError: new (message: string, options?: ErrorOptions) => Error;
  };

const ISO = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:05:00.000Z";

const root = await mkdtemp(join(tmpdir(), "review-deck-batch-store-"));
const storePath = join(root, "nested", "review-batches.json");
const store = (path: string = storePath) => new ReviewBatchStore(path);

const batch = (id: string, overrides: Partial<ReviewBatch> = {}): ReviewBatch => ({
  id,
  createdAt: ISO,
  projectId: "project-1",
  workspaceId: `workspace-${id}`,
  agentId: `agent-${id}`,
  commentIds: [`comment-${id}`],
  status: "draft",
  outcomes: {},
  ...overrides,
});

const finished = (id: string, overrides: Partial<ReviewBatch> = {}): ReviewBatch =>
  batch(id, {
    status: "completed",
    submittedAt: ISO,
    completedAt: LATER,
    outcomes: { [`comment-${id}`]: "completed" },
    ...overrides,
  });

const readRaw = (path: string) => readFile(path, "utf8");
const readStore = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as { version: number; batches: ReviewBatch[] };
const tempFiles = async (path: string) => {
  try {
    return (await readdir(dirname(path))).filter((name) => name.endsWith(".tmp"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

try {
  // -------------------------------------------------------------------------
  // 0. Contract constants: the default path sits beside the review store.
  // -------------------------------------------------------------------------
  assert.strictEqual(REVIEW_BATCH_VERSION, 1);
  assert.ok(DEFAULT_REVIEW_BATCH_PATH.endsWith(join("review-deck", "review-batches.json")));
  // All three constructor forms are accepted; the no-arg form is never written.
  assert.ok(new ReviewBatchStore() instanceof ReviewBatchStore);
  assert.ok(new ReviewBatchStore(storePath) instanceof ReviewBatchStore);
  assert.ok(new ReviewBatchStore({ storagePath: storePath }) instanceof ReviewBatchStore);

  // -------------------------------------------------------------------------
  // 1. A store that was never written is empty and is not created.
  // -------------------------------------------------------------------------
  const fresh = store();
  assert.deepStrictEqual(await fresh.list(), []);
  assert.deepStrictEqual(await fresh.listByProject("project-1"), []);
  assert.deepStrictEqual(await fresh.listActiveByProject("project-1"), []);
  assert.strictEqual(await fresh.findActiveForAgent("agent-batch-1"), null);
  await assert.rejects(readRaw(storePath), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.deepStrictEqual(await tempFiles(storePath), []);

  // -------------------------------------------------------------------------
  // 2. create writes a strict version-1 envelope and the batch is durable
  //    across instances; queries filter by project and by activity.
  // -------------------------------------------------------------------------
  assert.deepStrictEqual(await fresh.create(batch("batch-1")), batch("batch-1"));
  const stored = await readStore(storePath);
  assert.deepStrictEqual(Object.keys(stored), ["version", "batches"]);
  assert.deepStrictEqual(stored, { version: REVIEW_BATCH_VERSION, batches: [batch("batch-1")] });

  await fresh.create(batch("batch-2", { projectId: "project-2" }));
  // Newest batch is appended, so the file order is the creation order.
  assert.deepStrictEqual((await store().list()).map((entry) => entry.id), ["batch-1", "batch-2"]);
  assert.deepStrictEqual(
    (await new ReviewBatchStore({ storagePath: storePath }).list()).map((entry) => entry.id),
    ["batch-1", "batch-2"],
  );
  assert.deepStrictEqual((await fresh.listByProject("project-2")).map((entry) => entry.id), ["batch-2"]);
  assert.deepStrictEqual(await fresh.listByProject("project-absent"), []);
  assert.deepStrictEqual((await fresh.listActiveByProject("project-1")).map((entry) => entry.id), ["batch-1"]);
  assert.deepStrictEqual(await fresh.listActiveByProject("project-2").then((entries) => entries.map((e) => e.id)), [
    "batch-2",
  ]);
  assert.deepStrictEqual(await fresh.findActiveForAgent("agent-batch-1"), batch("batch-1"));
  assert.strictEqual(await fresh.findActiveForAgent("agent-nobody"), null);
  assert.deepStrictEqual(await tempFiles(storePath), []);

  // -------------------------------------------------------------------------
  // 3. create validates before touching the file: an invalid batch neither
  //    lands nor creates a store, and never disturbs a valid one.
  // -------------------------------------------------------------------------
  const strictPath = join(root, "strict", "review-batches.json");
  const strict = store(strictPath);
  const invalidBatches = [
    batch("", {}),
    { ...batch("batch-x"), projectId: undefined },
    { ...batch("batch-x"), commentIds: [] },
    { ...batch("batch-x"), commentIds: ["comment-x", "comment-x"] },
    { ...batch("batch-x"), outcomes: { "comment-other": "completed" } },
    { ...batch("batch-x"), outcomes: { "comment-x": "skipped" } },
    { ...batch("batch-x"), status: "queued" },
    { ...batch("batch-x"), status: "submitted" },
    { ...batch("batch-x"), status: "completed", submittedAt: ISO, outcomes: { "comment-x": "completed" } },
    // `failed` is the one terminal status that does not need submittedAt.
    { ...batch("batch-x"), status: "failed", completedAt: LATER },
    batch("batch-x", { completedAt: LATER }),
    { ...batch("batch-x"), futureField: true },
  ] as unknown as ReviewBatch[];
  for (const invalid of invalidBatches) {
    await assert.rejects(
      strict.create(invalid),
      (error) => error instanceof ReviewBatchStoreError && error.message.includes(strictPath),
      `create must reject an invalid batch: ${JSON.stringify(invalid).slice(0, 60)}`,
    );
  }
  await assert.rejects(readRaw(strictPath), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.deepStrictEqual(await tempFiles(strictPath), []);

  const validBeforeInvalidCreate = await readRaw(storePath);
  await assert.rejects(
    fresh.create({ ...batch("batch-3"), workspaceId: "" } as unknown as ReviewBatch),
    (error) => error instanceof ReviewBatchStoreError,
  );
  assert.strictEqual(await readRaw(storePath), validBeforeInvalidCreate);

  // -------------------------------------------------------------------------
  // 4. A duplicate id is rejected across the whole file, not per project.
  // -------------------------------------------------------------------------
  await assert.rejects(
    fresh.create(batch("batch-1")),
    (error) => error instanceof ReviewBatchStoreError && error.message.includes("already stores"),
  );
  await assert.rejects(
    fresh.create(batch("batch-1", { projectId: "project-9" })),
    (error) => error instanceof ReviewBatchStoreError,
  );
  assert.strictEqual(await readRaw(storePath), validBeforeInvalidCreate);

  // -------------------------------------------------------------------------
  // 5. At most one in-flight batch per agent; a terminal batch frees the agent.
  // -------------------------------------------------------------------------
  const agentPath = join(root, "agent", "review-batches.json");
  const agents = store(agentPath);
  await agents.create(batch("a1", { agentId: "agent-x" }));
  await assert.rejects(
    agents.create(batch("a2", { agentId: "agent-x", commentIds: ["comment-a2"] })),
    (error) => error instanceof ReviewBatchStoreError && error.message.includes("agent-x"),
  );
  // Another agent with disjoint comments is fine.
  await agents.create(batch("a3", { agentId: "agent-y", commentIds: ["comment-a3"] }));
  assert.deepStrictEqual((await agents.list()).map((entry) => entry.id), ["a1", "a3"]);

  await agents.update("a1", (entry) => ({
    ...entry,
    status: "completed",
    submittedAt: ISO,
    completedAt: LATER,
    outcomes: { "comment-a1": "completed" },
  }));
  await agents.create(batch("a4", { agentId: "agent-x", commentIds: ["comment-a4"] }));
  assert.deepStrictEqual((await agents.list()).map((entry) => entry.id), ["a1", "a3", "a4"]);
  assert.deepStrictEqual(await agents.findActiveForAgent("agent-x"), batch("a4", { agentId: "agent-x" }));
  assert.deepStrictEqual((await agents.findActiveForAgent("agent-y"))?.id, "a3");

  // -------------------------------------------------------------------------
  // 6. A workspace, Agent, or comment id can have only one in-flight batch;
  //    terminal batches do not block a new active batch.
  // -------------------------------------------------------------------------
  const overlapPath = join(root, "overlap", "review-batches.json");
  const overlaps = store(overlapPath);
  await overlaps.create(batch("o1", { agentId: "agent-p", commentIds: ["comment-1", "comment-2"] }));
  await assert.rejects(
    overlaps.create(batch("o-same-workspace", {
      agentId: "agent-q",
      workspaceId: "workspace-o1",
      commentIds: ["comment-other"],
    })),
    (error) => error instanceof ReviewBatchStoreError && error.message.includes("workspace-o1"),
  );
  await assert.rejects(
    overlaps.create(batch("o2", { agentId: "agent-q", commentIds: ["comment-3", "comment-2"] })),
    (error) => error instanceof ReviewBatchStoreError && error.message.includes("comment-2"),
  );
  assert.deepStrictEqual((await overlaps.list()).map((entry) => entry.id), ["o1"]);

  await overlaps.update("o1", (entry) => ({
    ...entry,
    status: "partial",
    submittedAt: ISO,
    completedAt: LATER,
    outcomes: { "comment-1": "completed", "comment-2": "stale" },
  }));
  await overlaps.create(batch("o3", { agentId: "agent-q", commentIds: ["comment-2"] }));
  // A terminal batch may still be duplicated in spirit: it holds the comment
  // only for history, so a new active claim wins.
  await overlaps.create(finished("o4", { agentId: "agent-r" }));
  await overlaps.create(batch("o5", { agentId: "agent-s", commentIds: ["comment-o4"] }));
  assert.deepStrictEqual((await overlaps.list()).map((entry) => entry.id), ["o1", "o3", "o4", "o5"]);
  assert.deepStrictEqual(
    (await overlaps.listActiveByProject("project-1")).map((entry) => entry.id),
    ["o3", "o5"],
  );
  // Terminal batches stay stored: the file keeps them and a plain list shows them.
  assert.strictEqual((await readStore(overlapPath)).batches.length, 4);
  assert.strictEqual((await overlaps.list()).length, 4);

  // -------------------------------------------------------------------------
  // 7. update validates, persists atomically, and returns null for an absent id
  //    without rewriting the file.
  // -------------------------------------------------------------------------
  const updatePath = join(root, "update", "review-batches.json");
  const updates = store(updatePath);
  await updates.create(batch("u1"));
  const submitted = await updates.update("u1", (entry) => ({ ...entry, status: "submitted", submittedAt: ISO }));
  assert.deepStrictEqual(submitted, batch("u1", { status: "submitted", submittedAt: ISO }));
  assert.deepStrictEqual((await store(updatePath).list())[0], submitted);
  // The transformed batch is the stored one, not a reference to the caller's.
  assert.deepStrictEqual(await updates.update("u1", async (entry) => entry), submitted);

  const beforeAbsentUpdate = await readRaw(updatePath);
  assert.strictEqual(await updates.update("absent", (entry) => entry), null);
  assert.strictEqual(
    await updates.update("absent", () => {
      throw new Error("the transform must not run for an absent id");
    }),
    null,
  );
  assert.strictEqual(await readRaw(updatePath), beforeAbsentUpdate);
  assert.deepStrictEqual(await tempFiles(updatePath), []);

  const running = await updates.update("u1", (entry) => ({ ...entry, status: "running" }));
  assert.strictEqual(running?.status, "running");
  const beforeInvalidUpdate = await readRaw(updatePath);
  await assert.rejects(
    updates.update("u1", (entry) => ({ ...entry, completedAt: LATER })),
    (error) => error instanceof ReviewBatchStoreError && error.message.includes(updatePath),
  );
  assert.strictEqual(await readRaw(updatePath), beforeInvalidUpdate, "an invalid update must not write");

  const completed = await updates.update("u1", (entry) => ({
    ...entry,
    status: "completed",
    completedAt: LATER,
    outcomes: { "comment-u1": "completed" },
  }));
  assert.deepStrictEqual(completed, finished("u1"));
  assert.deepStrictEqual(await store(updatePath).list(), [finished("u1")]);
  assert.deepStrictEqual(await updates.listActiveByProject("project-1"), []);
  assert.strictEqual(await updates.findActiveForAgent("agent-u1"), null);
  assert.deepStrictEqual((await updates.listByProject("project-1")).map((entry) => entry.id), ["u1"]);
  assert.deepStrictEqual(await tempFiles(updatePath), []);

  // A rename is allowed; a rename onto an existing id is not.
  await updates.create(batch("u2"));
  const renamed = await updates.update("u2", (entry) => ({ ...entry, id: "u2-renamed" }));
  assert.strictEqual(renamed?.id, "u2-renamed");
  assert.strictEqual(await updates.update("u2", (entry) => entry), null);
  assert.deepStrictEqual((await updates.list()).map((entry) => entry.id), ["u1", "u2-renamed"]);
  await updates.create(batch("u3"));
  await assert.rejects(
    updates.update("u3", (entry) => ({ ...entry, id: "u2-renamed" })),
    (error) => error instanceof ReviewBatchStoreError && error.message.includes("u2-renamed"),
  );

  // update cannot mint a second active claim for an Agent, workspace, or comment.
  const claimPath = join(root, "claim", "review-batches.json");
  const claims = store(claimPath);
  await claims.create(batch("k1", { agentId: "agent-k", commentIds: ["comment-k1"] }));
  await claims.create(batch("k2", { agentId: "agent-l", commentIds: ["comment-k2"] }));
  await assert.rejects(
    claims.update("k2", (entry) => ({ ...entry, agentId: "agent-k" })),
    (error) => error instanceof ReviewBatchStoreError && error.message.includes("agent-k"),
  );
  await assert.rejects(
    claims.update("k2", (entry) => ({ ...entry, workspaceId: "workspace-k1" })),
    (error) => error instanceof ReviewBatchStoreError && error.message.includes("workspace-k1"),
  );
  await assert.rejects(
    claims.update("k2", (entry) => ({ ...entry, commentIds: ["comment-k2", "comment-k1"] })),
    (error) => error instanceof ReviewBatchStoreError && error.message.includes("comment-k1"),
  );
  assert.deepStrictEqual((await readStore(claimPath)).batches.map((entry) => entry.id), ["k1", "k2"]);

  // -------------------------------------------------------------------------
  // 8. Fail closed: a malformed, unsupported, or duplicate-id document is
  //    reported by every operation and preserved byte for byte.
  // -------------------------------------------------------------------------
  const damagedPath = join(root, "damaged", "review-batches.json");
  const damaged = store(damagedPath);
  await mkdir(dirname(damagedPath), { recursive: true });
  const damagedDocuments = [
    '{ "version": 1, "batches": [ ',
    "",
    " \n\t ",
    "[]",
    "null",
    JSON.stringify({ batches: [] }),
    JSON.stringify({ version: REVIEW_BATCH_VERSION + 1, batches: [] }),
    JSON.stringify({ version: "1", batches: [] }),
    JSON.stringify({ version: REVIEW_BATCH_VERSION, batches: {} }),
    JSON.stringify({ version: REVIEW_BATCH_VERSION, extra: true, batches: [] }),
    JSON.stringify({ version: REVIEW_BATCH_VERSION, batches: [{ ...batch("x"), futureField: true }] }),
    JSON.stringify({ version: REVIEW_BATCH_VERSION, batches: [{ ...batch("x"), status: "queued" }] }),
    JSON.stringify({ version: REVIEW_BATCH_VERSION, batches: [{ ...batch("x"), submittedAt: "not-a-date" }] }),
    JSON.stringify({ version: REVIEW_BATCH_VERSION, batches: [{ ...batch("x"), commentIds: [] }] }),
    JSON.stringify({ version: REVIEW_BATCH_VERSION, batches: [batch("dup"), batch("dup", { agentId: "agent-dup-2" })] }),
  ];
  for (const document of damagedDocuments) {
    await writeFile(damagedPath, document, "utf8");
    const readers: Array<() => Promise<unknown>> = [
      () => damaged.list(),
      () => damaged.listByProject("project-1"),
      () => damaged.listActiveByProject("project-1"),
      () => damaged.findActiveForAgent("agent-x"),
      () => damaged.create(batch("batch-new")),
      () => damaged.update("x", (entry) => entry),
    ];
    for (const read of readers) {
      await assert.rejects(
        read(),
        (error) => error instanceof ReviewBatchStoreError && error.message.includes(damagedPath),
        `every operation must report the damaged store: ${document.slice(0, 40)}`,
      );
    }
    assert.strictEqual(
      await readRaw(damagedPath),
      document,
      `the damaged store must stay byte-identical: ${document.slice(0, 40)}`,
    );
    assert.deepStrictEqual(await tempFiles(damagedPath), []);
  }

  // 8b. A store path that is not a file is an error, not an empty store.
  await assert.rejects(store(root).list(), (error) => error instanceof ReviewBatchStoreError);

  // -------------------------------------------------------------------------
  // 9. Concurrent read-modify-write cycles are serialized: no create is lost,
  //    no conflicting create slips through, and no temp file survives.
  // -------------------------------------------------------------------------
  const concurrentPath = join(root, "concurrent", "review-batches.json");
  const concurrent = store(concurrentPath);
  const writers = 25;
  await Promise.all(
    Array.from({ length: writers }, (_, index) =>
      concurrent.create(batch(`c-${index}`, { agentId: `agent-c-${index}`, commentIds: [`comment-c-${index}`] })),
    ),
  );
  const concurrentEntries = await concurrent.list();
  assert.strictEqual(concurrentEntries.length, writers);
  assert.deepStrictEqual(
    concurrentEntries.map((entry) => entry.id),
    Array.from({ length: writers }, (_, index) => `c-${index}`),
  );
  assert.deepStrictEqual(await tempFiles(concurrentPath), []);

  // 9b. Racing creates that claim the same agent and comment: exactly one lands.
  const races = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) =>
      concurrent.create(batch(`race-${index}`, { agentId: "agent-race", commentIds: ["comment-race"] })),
    ),
  );
  assert.strictEqual(races.filter((result) => result.status === "fulfilled").length, 1);
  assert.strictEqual(races.filter((result) => result.status === "rejected").length, 4);
  assert.strictEqual((await concurrent.list()).filter((entry) => entry.agentId === "agent-race").length, 1);
  assert.deepStrictEqual(await tempFiles(concurrentPath), []);

  // 9c. Concurrent updates to one batch accumulate every outcome.
  const mergePath = join(root, "merge", "review-batches.json");
  const merge = store(mergePath);
  const commentIds = Array.from({ length: 20 }, (_, index) => `mc-${index}`);
  await merge.create(batch("m-1", { agentId: "agent-m", status: "running", submittedAt: ISO, commentIds }));
  await Promise.all(
    commentIds.map((commentId) =>
      merge.update("m-1", (entry) => ({ ...entry, outcomes: { ...entry.outcomes, [commentId]: "completed" } })),
    ),
  );
  const merged = (await merge.list())[0];
  assert.deepStrictEqual(Object.keys(merged.outcomes).sort(), [...commentIds].sort());
  assert.ok(Object.values(merged.outcomes).every((outcome) => outcome === "completed"));
  assert.deepStrictEqual(await tempFiles(mergePath), []);

  // 9d. Reads racing writes still observe a complete store.
  const [listed, ...rest] = await Promise.all([concurrent.list(), concurrent.listByProject("project-1")]);
  assert.strictEqual(listed.length, writers + 1);
  assert.strictEqual(rest[0].length, writers + 1);
  assert.deepStrictEqual(await tempFiles(concurrentPath), []);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("review-batch-store: all assertions passed");

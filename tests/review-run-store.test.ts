/**
 * Persistence contract for transient AI review runs (v1.6).
 *
 * `runs.json` is a strict version-1 envelope (`{ version: 1, runs }`) holding
 * every run, oldest first. A document that is not valid JSON, declares another
 * version, or fails run validation raises ReviewRunStoreError and is left
 * byte-identical, so a damaged store is visible rather than quietly reset; only
 * ENOENT means "nothing stored yet". A run holds identifiers, the review mode,
 * the run status, the prompt/schema versions, the v1.7 completion/read metadata
 * (completedAt, findingCount, highRiskFindingCount, readAt), and the
 * non-content reviewer metadata needed to rebuild the transient entry — never
 * prompt text, diff patches, review output, or cached result bodies, and the
 * strict schema rejects any document that tries to smuggle one in. The v1.7
 * keys are optional, so a document written before v1.7 loads unchanged.
 *
 * Writes are serialized per store instance and land through a same-directory
 * temp file renamed into place, so concurrent creates cannot lose entries and
 * cannot leave `.tmp` files behind. Request ids are unique across the file;
 * `update` and `remove` of an absent id return null without rewriting, so
 * unrelated runs are never disturbed.
 *
 * Run: node tests/review-run-store.test.ts
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import type { ReviewRun, ReviewRunStoreOptions } from "../server/persistence/ReviewRunStore";

type Store = {
  list(): Promise<ReviewRun[]>;
  get(requestId: string): Promise<ReviewRun | null>;
  create(run: ReviewRun): Promise<ReviewRun>;
  update(requestId: string, transform: (run: ReviewRun) => ReviewRun | Promise<ReviewRun>): Promise<ReviewRun | null>;
  remove(requestId: string): Promise<ReviewRun | null>;
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
const { DEFAULT_REVIEW_RUN_PATH, REVIEW_RUN_VERSION, ReviewRunStore, ReviewRunStoreError } = requireFromRepo(
  "../server/persistence/ReviewRunStore.ts",
) as {
  DEFAULT_REVIEW_RUN_PATH: string;
  REVIEW_RUN_VERSION: number;
  ReviewRunStore: new (options?: ReviewRunStoreOptions | string) => Store;
  ReviewRunStoreError: new (message: string, options?: ErrorOptions) => Error;
};

const ISO = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:05:00.000Z";

const root = await mkdtemp(join(tmpdir(), "review-deck-run-store-"));
const storePath = join(root, "nested", "runs.json");
const store = (path: string = storePath) => new ReviewRunStore(path);

const run = (requestId: string, overrides: Partial<ReviewRun> = {}): ReviewRun => ({
  requestId,
  childAgentId: `child-${requestId}`,
  parentAgentId: "parent-1",
  workspaceId: `workspace-${requestId}`,
  cacheKey: `cache-${requestId}`,
  mode: "hunk",
  status: "running",
  resultSource: "fresh",
  startedAt: ISO,
  locale: "en",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  thinkingOptionId: "high",
  reviewerPermissionMode: "read-only",
  depth: "targeted",
  reviewPreset: "balanced",
  cacheEnabled: true,
  inputFingerprint: `fingerprint-${requestId}`,
  promptVersion: 4,
  schemaVersion: 2,
  ...overrides,
});
const cachedRun = (requestId: string, overrides: Partial<ReviewRun> = {}): ReviewRun =>
  run(requestId, {
    childAgentId: null,
    status: "completed",
    resultSource: "cached",
    ...overrides,
  });

/** The narrowest run the store must accept: no optional recovery metadata. */
const minimal = (requestId: string, overrides: Partial<ReviewRun> = {}): ReviewRun => {
  const { locale, depth, reviewPreset, inputFingerprint, ...rest } = run(requestId);
  return { ...rest, ...overrides };
};

const readRaw = (path: string) => readFile(path, "utf8");
const readStore = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as { version: number; runs: ReviewRun[] };
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
  // 0. Contract constants: the default path sits beside the batch store.
  // -------------------------------------------------------------------------
  assert.strictEqual(REVIEW_RUN_VERSION, 1);
  assert.ok(DEFAULT_REVIEW_RUN_PATH.endsWith(join("review-deck", "runs.json")));
  // All three constructor forms are accepted; the no-arg form is never written.
  assert.ok(new ReviewRunStore() instanceof ReviewRunStore);
  assert.ok(new ReviewRunStore(storePath) instanceof ReviewRunStore);
  assert.ok(new ReviewRunStore({ storagePath: storePath }) instanceof ReviewRunStore);

  // -------------------------------------------------------------------------
  // 1. A store that was never written is empty and is not created; reading or
  //    removing an absent id never creates the file.
  // -------------------------------------------------------------------------
  const fresh = store();
  assert.deepStrictEqual(await fresh.list(), []);
  assert.strictEqual(await fresh.get("absent"), null);
  assert.strictEqual(await fresh.remove("absent"), null);
  await assert.rejects(readRaw(storePath), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.deepStrictEqual(await tempFiles(storePath), []);

  // -------------------------------------------------------------------------
  // 2. create writes a strict version-1 envelope and the run is durable across
  //    instances, in creation order.
  // -------------------------------------------------------------------------
  assert.deepStrictEqual(await fresh.create(run("r1")), run("r1"));
  const stored = await readStore(storePath);
  assert.deepStrictEqual(Object.keys(stored), ["version", "runs"]);
  assert.deepStrictEqual(stored, { version: REVIEW_RUN_VERSION, runs: [run("r1")] });

  await fresh.create(run("r2", { mode: "file", status: "completed", startedAt: LATER }));
  assert.deepStrictEqual((await store().list()).map((entry) => entry.requestId), ["r1", "r2"]);
  assert.deepStrictEqual(
    (await new ReviewRunStore({ storagePath: storePath }).list()).map((entry) => entry.requestId),
    ["r1", "r2"],
  );
  assert.deepStrictEqual(await fresh.get("r2"), run("r2", { mode: "file", status: "completed", startedAt: LATER }));
  assert.strictEqual(await fresh.get("r3"), null);
  assert.deepStrictEqual(await tempFiles(storePath), []);

  // 2b. A run without optional recovery metadata is stored as-is.
  await fresh.create(minimal("r3-minimal", { mode: "target", model: null, thinkingOptionId: null }));
  assert.deepStrictEqual(await fresh.get("r3-minimal"), minimal("r3-minimal", {
    mode: "target",
    model: null,
    thinkingOptionId: null,
  }));

  const cached = cachedRun("r-cache-hit");
  await fresh.create(cached);
  assert.deepStrictEqual(await fresh.get(cached.requestId), cached);
  // -------------------------------------------------------------------------
  // 3. create validates before touching the file: an invalid run neither lands
  //    nor creates a store, and never disturbs a valid one.
  // -------------------------------------------------------------------------
  const strictPath = join(root, "strict", "runs.json");
  const strict = store(strictPath);
  const invalidRuns = [
    run(""),
    { ...run("r-x"), requestId: undefined },
    { ...run("r-x"), childAgentId: "" },
    { ...run("r-x"), parentAgentId: "" },
    { ...run("r-x"), childAgentId: null, status: "completed" },
    { ...run("r-x"), resultSource: "cached" },
    { ...cachedRun("r-x"), childAgentId: "child-r-x" },
    { ...cachedRun("r-x"), status: "running" },
    { ...run("r-x"), resultSource: "unknown" },
    { ...run("r-x"), resultSource: undefined },
    { ...run("r-x"), workspaceId: "" },
    { ...run("r-x"), cacheKey: "" },
    { ...run("r-x"), mode: "hunks" },
    { ...run("r-x"), status: "queued" },
    { ...run("r-x"), startedAt: "2026-01-01" },
    { ...run("r-x"), startedAt: 1767225600000 },
    { ...run("r-x"), locale: "fr" },
    { ...run("r-x"), provider: "" },
    { ...run("r-x"), model: undefined },
    { ...run("r-x"), thinkingOptionId: undefined },
    { ...run("r-x"), reviewerPermissionMode: "write" },
    { ...run("r-x"), depth: "deep" },
    { ...run("r-x"), reviewPreset: "maximal" },
    { ...run("r-x"), cacheEnabled: "yes" },
    { ...run("r-x"), inputFingerprint: "" },
    { ...run("r-x"), promptVersion: 0 },
    { ...run("r-x"), promptVersion: 3.5 },
    { ...run("r-x"), promptVersion: "3" },
    { ...run("r-x"), schemaVersion: -1 },
    { ...run("r-x"), schemaVersion: undefined },
    // A run is metadata only: content-bearing keys are rejected outright.
    { ...run("r-x"), prompt: "review this diff" },
    { ...run("r-x"), patch: "@@ -1 +1 @@" },
    { ...run("r-x"), review: "looks good" },
    { ...run("r-x"), sections: { verifiedFacts: [] } },
    { ...run("r-x"), cachedResult: { review: "looks good" } },
    { ...run("r-x"), futureField: true },
  ] as unknown as ReviewRun[];
  for (const invalid of invalidRuns) {
    await assert.rejects(
      strict.create(invalid),
      (error) => error instanceof ReviewRunStoreError && error.message.includes(strictPath),
      `create must reject an invalid run: ${JSON.stringify(invalid).slice(0, 60)}`,
    );
  }
  await assert.rejects(readRaw(strictPath), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.deepStrictEqual(await tempFiles(strictPath), []);

  const validBeforeInvalidCreate = await readRaw(storePath);
  await assert.rejects(
    fresh.create({ ...run("r4"), prompt: "SECRET PROMPT TEXT" } as unknown as ReviewRun),
    (error) => error instanceof ReviewRunStoreError,
  );
  assert.strictEqual(await readRaw(storePath), validBeforeInvalidCreate);

  // -------------------------------------------------------------------------
  // 4. A duplicate request id is rejected across the whole file.
  // -------------------------------------------------------------------------
  await assert.rejects(
    fresh.create(run("r1")),
    (error) => error instanceof ReviewRunStoreError && error.message.includes("already stores"),
  );
  await assert.rejects(
    fresh.create(run("r1", { workspaceId: "workspace-other", status: "abandoned" })),
    (error) => error instanceof ReviewRunStoreError,
  );
  assert.strictEqual(await readRaw(storePath), validBeforeInvalidCreate);

  // -------------------------------------------------------------------------
  // 5. update validates, persists atomically, transitions status, and returns
  //    null for an absent id without rewriting the file.
  // -------------------------------------------------------------------------
  const updatePath = join(root, "update", "runs.json");
  const updates = store(updatePath);
  await updates.create(run("u1"));
  const completed = await updates.update("u1", (entry) => ({ ...entry, status: "completed" }));
  assert.deepStrictEqual(completed, run("u1", { status: "completed" }));
  assert.deepStrictEqual((await store(updatePath).list())[0], completed);
  // The transformed run is the stored one, and the write is idempotent.
  assert.deepStrictEqual(await updates.update("u1", async (entry) => entry), completed);

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

  const failed = await updates.update("u1", (entry) => ({ ...entry, status: "failed" }));
  assert.strictEqual(failed?.status, "failed");
  const abandoned = await updates.update("u1", (entry) => ({ ...entry, status: "abandoned" }));
  assert.deepStrictEqual(abandoned, run("u1", { status: "abandoned" }));
  // Status is the only terminal bit: the run survives until the caller removes
  // it, and a run may be marked abandoned with no completion timestamp.
  assert.strictEqual((await updates.list()).length, 1);

  const beforeInvalidUpdate = await readRaw(updatePath);
  for (const invalid of [
    { ...run("u1"), status: "queued" },
    { ...run("u1"), startedAt: "not-a-date" },
    { ...run("u1"), promptVersion: 0 },
    { ...run("u1"), review: "SECRET REVIEW TEXT" },
    { ...run("u1"), futureField: true },
  ] as unknown as ReviewRun[]) {
    await assert.rejects(
      updates.update("u1", () => invalid),
      (error) => error instanceof ReviewRunStoreError && error.message.includes(updatePath),
      `update must reject an invalid run: ${JSON.stringify(invalid).slice(0, 60)}`,
    );
  }
  assert.strictEqual(await readRaw(updatePath), beforeInvalidUpdate, "an invalid update must not write");
  assert.ok(!beforeInvalidUpdate.includes("SECRET"), "no review content may reach the store");

  // A request-id rename is allowed; a rename onto an existing id is not.
  await updates.create(run("u2"));
  const renamed = await updates.update("u2", (entry) => ({ ...entry, requestId: "u2-renamed" }));
  assert.strictEqual(renamed?.requestId, "u2-renamed");
  assert.strictEqual(await updates.update("u2", (entry) => entry), null);
  assert.deepStrictEqual((await updates.list()).map((entry) => entry.requestId), ["u1", "u2-renamed"]);
  await updates.create(run("u3"));
  const beforeCollision = await readRaw(updatePath);
  await assert.rejects(
    updates.update("u3", (entry) => ({ ...entry, requestId: "u2-renamed" })),
    (error) => error instanceof ReviewRunStoreError && error.message.includes("u2-renamed"),
  );
  assert.strictEqual(await readRaw(updatePath), beforeCollision);
  assert.deepStrictEqual(await tempFiles(updatePath), []);

  // -------------------------------------------------------------------------
  // 6. remove drops exactly one run, and an absent id is a no-op that leaves
  //    every other record byte-identical.
  // -------------------------------------------------------------------------
  const removePath = join(root, "remove", "runs.json");
  const removals = store(removePath);
  await removals.create(run("d1"));
  await removals.create(run("d2", { status: "completed" }));
  await removals.create(run("d3"));

  const beforeAbsentRemove = await readRaw(removePath);
  assert.strictEqual(await removals.remove("absent"), null);
  assert.strictEqual(await readRaw(removePath), beforeAbsentRemove);

  assert.deepStrictEqual(await removals.remove("d2"), run("d2", { status: "completed" }));
  assert.deepStrictEqual((await removals.list()).map((entry) => entry.requestId), ["d1", "d3"]);
  assert.deepStrictEqual((await readStore(removePath)).runs.map((entry) => entry.requestId), ["d1", "d3"]);
  // The removed id is free again, and re-removing it is a no-op.
  assert.strictEqual(await removals.remove("d2"), null);
  await removals.create(run("d2", { status: "failed" }));
  assert.deepStrictEqual(await removals.remove("d1"), run("d1"));
  assert.deepStrictEqual(await removals.remove("d3"), run("d3"));
  assert.deepStrictEqual((await removals.list()).map((entry) => entry.requestId), ["d2"]);
  assert.deepStrictEqual(await readStore(removePath), { version: REVIEW_RUN_VERSION, runs: [run("d2", { status: "failed" })] });
  // Removing the last run leaves a valid empty envelope, not a deleted file.
  assert.deepStrictEqual(await removals.remove("d2"), run("d2", { status: "failed" }));
  assert.deepStrictEqual(await removals.list(), []);
  assert.deepStrictEqual(await readStore(removePath), { version: REVIEW_RUN_VERSION, runs: [] });
  assert.deepStrictEqual(await tempFiles(removePath), []);

  // -------------------------------------------------------------------------
  // 6b. v1.7 completion/read metadata is optional, strict, and content-free:
  //     a terminal run may carry its completion time, its finding tally, and
  //     the moment the user opened Review Deck for it, a pre-v1.7 document
  //     still loads byte-identical, and malformed or contradictory metadata is
  //     rejected without a write.
  // -------------------------------------------------------------------------
  const metadataPath = join(root, "metadata", "runs.json");
  const metadata = store(metadataPath);
  const completedAt = "2026-01-01T00:10:00.000Z";
  const readAt = "2026-01-01T00:20:00.000Z";
  const completedRun: ReviewRun = {
    ...run("m-completed"),
    status: "completed",
    completedAt,
    findingCount: 3,
    highRiskFindingCount: 2,
  };
  assert.deepStrictEqual(await metadata.create(completedRun), completedRun);
  assert.deepStrictEqual(await metadata.get("m-completed"), completedRun);
  const readRun: ReviewRun = { ...completedRun, requestId: "m-read", readAt };
  await metadata.create(readRun);
  assert.deepStrictEqual(await metadata.get("m-read"), readRun);
  // Zero findings are a valid tally (a clean review), and an abandoned run
  // keeps the completion time and read mark it finished with.
  const zeroRun: ReviewRun = { ...completedRun, requestId: "m-zero", findingCount: 0, highRiskFindingCount: 0 };
  const abandonedRun: ReviewRun = { ...completedRun, requestId: "m-abandoned", status: "abandoned" };
  await metadata.create(zeroRun);
  await metadata.create(abandonedRun);
  assert.deepStrictEqual(
    (await metadata.list()).map((entry) => entry.requestId),
    ["m-completed", "m-read", "m-zero", "m-abandoned"],
  );
  // A version-1 document written before v1.7 (no completion metadata) loads
  // as-is and is left byte-identical.
  const legacyPath = join(root, "legacy-v17", "runs.json");
  await mkdir(dirname(legacyPath), { recursive: true });
  const legacyDocument = JSON.stringify({
    version: REVIEW_RUN_VERSION,
    runs: [run("legacy-1"), cachedRun("legacy-2")],
  });
  await writeFile(legacyPath, legacyDocument, "utf8");
  assert.deepStrictEqual(
    (await store(legacyPath).list()).map((entry) => entry.requestId),
    ["legacy-1", "legacy-2"],
  );
  assert.strictEqual(await readRaw(legacyPath), legacyDocument, "a pre-v1.7 document must stay byte-identical");

  const beforeInvalidMetadata = await readRaw(metadataPath);
  const invalidMetadata = [
    { ...completedRun, requestId: "m-x", completedAt: "yesterday" },
    { ...completedRun, requestId: "m-x", completedAt: 1767225600000 },
    { ...completedRun, requestId: "m-x", findingCount: -1 },
    { ...completedRun, requestId: "m-x", findingCount: 2.5 },
    { ...completedRun, requestId: "m-x", findingCount: "3" },
    { ...completedRun, requestId: "m-x", highRiskFindingCount: 9 },
    { ...completedRun, requestId: "m-x", findingCount: 2, highRiskFindingCount: 3 },
    { ...completedRun, requestId: "m-x", highRiskFindingCount: undefined },
    { ...completedRun, requestId: "m-x", findingCount: undefined },
    { ...completedRun, requestId: "m-x", readAt: "yesterday" },
    { ...completedRun, requestId: "m-x", readAt: 123 },
    // A run still in flight has neither a completion time nor a read mark.
    { ...run("m-x"), completedAt },
    { ...run("m-x"), readAt },
    { ...run("m-x"), findingCount: 4 },
    // Metadata only: a stamped run still rejects content keys outright.
    { ...completedRun, requestId: "m-x", review: "SECRET REVIEW TEXT" },
    { ...completedRun, requestId: "m-x", futureField: true },
  ] as unknown as ReviewRun[];
  for (const invalid of invalidMetadata) {
    await assert.rejects(
      metadata.create(invalid),
      (error) => error instanceof ReviewRunStoreError && error.message.includes(metadataPath),
      `create must reject invalid v1.7 metadata: ${JSON.stringify(invalid).slice(0, 80)}`,
    );
  }
  assert.strictEqual(await readRaw(metadataPath), beforeInvalidMetadata, "an invalid stamp must not write");
  assert.ok(!beforeInvalidMetadata.includes("SECRET"), "no review content may reach the store");

  // update() stamps a terminal transition in one write, and the same
  // contradictory stamps are refused there too.
  const terminalTransition = await metadata.update("m-completed", (entry) => ({
    ...entry,
    status: "failed",
    findingCount: 0,
    highRiskFindingCount: 0,
  }));
  assert.deepStrictEqual(terminalTransition, {
    ...completedRun,
    status: "failed",
    findingCount: 0,
    highRiskFindingCount: 0,
  });
  const beforeInvalidStamp = await readRaw(metadataPath);
  await assert.rejects(
    metadata.update("m-read", (entry) => ({ ...entry, status: "abandoned", highRiskFindingCount: 4 })),
    (error) => error instanceof ReviewRunStoreError && error.message.includes(metadataPath),
  );
  assert.strictEqual(await readRaw(metadataPath), beforeInvalidStamp);
  assert.deepStrictEqual(await tempFiles(metadataPath), []);

  // -------------------------------------------------------------------------
  // 7. Fail closed: a malformed, unsupported, content-bearing, or duplicate-id
  //    document is reported by every operation and preserved byte for byte.
  // -------------------------------------------------------------------------
  const damagedPath = join(root, "damaged", "runs.json");
  const damaged = store(damagedPath);
  await mkdir(dirname(damagedPath), { recursive: true });
  const damagedDocuments = [
    '{ "version": 1, "runs": [ ',
    "",
    " \n\t ",
    "[]",
    "null",
    JSON.stringify({ runs: [] }),
    JSON.stringify({ version: REVIEW_RUN_VERSION + 1, runs: [] }),
    JSON.stringify({ version: "1", runs: [] }),
    JSON.stringify({ version: REVIEW_RUN_VERSION, runs: {} }),
    JSON.stringify({ version: REVIEW_RUN_VERSION, extra: true, runs: [] }),
    JSON.stringify({ version: REVIEW_RUN_VERSION, runs: [{ ...run("x"), prompt: "SECRET PROMPT TEXT" }] }),
    JSON.stringify({ version: REVIEW_RUN_VERSION, runs: [{ ...run("x"), review: "SECRET REVIEW TEXT" }] }),
    JSON.stringify({ version: REVIEW_RUN_VERSION, runs: [{ ...run("x"), futureField: true }] }),
    JSON.stringify({ version: REVIEW_RUN_VERSION, runs: [{ ...run("x"), status: "queued" }] }),
    JSON.stringify({ version: REVIEW_RUN_VERSION, runs: [{ ...run("x"), mode: "targets" }] }),
    JSON.stringify({ version: REVIEW_RUN_VERSION, runs: [{ ...run("x"), startedAt: "yesterday" }] }),
    JSON.stringify({ version: REVIEW_RUN_VERSION, runs: [{ ...run("x"), promptVersion: 2.5 }] }),
    JSON.stringify({ version: REVIEW_RUN_VERSION, runs: [{ ...run("x"), requestId: "" }] }),
    JSON.stringify({
      version: REVIEW_RUN_VERSION,
      runs: [run("dup"), run("dup", { workspaceId: "workspace-dup-2" })],
    }),
  ];
  for (const document of damagedDocuments) {
    await writeFile(damagedPath, document, "utf8");
    const readers: Array<() => Promise<unknown>> = [
      () => damaged.list(),
      () => damaged.get("x"),
      () => damaged.create(run("fresh-run")),
      () => damaged.update("x", (entry) => entry),
      () => damaged.remove("x"),
    ];
    for (const read of readers) {
      await assert.rejects(
        read(),
        (error) => error instanceof ReviewRunStoreError && error.message.includes(damagedPath),
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

  // 7b. A store path that is not a file is an error, not an empty store.
  await assert.rejects(store(root).list(), (error) => error instanceof ReviewRunStoreError);

  // -------------------------------------------------------------------------
  // 8. Concurrent read-modify-write cycles are serialized: no create is lost,
  //    no duplicate slips through, and no temp file survives.
  // -------------------------------------------------------------------------
  const concurrentPath = join(root, "concurrent", "runs.json");
  const concurrent = store(concurrentPath);
  const writers = 25;
  await Promise.all(
    Array.from({ length: writers }, (_, index) => concurrent.create(run(`c-${index}`, { workspaceId: `ws-${index}` }))),
  );
  const concurrentRuns = await concurrent.list();
  assert.strictEqual(concurrentRuns.length, writers);
  assert.deepStrictEqual(
    concurrentRuns.map((entry) => entry.requestId),
    Array.from({ length: writers }, (_, index) => `c-${index}`),
  );
  assert.deepStrictEqual(await tempFiles(concurrentPath), []);

  // 8b. Racing creates of the same request id: exactly one lands.
  const races = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) => concurrent.create(run("race", { workspaceId: `race-ws-${index}` }))),
  );
  assert.strictEqual(races.filter((result) => result.status === "fulfilled").length, 1);
  assert.strictEqual(races.filter((result) => result.status === "rejected").length, 4);
  assert.strictEqual((await concurrent.list()).filter((entry) => entry.requestId === "race").length, 1);
  assert.deepStrictEqual(await tempFiles(concurrentPath), []);

  // 8c. Concurrent updates to one run accumulate in order (each transform sees
  //     the previous write), which is the observable proof of serialization.
  const mergePath = join(root, "merge", "runs.json");
  const merge = store(mergePath);
  await merge.create(run("m-1"));
  const markers = Array.from({ length: 20 }, (_, index) => `+${index}`);
  await Promise.all(
    markers.map((marker) =>
      merge.update("m-1", (entry) => ({ ...entry, inputFingerprint: `${entry.inputFingerprint ?? ""}${marker}` })),
    ),
  );
  const merged = await merge.get("m-1");
  assert.strictEqual(merged?.inputFingerprint, `fingerprint-m-1${markers.join("")}`);
  assert.deepStrictEqual(await tempFiles(mergePath), []);

  // 8d. Racing creates with racing removals of the same id never corrupt the
  //     store: some subset lands, the file stays valid and temp-free.
  const removeRacePath = join(root, "remove-race", "runs.json");
  const removeRace = store(removeRacePath);
  await removeRace.create(run("keep"));
  await Promise.allSettled([
    removeRace.create(run("contested", { workspaceId: "ws-a" })),
    removeRace.remove("contested"),
    removeRace.create(run("contested", { workspaceId: "ws-b" })),
    removeRace.remove("contested"),
    removeRace.create(run("contested", { workspaceId: "ws-c" })),
  ]);
  const survivors = await removeRace.list();
  assert.ok(survivors.every((entry) => entry.requestId === "keep" || entry.requestId === "contested"));
  assert.strictEqual(new Set(survivors.map((entry) => entry.requestId)).size, survivors.length);
  assert.deepStrictEqual(await readStore(removeRacePath), { version: REVIEW_RUN_VERSION, runs: survivors });
  assert.deepStrictEqual(await tempFiles(removeRacePath), []);

  // 8e. Reads racing writes still observe a complete store.
  const [listed, fetched] = await Promise.all([concurrent.list(), concurrent.get("c-0")]);
  assert.strictEqual(listed.length, writers + 1);
  assert.strictEqual(fetched?.requestId, "c-0");
  assert.deepStrictEqual(await tempFiles(concurrentPath), []);

  // -------------------------------------------------------------------------
  // 9. The stored document holds metadata only: exactly the schema keys, and
  //    no review content anywhere in the bytes on disk.
  // -------------------------------------------------------------------------
  const persisted = await readStore(storePath);
  const expectedKeys = Object.keys(run("shape")).sort();
  const contentKeys = ["prompt", "patch", "review", "sections", "cachedResult", "usage", "handle"];
  for (const entry of persisted.runs) {
    const keys = Object.keys(entry);
    assert.deepStrictEqual(
      keys.filter((key) => !expectedKeys.includes(key)),
      [],
      `a stored run must only hold schema keys, found ${keys.join(", ")}`,
    );
    for (const contentKey of contentKeys) {
      assert.ok(!keys.includes(contentKey), `a stored run must not hold ${contentKey}`);
    }
  }
  const bytes = await readRaw(storePath);
  assert.ok(!bytes.includes("SECRET"), "no prompt or review text may be persisted");
  assert.ok(!bytes.includes("@@ -"), "no diff patch may be persisted");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("review-run-store: all assertions passed");

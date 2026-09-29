/**
 * Versioned persistence contract for the saved review state.
 *
 * `reviews.json` is a `{ version: 2, targets }` envelope. The previous layout —
 * the bare bucket map — is still read, validated, and rewritten in place by the
 * load that encounters it, so existing stores migrate without user action.
 * Malformed JSON, schema-invalid documents, and versions this build does not
 * understand are SURFACED (StateStoreError) and the file is left byte-identical
 * instead of being silently replaced by an empty store. Writes stay atomic
 * (temp file + rename) and every read/write runs in the store's critical
 * section, so concurrent read-modify-write cycles cannot lose decisions and a
 * stale legacy read can never overwrite a save that lands after it.
 *
 * Run: node tests/state-store.test.ts
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import type { StateEntry, StateFile } from "../server/persistence/StateStore";

type Store = {
  load(): Promise<StateFile>;
  save(next: StateFile): Promise<void>;
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
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

// The domain types come from the type-only import above (erased at runtime,
// checked by tsc); the runtime values are required at their real path.
const requireFromRepo = createRequire(import.meta.url);
const { STATE_VERSION, StateStore, StateStoreError } = requireFromRepo(
  "../server/persistence/StateStore.ts",
) as {
  STATE_VERSION: number;
  StateStore: new (storagePath?: string) => Store;
  StateStoreError: new (message: string, options?: ErrorOptions) => Error;
};

const root = await mkdtemp(join(tmpdir(), "review-deck-state-"));
const statePath = join(root, "nested", "reviews.json");
const store = new StateStore(statePath);
const savedAt = "2026-01-01T00:00:00.000Z";
const reviewed: StateEntry = { hunkId: "hunk-1", decision: "reviewed", savedAt };

try {
  // -------------------------------------------------------------------------
  // 1. A store that was never written reads as empty and is not created.
  // -------------------------------------------------------------------------
  assert.deepStrictEqual(await store.load(), {});
  await assert.rejects(
    readFile(statePath, "utf8"),
    (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );

  // Empty and whitespace-only files are malformed JSON, not empty stores.
  // Both must surface an error and remain available for repair.
  await mkdir(dirname(statePath), { recursive: true });
  for (const malformed of ["", " \n\t "]) {
    await writeFile(statePath, malformed, "utf8");
    await assert.rejects(store.load(), (error) => error instanceof StateStoreError);
    assert.strictEqual(await readFile(statePath, "utf8"), malformed);
  }

  // 1c. An unreadable store surfaces as an error instead of an empty state
  //     (reading a directory is not ENOENT).
  await assert.rejects(new StateStore(root).load(), (error) => error instanceof StateStoreError);

  // -------------------------------------------------------------------------
  // 2. A legacy (v1) store is validated, migrated on load, and migration is
  //    idempotent — a second load reads the envelope and rewrites nothing.
  // -------------------------------------------------------------------------
  const legacy = {
    "sha256:target-a": [reviewed],
    "sha256:target-b": [{ hunkId: "hunk-2", decision: "commented", comment: "why?", savedAt }],
  };
  await writeFile(statePath, JSON.stringify(legacy, null, 2), "utf8");
  assert.deepStrictEqual(await store.load(), legacy);

  const migrated = JSON.parse(await readFile(statePath, "utf8"));
  assert.strictEqual(migrated.version, STATE_VERSION);
  assert.deepStrictEqual(migrated.targets, legacy);
  const afterMigration = await readFile(statePath, "utf8");
  assert.deepStrictEqual(await store.load(), legacy);
  assert.strictEqual(await readFile(statePath, "utf8"), afterMigration);
  assert.deepStrictEqual((await readdir(dirname(statePath))).filter((name) => name.endsWith(".tmp")), []);

  // 2b. Fields written by a version this build does not know still survive the
  //     rewrite: a migration must never drop data.
  const extended = { "sha256:target-c": [{ ...reviewed, futureField: { nested: true } }] };
  await writeFile(statePath, JSON.stringify(extended), "utf8");
  await store.load();
  assert.deepStrictEqual(JSON.parse(await readFile(statePath, "utf8")).targets, extended);

  // 2c. A legacy bucket legitimately named "version" is not mistaken for an
  //     envelope: only a numeric version field marks a versioned document.
  const bucketNamedVersion = { version: [reviewed] };
  await writeFile(statePath, JSON.stringify(bucketNamedVersion), "utf8");
  assert.deepStrictEqual(await store.load(), bucketNamedVersion);
  assert.deepStrictEqual(JSON.parse(await readFile(statePath, "utf8")).targets, bucketNamedVersion);

  // -------------------------------------------------------------------------
  // 3. v2 roundtrip: save writes the envelope, any store reads it back.
  // -------------------------------------------------------------------------
  const next: StateFile = {
    "sha256:target-a": [{
      ...reviewed,
      hunkId: "hunk-9",
      anchor: {
        kind: "hunk",
        filePath: "src/a.ts",
        hunkId: "hunk-9",
        hunkFingerprint: "fp-9",
        contentId: "content-9",
      },
    }],
  };
  await store.save(next);
  assert.deepStrictEqual(JSON.parse(await readFile(statePath, "utf8")), {
    version: STATE_VERSION,
    targets: next,
  });
  assert.deepStrictEqual(await store.load(), next);
  assert.deepStrictEqual(await new StateStore(statePath).load(), next);

  // -------------------------------------------------------------------------
  // 4. Malformed JSON is surfaced with the path, and the file is untouched.
  // -------------------------------------------------------------------------
  const corrupted = '{ "sha256:target-a": [ { ';
  await writeFile(statePath, corrupted, "utf8");
  await assert.rejects(
    store.load(),
    (error) => error instanceof StateStoreError && error.message.includes(statePath),
  );
  assert.strictEqual(await readFile(statePath, "utf8"), corrupted);

  // -------------------------------------------------------------------------
  // 5. Schema-invalid documents are surfaced without overwriting the source:
  //    a bad legacy entry, a non-array bucket, a broken v2 envelope, a bad
  //    scope, and a future version this build cannot read.
  // -------------------------------------------------------------------------
  const invalidDocuments = [
    JSON.stringify({ "sha256:target-a": [{ hunkId: "hunk-1", decision: "maybe", savedAt }] }),
    JSON.stringify({ "sha256:target-a": "not-a-bucket" }),
    JSON.stringify({ "sha256:target-a": [{ hunkId: "hunk-1", decision: "reviewed", savedAt, scope: "bogus" }] }),
    JSON.stringify({ version: STATE_VERSION, targets: { "sha256:target-a": [{ hunkId: "hunk-1", decision: "maybe", savedAt }] } }),
    JSON.stringify({ version: STATE_VERSION, targets: "not-a-target-map" }),
    JSON.stringify({ version: STATE_VERSION + 1, targets: {} }),
    JSON.stringify({
      version: STATE_VERSION,
      targets: {
        "sha256:target-a": [{
          ...reviewed,
          anchor: { kind: "hunk", filePath: "src/a.ts", hunkId: "hunk-1", hunkFingerprint: "fp-1" },
        }],
      },
    }),
  ];
  for (const bad of invalidDocuments) {
    await writeFile(statePath, bad, "utf8");
    await assert.rejects(store.load(), (error) => error instanceof StateStoreError);
    assert.strictEqual(await readFile(statePath, "utf8"), bad);
  }
  // A repair after the failures is picked up: nothing above poisoned the store.
  await store.save(next);
  assert.deepStrictEqual(await store.load(), next);

  // -------------------------------------------------------------------------
  // 6. save() validates before it writes: an invalid payload never lands.
  // -------------------------------------------------------------------------
  const beforeInvalidSave = await readFile(statePath, "utf8");
  const invalidPayload = {
    "sha256:target-a": [{ hunkId: "hunk-1", decision: "maybe", savedAt }],
  } as unknown as StateFile;
  await assert.rejects(store.save(invalidPayload), (error) => error instanceof StateStoreError);
  assert.strictEqual(await readFile(statePath, "utf8"), beforeInvalidSave);

  // -------------------------------------------------------------------------
  // 7. Concurrent read-modify-write cycles keep every decision: load+save
  //    inside runExclusive is serialized (and re-entrant, so it cannot hang).
  // -------------------------------------------------------------------------
  await store.save({});
  const writers = 25;
  await Promise.all(
    Array.from({ length: writers }, (_, index) =>
      store.runExclusive(async () => {
        const file = await store.load();
        file["sha256:concurrent"] = [
          ...(file["sha256:concurrent"] ?? []),
          { ...reviewed, hunkId: `hunk-${index}` },
        ];
        await store.save(file);
      }),
    ),
  );
  const converged = await store.load();
  assert.deepStrictEqual(
    converged["sha256:concurrent"].map((entry) => entry.hunkId).sort(),
    Array.from({ length: writers }, (_, index) => `hunk-${index}`).sort(),
  );

  // -------------------------------------------------------------------------
  // 8. A load that started on a legacy store cannot clobber the save that was
  //    issued after it: the critical section runs them in call order.
  // -------------------------------------------------------------------------
  const legacyRace = { "sha256:stale": [reviewed] };
  await writeFile(statePath, JSON.stringify(legacyRace), "utf8");
  const raced: StateFile = { "sha256:fresh": [{ ...reviewed, hunkId: "hunk-fresh" }] };
  const [staleResult] = await Promise.all([store.load(), store.save(raced)]);
  assert.deepStrictEqual(staleResult, legacyRace);
  const afterRace = JSON.parse(await readFile(statePath, "utf8"));
  assert.strictEqual(afterRace.version, STATE_VERSION);
  assert.deepStrictEqual(afterRace.targets, raced);
  assert.deepStrictEqual(await store.load(), raced);

  // -------------------------------------------------------------------------
  // 9. Concurrent readers only ever observe a complete document.
  // -------------------------------------------------------------------------
  for (const file of await Promise.all(Array.from({ length: 12 }, () => store.load()))) {
    assert.deepStrictEqual(file, raced);
  }

  // -------------------------------------------------------------------------
  // 10. No write path left a temp file behind.
  // -------------------------------------------------------------------------
  assert.deepStrictEqual((await readdir(dirname(statePath))).filter((name) => name.endsWith(".tmp")), []);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(
  `state-store: version ${STATE_VERSION} envelope, legacy migration, corruption preservation, payload validation, and concurrency assertions passed.`,
);

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ReviewScope } from "../../shared/review";
import { createMutex, type Mutex } from "../util/mutex";

export type StateEntry = {
  id?: string;
  projectId?: string;
  projectName?: string;
  projectRootPath?: string;
  workspaceId?: string;
  targetFingerprint?: string;
  hunkId: string;
  hunkFingerprint?: string;
  contentId?: string;
  filePath?: string;
  hunkHeader?: string;
  hunkPatch?: string;
  decision: "reviewed" | "commented";
  comment?: string;
  savedAt: string;
  cwd?: string;
  scope?: ReviewScope;
  baseRef?: string;
  headRef?: string;
};

export type StateFile = Record<string, StateEntry[]>;

export const DEFAULT_STATE_PATH = join(homedir(), ".paseo", "review-deck", "reviews.json");

/**
 * Persistence for saved hunk decisions: one JSON file keyed by target
 * fingerprint, written atomically (temp file + rename) and serialized through
 * an internal mutex so concurrent writers cannot interleave. The storage path
 * is constructor-injected so tests can point the store at a temp file.
 */
export class StateStore {
  private readonly mutex: Mutex = createMutex();

  constructor(private readonly storagePath: string = DEFAULT_STATE_PATH) {}

  async load(): Promise<StateFile> {
    try {
      return JSON.parse(await readFile(this.storagePath, "utf8")) as StateFile;
    } catch {
      return {};
    }
  }

  async save(next: StateFile): Promise<void> {
    await mkdir(dirname(this.storagePath), { recursive: true });
    const temporary = `${this.storagePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temporary, this.storagePath);
  }

  /** Serialize read-modify-write cycles through the store's mutex. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(fn);
  }
}

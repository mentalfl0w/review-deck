export interface Mutex {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createMutex(): Mutex {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(() => fn());
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

/**
 * Repository-scoped mutex registry. Each key (a Git directory) gets its own
 * mutex that is created lazily and dropped once its queue empties, so lock
 * state never leaks between repositories or persists forever.
 */
export class RepoMutexRegistry {
  private readonly mutexes = new Map<string, Mutex>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let mutex = this.mutexes.get(key);
    if (!mutex) {
      let queued = 0;
      const fresh = createMutex();
      const trackedRun = <T2>(op: () => Promise<T2>): Promise<T2> => {
        queued++;
        const result = fresh.run(op);
        void result.then(
          () => {
            queued--;
            if (queued === 0 && this.mutexes.get(key) === fresh) this.mutexes.delete(key);
          },
          () => {
            queued--;
            if (queued === 0 && this.mutexes.get(key) === fresh) this.mutexes.delete(key);
          },
        );
        return result;
      };
      mutex = { run: trackedRun };
      this.mutexes.set(key, mutex);
    }
    return mutex.run(fn);
  }
}

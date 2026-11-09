import { existsSync, watch } from "node:fs";
import path from "node:path";

/**
 * The shared event-driven wait for tests (dec_25B3C380F6FB9D4D4A1E27921E CH1): an integration test
 * waits for the process under test to publish something, never for the wall clock to pass.
 *
 * Wait until a durable read reports a value, without losing an arrival between the read and the
 * subscription. Order is the contract: `subscribe` installs the wake-up first, then `read` observes
 * durable state. An arrival that lands before or during the read is therefore either seen by the
 * read itself or delivered to the already-installed wake-up; a caller that reads first and
 * subscribes afterwards has a window in which the only notification is discarded. The read may be
 * asynchronous (a drain followed by a projection read): the wake-up stays installed across it.
 * There is no deadline here; the node:test `timeout` option is the only hang guard.
 */
export async function waitForArrival<T>(
  read: () => T | null | Promise<T | null>,
  subscribe: (arrive: () => void) => () => void,
): Promise<T> {
  for (;;) {
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unsubscribe = subscribe(release);
    try {
      const value = await read();
      if (value !== null) return value;
      await arrived;
    } finally {
      unsubscribe();
    }
  }
}

/**
 * The fallback when the process under test publishes no subscribable event (owner ruling
 * 2026-11-09 on task_6ddecd04b58fe29d6aa32c9736): read the durable state again until the predicate
 * holds. There is no deadline and no "not within N ms" failure here; the node:test `timeout` option
 * is the only hang guard. Yield with setImmediate, not a wall-clock interval: the sample is not
 * spaced by elapsed time, so the wait never judges by the clock.
 */
export async function waitForDurableValue<T>(read: () => T | null | Promise<T | null>): Promise<T> {
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export async function waitForDurableCondition(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (;;) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Subscribe to a durable file the process under test publishes: creating it, appending to it, or
 * deleting it wakes the waiter, and the caller's `read` decides whether the awaited state arrived.
 * An existing file is watched directly, which reports appends on every platform; a file that is not
 * there yet is observed through its nearest existing ancestor directory, so a directory created
 * later is still seen and the re-subscription after that wake moves onto the file itself. Like
 * `waitForArrival`, this carries no deadline: the node:test `timeout` option is the hang guard.
 */
export function watchFileArrival(file: string): (arrive: () => void) => () => void {
  return (arrive) => {
    try {
      const watcher = watch(file, { persistent: false }, () => arrive());
      return () => watcher.close();
    } catch {
      // The file does not exist yet (or vanished between the caller's read and this subscription).
    }
    let directory = path.dirname(file);
    while (!existsSync(directory)) {
      const parent = path.dirname(directory);
      if (parent === directory) return () => undefined;
      directory = parent;
    }
    const watcher = watch(directory, { persistent: false }, () => arrive());
    return () => watcher.close();
  };
}

/**
 * Subscribe to every change under a directory tree. Git does not write a single file a caller can
 * watch for "a commit landed": the ref, the reflog and the index change together, and branches move
 * under subdirectories. A recursive watch over the git directory wakes the waiter for any of them and
 * the caller's read decides whether HEAD already carries the awaited content. No deadline.
 */
export function watchDirectoryArrival(directory: string): (arrive: () => void) => () => void {
  return (arrive) => {
    const watcher = watch(directory, { persistent: false, recursive: true }, () => arrive());
    return () => watcher.close();
  };
}

/**
 * Subscribe to the SQLite ledger writes a repository cell publishes (canonical event store and
 * projection at `<rootDir>/.harness/cache/task.sqlite`). A test that waits for a projection or
 * write-queue state derives that state from a ledger write, so the commit is the arrival; the
 * caller's `read` still decides whether the awaited value is visible. The database file covers
 * rollback-journal writes, the `-wal` file covers the commit path, and the cache directory covers
 * creating or rotating either of them. No deadline: the node:test timeout is the hang guard.
 */
export function watchLedgerArrival(rootDir: string): (arrive: () => void) => () => void {
  const cache = path.join(rootDir, ".harness", "cache"),
    database = path.join(cache, "task.sqlite");
  return (arrive) => {
    const stops = [
      watchFileArrival(database)(arrive),
      watchFileArrival(`${database}-wal`)(arrive),
      watchFileArrival(path.join(cache, "ledger-rotation"))(arrive),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  };
}

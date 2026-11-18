import { EventEmitter } from "node:events";
import { lstatSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";

function attempt<T>(run: () => T): { ok: true; value: T } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Watch each entry without Node's repeated full-folder scans on Linux. */
export function watchLinuxWorkspace(
  root: string,
  onChange: (event: string, filename: string | Buffer | null) => void,
): { close: () => void; unref: () => void; on: (event: "error", listener: (error: Error) => void) => unknown } {
  const events = new EventEmitter(),
    entries = new Map<string, { watcher: FSWatcher; dev: number; ino: number; directory: boolean }>();
  let closed = false;
  const forget = (target: string): void => {
    const existing = entries.get(target);
    if (!existing) return;
    if (!existing.directory) {
      existing.watcher.close();
      entries.delete(target);
      return;
    }
    for (const [name, entry] of entries) {
      if (name === target || name.startsWith(`${target}${path.sep}`)) {
        entry.watcher.close();
        entries.delete(name);
      }
    }
  };
  const missing = (target: string, error: unknown): boolean =>
    target !== root && (error as NodeJS.ErrnoException).code === "ENOENT";
  const refresh = (target: string): void => {
    if (closed) return;
    const stat = target === root ? statSync(target) : lstatSync(target, { throwIfNoEntry: false });
    if (!stat) {
      forget(target);
      return;
    }
    const previous = entries.get(target);
    if (previous && previous.dev === stat.dev && previous.ino === stat.ino) return;
    if (previous) forget(target);
    const opened = attempt(() =>
      watch(target, { persistent: false }, (event, filename) => {
        if (closed) return;
        const relative = path.relative(root, target),
          child = filename === null || !stat.isDirectory() ? null : path.join(target, String(filename));
        onChange(event, child === null ? relative || null : path.relative(root, child));
        if (event !== "rename") return;
        const updated = attempt(() => {
          if (!stat.isDirectory()) refresh(target);
          else if (child) refresh(child);
          else scan(target);
        });
        if (!updated.ok) events.emit("error", updated.error);
      }),
    );
    if (!opened.ok) {
      if (missing(target, opened.error)) return;
      throw opened.error;
    }
    const watcher = opened.value;
    entries.set(target, { watcher, dev: stat.dev, ino: stat.ino, directory: stat.isDirectory() });
    watcher.on("error", (error) => events.emit("error", error));
    if (stat.isDirectory()) {
      const scanned = attempt(() => scan(target));
      if (!scanned.ok) {
        if (!missing(target, scanned.error)) throw scanned.error;
        forget(target);
      }
    }
  };
  const scan = (directory: string): void => {
    const names = readdirSync(directory, { withFileTypes: true }),
      present = new Set(names.map((entry) => entry.name));
    for (const entry of names) refresh(path.join(directory, entry.name));
    for (const name of entries.keys()) {
      if (path.dirname(name) === directory && !present.has(path.basename(name))) forget(name);
    }
  };
  try {
    refresh(root);
  } catch (error) {
    for (const entry of entries.values()) entry.watcher.close();
    throw error;
  }
  return {
    close: () => {
      if (closed) return;
      closed = true;
      for (const entry of entries.values()) entry.watcher.close();
      entries.clear();
    },
    unref: () => undefined,
    on: (_event, listener) => events.on("error", listener),
  };
}

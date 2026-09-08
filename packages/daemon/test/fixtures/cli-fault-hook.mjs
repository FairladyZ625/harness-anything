import { registerHooks } from "node:module";

// Test-only loader: all commands, projection and SQLite reads remain real. The
// injected scan error and stale watermark are armed only after Task start.
const state = { armed: false, initialized: false, uncached: false, scans: 0, rows: 0, cpuMicros: 0 };
globalThis.cliFaultState = state;
globalThis.cliFaultLookup = (cell, run) => {
  if (!state.armed) return run(cell);
  if (!state.initialized || state.uncached) cell.knownTaskIds = null;
  state.initialized = true;
  const proxy = new Proxy(cell, {
    get(target, key) {
      if (key === "projection")
        return new Proxy(target.projection, {
          get(projection, method) {
            if (method !== "list") return Reflect.get(projection, method);
            return (...args) => {
              const result = projection.list(...args);
              return { ...result, watermark: result.sourceRevision - 1 };
            };
          },
        });
      if (key === "store")
        return new Proxy(target.store, {
          get(store, method) {
            if (method !== "readBatch") return Reflect.get(store, method);
            return (...args) => {
              const before = process.cpuUsage();
              const batch = store.readBatch(...args);
              const cpu = process.cpuUsage(before);
              state.scans += 1;
              state.rows += batch.events.length;
              state.cpuMicros += cpu.user + cpu.system;
              throw Object.assign(new Error("injected canonical scan read failure"), { code: "invalid_store" });
            };
          },
        });
      return Reflect.get(target, key);
    },
  });
  return run(proxy);
};
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith("/repo-cell-receipts.ts")) return loaded;
    const original = "export function projectedTaskIds(cell: ProjectedTaskIdsContext): Set<string> {";
    const source = String(loaded.source);
    if (!source.includes(original)) throw new Error("projectedTaskIds test seam no longer matches source");
    return {
      ...loaded,
      source: source.replace(
        original,
        `${original}\n  return globalThis.cliFaultLookup(cell, projectedTaskIdsUnderTest);\n}\nfunction projectedTaskIdsUnderTest(cell: ProjectedTaskIdsContext): Set<string> {`,
      ),
    };
  },
});

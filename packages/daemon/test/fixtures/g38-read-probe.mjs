// All instrumentation stays in the G38 fixture. Include bytes returned by SQL: a COUNT
// or a single JSON row can conceal a growing collection from a row-only counter.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { StatementSync } from "node:sqlite";
import { installCostProbe, resetCostProbe, snapshotCostProbe } from "./g1-cost-probe.mjs";
let installed = false,
  sqlResultBytes = 0,
  asyncFileReadBytes = 0,
  directoryEntries = 0;
const bytes = (row) => Buffer.byteLength(JSON.stringify(row) ?? "", "utf8");
export function installReadProbe() {
  if (installed) return;
  installed = true;
  installCostProbe();
  for (const name of ["get", "all"]) {
    const original = StatementSync.prototype[name];
    StatementSync.prototype[name] = function (...args) {
      const result = original.apply(this, args);
      sqlResultBytes += bytes(result);
      return result;
    };
  }
  const originalRead = fs.promises.readFile,
    originalReadSync = fs.readSync,
    originalDirectory = fs.promises.readdir,
    originalDirectorySync = fs.readdirSync;
  fs.promises.readFile = async (...args) => {
    const value = await originalRead(...args);
    asyncFileReadBytes += typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
    return value;
  };
  fs.readSync = (...args) => {
    const count = originalReadSync(...args);
    asyncFileReadBytes += count;
    return count;
  };
  fs.promises.readdir = async (...args) => {
    const value = await originalDirectory(...args);
    directoryEntries += value.length;
    return value;
  };
  fs.readdirSync = (...args) => {
    const value = originalDirectorySync(...args);
    directoryEntries += value.length;
    return value;
  };
  syncBuiltinESMExports();
  const original = StatementSync.prototype.iterate;
  StatementSync.prototype.iterate = function (...args) {
    const iterator = original.apply(this, args),
      next = iterator.next.bind(iterator);
    iterator.next = (...values) => {
      const value = next(...values);
      if (!value.done) sqlResultBytes += bytes(value.value);
      return value;
    };
    return iterator;
  };
}
export function resetReadProbe() {
  resetCostProbe();
  sqlResultBytes = 0;
  asyncFileReadBytes = 0;
  directoryEntries = 0;
}
export function snapshotReadProbe() {
  const counts = snapshotCostProbe();
  return { ...counts, fileReadBytes: counts.fileReadBytes + asyncFileReadBytes, sqlResultBytes, directoryEntries };
}

// EXPLAIN reports per-loop row averages. Include filtered/rechecked rows and every
// scan, including scans below an Aggregate or a recursive/CTE wrapper.
export function planRowsRead(plan) {
  const own = /Scan$/u.test(plan["Node Type"] ?? "")
    ? ((plan["Actual Rows"] ?? 0) +
        (plan["Rows Removed by Filter"] ?? 0) +
        (plan["Rows Removed by Index Recheck"] ?? 0)) *
      (plan["Actual Loops"] ?? 1)
    : 0;
  return own + (plan.Plans ?? []).reduce((sum, child) => sum + planRowsRead(child), 0);
}

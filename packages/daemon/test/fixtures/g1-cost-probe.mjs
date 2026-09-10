// G1 write-cost-scaling gate: deterministic-cost instrumentation shared by the writer-worker
// `--import` preload (g1-writer-probe-import.mjs) and the gate's own host-side read measurements.
// Patches built-in prototypes only (node:sqlite StatementSync, node:crypto Hash, node:fs
// readFileSync); production source carries none of this. Git subprocess count reuses the
// existing production counter (localGitObjectRefStore.processCount) instead of patching
// child_process, so it stays accurate across every call shape the kernel already uses.
import { syncBuiltinESMExports } from "node:module";
import { StatementSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import { localGitObjectRefStore } from "../../../kernel/src/index.ts";

const counters = { sqlRowsRead: 0, sha256Calls: 0, sha256Bytes: 0, fileReadBytes: 0 };
let gitBaseline = 0;
let installed = false;

function rowCount(result) {
  if (Array.isArray(result)) return result.length;
  return result === undefined ? 0 : 1;
}

function byteLength(chunk, encoding) {
  if (typeof chunk === "string") return Buffer.byteLength(chunk, encoding ?? "utf8");
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  return Buffer.byteLength(String(chunk));
}

export function installCostProbe() {
  if (installed) return;
  installed = true;

  const statementProto = StatementSync.prototype,
    originalAll = statementProto.all,
    originalGet = statementProto.get,
    originalIterate = statementProto.iterate;
  statementProto.all = function all(...args) {
    const result = originalAll.apply(this, args);
    counters.sqlRowsRead += rowCount(result);
    return result;
  };
  statementProto.get = function get(...args) {
    const result = originalGet.apply(this, args);
    counters.sqlRowsRead += rowCount(result);
    return result;
  };
  // Streaming reads (the projection state digest walks every table this way) return their rows
  // one step at a time, so each step the caller takes is one row read.
  statementProto.iterate = function iterate(...args) {
    const iterator = originalIterate.apply(this, args),
      next = iterator.next.bind(iterator);
    iterator.next = (...nextArgs) => {
      const step = next(...nextArgs);
      if (!step.done) counters.sqlRowsRead += 1;
      return step;
    };
    return iterator;
  };

  const hashProto = crypto.Hash.prototype,
    originalUpdate = hashProto.update,
    originalDigest = hashProto.digest;
  hashProto.update = function update(chunk, encoding) {
    counters.sha256Bytes += byteLength(chunk, encoding);
    return originalUpdate.call(this, chunk, encoding);
  };
  hashProto.digest = function digest(...args) {
    counters.sha256Calls += 1;
    return originalDigest.apply(this, args);
  };

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function readFileSync(...args) {
    const result = originalReadFileSync.apply(this, args);
    counters.fileReadBytes += typeof result === "string" ? Buffer.byteLength(result, "utf8") : result.byteLength;
    return result;
  };
  syncBuiltinESMExports();
}

export function resetCostProbe() {
  counters.sqlRowsRead = 0;
  counters.sha256Calls = 0;
  counters.sha256Bytes = 0;
  counters.fileReadBytes = 0;
  gitBaseline = localGitObjectRefStore.processCount();
}

export function snapshotCostProbe() {
  return {
    sqlRowsRead: counters.sqlRowsRead,
    sha256Calls: counters.sha256Calls,
    sha256Bytes: counters.sha256Bytes,
    gitProcesses: localGitObjectRefStore.processCount() - gitBaseline,
    fileReadBytes: counters.fileReadBytes,
  };
}

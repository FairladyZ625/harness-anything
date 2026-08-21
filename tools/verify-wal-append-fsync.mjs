#!/usr/bin/env node
// Observes the durability boundary of the acknowledged WAL append directly at
// the node:fs boundary: localWalFileSystem.append must issue writeSync(fd) on
// the segment and then fsyncSync(fd) or fdatasyncSync(fd) on the SAME
// descriptor, before closeSync(fd). A crash-visibility criterion cannot
// distinguish page-cache writes from fsynced writes (the page cache survives
// process death), so the syscall sequence is the only directly observable
// witness of the property.
//
// This replaced a wall-clock ratio probe (shadow append vs an explicit-fsync
// append). Both arms of that ratio executed nearly identical syscall
// sequences, so the ratio measured fsync-latency jitter between two time
// windows, not the presence of the fsync: on CI Linux the ratio read
// 0.462x-6.076x across twenty main runs while the fsync was present the whole
// time, redding both sides of a [0.25, 2.5] band. No threshold separates
// regimes when the noise is wider than the band; the syscall trace carries no
// timing and needs none.
//
// Instrumentation mechanics (verified on Node 24.13, 24.18, and 26.7): this
// file deliberately has NO static import from "node:fs". The ESM facade for a
// builtin snapshots its named export values when first linked, so the kernel
// module's `import { fsyncSync } from "node:fs"` binds to these wrappers only
// because the patch is installed before that module is dynamically imported
// and nothing linked node:fs earlier. A static `import ... from "node:fs"` in
// this tool, or a future Node that links builtin facades eagerly, would hand
// the kernel module the real functions, the trace would come back empty, and
// the assertion would fail closed.
//
// --module <path> overrides the module under observation; the negative
// controls run a copy of the adapter with the fsync removed (or reordered
// ahead of the write) through this same instrument.
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const moduleIndex = process.argv.indexOf("--module");
const modulePath = moduleIndex === -1
  ? path.resolve(import.meta.dirname, "../packages/kernel/src/local/local-layout-file-system.ts")
  : path.resolve(process.argv[moduleIndex + 1]);
const instrumented = ["openSync", "writeSync", "fsyncSync", "fdatasyncSync", "closeSync"];
const events = [];
const originals = {};
for (const api of instrumented) {
  originals[api] = fs[api];
  fs[api] = (...args) => {
    const at = events.length;
    const result = originals[api](...args);
    if (api === "openSync") events.push({ api, at, path: String(args[0]), fd: result });
    else events.push({ api, at, fd: args[0] });
    return result;
  };
}
const root = fs.mkdtempSync(path.join(tmpdir(), "ha-wal-fsync-probe-"));
try {
  const target = path.join(root, "seg-000000.log");
  const { localWalFileSystem } = await import(pathToFileURL(modulePath).href);
  localWalFileSystem.append(target, '{"probe":1}\n');
  const opens = events.filter((event) => event.api === "openSync" && path.resolve(event.path) === path.resolve(target));
  const open = opens.at(-1);
  const fd = open?.fd;
  // Descriptor numbers are reused (the module loader's own open/close can
  // recycle the same number), so only events after the target's open count.
  const appendScoped = events.filter((event) => open !== undefined && event.at > open.at);
  const writes = appendScoped.filter((event) => event.api === "writeSync" && event.fd === fd);
  const syncs = appendScoped.filter((event) => (event.api === "fsyncSync" || event.api === "fdatasyncSync") && event.fd === fd);
  const closes = appendScoped.filter((event) => event.api === "closeSync" && event.fd === fd);
  const lastWrite = writes.at(-1), close = closes.at(-1);
  const syncAfterWriteBeforeClose = syncs.find((sync) => lastWrite !== undefined && close !== undefined
    && sync.at > lastWrite.at && sync.at < close.at);
  console.log(JSON.stringify({
    module: modulePath,
    targetOpens: opens.length,
    writeCount: writes.length,
    syncCount: syncs.length,
    closeCount: closes.length,
    durable: opens.length === 1 && writes.length === 1 && syncs.length >= 1 && closes.length === 1 && syncAfterWriteBeforeClose !== undefined,
    trace: events.map((event) => event.api === "openSync" ? `${event.api}(${event.path})=>${event.fd}` : `${event.api}(${event.fd})`)
  }));
} finally {
  for (const api of instrumented) fs[api] = originals[api];
  fs.rmSync(root, { recursive: true, force: true });
}

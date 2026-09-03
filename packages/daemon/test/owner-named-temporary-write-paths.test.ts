// harness-test-tier: fast
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packagesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

function relative(file: string): string {
  return path.relative(packagesRoot, file).split(path.sep).join("/");
}

// A temporary whose name carries the writer's pid is reclaimed by nobody else. Inside one
// machine that only costs a leak; across machines the pid is a different process entirely, so
// the reclaim is either a no-op or a deletion of a file someone else is still writing.
// task_f821cb831f535a13d8cc857c3c judged every construction below one at a time and recorded
// the directory it lands in, its readers, and its disposition in the task package's
// artifacts/temp-write-path-inventory.md. A construction that is not on this list has not been
// judged, which is what the exact comparison is here to say.
test("a temporary named after its writer exists only where it was judged", () => {
  const pidTemplate = /`[^`]*\$\{process\.pid\}[^`]*`/gu,
    namesATemporary = /\.tmp|\.ha-(?:settle|visible)-/u;
  const offenders = ["daemon/src", "kernel/src", "preset/src"]
    .flatMap((root) =>
      sourceFiles(path.join(packagesRoot, root)).flatMap((file) =>
        (readFileSync(file, "utf8").match(pidTemplate) ?? [])
          .filter((value) => namesATemporary.test(value))
          .map((value) => `${relative(file)}: ${value}`),
      ),
    )
    .sort();
  assert.deepEqual(offenders, [
    "daemon/src/agent-runtime-instance-storage.ts: `${target}.${process.pid}.tmp`",
    "daemon/src/agent-runtime-instance-store.ts: `${target}.${process.pid}.tmp`",
    "daemon/src/dispatch-stream.ts: `${target}.${process.pid}.tmp`",
    "daemon/src/durable-file.ts: `${file}.${process.pid}.${randomUUID()}.tmp`",
    "kernel/src/daemon/registry.ts: `${registryPath}.${process.pid}.${Date.now()}.tmp`",
    "kernel/src/local/local-layout-file-system.ts: `${inputPath}.${process.pid}.tmp`",
    "kernel/src/store/local-version-control-system.ts: `${target}.tmp-${process.pid}`",
    "kernel/src/store/local-version-control-system.ts: `.ha-settle-${process.pid}-${index}`",
    "kernel/src/store/local-version-control-system.ts: `.ha-visible-${process.pid}-${index}`",
  ]);
});

// Reclaiming by pid liveness answers "is this owner still running" against the local process
// table. A write path whose temporary can reach a second machine cannot ask that question:
// harness/ is its own git repository and does not ignore *.tmp, so a leftover there travels.
// Both write paths below reach a repository worktree, so neither may probe a pid.
test("a write path that reaches a repository worktree mounts no pid-liveness reclaim", () => {
  const durableWrite = readFileSync(path.join(packagesRoot, "kernel/src/store/local-version-control-system.ts"), "utf8")
    .split("function durableWrite(")[1]
    ?.split("\nfunction ")[0];
  assert.ok(durableWrite, "durableWrite must still be a top-level function in the store");
  assert.equal(durableWrite.includes("sweepStaleSettlementMarkers"), false);
  assert.equal(durableWrite.includes("processMayBeAlive"), false);
  const durableFile = readFileSync(path.join(packagesRoot, "daemon/src/durable-file.ts"), "utf8");
  assert.equal(durableFile.includes("process.kill"), false);
  // The mirror does probe a pid, for the .mirror-round.lock it holds under the replica view
  // store, which never leaves this machine. That probe must stay in the lock and out of the
  // write path, which now reaches harness/ through writeFileDurably.
  const mirror = readFileSync(path.join(packagesRoot, "daemon/src/fleet-edge-mirror.ts"), "utf8");
  const probing = mirror
    .split(/\nfunction |\nasync function /u)
    .filter((body) => body.includes("process.kill("))
    .map((body) => body.slice(0, body.indexOf("(")));
  assert.deepEqual(probing, ["fleetMirrorLockIsStale"]);
});

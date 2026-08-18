// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireDaemonSingleton, daemonSingletonLockPath } from "../src/daemon-singleton.ts";

const endpoint = "/tmp/ha-singleton-probe.sock";

test("a free slot is claimed atomically and released by its holder only", async () => {
  const userRoot = fixture();
  try {
    const held = await acquireDaemonSingleton({ userRoot, daemonId: "default", endpoint, pid: 4242, probe: async () => false });
    assert.equal(held.claim, "acquired");
    assert.equal(readFileSync(daemonSingletonLockPath(userRoot, "default"), "utf8"), "4242\n");
    held.release();
    assert.equal(existsSync(daemonSingletonLockPath(userRoot, "default")), false, "release must remove the lock");
    held.release();
    assert.equal(existsSync(daemonSingletonLockPath(userRoot, "default")), false, "release is idempotent");
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("a live holder pid defers the candidate without touching its claim", async () => {
  const userRoot = fixture(), holder = await liveProcess();
  try {
    writeFileSync(daemonSingletonLockPath(userRoot, "default"), `${holder.pid}\n`, "utf8");
    const incumbent = await acquireDaemonSingleton({ userRoot, daemonId: "default", endpoint, pid: 9999, probe: async () => false });
    assert.equal(incumbent.claim, "incumbent");
    assert.equal(incumbent.pid, holder.pid);
    assert.equal(incumbent.witness, "singleton-lock");
    assert.equal(readFileSync(daemonSingletonLockPath(userRoot, "default"), "utf8"), `${holder.pid}\n`, "a deferring candidate must not rewrite the incumbent lock");
  } finally { holder.kill("SIGKILL"); rmSync(userRoot, { recursive: true, force: true }); }
});

test("a dead holder pid is replaced so a crashed daemon never wedges the slot", async () => {
  const userRoot = fixture(), dead = await deadProcessPid();
  try {
    writeFileSync(daemonSingletonLockPath(userRoot, "default"), `${dead}\n`, "utf8");
    const held = await acquireDaemonSingleton({ userRoot, daemonId: "default", endpoint, pid: 5252, probe: async () => false });
    assert.equal(held.claim, "acquired");
    assert.equal(readFileSync(daemonSingletonLockPath(userRoot, "default"), "utf8"), "5252\n");
    held.release();
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("an unparsable lock body is treated as abandoned and replaced", async () => {
  const userRoot = fixture();
  try {
    writeFileSync(daemonSingletonLockPath(userRoot, "default"), "not-a-pid\n", "utf8");
    const held = await acquireDaemonSingleton({ userRoot, daemonId: "default", endpoint, pid: 6262, probe: async () => false });
    assert.equal(held.claim, "acquired");
    held.release();
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("a socket that answers is a live incumbent even before the lock is consulted", async () => {
  const userRoot = fixture();
  try {
    const incumbent = await acquireDaemonSingleton({ userRoot, daemonId: "default", endpoint, pid: 7272, probe: async () => true });
    assert.equal(incumbent.claim, "incumbent");
    assert.equal(incumbent.witness, "unix-socket");
    assert.equal(existsSync(daemonSingletonLockPath(userRoot, "default")), false, "a deferring candidate must not leave a lock behind");
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("a socket that starts answering after the claim makes the candidate stand down and release", async () => {
  const userRoot = fixture();
  try {
    let probes = 0;
    const incumbent = await acquireDaemonSingleton({ userRoot, daemonId: "default", endpoint, pid: 8282, probe: async () => (probes += 1) > 1 });
    assert.equal(incumbent.claim, "incumbent");
    assert.equal(incumbent.witness, "unix-socket");
    assert.equal(existsSync(daemonSingletonLockPath(userRoot, "default")), false, "the fresh claim must be rolled back when an older daemon owns the socket");
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

function fixture(): string { const userRoot = path.join(mkdtempSync(path.join(tmpdir(), "ha-daemon-singleton-")), "user"); mkdirSync(userRoot, { recursive: true }); return userRoot; }
function liveProcess(): Promise<ChildProcess> { const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000);"]); return new Promise((resolve, reject) => { child.once("spawn", () => resolve(child)); child.once("error", reject); }); }
async function deadProcessPid(): Promise<number> { const child = spawn(process.execPath, ["-e", ""]); const pid = child.pid!; await new Promise((resolve) => child.once("exit", resolve)); return pid; }

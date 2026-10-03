// harness-test-tier: integration
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot } from "../src/protocol/daemon-protocol.contract.ts";
import {
  acquireDaemonAutostartFlight,
  acquireDaemonSingleton,
  daemonAutostartLockPath,
  daemonSingletonLockPath,
} from "../src/daemon-singleton.ts";
import { acquireWorkspaceLock, staleWriterLock } from "../src/repo-cell-lock.ts";

for (const signal of ["alive", "EPERM"] as const) {
  for (const creation of [1000, 2000, 3000, "failed", "empty"] as const) {
    test(`Windows ${signal} holder creation ${creation} against lock at 2000`, (t) => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "win32" });
      t.after(() => Object.defineProperty(process, "platform", platform));
      t.mock.method(process, "kill", () => {
        if (signal === "EPERM") throw Object.assign(new Error("permission unavailable"), { code: "EPERM" });
        return true;
      });
      t.mock.method(childProcess, "execFileSync", (command, args) => {
        assert.equal(command, "powershell.exe");
        assert.match(String(args), /Get-Process -Id/);
        if (creation === "failed") throw new Error("creation query failed");
        if (creation === "empty") return "";
        return String((BigInt(creation) + 11644473600000n) * 10000n);
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      const dir = mkdtempSync(path.join(tmpdir(), "ha-lock-identity-"));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const lock = path.join(dir, "writer.lock");
      writeFileSync(lock, `${process.pid}\n`);
      utimesSync(lock, new Date(2000), new Date(2000));
      if (typeof creation === "number") assert.equal(staleWriterLock(lock), creation > 2000);
      else assert.throws(() => staleWriterLock(lock), /creation query|creation time/);
    });
  }
}

for (const platformName of ["linux", "darwin"] as const) {
  test(`${platformName} retains a live holder despite old lock or late proc directory mtime`, (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: platformName });
    t.after(() => Object.defineProperty(process, "platform", platform));
    t.mock.method(process, "kill", () => true);
    const originalStat = fs.statSync;
    t.mock.method(fs, "statSync", (target, ...args) =>
      String(target).startsWith("/proc/") ? { mtimeMs: 3000 } : originalStat(target, ...args),
    );
    t.mock.method(childProcess, "execFileSync", () => {
      throw new Error("non-Windows query must not run");
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const dir = mkdtempSync(path.join(tmpdir(), "ha-posix-lock-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const lock = path.join(dir, "writer.lock");
    writeFileSync(lock, `${process.pid}\n`);
    utimesSync(lock, new Date(2000), new Date(2000));
    assert.equal(staleWriterLock(lock), false);
  });
}

test("all lock paths retain old live holders and have one concurrent claimant", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ha-live-locks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "repo"));
  const root = canonicalRoot(path.join(dir, "repo"));
  const lock = await acquireWorkspaceLock(root);
  try {
    await assert.rejects(acquireWorkspaceLock(root), /writer lock is held/);
  } finally {
    await lock.close();
  }
  const flight = await acquireDaemonAutostartFlight({ userRoot: dir, daemonId: "flight" });
  const flightPath = daemonAutostartLockPath(dir, "flight");
  utimesSync(flightPath, new Date(2000), new Date(2000));
  try {
    assert.equal((await acquireDaemonAutostartFlight({ userRoot: dir, daemonId: "flight" })).owner, false);
  } finally {
    flight.release();
  }
  const outcomes = await Promise.all(
    Array.from({ length: 8 }, () =>
      acquireDaemonSingleton({ userRoot: dir, daemonId: "race", endpoint: "unused", probe: async () => false }),
    ),
  );
  assert.equal(outcomes.filter((outcome) => outcome.claim === "acquired").length, 1);
  const singletonPath = daemonSingletonLockPath(dir, "race");
  utimesSync(singletonPath, new Date(2000), new Date(2000));
  assert.equal(
    (await acquireDaemonSingleton({ userRoot: dir, daemonId: "race", endpoint: "unused", probe: async () => false }))
      .claim,
    "incumbent",
  );
  for (const outcome of outcomes) if (outcome.claim === "acquired") outcome.release();
});

for (const kind of ["workspace", "singleton", "autostart"] as const) {
  test(`${kind} Windows reuse recovery and query failure preserve the same rule`, async (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    t.after(() => Object.defineProperty(process, "platform", platform));
    t.mock.method(process, "kill", () => {
      throw Object.assign(new Error("permission unavailable"), { code: "EPERM" });
    });
    let queryFails = true;
    t.mock.method(childProcess, "execFileSync", () => {
      if (queryFails) throw new Error("creation query failed");
      return String((3000n + 11644473600000n) * 10000n);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const dir = mkdtempSync(path.join(tmpdir(), "ha-shared-rule-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, "repo"));
    const root = canonicalRoot(path.join(dir, "repo"));
    const target =
      kind === "workspace"
        ? `${root}.harness-anything-writer.lock`
        : kind === "singleton"
          ? daemonSingletonLockPath(dir, "rule")
          : daemonAutostartLockPath(dir, "rule");
    writeFileSync(target, "4242\n");
    utimesSync(target, new Date(2000), new Date(2000));
    const acquire = () =>
      kind === "workspace"
        ? acquireWorkspaceLock(root)
        : kind === "singleton"
          ? acquireDaemonSingleton({ userRoot: dir, daemonId: "rule", endpoint: "unused", probe: async () => false })
          : acquireDaemonAutostartFlight({ userRoot: dir, daemonId: "rule" });
    await assert.rejects(acquire(), /creation query failed/);
    assert.equal(fs.readFileSync(target, "utf8"), "4242\n");
    queryFails = false;
    const held = await acquire();
    assert.equal(fs.readFileSync(target, "utf8"), `${process.pid}\n`);
    if ("close" in held) await held.close();
    else if ("release" in held) held.release();
  });
}

test("concurrent dead-holder recovery must have one singleton winner", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ha-stale-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(process, "kill", (pid) => {
    if (pid === 4242) throw Object.assign(new Error("dead holder"), { code: "ESRCH" });
    return true;
  });
  writeFileSync(daemonSingletonLockPath(dir, "race"), "4242\n");
  const outcomes = await Promise.all(
    Array.from({ length: 8 }, () =>
      acquireDaemonSingleton({ userRoot: dir, daemonId: "race", endpoint: "unused", probe: async () => false }),
    ),
  );
  for (const outcome of outcomes) if (outcome.claim === "acquired") outcome.release();
  assert.equal(outcomes.filter((outcome) => outcome.claim === "acquired").length, 1);
});

test("a separate writer process keeps its workspace lock during candidate attach", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ha-external-writer-"));
  const root = canonicalRoot(dir);
  const entry = new URL("../src/repo-cell-lock.ts", import.meta.url).href;
  const child = childProcess.spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { acquireWorkspaceLock } from ${JSON.stringify(entry)};
    const lock = await acquireWorkspaceLock(${JSON.stringify(root)});
    process.stdout.write('held');
    process.stdin.once('data', async () => { await lock.close(); process.exit(0); });
  `,
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.stdin.end("close");
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  await once(child.stdout, "data");
  await assert.rejects(acquireWorkspaceLock(root), /writer lock is held/);
  assert.equal(fs.readFileSync(`${root}.harness-anything-writer.lock`, "utf8"), `${child.pid}\n`);
});

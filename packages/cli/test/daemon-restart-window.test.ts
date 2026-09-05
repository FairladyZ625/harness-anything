// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { daemonPidPath } from "../../daemon/src/daemon-singleton.ts";
import type { DaemonLaunchSpec } from "../../daemon/src/client/daemon-autostart.ts";
import { withAutostart } from "../src/daemon/with-autostart.ts";

const unusedLaunch = (): DaemonLaunchSpec => ({ command: process.execPath, args: [], env: {} });

test("daemon_stopping waits for the replacement generation and resends exactly once", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-restart-ready-")),
    socketPath = path.join(parent, "daemon.sock"),
    daemonId = "restart-ready",
    pidPath = daemonPidPath(parent, daemonId),
    server = createServer(),
    receipts = [
      { ok: false, code: "daemon_stopping" },
      { ok: true, outcome: "applied" },
    ],
    request = async () => receipts.shift()!;
  writeFileSync(pidPath, "111\n");
  const replace = setTimeout(() => {
    writeFileSync(pidPath, "222\n");
    server.listen(socketPath);
  }, 20);
  try {
    const result = await withAutostart(request, unusedLaunch, socketPath, {
      autostart: true,
      env: {},
      invokingRoot: process.cwd(),
      userRoot: parent,
      daemonId,
      restartBudgetMs: 1_000,
    });
    assert.equal(result.outcome, "applied");
    assert.deepEqual(result.daemonRestart, {
      waitedMs: (result.daemonRestart as { waitedMs: number }).waitedMs,
      retries: 1,
    });
    assert.equal(receipts.length, 0, "the original request is resent exactly once");
  } finally {
    clearTimeout(replace);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(parent, { recursive: true, force: true });
  }
});

test("restart budget exhaustion returns daemon_restarting without resending", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-restart-timeout-")),
    daemonId = "restart-timeout",
    calls: number[] = [];
  writeFileSync(daemonPidPath(parent, daemonId), "111\n");
  try {
    const result = await withAutostart(
      async () => {
        calls.push(Date.now());
        return { ok: false, code: "daemon_stopping" };
      },
      unusedLaunch,
      path.join(parent, "missing.sock"),
      {
        autostart: true,
        env: {},
        invokingRoot: process.cwd(),
        userRoot: parent,
        daemonId,
        restartBudgetMs: 25,
      },
    );
    assert.equal(result.code, "daemon_restarting");
    assert.match(String((result.error as { hint: string }).hint), /old build -> new build.*waited 1s/u);
    assert.deepEqual(result.daemonRestart, {
      waitedMs: (result.daemonRestart as { waitedMs: number }).waitedMs,
      retries: 0,
    });
    assert.equal(calls.length, 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { DaemonLaunchSpec } from "@harness-anything/daemon/internal/client/daemon-autostart";
import { daemonPidPath } from "@harness-anything/daemon/internal/daemon-singleton";
import { withAutostart } from "../src/daemon/with-autostart.ts";

const unusedLaunch = (): DaemonLaunchSpec => ({ command: "unused", args: [], env: {} });

function options(parent: string) {
  return {
    autostart: false,
    env: {},
    invokingRoot: process.cwd(),
    userRoot: parent,
    daemonId: "identity-retry",
    restartBudgetMs: 5_000,
    commandCategory: "operation" as const,
  };
}

test("an identity-authority outage is retried once in the unified daemon restart path", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-identity-retry-"));
  let calls = 0;
  try {
    const result = await withAutostart(
      async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, outcome: "op_rejected", code: "keycloak_unavailable" }
          : { ok: true, outcome: "applied", code: null };
      },
      unusedLaunch,
      path.join(parent, "daemon.sock"),
      options(parent),
    );
    assert.equal(result.outcome, "applied");
    assert.equal(calls, 2, "the pre-apply identity refusal is resent after its window closes");
    assert.equal((result.daemonRestart as { retries: number }).retries, 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a second identity-authority refusal is returned without another retry", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-identity-retry-exhausted-"));
  let calls = 0;
  try {
    const result = await withAutostart(
      async () => {
        calls += 1;
        return { ok: false, outcome: "op_rejected", code: "keycloak_unavailable" };
      },
      unusedLaunch,
      path.join(parent, "daemon.sock"),
      options(parent),
    );
    assert.equal(result.code, "keycloak_unavailable");
    assert.equal(calls, 2, "one immediate resend, then the real identity failure is returned");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an indeterminate identity failure is not replayed", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-identity-indeterminate-"));
  let calls = 0;
  try {
    const result = await withAutostart(
      async () => {
        calls += 1;
        return { ok: false, outcome: "indeterminate", code: "keycloak_unavailable" };
      },
      unusedLaunch,
      path.join(parent, "daemon.sock"),
      options(parent),
    );
    assert.equal(result.outcome, "indeterminate");
    assert.equal(calls, 1, "a write that may already have landed is never replayed");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("daemon_stopping -> identity refusal -> applied reuses the same bounded recovery", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-identity-after-restart-")),
    daemonId = "identity-after-restart",
    pidPath = daemonPidPath(parent, daemonId);
  writeFileSync(pidPath, "111\n");
  let calls = 0;
  try {
    const result = await withAutostart(
      async () => {
        calls += 1;
        if (calls === 1) {
          writeFileSync(pidPath, "222\n");
          return { ok: false, code: "daemon_stopping" };
        }
        return calls === 2
          ? { ok: false, outcome: "op_rejected", code: "keycloak_unavailable" }
          : { ok: true, outcome: "applied", code: null };
      },
      unusedLaunch,
      path.join(parent, "daemon.sock"),
      {
        autostart: false,
        env: {},
        invokingRoot: process.cwd(),
        userRoot: parent,
        daemonId,
        restartBudgetMs: 5_000,
        commandCategory: "operation",
      },
    );
    assert.equal(result.outcome, "applied");
    assert.equal(calls, 3, "the successor's identity refusal gets the same one retry");
    assert.equal((result.daemonRestart as { retries: number }).retries, 2);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a reconnected socket still gets the identity recovery", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-identity-after-reconnect-")),
    daemonId = "identity-after-reconnect",
    socketDir = mkdtempSync("/tmp/ha-id-"),
    socketPath = path.join(socketDir, "d.sock"),
    server = createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const launch = (): DaemonLaunchSpec => ({
    command: process.execPath,
    args: ["serve-entry.mjs", "serve", "--user-root", parent, "--daemon-id", daemonId],
    env: {},
  });
  let calls = 0;
  try {
    const result = await withAutostart(
      async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("daemon_unavailable"), { code: "ECONNREFUSED" });
        return calls === 2
          ? { ok: false, outcome: "op_rejected", code: "keycloak_unavailable" }
          : { ok: true, outcome: "applied", code: null };
      },
      launch,
      socketPath,
      {
        autostart: true,
        env: {},
        invokingRoot: process.cwd(),
        userRoot: parent,
        daemonId,
        restartBudgetMs: 5_000,
        commandCategory: "operation",
      },
    );
    assert.equal(result.outcome, "applied");
    assert.equal(calls, 3, "the autostart retry's identity refusal gets the same one retry");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(socketDir, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a Keycloak Admin write transport failure is not replayed", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-admin-write-not-replayed-"));
  let calls = 0;
  try {
    const result = await withAutostart(
      async () => {
        calls += 1;
        return { ok: false, outcome: "op_rejected", code: "daemon_error" };
      },
      unusedLaunch,
      path.join(parent, "daemon.sock"),
      options(parent),
    );
    assert.equal(result.code, "daemon_error");
    assert.equal(calls, 1, "an admin write with a lost response may already have landed");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

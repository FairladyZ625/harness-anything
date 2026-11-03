// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { DaemonLaunchSpec } from "@harness-anything/daemon/internal/client/daemon-autostart";
import { daemonSingletonLockPath } from "@harness-anything/daemon/internal/daemon-singleton";
import { openDaemonLifecycleLog } from "@harness-anything/daemon/internal/lifecycle-log";
import { withAutostart } from "../src/daemon/with-autostart.ts";

const unusedLaunch = (): DaemonLaunchSpec => ({ command: "unused", args: [], env: {} });

function launchSpec(parent: string, daemonId: string): DaemonLaunchSpec {
  return {
    command: process.execPath,
    args: ["serve-entry.mjs", "serve", "--user-root", parent, "--daemon-id", daemonId],
    env: {},
  };
}

/** A live bound socket whose current generation has the requested identity-resume state. */
async function boundSocketWithLifecycle(
  parent: string,
  daemonId: string,
  identity: "pending" | "ready" | "failed",
  onConnection?: (connections: number, recordIdentityReady: () => void) => void,
): Promise<{ readonly socketPath: string; readonly close: () => Promise<void> }> {
  // A Unix socket address is capped at 104 bytes on macOS and the isolated runner sets a long
  // TMPDIR; bind under a short directory instead of beside the lifecycle files.
  const socketDir = mkdtempSync("/tmp/ha-identity-"),
    socketPath = path.join(socketDir, `${daemonId}.sock`),
    lifecycle = openDaemonLifecycleLog({ userRoot: parent, daemonId });
  lifecycle.record({ event: "process_start" });
  lifecycle.record({ event: "socket_bound" });
  if (identity === "ready") lifecycle.record({ event: "identity_ready" });
  if (identity === "failed") lifecycle.record({ event: "rbac_resume_failed", error: "postgres exited with 1." });
  // The successor owns the singleton, so the wait must not spawn a second daemon.
  writeFileSync(daemonSingletonLockPath(parent, daemonId), `${process.pid}\n`, "utf8");
  let connections = 0;
  const server = createServer();
  server.on("connection", (socket) => {
    connections += 1;
    onConnection?.(connections, () => lifecycle.record({ event: "identity_ready" }));
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(socketDir, { recursive: true, force: true });
    },
  };
}

test("a keycloak_unavailable before the write is applied is returned, not replayed", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-identity-no-replay-"));
  let calls = 0;
  try {
    const result = await withAutostart(
      async () => {
        calls += 1;
        return { ok: false, outcome: "op_rejected", code: "keycloak_unavailable" };
      },
      unusedLaunch,
      path.join(parent, "daemon.sock"),
      {
        autostart: false,
        env: {},
        invokingRoot: process.cwd(),
        userRoot: parent,
        daemonId: "identity-no-replay",
        restartBudgetMs: 5_000,
        commandCategory: "operation",
      },
    );
    assert.equal(result.code, "keycloak_unavailable");
    assert.equal(calls, 1, "a settled identity refusal is the caller's answer, not a retry trigger");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test(
  "a write waits for the successor's identity resume before it is resent",
  {
    skip: process.platform === "win32" ? "requires POSIX Unix-domain sockets" : false,
  },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-identity-waits-")),
      daemonId = "identity-waits";
    let identityReady = false,
      calls = 0;
    // The third socket probe is the observable action that makes the daemon write-ready. The write
    // must not be resent before it; without the readiness gate the first resend would see identity
    // still pending and return keycloak_unavailable.
    const server = await boundSocketWithLifecycle(parent, daemonId, "pending", (connections, recordIdentityReady) => {
      if (connections !== 3) return;
      recordIdentityReady();
      identityReady = true;
    });
    try {
      const result = await withAutostart(
        async () => {
          calls += 1;
          if (calls === 1) throw Object.assign(new Error("daemon_unavailable"), { code: "ECONNREFUSED" });
          assert.equal(identityReady, true, "the write is resent only after the identity resume settled");
          return { ok: true, outcome: "applied", code: null };
        },
        () => launchSpec(parent, daemonId),
        server.socketPath,
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
      assert.equal(calls, 2, "the pre-apply request is resent exactly once after readiness");
    } finally {
      await server.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "a settled identity failure after startup fails immediately without a second request",
  {
    skip: process.platform === "win32" ? "requires POSIX Unix-domain sockets" : false,
  },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-identity-failed-")),
      daemonId = "identity-failed",
      server = await boundSocketWithLifecycle(parent, daemonId, "failed");
    let calls = 0;
    try {
      const result = await withAutostart(
        async () => {
          calls += 1;
          if (calls === 1) throw Object.assign(new Error("daemon_unavailable"), { code: "ECONNREFUSED" });
          return { ok: false, outcome: "op_rejected", code: "keycloak_unavailable" };
        },
        () => launchSpec(parent, daemonId),
        server.socketPath,
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
      assert.equal(result.code, "keycloak_unavailable", "the real identity refusal is returned immediately");
      assert.equal(calls, 2, "a settled identity failure is not replayed");
    } finally {
      await server.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "a startup that never settles identity fails with a clear daemon_starting reason",
  {
    skip: process.platform === "win32" ? "requires POSIX Unix-domain sockets" : false,
  },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-identity-timeout-")),
      daemonId = "identity-timeout",
      server = await boundSocketWithLifecycle(parent, daemonId, "pending");
    let calls = 0;
    try {
      await assert.rejects(
        withAutostart(
          async () => {
            calls += 1;
            throw Object.assign(new Error("daemon_unavailable"), { code: "ECONNREFUSED" });
          },
          () => launchSpec(parent, daemonId),
          server.socketPath,
          {
            autostart: true,
            env: {},
            invokingRoot: process.cwd(),
            userRoot: parent,
            daemonId,
            restartBudgetMs: 1,
            commandCategory: "operation",
          },
        ),
        (error: Error & { readonly code?: string }) => {
          assert.equal(error.code, "daemon_starting");
          assert.match(error.message, /managed identity services are starting/u);
          return true;
        },
      );
      assert.equal(calls, 1, "the write is never sent while identity is unsettled");
    } finally {
      await server.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ManagedRbacLifecycleEvent } from "@harness-anything/authorization-keycloak/managed-rbac-service";
import { managedShutdownFixture } from "./managed-rbac-shutdown.fixture.ts";

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
  });
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function exchange(port: number) {
  const socket = connect(port, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write("hello");
    const [chunk] = await new Promise<[Buffer]>((resolve, reject) => {
      socket.once("data", (data: Buffer) => resolve([data]));
      socket.once("error", reject);
    });
    return String(chunk);
  } finally {
    socket.destroy();
  }
}

/**
 * Waits on supervision events instead of the clock: the service records each event synchronously,
 * and the test's node:test timeout is the only hang guard.
 */
function createLifecycleWatcher() {
  const events: ManagedRbacLifecycleEvent[] = [],
    waiters: {
      readonly matches: (event: ManagedRbacLifecycleEvent) => boolean;
      readonly resolve: (event: ManagedRbacLifecycleEvent) => void;
    }[] = [];
  return {
    events,
    record: (event: ManagedRbacLifecycleEvent) => {
      events.push(event);
      const index = waiters.findIndex((waiter) => waiter.matches(event));
      if (index === -1) return;
      waiters.splice(index, 1)[0]!.resolve(event);
    },
    next: (matches: (event: ManagedRbacLifecycleEvent) => boolean): Promise<ManagedRbacLifecycleEvent> => {
      const recorded = events.find(matches);
      if (recorded) return Promise.resolve(recorded);
      return new Promise((resolve) => waiters.push({ matches, resolve }));
    },
  };
}

test(
  "a managed service that exits after readiness is restarted by the daemon that owns it",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-supervision-")),
      bin = path.join(root, "rbac", "runtime", "postgres", "bin"),
      data = path.join(root, "rbac", "data", "postgres"),
      listener = {
        address: "127.0.0.1",
        hostname: "center.example.test",
        port: await availablePort(),
        certificateFile: path.join(root, "test.crt"),
        certificateKeyFile: path.join(root, "test.key"),
      },
      watcher = createLifecycleWatcher();
    mkdirSync(bin, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(path.join(bin, "postgres"), "fixture");
    writeFileSync(listener.certificateKeyFile, "fixture", { mode: 0o600 });
    writeFileSync(
      path.join(root, "rbac", "config.json"),
      JSON.stringify({
        mode: "managed",
        url: `http://127.0.0.1:${await availablePort()}`,
        realm: "harness",
        clientId: "harness-center",
        postgresPort: await availablePort(),
        managementPort: await availablePort(),
        listener,
      }),
    );
    const { service, children } = managedShutdownFixture(root, { recordLifecycle: watcher.record });
    try {
      await service.start();
      assert.equal(children.length, 2, "PostgreSQL and Keycloak are daemon-owned children");
      assert.equal(await exchange(listener.port), "tls:hello");

      const keycloak = children[1]!,
        exited = new Promise<void>((resolve) => keycloak.once("exit", () => resolve()));
      keycloak.kill("SIGTERM");
      await exited;

      const exit = await watcher.next((event) => event.event === "rbac_child_exited");
      if (exit.event !== "rbac_child_exited") throw new Error("expected an rbac_child_exited event");
      assert.equal(exit.service, "keycloak");
      const scheduled = await watcher.next((event) => event.event === "rbac_restart_scheduled");
      if (scheduled.event !== "rbac_restart_scheduled") throw new Error("expected an rbac_restart_scheduled event");
      assert.deepEqual(
        { service: scheduled.service, attempt: scheduled.attempt, delayMs: scheduled.delayMs },
        { service: "keycloak", attempt: 0, delayMs: 1_000 },
      );
      const restart = await watcher.next((event) => event.event === "rbac_restart");
      if (restart.event !== "rbac_restart") throw new Error("expected an rbac_restart event");
      assert.equal(restart.ok, true);
      assert.equal(children.length, 3, "the daemon started a replacement Keycloak");
      assert.notEqual(children[2], keycloak, "the replacement is a new process");
      assert.equal(await exchange(listener.port), "tls:hello", "the replacement serves the configured listener");

      await service.stop();
      assert.equal(children.length, 3, "an intentional stop does not start a replacement");
      assert.equal(
        watcher.events.filter((event) => event.event === "rbac_child_exited").length,
        1,
        "the operator's stop is not reported as an unexpected child exit",
      );
    } finally {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

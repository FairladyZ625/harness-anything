// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ManagedRbacLifecycleEvent } from "@harness-anything/authorization-keycloak/managed-rbac-service";
import { managedShutdownFixture, type ManagedShutdownFixtureOptions } from "./managed-rbac-shutdown.fixture.ts";

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

async function createManagedRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-supervision-")),
    bin = path.join(root, "rbac", "runtime", "postgres", "bin"),
    data = path.join(root, "rbac", "data", "postgres"),
    // The managed health read is a GET /realms/<realm>; backup/restore wait for it after restarting.
    healthPort = await availablePort(),
    health = createHttpServer((_request, response) => {
      response.writeHead(200);
      response.end("{}");
    }),
    listener = {
      address: "127.0.0.1",
      hostname: "center.example.test",
      port: await availablePort(),
      certificateFile: path.join(root, "test.crt"),
      certificateKeyFile: path.join(root, "test.key"),
    };
  mkdirSync(bin, { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(path.join(bin, "postgres"), "fixture");
  writeFileSync(listener.certificateKeyFile, "fixture", { mode: 0o600 });
  writeFileSync(
    path.join(root, "rbac", "config.json"),
    JSON.stringify({
      mode: "managed",
      url: `http://127.0.0.1:${healthPort}`,
      realm: "harness",
      clientId: "harness-center",
      postgresPort: await availablePort(),
      managementPort: await availablePort(),
      listener,
    }),
  );
  await new Promise<void>((resolve, reject) => {
    health.once("error", reject);
    health.listen(healthPort, "127.0.0.1", resolve);
  });
  return {
    root,
    listener,
    closeHealth: () => new Promise<void>((resolve) => health.close(() => resolve())),
  };
}

function killChild(child: ReturnType<typeof managedShutdownFixture>["children"][number], signal = "SIGTERM") {
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill(signal);
  return exited;
}

test(
  "a managed service that exits after readiness is restarted by the daemon that owns it",
  { timeout: 30_000 },
  async () => {
    const { root, listener, closeHealth } = await createManagedRoot(),
      watcher = createLifecycleWatcher(),
      { service, children } = managedShutdownFixture(root, { recordLifecycle: watcher.record });
    try {
      await service.start();
      assert.equal(children.length, 2, "PostgreSQL and Keycloak are daemon-owned children");
      assert.equal(await exchange(listener.port), "tls:hello");

      const keycloak = children[1]!;
      await killChild(keycloak);

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
      await closeHealth();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a replacement that exits 0 before readiness fails its start and the next attempt succeeds",
  { timeout: 30_000 },
  async () => {
    const { root, listener, closeHealth } = await createManagedRoot(),
      watcher = createLifecycleWatcher(),
      { service, children } = managedShutdownFixture(root, {
        recordLifecycle: watcher.record,
        exitBeforeReadyOnCall: { child: "keycloak", call: 2 },
      });
    try {
      await service.start();
      await killChild(children[1]!);

      const failed = await watcher.next((event) => event.event === "rbac_restart" && !event.ok);
      if (failed.event !== "rbac_restart") throw new Error("expected a failed rbac_restart event");
      assert.equal(failed.service, "keycloak");
      const retry = await watcher.next((event) => event.event === "rbac_restart_scheduled" && event.attempt === 1);
      if (retry.event !== "rbac_restart_scheduled") throw new Error("expected a second restart_scheduled event");
      assert.equal(retry.delayMs, 2_000, "the failed attempt backs off before retrying");
      const succeeded = await watcher.next((event) => event.event === "rbac_restart" && event.ok);
      if (succeeded.event !== "rbac_restart") throw new Error("expected a successful rbac_restart event");
      assert.equal(children.length, 4, "the clean pre-readiness exit was replaced by a live child");
      assert.equal(await exchange(listener.port), "tls:hello");
    } finally {
      await service.stop();
      await closeHealth();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a spawn error without an exit event does not leave a rejected readiness for later retries",
  { timeout: 30_000 },
  async () => {
    const { root, listener, closeHealth } = await createManagedRoot(),
      watcher = createLifecycleWatcher(),
      { service, children } = managedShutdownFixture(root, {
        recordLifecycle: watcher.record,
        spawnErrorOnCall: { child: "keycloak", call: 2 },
      });
    try {
      await service.start();
      await killChild(children[1]!);

      const failed = await watcher.next((event) => event.event === "rbac_restart" && !event.ok);
      if (failed.event !== "rbac_restart") throw new Error("expected a failed rbac_restart event");
      const succeeded = await watcher.next((event) => event.event === "rbac_restart" && event.ok);
      if (succeeded.event !== "rbac_restart") throw new Error("expected a successful rbac_restart event");
      assert.equal(children.length, 4, "the errored spawn was replaced by a live child");
      assert.equal(await exchange(listener.port), "tls:hello");
      // The errored child has no valid pid/exit event; stop must still finish.
      await service.stop();
      assert.equal(children.length, 4, "stop does not create another child");
    } finally {
      await service.stop();
      await closeHealth();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "stop during an in-flight automatic restart leaves no child and spawns nothing after it",
  { timeout: 30_000 },
  async () => {
    const { root, listener, closeHealth } = await createManagedRoot(),
      gateFile = path.join(root, "postgres-ready.gate"),
      watcher = createLifecycleWatcher();
    let releaseReplacement!: () => void;
    const replacementSpawned = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const options: ManagedShutdownFixtureOptions = {
      recordLifecycle: watcher.record,
      delayReadyOnCall: { child: "postgres", call: 2, gateFile },
      onSpawn: (child, call) => {
        if (child === "postgres" && call === 2) releaseReplacement();
      },
    };
    const { service, children } = managedShutdownFixture(root, options);
    try {
      await service.start();
      assert.equal(await exchange(listener.port), "tls:hello");

      // Both managed services go down: the automatic restart starts PostgreSQL with a gated readiness.
      await Promise.all(children.map((child) => killChild(child)));
      await replacementSpawned;
      assert.equal(children.length, 3, "the restart is paused inside its PostgreSQL start");

      // Stop runs while that start is still awaiting readiness. The teardown joins the lifecycle
      // queue, and the released start must not add Keycloak after the stop.
      const stopping = service.stop();
      writeFileSync(gateFile, "");
      await stopping;

      assert.equal(children.length, 3, "the aborted restart spawned no Keycloak after the stop");
      assert.ok(
        children.every((child) => child.exitCode !== null || child.signalCode !== null),
        "every child has exited when stop resolves",
      );
    } finally {
      await service.stop();
      await closeHealth();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a running backup through the public lifecycle queue completes and leaves the service usable",
  { timeout: 60_000 },
  async () => {
    const { root, listener, closeHealth } = await createManagedRoot(),
      backupDir = path.join(root, "backup");
    const { service, children } = managedShutdownFixture(root);
    try {
      await service.start();
      const receipt = await service.run({ operation: "backup", backupDir });
      assert.equal(receipt.ok, true);
      assert.equal(existsSync(path.join(backupDir, "keycloak-data.tar.gz")), true);
      assert.equal(children.length, 4, "backup stopped and restarted both services");
      assert.equal(await exchange(listener.port), "tls:hello");
      const listenerRead = await service.run({ operation: "listener" });
      assert.equal(listenerRead.ok, true, "a later lifecycle operation still runs");
      assert.equal((await service.stop()).ok, true);
    } finally {
      await service.stop();
      await closeHealth();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a valid restore through the public lifecycle queue completes and leaves the service usable",
  { timeout: 60_000 },
  async () => {
    const { root, listener, closeHealth } = await createManagedRoot(),
      backupDir = path.join(root, "backup");
    const { service, children } = managedShutdownFixture(root);
    try {
      await service.start();
      assert.equal((await service.run({ operation: "backup", backupDir })).ok, true);
      const restored = await service.run({ operation: "restore", backupDir });
      assert.equal(restored.ok, true);
      assert.equal(await exchange(listener.port), "tls:hello");
      assert.equal(children.length, 6, "restore stopped and restarted the managed services");
      const listenerRead = await service.run({ operation: "listener" });
      assert.equal(listenerRead.ok, true, "a later lifecycle operation still runs");
      assert.equal((await service.stop()).ok, true);
    } finally {
      await service.stop();
      await closeHealth();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

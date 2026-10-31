// harness-test-tier: integration
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { managedShutdownFixture } from "./managed-rbac-shutdown.fixture.ts";

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function exchange(port: number) {
  const socket = connect(port, "127.0.0.1");
  try {
    await once(socket, "connect", { signal: AbortSignal.timeout(5000) });
    socket.write("hello");
    const [chunk] = await once(socket, "data", { signal: AbortSignal.timeout(5000) });
    return String(chunk);
  } finally {
    socket.destroy();
  }
}

test(
  "shutdown during managed resume releases child processes, PostgreSQL pid file and TLS passthrough for the successor",
  { timeout: 20_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-shutdown-")),
      bin = path.join(root, "rbac", "runtime", "postgres", "bin"),
      data = path.join(root, "rbac", "data", "postgres"),
      pidFile = path.join(data, "postmaster.pid"),
      listener = {
        address: "127.0.0.1",
        hostname: "center.example.test",
        port: await availablePort(),
        certificateFile: path.join(root, "test.crt"),
        certificateKeyFile: path.join(root, "test.key"),
      },
      predecessor = managedShutdownFixture(root, { ignoreSigterm: "keycloak" }),
      successor = managedShutdownFixture(root);
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
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      resumed = gate.then(() => predecessor.service.start()),
      host = await openDaemonHost({
        daemonId: "rbac-shutdown",
        userRoot: root,
        managedRbac: {
          run: (request) => predecessor.service.run(request),
          resume: () => resumed,
          stop: () => predecessor.service.stop(),
        },
      });
    try {
      const closing = host.close();
      release();
      await closing;
      assert.equal(predecessor.children.length, 2);
      assert.ok(
        predecessor.children.every((child) => child.exitCode === 0 || child.signalCode === "SIGKILL"),
        "close waits through SIGKILL until owned children actually exit",
      );
      assert.equal(predecessor.children[1]?.signalCode, "SIGKILL", "Keycloak intentionally ignored SIGTERM");
      assert.equal(existsSync(pidFile), false);
      await assert.rejects(exchange(listener.port), { code: "ECONNREFUSED" });
      await successor.service.start();
      assert.equal(await exchange(listener.port), "tls:hello");
      assert.equal(existsSync(pidFile), true);
      assert.equal(successor.children.length, 2);
    } finally {
      release();
      await resumed;
      await predecessor.service.stop();
      await successor.service.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bindWriterGenerationToken } from "@harness-anything/kernel";
import { bootstrapRepo, resolveRepoBootstrap } from "../src/repo-bootstrap.ts";
import { startDaemon, type RunningDaemon } from "../src/runtime.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { openBootstrappedRepoCell, registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { policyTestCenter, signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const execution of [false, true]) {
  test(
    `successor ${execution ? "execution" : "session"} authentication waits for managed resume on its real socket`,
    { timeout: 20_000 },
    async () => {
      const parent = mkdtempSync(path.join(tmpdir(), "ha-successor-resume-")),
        userRoot = path.join(parent, "user"),
        rootDir = path.join(parent, "repo"),
        repoId = "successor",
        resume = deferred(),
        center = await gatedCenter((await policyTestCenter()).url);
      rosterRepo(rootDir, repoId);
      registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
      signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
      writeFileSync(path.join(userRoot, "rbac/config.json"), JSON.stringify({ url: center.url, realm: "harness" }));
      const input = {
        daemonId: repoId,
        userRoot,
        buildSupersessionEnabled: false,
        managedRbac: {
          run: async () => ({ ok: true }),
          resume: () => resume.promise,
          stop: async () => ({ ok: true }),
        },
      };
      // Release the same registered slot through a real predecessor teardown before starting its successor.
      const predecessor = (await startDaemon({
        ...input,
        managedRbac: { ...input.managedRbac, resume: async () => undefined },
      })) as RunningDaemon;
      await predecessor.stop();
      const daemon = (await startDaemon(input)) as RunningDaemon;
      assert.equal(daemon.endpoint, predecessor.endpoint);
      const socket = net.createConnection(daemon.endpoint);
      const { JsonRpcLineClient } = await import("../src/client/local-json-rpc-client.ts");
      const client = new JsonRpcLineClient(socket, socket);
      let receipt: unknown;
      try {
        // The deadline guards a hang; attachment progress is observed on the actual status path.
        const attachmentDeadline = Date.now() + 10_000;
        for (;;) {
          const status = await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.status", {}, 2_000, 2_000);
          if ((status.repos as { state: string }[]).some((repo) => repo.state === "attached")) break;
          assert.ok(Date.now() < attachmentDeadline, `successor attachment did not settle: ${JSON.stringify(status)}`);
          await new Promise((done) => setImmediate(done));
        }
        await client.request(
          "protocol.hello",
          {
            protocolVersion: currentDaemonProtocolVersion,
            ...(execution ? { executionCredential: "unknown-execution" } : {}),
          },
          2_000,
        );
        const pending = client
          .request(
            "repo.agentRuntime.sessions.await",
            { repo: { repoId }, payload: { runtimeSessionIds: ["unknown-runtime"] } },
            10_000,
          )
          .then((value) => {
            receipt = value;
            return value;
          });
        // A real control roundtrip demonstrates that the socket serves while the center is gated.
        const status = await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.status", {}, 2_000, 2_000);
        assert.equal(status.ok, true);
        for (let turn = 0; turn < 20; turn++) await new Promise((done) => setImmediate(done));
        assert.equal(center.requests(), 0, "no successor authentication may consult the resuming center");
        assert.equal(receipt, undefined, "the await must remain pending behind resume");
        center.release();
        resume.resolve();
        const result = await pending;
        assert.equal(result.code === "bootstrap_failed", false, JSON.stringify(result));
        if (execution)
          assert.equal(
            result.code,
            "execution_credential_rejected",
            "unknown credentials remain rejected after resume",
          );
        else assert.equal(result.ok, true, JSON.stringify(result));
      } finally {
        resume.resolve();
        center.release();
        client.close();
        await daemon.stop();
        await center.close();
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );
}

for (const phase of ["authentication", "read"]) {
  test(`managed center stop abandons parked ${phase} before resetting authorization`, { timeout: 20_000 }, async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-stop-park-")),
      userRoot = path.join(parent, "user"),
      rootDir = path.join(parent, "repo"),
      repoId = "stop-park",
      readStarted = deferred(),
      reset = deferred(),
      stopStarted = deferred();
    rosterRepo(rootDir, repoId);
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
    signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
    const host = await openDaemonHost({
      daemonId: repoId,
      userRoot,
      managedRbac: {
        run: async () => ({ ok: true }),
        resume: async () => undefined,
        stop: async () => {
          stopStarted.resolve();
          reset.resolve();
        },
      },
      openCell: async (input) => {
        const cell = await openBootstrappedRepoCell(input);
        return {
          ...cell,
          read: async (...args: Parameters<typeof cell.read>) => {
            if (phase === "read" && args[0] === "repo.agentRuntime.sessions.read") {
              readStarted.resolve();
              await reset.promise;
              throw new TypeError("fetch failed");
            }
            return cell.read(...args);
          },
        };
      },
    });
    await host.attachmentsSettled();
    const server = createJsonRpcProtocolServer({
      host,
      build: { commit: null },
      authContext: { ...auth },
      emit: async () => undefined,
      ...(phase === "authentication"
        ? {
            sessionPrincipal: async () => {
              readStarted.resolve();
              await reset.promise;
              throw new TypeError("fetch failed");
            },
          }
        : {}),
    });
    try {
      await server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "protocol.hello",
        params: { protocolVersion: currentDaemonProtocolVersion },
      });
      const pending = server.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "repo.agentRuntime.sessions.await",
        params: { repo: { repoId }, payload: { runtimeSessionIds: ["live"] } },
      });
      await readStarted.promise;
      const closing = host.close();
      await stopStarted.promise;
      assert.equal(
        await pending,
        undefined,
        "host abandonment must win before managedRbac.stop resets an in-flight read",
      );
      await closing;
    } finally {
      reset.resolve();
      server.close();
      await host.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });
}

test(
  "configure-only remount exposes warming throughout old-cell drain and new-cell open",
  { timeout: 30_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-bootstrap-warming-")),
      userRoot = path.join(parent, "user"),
      rootDir = path.join(parent, "repo"),
      repoId = "remount",
      closing = deferred(),
      drain = deferred(),
      opening = deferred(),
      publish = deferred();
    rosterRepo(rootDir, repoId);
    const writer = { workspaceId: repoId, ownerId: "remount-fixture", generation: 0 };
    const initialized = bootstrapRepo(
      resolveRepoBootstrap({ rootDir, repoId, personId: "writer" }, auth),
      writer,
      bindWriterGenerationToken(writer),
    );
    assert.equal(initialized.publication.ok, true, JSON.stringify(initialized));
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
    signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
    let initial = true;
    const host = await openDaemonHost({
      daemonId: repoId,
      userRoot,
      openCell: async (input) => {
        if (input.bootstrap) {
          opening.resolve();
          await publish.promise;
        }
        const cell = await openBootstrappedRepoCell(input);
        return {
          ...cell,
          close: async () => {
            if (initial) {
              initial = false;
              closing.resolve();
              await drain.promise;
            }
            await cell.close();
          },
        };
      },
    });
    await host.attachmentsSettled();
    let bootstrap: ReturnType<typeof host.bootstrap> | undefined;
    try {
      bootstrap = host.bootstrap({ rootDir, repoId, configureOnly: true }, auth);
      await closing.promise;
      assert.equal(host.status().repos.find((repo) => repo.repoId === repoId)?.state, "warming");
      drain.resolve();
      await opening.promise;
      let settled = false;
      const reading = host.read(repoId, "repo.agentRuntime.sessions.read", { runtimeSessionId: "absent" }, auth).then(
        () => {
          settled = true;
        },
        (error: { code: string }) => {
          settled = true;
          return error.code;
        },
      );
      for (let turn = 0; turn < 20; turn++) await new Promise((done) => setImmediate(done));
      assert.equal(settled, false, "reads must wait while the old cell is absent");
      publish.resolve();
      const result = await bootstrap;
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(await reading, "runtime_session_not_found");
      assert.equal(host.status().repos.find((repo) => repo.repoId === repoId)?.state, "attached");
    } finally {
      drain.resolve();
      publish.resolve();
      await bootstrap?.catch(() => undefined);
      await host.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

async function gatedCenter(upstreamUrl: string) {
  let ready = false,
    requests = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    if (!ready) {
      requests++;
      socket.end("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const upstream = net.connect(Number(new URL(upstreamUrl).port), "127.0.0.1");
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.on("error", () => socket.destroy());
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  server.unref();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    requests: () => requests,
    release: () => {
      ready = true;
    },
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((done) => server.close(() => done()));
    },
  };
}

for (const stopping of [false, true]) {
  test(`request admission with stopping=${stopping} preserves the correct authentication boundary`, async () => {
    let authentications = 0;
    const server = createJsonRpcProtocolServer({
      host: {} as Awaited<ReturnType<typeof openDaemonHost>>,
      build: { commit: null },
      authContext: { ...auth },
      stopping: () => stopping,
      emit: async () => undefined,
      sessionPrincipal: async () => {
        authentications++;
        throw new TypeError("fetch failed");
      },
    });
    try {
      await server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "protocol.hello",
        params: { protocolVersion: currentDaemonProtocolVersion },
      });
      const response = await server.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "repo.agentRuntime.sessions.await",
        params: { repo: { repoId: "handoff" }, payload: { runtimeSessionIds: ["live"] } },
      });
      assert.equal(
        (response as { result: { code: string } }).result.code,
        stopping ? "daemon_stopping" : "bootstrap_failed",
      );
      assert.equal(authentications, stopping ? 0 : 1);
    } finally {
      server.close();
    }
  });
}

test("a failed remount releases warming and exposes the existing unavailable state", { timeout: 20_000 }, async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-remount-failed-")),
    userRoot = path.join(parent, "user"),
    rootDir = path.join(parent, "repo"),
    repoId = "remount-failed";
  rosterRepo(rootDir, repoId);
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
  const host = await openDaemonHost({
    daemonId: repoId,
    userRoot,
    openCell: async (input) => {
      if (input.bootstrap) throw Object.assign(new Error("remount open failed"), { code: "repo_unavailable" });
      return openBootstrappedRepoCell(input);
    },
  });
  try {
    await host.attachmentsSettled();
    await assert.rejects(host.bootstrap({ rootDir, repoId, configureOnly: true }, auth), /remount open failed/u);
    assert.equal(host.status().repos.find((repo) => repo.repoId === repoId)?.state, "unavailable");
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("daemon status and stop retain their transport authority while authentication is unavailable", async () => {
  let authentications = 0,
    stops = 0;
  const server = createJsonRpcProtocolServer({
    host: { status: () => ({ daemonId: "controls", pid: process.pid, repos: [] }) } as Awaited<
      ReturnType<typeof openDaemonHost>
    >,
    build: { commit: null },
    authContext: { ...auth },
    emit: async () => undefined,
    sessionPrincipal: async () => {
      authentications++;
      throw new TypeError("fetch failed");
    },
    requestShutdown: () => {
      stops++;
    },
  });
  try {
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion },
    });
    for (const method of ["daemon.status", "daemon.stop"]) {
      const response = await server.handle({ jsonrpc: "2.0", id: 2, method, params: {} });
      assert.equal((response as { result: { ok: boolean } }).result.ok, true);
    }
    assert.equal(authentications, 0);
    assert.equal(stops, 1);
  } finally {
    server.close();
  }
});

test("execution credentials cannot acquire daemon status or stop authority", async () => {
  let authentications = 0,
    stops = 0;
  const server = createJsonRpcProtocolServer({
    host: { status: () => ({ daemonId: "controls", pid: process.pid, repos: [] }) } as Awaited<
      ReturnType<typeof openDaemonHost>
    >,
    build: { commit: null },
    authContext: { ...auth },
    emit: async () => undefined,
    executionPrincipal: async () => {
      authentications++;
      throw Object.assign(new Error("scoped"), { code: "execution_credential_rejected" });
    },
    requestShutdown: () => {
      stops++;
    },
  });
  try {
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion, executionCredential: "dispatch" },
    });
    for (const method of ["daemon.status", "daemon.stop"]) {
      const response = await server.handle({ jsonrpc: "2.0", id: 2, method, params: {} });
      assert.equal((response as { result: { code: string } }).result.code, "execution_credential_rejected");
    }
    assert.equal(stops, 0);
    assert.equal(authentications, 0);
  } finally {
    server.close();
  }
});

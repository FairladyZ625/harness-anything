// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { runDaemonControl } from "../../cli/src/daemon/control.ts";
import { registerDaemonRepo } from "../../kernel/src/index.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { streamDaemonFacetAt } from "../src/client/local-json-rpc-stream.ts";
import { openDaemonHost, type DaemonHost } from "../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { serveJsonRpcStream, type DaemonTransportConnection } from "../src/transport/json-rpc-stream.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { openBootstrappedRepoCell, registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

test(
  "remote-proxy forwards repository frames and streams, reconnects, and fails closed",
  { timeout: 30_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-remote-proxy-")),
      repoId = "proxy-repo",
      repoRoot = path.join(parent, "repo-b"),
      userRootA = path.join(parent, "user-a"),
      userRootB = path.join(parent, "user-b"),
      endpointA = localUserDaemonEndpoint(userRootA, "proxy-a"),
      uid = process.getuid?.() ?? 0,
      executablePath = writeProviderExecutable(
        path.join(parent, "codex-stub.mjs"),
        "if (process.argv[2] === '--version') console.log('codex-stub 1.0.0');\n",
      );
    initRepo(repoRoot, repoId, uid);
    registerBootstrappedDaemonRepo({
      canonicalRoot: repoRoot,
      repoId,
      userRoot: userRootB,
      createConvenienceLinks: false,
    });
    let providerOutput: ((chunk: string) => void) | undefined;
    const hostB = await openDaemonHost({
        daemonId: "origin-b",
        userRoot: userRootB,
        openCell: openBootstrappedRepoCell,
        runtimeDiscover: () => [
          {
            installationId: "installation-codex",
            kindId: "codex",
            executablePath,
            version: "1.0.0",
            observedAt: "2026-09-02T00:00:00.000Z",
          },
        ],
        runtimeLaunch: () => ({
          pid: 9021,
          onOutput: (listener) => {
            providerOutput = listener;
            queueMicrotask(() =>
              listener(`${JSON.stringify({ type: "thread.started", thread_id: "proxy-provider-session" })}\n`),
            );
          },
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        }),
      }),
      tcpB = daemonTcpTransport(hostB, uid),
      hostA = await openDaemonHost({ daemonId: "proxy-a", userRoot: userRootA }),
      transportA = createUnixSocketTransportServer({
        daemonId: "proxy-a",
        socketPath: endpointA,
        createProtocolServer: (authContext, emit) =>
          createJsonRpcProtocolServer({ host: hostA, build: { commit: null }, authContext, emit }),
      });
    await hostB.attachmentsSettled();
    await tcpB.start();
    await transportA.start();
    t.after(async () => {
      await transportA.stop();
      await tcpB.stop();
      await hostA.close();
      await hostB.close();
      rmSync(parent, { recursive: true, force: true });
    });
    const rpcA = (method: string, params: Record<string, unknown>) =>
        requestDaemonJsonRpcAt(endpointA, method, params, 2_000, 5_000),
      rpcB = (method: string, params: Record<string, unknown>) =>
        requestDaemonJsonRpcAt(tcpB.endpoint, method, params, 2_000, 5_000);

    await t.test("Goal 1-2: isolated A registers B by TCP endpoint without a root", async () => {
      const runCli = async (args: readonly string[]) => {
        const receipts: Record<string, unknown>[] = [],
          exit = await runDaemonControl(
            ["daemon", ...args, "--user-root", userRootA, "--daemon-id", "proxy-a"],
            (receipt) => receipts.push(receipt),
          );
        assert.equal(exit, 0, `${args.join(" ")}: ${JSON.stringify(receipts)}`);
        return receipts[0]!;
      };
      const add = await runCli(["connection", "add", "--connection", "server-b", "--endpoint", tcpB.endpoint]),
        update = await runCli(["connection", "update", "--connection", "server-b", "--display-name", "Server B"]),
        probe = await runCli(["connection", "probe", "--endpoint", tcpB.endpoint]),
        remove = await runCli(["connection", "remove", "--connection", "server-b"]);
      assert.deepEqual(
        [add.command, update.command, probe.command, remove.command],
        ["daemon-connection-add", "daemon-connection-update", "daemon-connection-probe", "daemon-connection-remove"],
      );
      for (const result of [add, update, probe, remove]) {
        assert.equal(result.ok, true);
        assert.equal((result.authorizationDecision as Record<string, unknown>).outcome, "allowed");
      }
      await runCli(["connection", "add", "--connection", "server-b", "--endpoint", tcpB.endpoint]);
      const receipt = await runCli([
        "repo",
        "register",
        "--repo-id",
        repoId,
        "--mode",
        "remote-proxy",
        "--endpoint",
        tcpB.endpoint,
      ]);
      assert.equal((receipt.repo as Record<string, unknown>).canonicalRoot, null);
      assert.equal((receipt.repo as Record<string, unknown>).mode, "remote-proxy");
      assert.equal(hostA.status().repos.find((repo) => repo.repoId === repoId)?.mode, "remote-proxy");
      assert.equal(hostA.status().repos.find((repo) => repo.repoId === repoId)?.rootDir, "");
      assert.equal(hostA.status().repos.find((repo) => repo.repoId === repoId)?.state, "closed");
      assert.equal(hostA.status().repos.find((repo) => repo.repoId === repoId)?.generation, null);
      const system = await rpcA("daemon.gui.system.read", {}),
        row = (system.repos as Array<Record<string, unknown>>).find((repo) => repo.repoId === repoId);
      assert.equal(row?.canonicalRoot, null);
      assert.equal(row?.cellState, "not_loaded");
    });

    await t.test("Goal 3: GUI reads and a write reach B and preserve its receipt", async () => {
      const settings = await rpcA("repo.settings.read", { repo: { repoId } });
      assert.equal(settings.schema, "daemon.settings-read/v1");
      const created = await rpcA("repo.task.create", {
        repo: { repoId },
        payload: { taskId: "task_proxy_round_trip", title: "Proxy round trip" },
      });
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      const listA = await rpcA("repo.tasks.list", { repo: { repoId }, payload: {} }),
        listB = await rpcB("repo.tasks.list", { repo: { repoId }, payload: {} });
      assert.equal(
        (listA.rows as Array<Record<string, unknown>>).some((row) => row.taskId === "task_proxy_round_trip"),
        true,
      );
      assert.deepEqual(listA, listB);
      const document = await rpcA("repo.tasks.document.read", {
        repo: { repoId },
        payload: { taskId: "task_proxy_round_trip", path: "INDEX.md" },
      });
      assert.match(String(document.worktreeBody), /Proxy round trip/u);
      assert.equal((await rpcA("repo.artifacts.list", { repo: { repoId }, payload: {} })).ok, true);
      assert.equal((await rpcA("daemon.connection.probe", { endpoint: tcpB.endpoint })).ok, true);
    });

    await rpcB("daemon.runtimeInstance.create", {
      payload: {
        instanceId: "proxy-codex",
        name: "Proxy Codex",
        kindId: "codex",
        installationId: "installation-codex",
        providerId: "openai",
        models: ["gpt-proxy"],
        authMode: "subscription",
      },
    });
    const spawned = await rpcA("repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "proxy-codex",
        model: "gpt-proxy",
        cwd: { scope: "repo-root" },
        prompt: "Observe the proxy.",
        taskId: null,
        idempotencyKey: "proxy-runtime",
      },
    });
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    const runtimeSessionId = String(spawned.runtimeSessionId),
      streamValues: Record<string, unknown>[] = [];
    await eventually(async () => {
      const overview = await rpcA("repo.agentRuntime.overview", { repo: { repoId }, payload: {} });
      return JSON.stringify(overview).includes("proxy-provider-session");
    });
    const detach = await streamDaemonFacetAt({
      socketPath: endpointA,
      repoId,
      method: "repo.agentRuntime.attach",
      payload: { runtimeSessionId, afterCursor: "stream:0" },
      timeoutMs: 2_000,
      onValue: (value) => streamValues.push(value as Record<string, unknown>),
    });
    t.after(detach);

    await t.test("Goal 3 stream: A receives B runtime events", async () => {
      providerOutput?.(
        `${JSON.stringify({ type: "item.completed", item: { id: "live", type: "agent_message", text: "live proxy event" } })}\n`,
      );
      await eventually(() => streamValues.some((value) => value.content === "live proxy event"));
    });

    await t.test(
      "Goal 4: unavailable is explicit and the existing stream budget reconnects after B restarts",
      async () => {
        await tcpB.stop();
        const unavailable = await rpcA("repo.settings.read", { repo: { repoId } });
        assert.equal(unavailable.ok, false);
        assert.equal(unavailable.code, "remote_proxy_unavailable");
        providerOutput?.(
          `${JSON.stringify({ type: "item.completed", item: { id: "offline", type: "agent_message", text: "replayed after restart" } })}\n`,
        );
        await tcpB.start();
        await eventually(() => streamValues.some((value) => value.content === "replayed after restart"), 5_000);
        assert.equal((await rpcA("repo.settings.read", { repo: { repoId } })).ok, true);
      },
    );

    await t.test("Goal 5: A rejects local bootstrap and local control authority for a proxy repo", async () => {
      const bootstrap = await rpcA("daemon.repo.bootstrap", {
        repoId,
        rootDir: path.join(parent, "must-not-exist"),
        personId: "owner",
        displayName: "No local bootstrap",
      });
      assert.equal(bootstrap.ok, false);
      assert.equal(bootstrap.code, "repo_mode_remote_proxy");
      const control = await rpcA("daemon.gui.control.request", {
        payload: { kind: "refresh", authorityRepoId: repoId },
      });
      assert.equal(control.ok, false);
      assert.equal(control.code, "repo_mode_remote_proxy");
    });

    await t.test("Goal 6: an exact protocol mismatch fails without compatibility", async () => {
      const mismatch = await mismatchEndpoint();
      t.after(mismatch.close);
      registerDaemonRepo({
        userRoot: userRootA,
        repoId: "mismatch-repo",
        mode: "remote-proxy",
        endpoint: mismatch.endpoint,
        createConvenienceLinks: false,
      });
      const response = await rpcA("repo.settings.read", { repo: { repoId: "mismatch-repo" } });
      assert.equal(response.ok, false);
      assert.equal(response.code, "remote_proxy_protocol_mismatch");
    });
  },
);

function daemonTcpTransport(host: DaemonHost, ownerUid: number) {
  let server: net.Server | undefined,
    port = 0;
  const connections = new Set<DaemonTransportConnection>();
  return {
    get endpoint() {
      if (port === 0) throw new Error("TCP daemon is not started");
      return `tcp://127.0.0.1:${port}`;
    },
    start: async () => {
      if (server) return;
      server = net.createServer((socket) => {
        const connection = serveJsonRpcStream({
          input: socket,
          output: socket,
          transportKind: "unix-socket",
          authContext: {
            transportKind: "unix-socket",
            unixSocketOwnerBoundary: { ownerUid, source: "unix-socket-filesystem-owner-boundary" },
          },
          createProtocolServer: (authContext, emit) =>
            createJsonRpcProtocolServer({ host, build: { commit: null }, authContext, emit }),
        });
        connections.add(connection);
        socket.once("close", () => connections.delete(connection));
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(port, "127.0.0.1", () => {
          server!.off("error", reject);
          const address = server!.address();
          if (typeof address !== "object" || address === null) reject(new Error("TCP endpoint has no port"));
          else {
            port = address.port;
            resolve();
          }
        });
      });
    },
    stop: async () => {
      if (!server) return;
      await Promise.all([...connections].map((connection) => connection.close()));
      const closing = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => closing.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function mismatchEndpoint(): Promise<{ endpoint: string; close: () => void }> {
  const sockets = new Set<net.Socket>(),
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      const lines = createInterface({ input: socket });
      lines.on("line", (line) => {
        const request = JSON.parse(line) as { readonly id: number; readonly method: string };
        if (request.method === "protocol.hello")
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                ok: true,
                protocolVersion: { ...currentDaemonProtocolVersion, major: currentDaemonProtocolVersion.major + 1 },
                methods: [],
                build: {},
              },
            })}\n`,
          );
      });
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("mismatch server has no port");
  return {
    endpoint: `tcp://127.0.0.1:${address.port}`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition did not settle within ${timeoutMs}ms`);
}

function initRepo(root: string, repoId: string, uid: number): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Remote Proxy Test");
  git(root, "config", "user.email", "remote-proxy@example.invalid");
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `${JSON.stringify(
      {
        schema: "harness-people/v1",
        people: [
          {
            personId: "owner",
            displayName: "Owner",
            roles: ["owner"],
            credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }],
          },
        ],
        roles: [{ roleId: "owner", commandClasses: ["repo-read", "repo-write", "admin", "arbiter"] }],
      },
      null,
      2,
    )}\n`,
  );
  git(root, "add", "harness");
  git(root, "commit", "-qm", "init");
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

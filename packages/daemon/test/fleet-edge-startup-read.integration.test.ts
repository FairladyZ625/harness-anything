// harness-test-tier: integration
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openSqliteEventStore, sqliteLedgerPath } from "@harness-anything/storage";
import { readDaemonRegistry } from "@harness-anything/kernel";
import { openRepoCell } from "../src/repo-cell-open.ts";
import { readReplicaHealth } from "../src/fleet/replica-health.ts";
import { locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { materializeCellReplica } from "./edge-repository-cut.fixtures.ts";
import { eventuallyValue } from "./fixtures/runtime-ingress.ts";

test(
  "remote-edge startup IPC reads contain center refusal before and after attachment",
  { timeout: 180_000 },
  async (t) => {
    t.diagnostic(
      `environment=${JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version })}`,
    );
    // Reserve and release a fixture-owned ephemeral port; never address a testbed center.
    const unused = net.createServer();
    unused.listen(0, "127.0.0.1");
    await once(unused, "listening");
    const address = unused.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve, reject) => unused.close((error) => (error ? reject(error) : resolve())));
    const probe = net.createConnection({ host: "127.0.0.1", port });
    const [refusal] = await once(probe, "error");
    assert.equal(refusal.code, "ECONNREFUSED");
    t.diagnostic(
      `center-unavailable=${JSON.stringify({ host: "127.0.0.1", port, code: refusal.code, message: refusal.message })}`,
    );
    probe.destroy();

    // No listening center or OpenSSL dependency is needed for transport-refused reads.
    const root = mkdtempSync(path.join(tmpdir(), "ha-startup-read-")),
      repo = path.join(root, "seed");
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
    mkdirSync(path.join(repo, "harness"), { recursive: true });
    writeFileSync(
      path.join(repo, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: startup-read\nsettings: {}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    // Empty trust material is accepted by TLS; refusal happens before TLS/authentication.
    writeFileSync(path.join(root, "tls.crt"), "");
    const f = {
      root,
      repo,
      center: { port },
      owners: {
        keycloak: {
          fetch: async (): Promise<Response> => {
            throw new Error("Unexpected identity-authority request before replica availability.");
          },
        },
      },
    };
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    // Release first even if an assertion fails, so host.close cannot wait on our barrier.
    t.after(() => release.resolve());
    const e = await fleetEdgeHostFixture(t, f, {
      name: "startup-empty",
      centerPort: port,
      waitForAttachments: false,
      runtimeDiscover: () => [],
      openCell: async (input) => {
        assert.equal(input.mode, "remote-edge");
        entered.resolve();
        await release.promise;
        return openRepoCell(input);
      },
    });
    assert.equal(
      readDaemonRegistry({ userRoot: e.edgeUser }).repos.find((row) => row.repoId === e.config.repoId)?.mode,
      "remote-edge",
    );
    const transport = createUnixSocketTransportServer({
      daemonId: "startup-empty-daemon",
      socketPath: localUserDaemonEndpoint(e.edgeUser, "startup-empty-daemon"),
      createProtocolServer: (authContext, emit) =>
        createJsonRpcProtocolServer({ host: e.host, authContext, emit, build: { commit: null } }),
    });
    await transport.start();
    t.after(() => transport.stop());
    // Match runtime.ts: bind IPC first, then start background attachments.
    e.host.startAttachments();
    await entered.promise;
    let settled = false;
    const settlement = e.host.attachmentsSettled().then(() => {
      settled = true;
    });
    const socket = net.createConnection(transport.endpoint);
    t.after(() => socket.destroy());
    await once(socket, "connect");
    socket.setEncoding("utf8");
    let pending = "";
    const responses: string[] = [];
    let receive: ((line: string) => void) | undefined;
    socket.on("data", (chunk: string) => {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (receive) {
          const resolve = receive;
          receive = undefined;
          resolve(line);
        } else responses.push(line);
      }
    });
    let id = 0;
    const request = async (method: string, params: Record<string, unknown>) => {
      const message = { jsonrpc: "2.0", id: ++id, method, params };
      const response = new Promise<string>((resolve) => {
        const buffered = responses.shift();
        if (buffered !== undefined) resolve(buffered);
        else receive = resolve;
      });
      socket.write(`${JSON.stringify(message)}\n`);
      const envelope = JSON.parse(await response);
      assert.equal(envelope.id, message.id);
      return envelope;
    };
    const hello = await request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion });
    assert.ok(hello.result, JSON.stringify(hello));
    t.diagnostic(`hello=${JSON.stringify(hello)}`);
    const { schema: _schema, ...payload } = e.config;
    const read = async (phase: string, iteration: number) => {
      assert.equal(settled, phase === "settled");
      assert.equal(
        e.host.status().repos.find((row) => row.repoId === e.config.repoId)?.state,
        phase === "settled" ? "attached" : "warming",
      );
      assert.equal(locateFleetMirrorView(e.viewRoot, e.config.repoId, e.config.nodeId), null);
      const envelope = await request("daemon.fleet.task.run", {
        payload: { ...payload, action: { kind: "task-list" } },
      });
      const health = readReplicaHealth(path.join(e.viewRoot, "repos", e.config.repoId, "views", e.config.nodeId));
      t.diagnostic(
        `sample=${JSON.stringify({ phase, iteration, attachmentSettled: settled, method: "daemon.fleet.task.run", health, envelope })}`,
      );
      if (phase === "opening") assert.equal(health.syncFailure, null, "resident sync starts after attachment");
      assert.equal(envelope.jsonrpc, "2.0");
      assert.equal(envelope.error, undefined);
      assert.equal(envelope.result.command, "task-list");
      assert.equal(envelope.result.ok, false);
      assert.equal(envelope.result.code, phase === "opening" ? "repo_warming" : "replica_unavailable");
      assert.doesNotMatch(JSON.stringify(envelope), /ECONNREFUSED/u);
      assert.equal(settled, phase === "settled");
      return envelope.result;
    };
    let before: Record<string, unknown> | undefined;
    for (let iteration = 1; iteration <= 5; iteration += 1) {
      const result = await read("opening", iteration);
      if (before) assert.deepEqual(result, before);
      before = result;
    }
    release.resolve();
    await settlement;
    assert.equal(e.host.status().repos.find((row) => row.repoId === e.config.repoId)?.state, "attached");
    await eventuallyValue(() =>
      readReplicaHealth(path.join(e.viewRoot, "repos", e.config.repoId, "views", e.config.nodeId)).syncFailure?.code ===
      "ECONNREFUSED"
        ? true
        : null,
    );
    let after: Record<string, unknown> | undefined;
    for (let iteration = 1; iteration <= 5; iteration += 1) {
      const result = await read("settled", iteration);
      if (after) assert.deepEqual(result, after);
      after = result;
    }
  },
);

test("a readable edge generation stays attached when the center sync token fails", { timeout: 180_000 }, async (t) => {
  const fixture = await fleetNodeClaimFixture(t);
  const edge = await fleetEdgeHostFixture(t, fixture, {
    beforeOpen: async (edgeRoot) => {
      // Preserve a previously readable replica while making the local writer fail to attach.
      // This is the path used by a remote edge whose local ledger is unavailable after restart.
      await materializeCellReplica(fixture.repo, "lease-repo", "person-one");
      const config = JSON.parse(readFileSync(path.join(fixture.repo, "fleet-edge.json"), "utf8")) as Record<
          string,
          unknown
        >,
        viewRoot = String(config.viewRoot),
        viewDir = path.join(viewRoot, "repos", "lease-repo", "views", "test-edge");
      config.host = "127.0.0.1";
      config.port = fixture.center.port;
      config.caPath = path.join(fixture.root, "tls.crt");
      writeFileSync(path.join(edgeRoot, "fleet-edge.json"), JSON.stringify(config));
      writeFileSync(
        path.join(viewDir, "replica-health.json"),
        JSON.stringify({
          rebuildCount: 0,
          lastHeartbeatAt: null,
          syncFailure: { code: "authentication_required", message: "fetch failed" },
          modelFailure: null,
        }),
      );
      const generationTwo = openSqliteEventStore({ repoId: "lease-repo", rootInput: edgeRoot, generation: 2 });
      generationTwo.close();
      mkdirSync(path.dirname(sqliteLedgerPath(edgeRoot, 3)), { recursive: true });
      writeFileSync(`${sqliteLedgerPath(edgeRoot, 3)}.activation.json`, "{}\n");
    },
  });
  const status = edge.host.status().repos.find((repo) => repo.repoId === "lease-repo");
  t.diagnostic(
    JSON.stringify({
      state: status?.state,
      lastError: status?.lastError,
      health: JSON.parse(
        readFileSync(
          path.join(
            String(JSON.parse(readFileSync(path.join(edge.edgeRoot, "fleet-edge.json"), "utf8")).viewRoot),
            "repos",
            "lease-repo",
            "views",
            "test-edge",
            "replica-health.json",
          ),
          "utf8",
        ),
      ),
    }),
  );
  assert.equal(status?.mode, "remote-edge");
  assert.equal(status?.state, "attached");
  assert.equal(status?.lastError, null);
});

test(
  "remote-edge mount ignores a stale generation-two ledger from the center mirror",
  { timeout: 180_000 },
  async (t) => {
    const fixture = await fleetNodeClaimFixture(t);
    const edge = await fleetEdgeHostFixture(t, fixture, {
      beforeOpen: (edgeRoot) => {
        const oldLedger = openSqliteEventStore({ repoId: "lease-repo", rootInput: edgeRoot, generation: 2 });
        oldLedger.close();
      },
    });
    const status = edge.host.status().repos.find((repo) => repo.repoId === "lease-repo");
    t.diagnostic(JSON.stringify({ state: status?.state, lastError: status?.lastError, mode: status?.mode }));
    assert.equal(status?.mode, "remote-edge");
    assert.equal(status?.state, "attached");
    assert.equal(status?.lastError, null);
    assert.equal(existsSync(sqliteLedgerPath(edge.edgeRoot, 2)), false);
    assert.equal(existsSync(`${sqliteLedgerPath(edge.edgeRoot, 3)}.activation.json`), true);
  },
);

test(
  "remote-edge mount preserves generation-two data when generation-three activation is corrupt",
  { timeout: 180_000 },
  async (t) => {
    const fixture = await fleetNodeClaimFixture(t);
    const edge = await fleetEdgeHostFixture(t, fixture, {
      beforeOpen: (edgeRoot) => {
        const oldLedger = openSqliteEventStore({ repoId: "lease-repo", rootInput: edgeRoot, generation: 2 });
        oldLedger.close();
        const activationPath = `${sqliteLedgerPath(edgeRoot, 3)}.activation.json`;
        mkdirSync(path.dirname(activationPath), { recursive: true });
        writeFileSync(activationPath, "{}\n");
      },
    });
    const status = edge.host.status().repos.find((repo) => repo.repoId === "lease-repo");
    assert.equal(status?.mode, "remote-edge");
    assert.equal(status?.state, "unavailable");
    assert.equal(existsSync(sqliteLedgerPath(edge.edgeRoot, 2)), true);
  },
);

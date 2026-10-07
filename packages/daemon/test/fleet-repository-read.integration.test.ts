// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  actionDeclarations,
  deriveBasePolicyGroups,
  effectivePolicyGroupScopes,
  makeTaskProjectionReader,
} from "@harness-anything/kernel";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { managedRbacSessionStore } from "../src/managed-rbac-service.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { daemonMethodAcceptsPayload } from "../src/protocol/daemon-protocol-rpc-validation.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { repositoryReadData } from "../src/protocol/repository-read-frame.ts";

test(
  "viewer GUI reads page from a replica cut and withhold it after the next sync reports revocation",
  { timeout: 120_000 },
  async (t) => {
    let edge: Awaited<ReturnType<typeof openDaemonHost>> | undefined;
    t.after(async () => {
      await edge?.close();
      edge = undefined;
    });
    const f = await fleetNodeClaimFixture(
      t,
      undefined,
      (input) => new OidcSessionService(path.join(f.root, "user")).bind(input),
      undefined,
      (nodeId) => ({ url: "https://keycloak.example", realm: "harness", clientId: `harness-node-${nodeId}` }),
      true,
    );
    const vertical = await f.host.run("lease-repo", { kind: "vertical-declaration-migrate" }, auth);
    assert.equal(vertical.outcome, "applied", JSON.stringify(vertical));
    await waitForFleetPublication(f.host, "lease-repo", vertical.opId, auth);
    await f.command("center-node", { kind: "task-create", taskId: "task-read-000", title: "Read 0" });
    for (let index = 1; index < 53; index += 1) {
      const receipt = await f.host.run(
        "lease-repo",
        {
          kind: "task-create",
          taskId: `task-read-${String(index).padStart(3, "0")}`,
          title: `Read ${index}`,
        },
        auth,
      );
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    }
    const everyAction = actionDeclarations.map(({ kind }) => kind);
    f.owners.keycloak.revoke("person-one", "lease-repo", everyAction);
    f.owners.keycloak.permit(
      "person-one",
      "lease-repo",
      effectivePolicyGroupScopes(deriveBasePolicyGroups(), "viewer"),
    );
    const edgeRoot = path.join(f.root, "edge"),
      edgeUser = path.join(f.root, "edge-user");
    mkdirSync(path.join(edgeRoot, "harness"), { recursive: true });
    writeFileSync(
      path.join(edgeRoot, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: edge\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    execFileSync("git", ["init", "-q", edgeRoot]);
    execFileSync("git", ["-C", edgeRoot, "add", "harness"]);
    execFileSync("git", [
      "-C",
      edgeRoot,
      "-c",
      "user.name=Read Test",
      "-c",
      "user.email=read@example.invalid",
      "commit",
      "-qm",
      "edge config",
    ]);
    registerBootstrappedDaemonRepo({
      repoId: "lease-repo",
      canonicalRoot: edgeRoot,
      userRoot: edgeUser,
      mode: "remote-edge",
      createConvenienceLinks: false,
    });
    managedRbacSessionStore(edgeUser).write(
      JSON.stringify({
        schema: "harness-oidc-session/v2",
        accessToken: "token-person-one",
        subject: "person-one",
        personId: "person-one",
        expiresAt: Date.now() + 3_600_000,
        roles: [],
        loginTarget: edgeRoot,
        authority: { url: f.owners.url, realm: "harness" },
      }),
    );
    assert.equal(existsSync(path.join(edgeUser, "rbac/config.json")), false);
    assert.equal(existsSync(path.join(edgeUser, "rbac/center-client-secret")), false);
    f.owners.keycloak.interactiveSession("person-one", "node-one", f.owners.url);
    const config = {
      schema: "fleet-edge-config/v1",
      repoId: "lease-repo",
      host: "127.0.0.1",
      port: f.center.port,
      servername: "localhost",
      caPath: path.join(f.root, "tls.crt"),
      nodeId: "node-one",
      credential: "secret-node-one",
      viewRoot: path.join(f.root, "view"),
      quotaBytes: 64 * 1024 * 1024,
      waitTimeoutMs: 2000,
    };
    writeFileSync(path.join(edgeRoot, "fleet-edge.json"), JSON.stringify(config));
    edge = await openDaemonHost({
      daemonId: "read-edge",
      userRoot: edgeUser,
      oidc: new OidcSessionService(edgeUser, { fetch: f.owners.keycloak.fetch }),
    });
    await edge.attachmentsSettled();
    const local = makeTaskProjectionReader({ rootDir: edgeRoot });
    assert.equal(
      local.withSession((projection) => projection.list().rows.length),
      0,
      "the edge SQL projection has never received a task",
    );
    const rpc = createJsonRpcProtocolServer({
      host: edge,
      build: { commit: null },
      authContext: auth,
      emit: async () => undefined,
    });
    t.after(() => rpc.close());
    await rpc.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion },
    });
    const read: typeof edge.read = async (repoId, method, payload) => {
      const response = await rpc.handle({
        jsonrpc: "2.0",
        id: 2,
        method,
        params: { repo: { repoId }, ...(daemonMethodAcceptsPayload(method) ? { payload } : {}) },
      });
      assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
      assert.notEqual((response.result as { ok?: boolean }).ok, false, JSON.stringify(response));
      const frame = response.result as { cut?: { revision: number }; freshness?: { state: string } };
      assert.ok(frame.cut);
      assert.ok(frame.freshness);
      return repositoryReadData(response.result) as never;
    };
    const refusedRead = async (code: RegExp) => {
      const response = await rpc.handle({
        jsonrpc: "2.0",
        id: 5,
        method: "repo.tasks.list",
        params: { repo: { repoId: "lease-repo" }, payload: {} },
      });
      assert.ok(response && !Array.isArray(response) && "result" in response);
      assert.equal((response.result as { ok?: boolean }).ok, false);
      assert.match(JSON.stringify(response.result), code);
    };
    const agentQuery = {
      name: "runtime-session-groups",
      groupBy: "agent",
      limit: 1,
      sessionIds: ["runtime-missing"],
    };
    const refusedAgentRead = async (code: RegExp) => {
      const response = await rpc.handle({
        jsonrpc: "2.0",
        id: 8,
        method: "repo.projection.read",
        params: { repo: { repoId: "lease-repo" }, payload: agentQuery },
      });
      assert.match(JSON.stringify(response), code);
    };
    const refusedCatalogRead = async (code: RegExp) => {
      const response = await rpc.handle({
        jsonrpc: "2.0",
        id: 6,
        method: "repo.gui.catalog.snapshot",
        params: { repo: { repoId: "lease-repo" } },
      });
      assert.match(JSON.stringify(response), code);
    };
    const rereadCatalog = async () =>
      rpc.handle({
        jsonrpc: "2.0",
        id: 7,
        method: "repo.gui.catalog.reread",
        params: { repo: { repoId: "lease-repo" }, payload: {} },
      });
    const refusedCatalogReread = async (code: RegExp) => {
      assert.match(JSON.stringify(await rereadCatalog()), code);
    };
    const pull = async () => {
      f.host.replica("lease-repo").activate();
      await f.host.replica("lease-repo").waitForCut(f.eventCount());
      return runFleetReplicaPullClient({
        ...f.peer("node-one"),
        viewRoot: config.viewRoot,
        diskQuotaBytes: config.quotaBytes,
      });
    };
    await pull();
    const first = await read("lease-repo", "repo.tasks.list", { limit: 50 }, auth);
    assert.equal(
      first.rows.length,
      50,
      "GUI host read must use the replica rather than the empty edge canonical projection",
    );
    assert.ok(first.watermark > 0);
    assert.ok(first.page.nextCursor);
    const tail = await read("lease-repo", "repo.tasks.list", { cursor: first.page.nextCursor }, auth);
    assert.equal(tail.rows.length, 3);
    assert.equal(tail.page.nextCursor, null);
    assert.equal(tail.watermark, first.watermark);
    const centerAgents = await f.host.read("lease-repo", "repo.projection.read", agentQuery, auth);
    assert.deepEqual(await read("lease-repo", "repo.projection.read", agentQuery, auth), centerAgents);
    assert.equal(centerAgents.name, "runtime-session-groups");
    const bootstrap = await rpc.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "daemon.rbac.manage",
      params: { operation: "bootstrap-status", repoId: "lease-repo" },
    });
    assert.ok(bootstrap && !Array.isArray(bootstrap) && "result" in bootstrap, JSON.stringify(bootstrap));
    assert.deepEqual(bootstrap.result, {
      source: "fleet-center",
      mode: "external",
      ok: true,
      ready: true,
      url: "https://keycloak.example",
      realm: "harness",
      clientId: "harness-node-node-one",
      status: 200,
      required: false,
    });
    const lifetime = await rpc.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "daemon.rbac.manage",
      params: { operation: "session-lifetime", repoId: "lease-repo" },
    });
    assert.match(JSON.stringify(lifetime), /authorization_denied/);
    const before = f.eventCount();
    for (const nodeId of ["node-one", "node-two"]) {
      // task list and task show are answered from the edge replica; forwarding either is not a
      // fleet frame at all anymore.
      await assert.rejects(
        f.command(nodeId, { kind: "task-show", taskId: "task-read-052" }),
        /violates closed schema fleet\.task\.command\/v1/u,
      );
      await assert.rejects(
        f.command(nodeId, { kind: "task-list", cursor: first.page.nextCursor }),
        /violates closed schema fleet\.task\.command\/v1/u,
      );
    }
    for (const method of [
      "repo.tasks.wip",
      "repo.works.index",
      "repo.workspace.summary.read",
      "repo.entity.kinds.read",
      "repo.vertical.declaration.read",
    ] as const) {
      assert.deepEqual(await read("lease-repo", method, {}, auth), await f.host.read("lease-repo", method, {}, auth));
    }
    for (const method of ["repo.tasks.completion.read"] as const) {
      assert.deepEqual(
        await read("lease-repo", method, { taskId: "task-read-000" }, auth),
        await f.host.read("lease-repo", method, { taskId: "task-read-000" }, auth),
      );
    }
    // These reads need data outside the materialized query closure; none may use local canonical
    // storage or fall back to a center request.
    for (const [method, payload] of [
      [
        "repo.entity.actions.explain",
        { schema: "entity-action-explain-request/v1", mode: "object", entityKind: null, refs: ["task/task-read-000"] },
      ],
      ["repo.entity.content.read", { entityKind: "task", entityId: "task-read-000" }],
      ["repo.workspace.scope.read", { rootTaskId: "task-read-000" }],
      ["repo.tasks.documents.list", { taskId: "task-read-000" }],
    ] as const)
      await assert.rejects(edge.read("lease-repo", method, payload, auth), { code: "replica_unavailable" });
    await assert.rejects(f.command("node-one", { kind: "work-show", taskId: "task-read-000" }), /closed schema/);
    const { schema: _configSchema, ...cliConfig } = config;
    const cli = await rpc.handle({
      jsonrpc: "2.0",
      id: 10,
      method: "daemon.fleet.task.run",
      params: {
        payload: { ...cliConfig, workspaceRoot: edgeRoot, action: { kind: "work-show", taskId: "task-read-000" } },
      },
    });
    assert.ok(cli && !Array.isArray(cli) && "result" in cli, JSON.stringify(cli));
    assert.equal((cli.result as { ok: boolean }).ok, true, JSON.stringify(cli));
    assert.ok((cli.result as { cut: unknown }).cut);
    const all = await read("lease-repo", "repo.tasks.list", { limit: 500 }, auth);
    assert.equal(all.rows.length, 53);
    assert.equal(f.eventCount(), before, "reads append no canonical event");
    await refusedCatalogRead(/replica_unavailable/);
    await refusedCatalogReread(/replica_unavailable/);
    await assert.rejects(edge.read("lease-repo", "repo.gui.catalog.preset.read", { presetId: "standard-task" }, auth), {
      code: "replica_unavailable",
    });
    assert.equal((await f.command("center-node", { kind: "task-start", taskId: "task-read-000" })).outcome, "applied");
    await pull();
    const updated = await read("lease-repo", "repo.tasks.list", {}, auth);
    assert.ok(updated.watermark > first.watermark);
    const changed = updated.rows.find((row) => row.taskId === "task-read-000")!;
    const detail = JSON.parse(
      String(
        (
          await f.host.run(
            "lease-repo",
            { kind: "task-show", taskId: changed.taskId },
            f.owners.auth({ nodeId: "node-one" }),
          )
        ).evidence,
      ),
    );
    assert.equal(changed.snapshot.task.status, detail.task.status);
    const otherRoot = path.join(f.root, "other-repo");
    mkdirSync(path.join(otherRoot, "harness"), { recursive: true });
    writeFileSync(
      path.join(otherRoot, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: other\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    execFileSync("git", ["init", "-q", otherRoot]);
    execFileSync("git", ["-C", otherRoot, "add", "harness"]);
    execFileSync("git", [
      "-C",
      otherRoot,
      "-c",
      "user.name=Read Test",
      "-c",
      "user.email=read@example.invalid",
      "commit",
      "-qm",
      "other config",
    ]);
    registerBootstrappedDaemonRepo({
      repoId: "other-repo",
      canonicalRoot: otherRoot,
      userRoot: path.join(f.root, "user"),
      createConvenienceLinks: false,
    });
    await f.host.admin({ kind: "register", rootDir: otherRoot, repoId: "other-repo", mode: "local" }, auth);
    f.owners.keycloak.permit("lease-owner", "other-repo", everyAction);
    const secret = await f.host.run(
      "other-repo",
      { kind: "task-create", taskId: "task-private", title: "Other repository" },
      auth,
    );
    assert.equal(secret.outcome, "applied", JSON.stringify(secret));
    // Cross-repository authorization is enforced when acquiring the view, before any rows reach the edge.
    await assert.rejects(
      runFleetReplicaPullClient({
        ...f.peer("node-two"),
        repoId: "other-repo",
        viewRoot: config.viewRoot,
        diskQuotaBytes: config.quotaBytes,
      }),
      { code: "authorization_denied" },
    );

    assert.equal(
      local.withSession((projection) => projection.list().rows.length),
      0,
      "successful reads do not mirror the SQL projection",
    );
    // Mirroring is reading: a viewer's node receives the replica its repository-read admits, which is
    // what lets its edge answer reads locally (dec_0C26B97C5B6CEA37101FC0A84D).
    const viewerPull = await runFleetReplicaPullClient({
      ...f.peer("node-one"),
      viewRoot: config.viewRoot,
      diskQuotaBytes: 64 * 1024 * 1024,
    });
    assert.equal(viewerPull.current.cut.revision > 0, true);
    f.owners.keycloak.account("person-outsider");
    f.owners.keycloak.node("node-two", "person-outsider");
    await assert.rejects(
      runFleetReplicaPullClient({
        ...f.peer("node-two"),
        viewRoot: config.viewRoot,
        diskQuotaBytes: config.quotaBytes,
      }),
      { code: "authorization_denied" },
    );
    f.owners.keycloak.node("node-two", "person-one");
    f.owners.keycloak.revoke("person-one", "lease-repo", ["repository-read"]);
    assert.equal(
      (await read("lease-repo", "repo.tasks.list", {}, auth)).rows.length,
      53,
      "a grant change reaches the local view at the next sync, not through GUI center forwarding",
    );
    // The edge answers task list from rows already delivered to it; a revocation reaches those rows at
    // the node's next sync, which the center refuses and the edge records by withholding them.
    await assert.rejects(
      runFleetReplicaPullClient({
        ...f.peer("node-one"),
        viewRoot: config.viewRoot,
        diskQuotaBytes: config.quotaBytes,
      }),
      { code: "authorization_denied" },
    );
    await refusedRead(/replica_unavailable/);
    await refusedAgentRead(/replica_unavailable/);
    await refusedCatalogRead(/replica_unavailable/);
    await refusedCatalogReread(/replica_unavailable/);
    const { schema: _schema, ...edgePayload } = config;
    const revokedCli = await rpc.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "daemon.fleet.task.run",
      params: { payload: { ...edgePayload, workspaceRoot: edgeRoot, action: { kind: "task-list" } } },
    });
    assert.ok(revokedCli && !Array.isArray(revokedCli) && "result" in revokedCli, JSON.stringify(revokedCli));
    assert.equal((revokedCli.result as { ok?: boolean }).ok, false);
    assert.equal((revokedCli.result as { code?: string }).code, "authorization_denied");
    // task-show no longer crosses the fleet channel at all; the edge's own answer is the one
    // the revoked-cli assertion above already proves withheld.
    await assert.rejects(
      f.command("node-two", { kind: "task-show", taskId: "task-read-000" }),
      /violates closed schema fleet\.task\.command\/v1/u,
    );
    f.owners.keycloak.permit("person-one", "lease-repo", ["repository-read"]);
    f.owners.keycloak.nodeClients.delete("harness-node-node-one");
    await assert.rejects(
      runFleetReplicaPullClient({
        ...f.peer("node-one"),
        viewRoot: config.viewRoot,
        diskQuotaBytes: config.quotaBytes,
      }),
      { code: "node_owner_unregistered" },
    );
    await f.center.close();
    await refusedRead(/replica_unavailable/);
    await refusedAgentRead(/replica_unavailable/);
    await refusedCatalogRead(/replica_unavailable/);
    await refusedCatalogReread(/replica_unavailable/);
  },
);

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
import { runFleetEdgeTask } from "../src/fleet-edge-task.ts";
import { runFleetRepositoryReadClient, runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { catalogWithNodeAdapters } from "../src/gui-catalog.ts";

test(
  "viewer edges read the center cut, page to the tail, and lose revoked repository authority at the center and at the next edge sync",
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
      return response.result as never;
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
    const first = await read("lease-repo", "repo.tasks.list", { limit: 50 }, auth);
    assert.equal(first.rows.length, 50, "GUI host read must reach the center rather than the empty edge projection");
    assert.ok(first.watermark > 0);
    assert.ok(first.page.nextCursor);
    const tail = await read("lease-repo", "repo.tasks.list", { cursor: first.page.nextCursor }, auth);
    assert.equal(tail.rows.length, 3);
    assert.equal(tail.page.nextCursor, null);
    assert.equal(tail.watermark, first.watermark);
    const centerAgents = await f.host.read("lease-repo", "repo.projection.read", agentQuery, auth);
    assert.deepEqual(await read("lease-repo", "repo.projection.read", agentQuery, auth), centerAgents);
    assert.equal(centerAgents.name, "runtime-session-groups");
    await assert.rejects(
      runFleetRepositoryReadClient({
        ...f.peer("node-one"),
        method: "repo.projection.read",
        payload: { name: "schedule-plane" },
      }),
      /closed schema/,
    );
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
      const result = await runFleetRepositoryReadClient({ ...f.peer(nodeId), method: "repo.tasks.list", payload: {} });
      assert.equal(result.watermark, first.watermark);
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
    for (const method of ["repo.tasks.documents.list", "repo.tasks.completion.read"] as const) {
      assert.deepEqual(
        await read("lease-repo", method, { taskId: "task-read-000" }, auth),
        await f.host.read("lease-repo", method, { taskId: "task-read-000" }, auth),
      );
    }
    const explanation = await read(
      "lease-repo",
      "repo.entity.actions.explain",
      {
        schema: "entity-action-explain-request/v1",
        mode: "object",
        entityKind: null,
        refs: ["task/task-read-000"],
      },
      auth,
    );
    assert.equal(explanation.subjects.length, 1);
    assert.ok(explanation.subjects[0]!.actions.length > 0);
    const content = { entityKind: "task", entityId: "task-read-000" };
    assert.deepEqual(
      await read("lease-repo", "repo.entity.content.read", content, auth),
      await f.host.read("lease-repo", "repo.entity.content.read", content, auth),
    );
    for (const kind of ["work-list", "work-show"] as const) {
      assert.equal(
        (await f.command("node-one", { kind, ...(kind === "work-show" ? { taskId: "task-read-000" } : {}) })).outcome,
        "applied",
      );
    }
    assert.deepEqual(
      await read("lease-repo", "repo.workspace.scope.read", { rootTaskId: "task-read-000" }, auth),
      await f.host.read("lease-repo", "repo.workspace.scope.read", { rootTaskId: "task-read-000" }, auth),
    );
    const longToken = [
      Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ sub: "person-one", fixture: "a".repeat(2048) })).toString("base64url"),
      Buffer.alloc(256, 97).toString("base64url"),
    ].join(".");
    assert.ok(Buffer.byteLength(longToken) > 2048);
    f.owners.keycloak.interactiveSession("person-one", "node-one", f.owners.url, longToken);
    const cli = await runFleetEdgeTask(
      { payload: { ...config, workspaceRoot: edgeRoot, action: { kind: "task-list", limit: 500 } } },
      async () => longToken,
    );
    assert.equal(cli.ok, true, JSON.stringify(cli));
    assert.equal(JSON.parse(String(cli.evidence)).rows.length, 53);
    let chunks = 0;
    const all = await runFleetRepositoryReadClient({
      ...f.peer("node-two"),
      method: "repo.tasks.list",
      payload: { limit: 500 },
      onFrame: (frame) => {
        if (frame.schema === "fleet.repository.read.result/v1") chunks += 1;
      },
    });
    assert.equal((all.rows as unknown[]).length, 53);
    assert.ok(chunks > 1, "a complete query page may span several Fleet frames");
    assert.equal(f.eventCount(), before, "reads append no canonical event");
    const initialCatalog = await read("lease-repo", "repo.gui.catalog.snapshot", {}, auth);
    assert.equal(initialCatalog.defaults.presetId, "standard-task");
    const initialReread = await rereadCatalog();
    assert.ok(initialReread && !Array.isArray(initialReread) && "result" in initialReread);
    assert.equal((initialReread.result as { outcome?: string }).outcome, "applied");
    const presetChange = await f.host.run(
      "lease-repo",
      { kind: "settings-update", defaultPreset: "docs-task", idempotencyKey: "catalog-preset-change" },
      auth,
    );
    assert.equal(presetChange.outcome, "applied", JSON.stringify(presetChange));
    const changedCatalog = await read("lease-repo", "repo.gui.catalog.snapshot", {}, auth);
    assert.equal(changedCatalog.defaults.presetId, "docs-task");
    const changedReread = await rereadCatalog();
    assert.ok(changedReread && !Array.isArray(changedReread) && "result" in changedReread);
    assert.equal((changedReread.result as { outcome?: string }).outcome, "applied");
    const refreshedCatalog = await read("lease-repo", "repo.gui.catalog.snapshot", {}, auth);
    assert.equal(refreshedCatalog.defaults.presetId, "docs-task");
    assert.equal((changedReread.result as { afterDigest?: string }).afterDigest, refreshedCatalog.catalogDigest);
    assert.deepEqual(changedCatalog.adapters, initialCatalog.adapters);
    assert.deepEqual(catalogWithNodeAdapters({ ...changedCatalog, adapters: [] }).adapters, changedCatalog.adapters);
    const preset = await read("lease-repo", "repo.gui.catalog.preset.read", { presetId: "docs-task" }, auth);
    assert.equal(preset.preset.id, "docs-task");
    assert.equal((await f.command("center-node", { kind: "task-start", taskId: "task-read-000" })).outcome, "applied");
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
    await assert.rejects(
      runFleetRepositoryReadClient({
        ...f.peer("node-two"),
        repoId: "other-repo",
        method: "repo.tasks.list",
        payload: {},
      }),
      { code: "authorization_denied" },
    );
    await assert.rejects(
      runFleetRepositoryReadClient({
        ...f.peer("node-two"),
        repoId: "other-repo",
        method: "repo.projection.read",
        payload: agentQuery,
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
    await assert.rejects(
      runFleetRepositoryReadClient({
        ...f.peer("node-two"),
        accessToken: "token-person-one",
        method: "repo.tasks.list",
        payload: {},
      }),
      { code: "human_confirmation_required" },
    );
    f.owners.keycloak.account("person-outsider");
    f.owners.keycloak.node("node-two", "person-outsider");
    await assert.rejects(
      runFleetRepositoryReadClient({ ...f.peer("node-two"), method: "repo.tasks.list", payload: {} }),
      { code: "authorization_denied" },
    );
    f.owners.keycloak.node("node-two", "person-one");
    f.owners.keycloak.revoke("person-one", "lease-repo", ["repository-read"]);
    await refusedRead(/authorization_denied/);
    await refusedAgentRead(/authorization_denied/);
    await refusedCatalogRead(/authorization_denied/);
    await refusedCatalogReread(/authorization_denied/);
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
    const revokedCli = await runFleetEdgeTask(
      { payload: { ...config, workspaceRoot: edgeRoot, action: { kind: "task-list" } } },
      async () => longToken,
    );
    assert.equal(revokedCli.ok, false);
    assert.equal(revokedCli.code, "authorization_denied");
    // task-show no longer crosses the fleet channel at all; the edge's own answer is the one
    // the revoked-cli assertion above already proves withheld.
    await assert.rejects(
      f.command("node-two", { kind: "task-show", taskId: "task-read-000" }),
      /violates closed schema fleet\.task\.command\/v1/u,
    );
    f.owners.keycloak.permit("person-one", "lease-repo", ["repository-read"]);
    f.owners.keycloak.nodeClients.delete("harness-node-node-one");
    await refusedRead(/node_owner_unregistered/);
    await f.center.close();
    await refusedRead(/ECONNREFUSED|closed|connect/);
    await refusedAgentRead(/ECONNREFUSED|closed|connect/);
    await refusedCatalogRead(/ECONNREFUSED|closed|connect/);
    await refusedCatalogReread(/ECONNREFUSED|closed|connect/);
  },
);

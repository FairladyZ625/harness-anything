// harness-test-tier: integration
import { daemonBuildStamp } from "../src/daemon-host/build-identity.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskProjectionReader } from "@harness-anything/storage";
import { actionDeclarations, deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { writeFleetEdgeConfig } from "../src/daemon-host/client/fleet-edge-config.ts";
import { createIdentitySession } from "../src/daemon-host/authorization-provider.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { managedRbacSessionStore } from "@harness-anything/authorization/keycloak/managed-rbac-service";
import { createJsonRpcProtocolServer } from "../src/daemon-host/protocol/json-rpc-server.ts";
import { daemonMethodAcceptsPayload } from "../src/daemon-host/protocol/daemon-protocol-rpc-validation.ts";
import { currentDaemonProtocolVersion } from "../src/daemon-host/protocol/version.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { repositoryReadData } from "../src/daemon-host/protocol/repository-read-frame.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";
import { syncFleetEdgeMirror } from "../src/daemon-host/fleet-center-admission.ts";
import { runFleetReplicaSync } from "../src/daemon-host/fleet/replica-sync.ts";
import { readReplicaGeneration } from "../src/fleet-sync/fleet/replica-generation.ts";
import { parseThinCommand } from "@harness-anything/cli/internal/cli/thin-command";
import { FleetRemoteError, openPeer, readFleetOperationalClient } from "../src/daemon-host/fleet/peer.ts";
import { makeOpaqueTaskAncestorReader } from "../src/daemon-host/host-action-authorization.ts";
import { parseDaemonReadResult } from "../src/daemon-host/protocol/daemon-result-validation.ts";
import { fleetFixture, localAuthFixture, waitForReceiptCommit } from "./fleet-tls-session.fixture.ts";

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
      (input) => createIdentitySession(path.join(f.root, "user")).bind(input),
      undefined,
      (nodeId) => ({ url: "https://keycloak.example", realm: "harness", clientId: `harness-node-${nodeId}` }),
      true,
      {},
      undefined,
      (nodeId) => createIdentitySession(path.join(f.root, "user")).revokeDeviceSessions(nodeId),
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
    mkdirSync(path.join(edgeUser, "rbac"), { recursive: true });
    writeFileSync(
      path.join(edgeUser, "rbac", "config.json"),
      JSON.stringify({ schema: "harness-managed-rbac/v1", mode: "external" }),
    );
    const signInViewer = (accessToken: string) =>
      managedRbacSessionStore(edgeUser, `${f.owners.url}/realms/harness`, "harness").write(
        JSON.stringify({
          schema: "harness-oidc-session/v3",
          issuer: `${f.owners.url}/realms/harness`,
          accessToken,
          subject: "person-one",
          personId: "person-one",
          expiresAt: Date.now() + 3_600_000,
          roles: [],
          loginTarget: edgeRoot,
          authority: { url: f.owners.url, realm: "harness" },
        }),
      );
    signInViewer("token-person-one");
    const providerConfig = JSON.parse(readFileSync(path.join(edgeUser, "rbac/config.json"), "utf8")) as {
      readonly mode: string;
      readonly url?: string;
    };
    assert.equal(providerConfig.mode, "external");
    assert.equal(providerConfig.url, undefined, "the edge learns its endpoint from the center invitation");
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
    writeFleetEdgeConfig(edgeUser, "lease-repo", config);
    edge = await openDaemonHost({
      daemonId: "read-edge",
      userRoot: edgeUser,
      oidc: createIdentitySession(edgeUser, { fetch: f.owners.keycloak.fetch }),
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
      build: daemonBuildStamp(),
      authContext: auth,
      emit: async () => undefined,
    });
    t.after(() => rpc.close());
    await rpc.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion, buildCommit: daemonBuildStamp().commit },
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
      return catchUpReplica({
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
      // The provider names its own administration console; the edge does not build the admin path.
      consoleUrl: "https://keycloak.example/admin/harness/console/",
      realm: "harness",
      clientId: "harness-node-node-one",
      status: 200,
      required: false,
    });
    // bootstrap-status asks the edge to reset the device session before reporting the
    // center authority. Model the required human re-approval explicitly for the next read.
    f.owners.keycloak.interactiveSession("person-one", "node-one", f.owners.url, "device-token-node-one");
    // Re-approval also replaces the edge's old token. A resident stream now rechecks that token
    // on every page, so retaining the pre-bootstrap token cannot represent a signed-in viewer.
    signInViewer("device-token-node-one");
    await pull();
    const lifetime = await rpc.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "daemon.rbac.manage",
      params: { operation: "session-lifetime", repoId: "lease-repo" },
    });
    assert.match(JSON.stringify(lifetime), /authorization_denied/);
    const before = f.eventCount();
    for (const nodeId of ["node-one", "node-two"]) {
      // Task list and task show are answered from the edge replica; forwarding either is not a
      // fleet frame at all anymore.
      await assert.rejects(
        f.command(nodeId, { kind: "task-show", taskId: "task-read-052" }),
        /(?:violates closed schema fleet\.task\.command\/v1|human_confirmation_required)/u,
      );
      await assert.rejects(
        f.command(nodeId, { kind: "task-list", cursor: first.page.nextCursor }),
        /(?:violates closed schema fleet\.task\.command\/v1|human_confirmation_required)/u,
      );
    }
    assert.equal(f.eventCount(), before, "unsupported direct task reads do not write to the fleet ledger");
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
    // Owned entity content now has a shared projection; offline files and empty directories are
    // covered by fleet-edge-gui-content.integration.test.ts. Direct fleet reads remain rejected
    // either by the closed action schema or by the interactive-session boundary.
    await assert.rejects(
      f.command("node-one", { kind: "work-show", taskId: "task-read-000" }),
      /(?:closed schema|human_confirmation_required)/u,
    );
    const { schema: _configSchema, ...cliConfig } = config;
    const cli = await rpc.handle({
      jsonrpc: "2.0",
      id: 10,
      method: "repo.task.read",
      params: {
        repo: { repoId: cliConfig.repoId },
        payload: { action: { kind: "work-show", taskId: "task-read-000" } },
      },
    });
    assert.ok(cli && !Array.isArray(cli) && "result" in cli, JSON.stringify(cli));
    assert.equal((cli.result as { ok: boolean }).ok, true, JSON.stringify(cli));
    assert.ok((cli.result as { cut: unknown }).cut);
    const all = await read("lease-repo", "repo.tasks.list", { limit: 500 }, auth);
    assert.equal(all.rows.length, 53);
    assert.equal(f.eventCount(), before, "reads append no canonical event");
    const catalog = await read("lease-repo", "repo.gui.catalog.snapshot", {}, auth);
    assert.ok(catalog.catalogDigest);
    assert.doesNotMatch(JSON.stringify(await rereadCatalog()), /replica_unavailable/);
    assert.ok((await read("lease-repo", "repo.gui.catalog.preset.read", { presetId: "standard-task" }, auth)).preset);
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
    // Cross-repository authorization is enforced when the replica stream starts, before any rows reach the edge.
    const stopped = new AbortController();
    let denied: unknown;
    await runFleetReplicaSync({
      ...f.peer("node-two"),
      repoId: "other-repo",
      viewRoot: config.viewRoot,
      diskQuotaBytes: config.quotaBytes,
      signal: stopped.signal,
      onFailure: (error) => {
        denied ??= error;
        stopped.abort();
      },
    });
    assert.equal((denied as { code?: string }).code, "authorization_denied", String(denied));
    assert.equal(readReplicaGeneration(path.join(config.viewRoot, "repos", "other-repo", "views", "node-two")), null);

    assert.equal(
      local.withSession((projection) => projection.list().rows.length),
      0,
      "successful reads do not mirror the SQL projection",
    );
    // Mirroring is reading: a viewer's node receives the replica its repository-read admits, which is
    // what lets its edge answer reads locally (dec_0C26B97C5B6CEA37101FC0A84D).
    // `ha daemon fleet edge sync` for this edge: the production sync waits on the edge daemon's stream.
    const edgeSync = () =>
      syncFleetEdgeMirror(
        { userRoot: edgeUser, payload: { ...config, workspaceRoot: edgeRoot } },
        f.peer("node-one").readAccessToken,
      );
    const viewerPull = await catchUpReplica({
      ...f.peer("node-one"),
      viewRoot: config.viewRoot,
      diskQuotaBytes: 64 * 1024 * 1024,
    });
    assert.equal(viewerPull.replica.knownHead.revision > 0, true);
    f.owners.keycloak.account("person-outsider");
    f.owners.keycloak.node("node-two", "person-outsider");
    // dec_F01770FD0DCF72683B7C4C7A47: ownership transfer revokes the previous consent.
    f.owners.keycloak.endInteractiveSession("device-token-node-two");
    await assert.rejects(
      catchUpReplica({
        ...f.peer("node-two"),
        viewRoot: config.viewRoot,
        diskQuotaBytes: config.quotaBytes,
      }),
      { code: "human_confirmation_required" },
    );
    f.owners.keycloak.node("node-two", "person-one");
    f.owners.keycloak.interactiveSession("person-one", "node-two", f.owners.url, "device-token-node-two");
    f.owners.keycloak.revoke("person-one", "lease-repo", ["repository-read"]);
    assert.equal(
      (await read("lease-repo", "repo.tasks.list", {}, auth)).rows.length,
      53,
      "a grant change reaches the local view at the next sync, not through GUI center forwarding",
    );
    // The edge answers task list from rows already delivered to it; a revocation reaches those rows at
    // the node's next sync, which the center refuses and the edge records by withholding them.
    await assert.rejects(edgeSync(), { code: "authorization_denied" });
    await refusedRead(/replica_unavailable/);
    await refusedAgentRead(/replica_unavailable/);
    await refusedCatalogRead(/replica_unavailable/);
    await refusedCatalogReread(/replica_unavailable/);
    const { schema: _schema, ...edgePayload } = config;
    const revokedCli = await rpc.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "repo.task.read",
      params: { repo: { repoId: edgePayload.repoId }, payload: { action: { kind: "task-list" } } },
    });
    assert.ok(revokedCli && !Array.isArray(revokedCli) && "result" in revokedCli, JSON.stringify(revokedCli));
    assert.equal((revokedCli.result as { ok?: boolean }).ok, false);
    // The CLI reads the same withheld view as the GUI.
    assert.equal((revokedCli.result as { code?: string }).code, "replica_unavailable");
    // task-show no longer crosses the fleet channel at all; the edge's own answer is the one
    // the revoked-cli assertion above already proves withheld.
    await assert.rejects(
      f.command("node-two", { kind: "task-show", taskId: "task-read-000" }),
      /violates closed schema fleet\.task\.command\/v1/u,
    );
    f.owners.keycloak.permit("person-one", "lease-repo", ["repository-read"]);
    f.owners.keycloak.nodeClients.delete("harness-node-node-one");
    await assert.rejects(edgeSync(), { code: "node_owner_unregistered" });
    await f.center.close();
    await refusedRead(/replica_unavailable/);
    await refusedAgentRead(/replica_unavailable/);
    await refusedCatalogRead(/replica_unavailable/);
    await refusedCatalogReread(/replica_unavailable/);
  },
);

test("G11 authorization ancestry reads only projected task identity, never assembled runtime content", async () => {
  const readTaskAuthorizationMetadata = async (taskIds: readonly string[]) =>
    taskIds.flatMap((taskId) =>
      taskId === "work-root"
        ? [{ taskId, taskClass: "work" as const, parentTaskId: null }]
        : taskId === "child-task"
          ? [{ taskId, taskClass: "task" as const, parentTaskId: "work-root" }]
          : [],
    );
  const readAncestor = makeOpaqueTaskAncestorReader({ readTaskAuthorizationMetadata });
  assert.ok(readAncestor);

  assert.deepEqual(await readAncestor("child-task"), {
    taskClass: "task",
    metadata: { parentTaskId: "work-root" },
  });
  assert.deepEqual(await readAncestor("work-root"), {
    taskClass: "work",
    metadata: { parentTaskId: null },
  });
  assert.equal(await readAncestor("missing-task"), null);
  assert.equal(makeOpaqueTaskAncestorReader({}), undefined);
});

test(
  "G11 selective disclosure: task-scoped and work-scoped principals read only authorized task artifacts/context/read-set; cross-task and nonexistent reads fail closed without existence disclosure",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const { nodeId, repoId } = fixture.subject;
    const keycloak = fixture.owners.keycloak;

    // Create two isolated Works and child Tasks in the shared center repository.
    const createAndWait = async (action: Readonly<Record<string, unknown>>) => {
      const receipt = await fixture.host.run(repoId, action as never, fixture.auth);
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      await waitForReceiptCommit(fixture.host, repoId, receipt.opId, fixture.auth);
      return receipt;
    };

    // Migrate vertical declaration and create an accepted Decision so Work roots satisfy the Work creation contract.
    await createAndWait({ kind: "vertical-declaration-migrate" });
    const proposed = await createAndWait({
      kind: "decision-propose",
      jsonInput: JSON.stringify({
        title: "Selective disclosure test work direction",
        question: "Should isolated Work roots isolate task artifacts by scope?",
        riskTier: "low",
        urgency: "low",
        vertical: "software/coding",
        preset: "standard-task",
        decisionClass: "ordinary",
        appliesTo: { modules: ["daemon"], productLines: [] },
        chosen: [{ id: "CH1", text: "Enforce task and work selective disclosure" }],
        rejected: [{ id: "RJ1", text: "Expose all tasks to every caller", whyNot: "Breaks least-privilege isolation" }],
        claims: [],
        fulfillments: [],
      }),
      body: "# Selective disclosure test work direction\n\n## 背景\n\nTest fixture.\n\n## 权衡\n\nIsolate tasks.\n\n## 结论\n\nEnforce task and work selective disclosure.\n",
    });
    const decisionId = String(
      (JSON.parse(String((proposed as Record<string, unknown>).evidence)) as { readonly decisionId: string })
        .decisionId,
    );
    const decisionRef = `${decisionId}/CH1`;
    keycloak.account("person-arbiter");
    keycloak.permit("person-arbiter", repoId, ["decision-accept", "repository-read"]);
    keycloak.interactiveSession("person-arbiter", nodeId, fixture.owners.url, "token-arbiter", "web-bff");
    const arbiterAuth = {
      transportKind: "fleet-tls" as const,
      humanAccessToken: "token-arbiter",
      nodePrincipal: { nodeId, personId: "person-owner" },
    };
    const accepted = await fixture.host.run(
      repoId,
      {
        kind: "decision-accept",
        decisionId,
        rationale: "Fixture work root authorization.",
        judgmentOnlyRationale: "Fixture test only.",
      },
      arbiterAuth,
    );
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    await waitForReceiptCommit(fixture.host, repoId, accepted.opId, fixture.auth);

    await createAndWait({
      kind: "task-create",
      taskId: "work-alpha",
      title: "Work Alpha",
      taskClass: "work",
      decisionRef,
    });
    const taskAlpha = await createAndWait({
      kind: "task-create",
      taskId: "task-alpha",
      title: "Sensitive Task Alpha",
      parentTaskId: "work-alpha",
    });
    await createAndWait({
      kind: "task-create",
      taskId: "work-beta",
      title: "Work Beta",
      taskClass: "work",
      decisionRef,
    });
    const taskBeta = await createAndWait({
      kind: "task-create",
      taskId: "task-beta",
      title: "Restricted Task Beta",
      parentTaskId: "work-beta",
    });

    const taskBeta2 = await createAndWait({
      kind: "task-create",
      taskId: "task-beta-2",
      title: "Restricted Task Beta Sibling",
      parentTaskId: "work-beta",
    });
    const workUnready = await createAndWait({
      kind: "task-create",
      taskId: "work-unready",
      title: "Work Unready Plan",
      taskClass: "work",
      decisionRef,
    });
    const taskUnready = await createAndWait({
      kind: "task-create",
      taskId: "task-unready",
      title: "Task Under Unready Work Plan",
      parentTaskId: "work-unready",
    });

    const alphaPkg = String((taskAlpha as Record<string, unknown>).packagePath);
    const betaPkg = String((taskBeta as Record<string, unknown>).packagePath);
    const beta2Pkg = String((taskBeta2 as Record<string, unknown>).packagePath);
    const workUnreadyPkg = String((workUnready as Record<string, unknown>).packagePath);
    const unreadyPkg = String((taskUnready as Record<string, unknown>).packagePath);

    // Attach both raw binary artifacts and text artifacts to each task.
    const alphaBin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const betaBin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x09, 0x08]);
    writeFileSync(path.join(fixture.repo, "alpha-secret.png"), alphaBin);
    writeFileSync(path.join(fixture.repo, "beta-secret.png"), betaBin);
    writeFileSync(path.join(fixture.repo, "alpha-note.md"), "# Alpha Secret Notes\n");
    writeFileSync(path.join(fixture.repo, "beta-note.md"), "# Beta Restricted Notes\n");
    writeFileSync(path.join(fixture.repo, "beta-2-note.md"), "# Beta Sibling Notes\n");
    writeFileSync(path.join(fixture.repo, "unready-note.md"), "# Authorized Under Unready Ancestor Plan\n");

    const addArtifact = async (action: Readonly<Record<string, unknown>>) => {
      const receipt = await fixture.host.run(repoId, action as never, localAuthFixture());
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      await waitForReceiptCommit(fixture.host, repoId, receipt.opId, fixture.auth);
      return receipt;
    };

    await addArtifact({
      kind: "task-artifact-add",
      taskId: "task-alpha",
      source: "alpha-secret.png",
      destination: "artifacts/secret-alpha.png",
    });
    await addArtifact({
      kind: "task-artifact-add",
      taskId: "task-alpha",
      source: "alpha-note.md",
      destination: "artifacts/note-alpha.md",
    });
    await addArtifact({
      kind: "task-artifact-add",
      taskId: "task-beta",
      source: "beta-secret.png",
      destination: "artifacts/secret-beta.png",
    });
    await addArtifact({
      kind: "task-artifact-add",
      taskId: "task-beta",
      source: "beta-note.md",
      destination: "artifacts/note-beta.md",
    });
    await addArtifact({
      kind: "task-artifact-add",
      taskId: "task-beta-2",
      source: "beta-2-note.md",
      destination: "artifacts/note-beta-2.md",
    });
    await addArtifact({
      kind: "task-artifact-add",
      taskId: "task-unready",
      source: "unready-note.md",
      destination: "artifacts/note-unready.md",
    });
    // Retire work-unready's inherited task_plan.md so runtimeContext.read fails with content_not_ready
    // while minimal projected task/Work ancestry metadata remains sufficient for authorization.
    await addArtifact({
      kind: "doc-retire",
      paths: [`${workUnreadyPkg}/task_plan.md`],
      reason: "Exercise authorization independence from unavailable ancestor plan content.",
    });

    // Provision 4 distinct principals with different least-privilege scopes:
    // 1. person-alpha: ONLY task-level read on task-alpha (no repo-wide read, no task-beta read)
    keycloak.account("person-alpha");
    keycloak.permit("person-alpha", `${repoId}:task/task-alpha`, ["repository-read"]);
    keycloak.interactiveSession("person-alpha", nodeId, fixture.owners.url, "token-alpha", "web-bff");

    // 2. person-work-beta: ONLY Work-level read on work-beta (inherits task-beta, denied on task-alpha)
    keycloak.account("person-work-beta");
    keycloak.permit("person-work-beta", `${repoId}:task/work-beta`, ["repository-read"]);
    keycloak.interactiveSession("person-work-beta", nodeId, fixture.owners.url, "token-work-beta", "web-bff");

    // 3. person-outsider: zero grants on fleet-repo
    keycloak.account("person-outsider");
    keycloak.interactiveSession("person-outsider", nodeId, fixture.owners.url, "token-outsider", "web-bff");

    // 4. person-repo-viewer: repo-wide read baseline
    keycloak.account("person-repo-viewer");
    keycloak.permit("person-repo-viewer", repoId, ["repository-read"]);
    keycloak.interactiveSession("person-repo-viewer", nodeId, fixture.owners.url, "token-repo-viewer", "web-bff");

    // 5. person-work-unready: ONLY Work-level read on work-unready (whose ancestor task_plan.md is retired)
    keycloak.account("person-work-unready");
    keycloak.permit("person-work-unready", `${repoId}:task/work-unready`, ["repository-read"]);
    keycloak.interactiveSession("person-work-unready", nodeId, fixture.owners.url, "token-work-unready", "web-bff");

    const center = await fixture.center();
    const peer = await openPeer({
      port: center.port,
      ca: fixture.cert,
      servername: "localhost",
      nodeId,
      credential: "machine-secret",
    });
    t.after(() => peer.close());

    const fleetRead = (
      accessToken: string,
      method:
        | "repo.tasks.document.read"
        | "repo.tasks.documents.list"
        | "repo.tasks.runtimeContext.read"
        | "repo.task.show"
        | "repo.task.read"
        | "repo.tasks.list"
        | "repo.artifacts.list",
      payload: Readonly<Record<string, unknown>>,
    ) =>
      peer.request({
        schema: "fleet.operational.read/v1",
        messageId: peer.messageId(),
        repoId,
        method,
        payload,
        accessToken,
      });

    const expectFleetDenied = async (
      accessToken: string,
      method: Parameters<typeof fleetRead>[1],
      payload: Readonly<Record<string, unknown>>,
    ): Promise<string> => {
      let message = "";
      await assert.rejects(fleetRead(accessToken, method, payload), (error: unknown) => {
        assert.ok(error instanceof FleetRemoteError, String(error));
        assert.equal(error.code, "authorization_denied", `${method} expected authorization_denied, got ${error.code}`);
        message = error.message;
        return true;
      });
      return message;
    };

    const eventsBefore = fixture.eventCount();

    // --- POSITIVE CONTROLS ---
    // 1) person-alpha CAN read task-alpha raw binary artifact, text artifact, document list, task show, and task-read-set over Fleet TLS.
    const alphaBinary = parseDaemonReadResult(
      "repo.tasks.document.read",
      await readFleetOperationalClient({
        port: center.port,
        ca: fixture.cert,
        servername: "localhost",
        nodeId,
        credential: "machine-secret",
        repoId,
        readAccessToken: async () => "token-alpha",
        method: "repo.tasks.document.read",
        payload: { taskId: "task-alpha", path: "artifacts/secret-alpha.png" },
      }),
    );
    assert.equal(alphaBinary.ok, true);
    assert.equal(alphaBinary.contentKind, "binary");
    assert.deepEqual(Buffer.from(String(alphaBinary.bytes), "base64"), alphaBin);

    const alphaList = parseDaemonReadResult(
      "repo.tasks.documents.list",
      await readFleetOperationalClient({
        port: center.port,
        ca: fixture.cert,
        servername: "localhost",
        nodeId,
        credential: "machine-secret",
        repoId,
        readAccessToken: async () => "token-alpha",
        method: "repo.tasks.documents.list",
        payload: { taskId: "task-alpha" },
      }),
    );
    assert.equal(alphaList.ok, true);
    assert.ok(alphaList.documents.some((doc) => doc.path === "artifacts/secret-alpha.png"));

    const alphaReadSet = await readFleetOperationalClient({
      port: center.port,
      ca: fixture.cert,
      servername: "localhost",
      nodeId,
      credential: "machine-secret",
      repoId,
      readAccessToken: async () => "token-alpha",
      method: "repo.task.read",
      payload: { action: { kind: "task-read-set", taskId: "task-alpha" } },
    });
    assert.equal(alphaReadSet.ok, true);
    assert.equal(alphaReadSet.command, "task-read-set");

    // Direct host.read for person-alpha on task-alpha runtimeContext & dispatches succeeds.
    const alphaAuth = {
      transportKind: "fleet-tls" as const,
      humanAccessToken: "token-alpha",
      nodePrincipal: { nodeId, personId: "person-owner" },
    };
    const alphaCtx = await fixture.host.read(
      repoId,
      "repo.tasks.runtimeContext.read",
      { taskId: "task-alpha" },
      alphaAuth,
    );
    assert.equal(alphaCtx.snapshot.task?.taskId, "task-alpha");
    const alphaDispatches = await fixture.host.read(
      repoId,
      "repo.task.dispatches",
      { taskId: "task-alpha" },
      alphaAuth,
    );
    assert.equal(alphaDispatches.ok, true);

    // 2) person-work-beta inherits visibility on child task-beta via Work ancestor work-beta.
    const betaBinaryForWork = parseDaemonReadResult(
      "repo.tasks.document.read",
      await readFleetOperationalClient({
        port: center.port,
        ca: fixture.cert,
        servername: "localhost",
        nodeId,
        credential: "machine-secret",
        repoId,
        readAccessToken: async () => "token-work-beta",
        method: "repo.tasks.document.read",
        payload: { taskId: "task-beta", path: "artifacts/secret-beta.png" },
      }),
    );
    assert.deepEqual(Buffer.from(String(betaBinaryForWork.bytes), "base64"), betaBin);

    // 3) person-repo-viewer retains full visibility across both tasks.
    const viewerBeta = parseDaemonReadResult(
      "repo.tasks.document.read",
      await readFleetOperationalClient({
        port: center.port,
        ca: fixture.cert,
        servername: "localhost",
        nodeId,
        credential: "machine-secret",
        repoId,
        readAccessToken: async () => "token-repo-viewer",
        method: "repo.tasks.document.read",
        payload: { taskId: "task-beta", path: "artifacts/secret-beta.png" },
      }),
    );
    assert.deepEqual(Buffer.from(String(viewerBeta.bytes), "base64"), betaBin);

    const viewerAuth = {
      transportKind: "fleet-tls" as const,
      humanAccessToken: "token-repo-viewer",
      nodePrincipal: { nodeId, personId: "person-owner" },
    };
    const workBetaAuth = {
      transportKind: "fleet-tls" as const,
      humanAccessToken: "token-work-beta",
      nodePrincipal: { nodeId, personId: "person-owner" },
    };
    const workUnreadyAuth = {
      transportKind: "fleet-tls" as const,
      humanAccessToken: "token-work-unready",
      nodePrincipal: { nodeId, personId: "person-owner" },
    };

    // 3a) Work-scoped principal (WITHOUT repo-wide read) succeeds on all-authorized multi-task and multi-path batches,
    // and fails closed on mixed-permission batches regardless of target ordering.
    const workBetaDispatchBatch = await fixture.host.read(
      repoId,
      "repo.task.dispatches",
      { taskIds: ["task-beta", "task-beta-2"], latestOnly: true },
      workBetaAuth,
    );
    assert.deepEqual(workBetaDispatchBatch.taskIds, ["task-beta", "task-beta-2"]);
    for (const mixedTaskIds of [
      ["task-beta", "task-alpha"],
      ["task-alpha", "task-beta"],
    ] as const) {
      await assert.rejects(
        fixture.host.read(repoId, "repo.task.dispatches", { taskIds: mixedTaskIds, latestOnly: true }, workBetaAuth),
        (error: unknown) => (error as { code?: string }).code === "authorization_denied",
        `mixed-permission dispatch batch ${JSON.stringify(mixedTaskIds)} must fail closed`,
      );
    }

    const workBetaDocumentBatch = await fixture.host.run(
      repoId,
      {
        kind: "doc-status",
        paths: [`${betaPkg}/artifacts/note-beta.md`, `${beta2Pkg}/artifacts/note-beta-2.md`],
      },
      workBetaAuth,
    );
    assert.equal(workBetaDocumentBatch.outcome, "applied", JSON.stringify(workBetaDocumentBatch));

    // 3a-cli) Public CLI selector & workspace-coordinate parity (F-G11-MULTI-READ):
    // parse public CLI invocations (`doc status --task`, `doc sync --dry-run --task`, repeated `--path`, `doc show --path`),
    // validate through the closed RPC schema (`repo.task.read`), and verify Work-scoped principals succeed on
    // all-authorized selectors while failing closed on cross-task, unindexed, or outside-root mixed batches.
    const parseCliAction = (args: readonly string[]) => {
      const parsed = parseThinCommand(args, fixture.repo);
      assert.equal(parsed.ok, true, `expected CLI parse to succeed for ${args.join(" ")}`);
      if (!parsed.ok) throw new Error("unreachable");
      return parsed.command.action;
    };
    const workBetaRpc = createJsonRpcProtocolServer({
      host: fixture.host,
      build: daemonBuildStamp(),
      authContext: workBetaAuth,
      emit: async () => undefined,
    });
    t.after(() => workBetaRpc.close());
    await workBetaRpc.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion, buildCommit: daemonBuildStamp().commit },
    });
    let rpcSeq = 2;
    const runWorkBetaCliRpc = async (args: readonly string[]) => {
      const response = await workBetaRpc.handle({
        jsonrpc: "2.0",
        id: rpcSeq++,
        method: "repo.task.read",
        params: { repo: { repoId }, payload: { action: parseCliAction(args) } },
      });
      assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
      return response.result as { readonly ok?: boolean; readonly outcome?: string; readonly code?: string };
    };

    const betaWorkspacePath = `harness/${betaPkg}/artifacts/note-beta.md`;
    const beta2WorkspacePath = `harness/${beta2Pkg}/artifacts/note-beta-2.md`;
    const alphaWorkspacePath = `harness/${alphaPkg}/artifacts/note-alpha.md`;
    const ghostWorkspacePath = "harness/tasks/task-ghost-nonexistent/artifacts/secret.md";

    for (const [cliArgs, expectedOutcome] of [
      [["doc", "status", "--task", "task-beta"], "applied"],
      [["doc", "sync", "--dry-run", "--task", "task-beta"], "pending"],
      [["doc", "status", "--path", betaWorkspacePath, "--path", beta2WorkspacePath], "applied"],
      [["doc", "sync", "--dry-run", "--path", betaWorkspacePath, "--path", beta2WorkspacePath], "pending"],
    ] as const) {
      const receipt = await runWorkBetaCliRpc(cliArgs);
      assert.equal(
        receipt.outcome,
        expectedOutcome,
        `Work-scoped principal must succeed on public CLI RPC ${cliArgs.join(" ")}: ${JSON.stringify(receipt)}`,
      );
    }

    // For a remote node without a task lease, `doc show --path <workspace>` passes Work-scoped authorization
    // (never `authorization_denied`) and reaches doc-sync's lease boundary (`execution_scope_mismatch`)
    // across `repo.task.read`, named `repo.doc.show`, and Fleet TLS.
    const remoteCliDocShow = await runWorkBetaCliRpc(["doc", "show", "--path", betaWorkspacePath]);
    assert.equal(remoteCliDocShow.code, "execution_scope_mismatch", JSON.stringify(remoteCliDocShow));
    const namedDocShow = await workBetaRpc.handle({
      jsonrpc: "2.0",
      id: rpcSeq++,
      method: "repo.doc.show",
      params: { repo: { repoId }, payload: { path: `${betaPkg}/artifacts/note-beta.md` } },
    });
    assert.ok(namedDocShow && !Array.isArray(namedDocShow) && "result" in namedDocShow, JSON.stringify(namedDocShow));
    assert.equal(
      (namedDocShow.result as { readonly code?: string }).code,
      "execution_scope_mismatch",
      JSON.stringify(namedDocShow),
    );
    await assert.rejects(
      readFleetOperationalClient({
        port: center.port,
        ca: fixture.cert,
        servername: "localhost",
        nodeId,
        credential: "machine-secret",
        repoId,
        readAccessToken: async () => "token-work-beta",
        method: "repo.task.read",
        payload: { action: parseCliAction(["doc", "show", "--path", betaWorkspacePath]) },
      }),
      (error: unknown) => (error as { code?: string }).code === "execution_scope_mismatch",
    );

    // Negative controls through public CLI JSON-RPC: cross-task `--task`, mixed-order `--path` batches,
    // unindexed workspace paths, and non-workspace (outside authored root) paths must all fail closed.
    for (const deniedCliArgs of [
      ["doc", "status", "--task", "task-alpha"],
      ["doc", "sync", "--dry-run", "--task", "task-alpha"],
      ["doc", "status", "--path", betaWorkspacePath, "--path", alphaWorkspacePath],
      ["doc", "status", "--path", alphaWorkspacePath, "--path", betaWorkspacePath],
      ["doc", "sync", "--dry-run", "--path", betaWorkspacePath, "--path", alphaWorkspacePath],
      ["doc", "sync", "--dry-run", "--path", alphaWorkspacePath, "--path", betaWorkspacePath],
      ["doc", "status", "--path", betaWorkspacePath, "--path", ghostWorkspacePath],
      ["doc", "status", "--path", betaWorkspacePath, "--path", `${betaPkg}/artifacts/note-beta.md`],
    ] as const) {
      const denied = await runWorkBetaCliRpc(deniedCliArgs);
      assert.equal(
        denied.code,
        "authorization_denied",
        `Work-scoped principal must fail closed on public CLI RPC ${deniedCliArgs.join(" ")}: ${JSON.stringify(denied)}`,
      );
      assert.equal(denied.outcome, "op_rejected");
    }

    const fleetDeniedExistingCliDocShow = await expectFleetDenied("token-alpha", "repo.task.read", {
      action: parseCliAction(["doc", "show", "--path", betaWorkspacePath]),
    });
    const fleetDeniedGhostCliDocShow = await expectFleetDenied("token-alpha", "repo.task.read", {
      action: parseCliAction(["doc", "show", "--path", ghostWorkspacePath]),
    });
    assert.equal(
      fleetDeniedExistingCliDocShow,
      fleetDeniedGhostCliDocShow,
      "Fleet CLI workspace-coordinate doc-show denial must be identical for existing vs nonexistent tasks",
    );

    const viewerDispatchBatch = await fixture.host.read(
      repoId,
      "repo.task.dispatches",
      { taskIds: ["task-beta", "task-alpha"], latestOnly: true },
      viewerAuth,
    );
    assert.deepEqual(viewerDispatchBatch.taskIds, ["task-beta", "task-alpha"]);
    for (const mixedTaskIds of [
      ["task-beta", "task-alpha"],
      ["task-alpha", "task-beta"],
    ] as const) {
      await assert.rejects(
        fixture.host.read(repoId, "repo.task.dispatches", { taskIds: mixedTaskIds, latestOnly: true }, alphaAuth),
        (error: unknown) => (error as { code?: string }).code === "authorization_denied",
        "a mixed-permission dispatch batch must be denied before any target content is read",
      );
    }

    const viewerDocumentBatch = await fixture.host.run(
      repoId,
      {
        kind: "doc-status",
        paths: [`${betaPkg}/artifacts/note-beta.md`, `${alphaPkg}/artifacts/note-alpha.md`],
      },
      viewerAuth,
    );
    assert.equal(viewerDocumentBatch.outcome, "applied", JSON.stringify(viewerDocumentBatch));
    for (const mixedPaths of [
      [`${betaPkg}/artifacts/note-beta.md`, `${alphaPkg}/artifacts/note-alpha.md`],
      [`${alphaPkg}/artifacts/note-alpha.md`, `${betaPkg}/artifacts/note-beta.md`],
      [`${alphaPkg}/artifacts/note-alpha.md`, "tasks/task-ghost-nonexistent/artifacts/secret.md"],
    ] as const) {
      const deniedDocumentBatch = await fixture.host.run(
        repoId,
        {
          kind: "doc-status",
          paths: mixedPaths,
        },
        alphaAuth,
      );
      assert.equal(deniedDocumentBatch.code, "authorization_denied", JSON.stringify(deniedDocumentBatch));
      assert.equal(deniedDocumentBatch.outcome, "op_rejected");
    }

    // 3b) Pre-auth context independence (F-G11-PREAUTH-CONTEXT): when work-unready's inherited task_plan.md
    // is unavailable (making runtimeContext.read throw content_not_ready), authorized reads of task-unready
    // documents still succeed via minimal projected ancestry metadata, while unauthorized callers get uniform
    // authorization_denied (never content_not_ready leaking ancestor plan paths).
    await assert.rejects(
      fixture.host.read(repoId, "repo.tasks.runtimeContext.read", { taskId: "task-unready" }, workUnreadyAuth),
      (error: unknown) => (error as { code?: string }).code === "content_not_ready",
      "precondition: authorized runtimeContext.read must hit content_not_ready when ancestor plan is retired",
    );
    const authorizedUnreadyDoc = parseDaemonReadResult(
      "repo.tasks.document.read",
      await readFleetOperationalClient({
        port: center.port,
        ca: fixture.cert,
        servername: "localhost",
        nodeId,
        credential: "machine-secret",
        repoId,
        readAccessToken: async () => "token-work-unready",
        method: "repo.tasks.document.read",
        payload: { taskId: "task-unready", path: "artifacts/note-unready.md" },
      }),
    );
    assert.equal(authorizedUnreadyDoc.ok, true);
    assert.match(String(authorizedUnreadyDoc.body), /Authorized Under Unready Ancestor Plan/u);
    const authorizedUnreadyDocStatus = await fixture.host.run(
      repoId,
      { kind: "doc-status", paths: [`${unreadyPkg}/artifacts/note-unready.md`] },
      workUnreadyAuth,
    );
    assert.equal(authorizedUnreadyDocStatus.outcome, "applied", JSON.stringify(authorizedUnreadyDocStatus));
    await expectFleetDenied("token-alpha", "repo.tasks.document.read", {
      taskId: "task-unready",
      path: "artifacts/note-unready.md",
    });
    await assert.rejects(
      fixture.host.read(repoId, "repo.tasks.runtimeContext.read", { taskId: "task-unready" }, alphaAuth),
      (error: unknown) => (error as { code?: string }).code === "authorization_denied",
      "unauthorized runtimeContext.read on unready-ancestor task must fail closed with authorization_denied, never content_not_ready",
    );
    const unreadyDocDeniedFleet = await expectFleetDenied("token-alpha", "repo.task.read", {
      action: { kind: "doc-show", path: `${unreadyPkg}/artifacts/note-unready.md` },
    });
    const unreadyDocDeniedHost = await fixture.host.run(
      repoId,
      { kind: "doc-show", path: `${unreadyPkg}/artifacts/note-unready.md` },
      alphaAuth,
    );
    assert.equal(unreadyDocDeniedHost.code, "authorization_denied");
    assert.equal(unreadyDocDeniedFleet.includes("task_plan.md"), false);
    assert.equal(unreadyDocDeniedFleet.includes("task-unready"), false);

    // --- 100% FAIL-CLOSED NEGATIVE CONTROLS & ZERO EXISTENCE DISCLOSURE ---
    // 4) person-alpha CANNOT read restricted task-beta OR nonexistent tasks across ANY surface.
    for (const targetTaskId of ["task-beta", "task-does-not-exist"]) {
      await expectFleetDenied("token-alpha", "repo.tasks.document.read", {
        taskId: targetTaskId,
        path: "artifacts/secret-beta.png",
      });
      await expectFleetDenied("token-alpha", "repo.tasks.documents.list", { taskId: targetTaskId });
      await expectFleetDenied("token-alpha", "repo.task.show", { taskId: targetTaskId });
      await expectFleetDenied("token-alpha", "repo.task.read", {
        action: { kind: "task-read-set", taskId: targetTaskId },
      });

      // Direct host.read surfaces must also fail closed with authorization_denied (never task_not_found!).
      for (const [method, payload] of [
        ["repo.tasks.document.read", { taskId: targetTaskId, path: "artifacts/secret-beta.png" }],
        ["repo.tasks.documents.list", { taskId: targetTaskId }],
        ["repo.tasks.runtimeContext.read", { taskId: targetTaskId }],
        ["repo.tasks.completion.read", { taskId: targetTaskId }],
        ["repo.tasks.deliveryDiff.read", { taskId: targetTaskId }],
        ["repo.task.dispatches", { taskId: targetTaskId }],
      ] as const) {
        await assert.rejects(
          fixture.host.read(repoId, method, payload, alphaAuth),
          (error: unknown) => (error as { code?: string }).code === "authorization_denied",
          `host.read ${method} on ${targetTaskId} must fail closed with authorization_denied`,
        );
      }
    }

    // 5) Path-addressed doc-show on existing restricted raw artifact vs nonexistent path MUST NOT leak existence, size, sha256, or taskId!
    const existingDocDeniedFleet = await expectFleetDenied("token-alpha", "repo.task.read", {
      action: { kind: "doc-show", path: `${betaPkg}/artifacts/secret-beta.png` },
    });
    const missingDocDeniedFleet = await expectFleetDenied("token-alpha", "repo.task.read", {
      action: { kind: "doc-show", path: "tasks/task-ghost-nonexistent/artifacts/secret-beta.png" },
    });
    assert.equal(
      existingDocDeniedFleet,
      missingDocDeniedFleet,
      "Fleet doc-show denial for existing restricted task vs nonexistent task must be identical (zero existence disclosure)",
    );
    assert.equal(
      unreadyDocDeniedFleet,
      missingDocDeniedFleet,
      "Fleet doc-show denial for unready-ancestor task vs nonexistent task must be identical",
    );
    assert.equal(existingDocDeniedFleet.includes("task-beta"), false);
    assert.equal(existingDocDeniedFleet.includes("bytes"), false);

    const existingDocDeniedHost = await fixture.host.run(
      repoId,
      { kind: "doc-show", path: `${betaPkg}/artifacts/secret-beta.png` },
      alphaAuth,
    );
    const missingDocDeniedHost = await fixture.host.run(
      repoId,
      { kind: "doc-show", path: "tasks/task-ghost-nonexistent/artifacts/secret-beta.png" },
      alphaAuth,
    );
    assert.equal(existingDocDeniedHost.code, "authorization_denied");
    assert.equal(missingDocDeniedHost.code, "authorization_denied");
    assert.equal(
      existingDocDeniedHost.rejectionExplanation,
      missingDocDeniedHost.rejectionExplanation,
      "Host doc-show denial for existing restricted task vs nonexistent task must be identical",
    );
    assert.equal(
      unreadyDocDeniedHost.rejectionExplanation,
      missingDocDeniedHost.rejectionExplanation,
      "Host doc-show denial for unready-ancestor task vs nonexistent task must be identical",
    );

    // 6) person-alpha cannot bypass task scope via repo-wide list methods or doc-show on repo-level paths.
    await expectFleetDenied("token-alpha", "repo.tasks.list", { limit: 10 });
    await expectFleetDenied("token-alpha", "repo.artifacts.list", { limit: 10 });
    await assert.rejects(
      fixture.host.read(repoId, "repo.artifacts.list", { limit: 10 }, alphaAuth),
      (error: unknown) => (error as { code?: string }).code === "authorization_denied",
    );
    await assert.rejects(
      fixture.host.read(repoId, "repo.task.dispatches", { limit: 10 }, alphaAuth),
      (error: unknown) => (error as { code?: string }).code === "authorization_denied",
    );

    // 7) person-work-beta is denied on task-alpha (sibling Work), and person-outsider is denied on both.
    await expectFleetDenied("token-work-beta", "repo.tasks.document.read", {
      taskId: "task-alpha",
      path: "artifacts/secret-alpha.png",
    });
    await expectFleetDenied("token-work-beta", "repo.task.read", {
      action: { kind: "doc-show", path: `${alphaPkg}/artifacts/note-alpha.md` },
    });
    await expectFleetDenied("token-outsider", "repo.tasks.document.read", {
      taskId: "task-alpha",
      path: "artifacts/secret-alpha.png",
    });
    await expectFleetDenied("token-outsider", "repo.tasks.document.read", {
      taskId: "task-beta",
      path: "artifacts/secret-beta.png",
    });

    assert.equal(fixture.eventCount(), eventsBefore, "selective disclosure checks must append zero canonical events");
    assert.deepEqual(fixture.transportErrors, [], "authorization denials must not record unexpected transport errors");
  },
);

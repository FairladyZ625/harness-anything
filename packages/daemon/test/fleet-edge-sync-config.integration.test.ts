// harness-test-tier: integration
// `ha daemon fleet edge sync` on a fresh edge: the admitted connection becomes the workspace's
// fleet-edge.json and the resident replica stream starts on it; a sync with a changed connection
// rewrites the file and restarts the stream on the new settings.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { readFleetEdgeConfig, writeFleetEdgeConfig } from "../src/client/fleet-edge-config.ts";
import { readReplicaGeneration } from "../src/fleet/replica-generation.ts";
import { readReplicaHealth } from "../src/fleet/replica-health.ts";
import { waitForFleetReplicaReady } from "../src/fleet/replica-sync.ts";

test(
  "a successful edge sync persists its connection and starts the resident stream",
  { timeout: 180_000 },
  async (t) => {
    let publishedAuthority: { readonly url: string; readonly realm: string; readonly clientId: string } | null = null;
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, () => publishedAuthority, true);
    publishedAuthority = {
      url: f.owners.url,
      realm: "tenant-realm",
      clientId: "harness-node-node-one",
    };
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId: "synced-0", title: "Synced 0" })).outcome,
      "applied",
    );
    const e = await fleetEdgeHostFixture(t, f, { writeEdgeConfig: false });
    const configFile = path.join(e.edgeRoot, "fleet-edge.json");
    assert.equal(existsSync(configFile), false);
    const { schema: _schema, waitTimeoutMs: _wait, ...connection } = e.config;
    let id = 100;
    const edgeSync = async (payload: Record<string, unknown>) => {
      id += 1;
      const response = await e.rpc.handle({
        jsonrpc: "2.0",
        id,
        method: "daemon.fleet.edge.sync",
        params: { payload: { ...payload, workspaceRoot: e.edgeRoot, timeoutMs: 30_000 } },
      });
      if (!response || Array.isArray(response) || !("result" in response))
        throw new Error(`edge sync failed: ${JSON.stringify(response)}`);
      return response.result as Record<string, unknown>;
    };

    const first = await edgeSync(connection);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.outcome, "applied");
    const persistedFirst = readFleetEdgeConfig(e.edgeRoot)!;
    const { loginUrl: _loginUrl, loginRealm: _loginRealm, ...persistedFirstConnection } = persistedFirst;
    assert.deepEqual(persistedFirstConnection, connection);
    assert.equal(persistedFirst.loginUrl, publishedAuthority.url);
    assert.equal(persistedFirst.loginRealm, publishedAuthority.realm);
    assert.equal(statSync(configFile).mode & 0o777, 0o600, "the file carries the machine credential");

    writeFleetEdgeConfig(e.edgeRoot, {
      ...connection,
      loginUrl: f.owners.url,
      loginRealm: "harness",
      loginBrowserUrl: f.owners.url,
    });
    f.owners.keycloak.interactiveSession(
      "person-one",
      "node-one",
      f.owners.url,
      "device-token-node-one",
      "harness-node-node-one",
    );

    // A changed connection is rewritten and the stream restarts on it; sync waits on the new stream.
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId: "synced-1", title: "Synced 1" })).outcome,
      "applied",
    );
    const changed = { ...connection, quotaBytes: connection.quotaBytes * 2 };
    const second = await edgeSync(changed);
    assert.equal(second.ok, true, JSON.stringify(second));
    const persisted = readFleetEdgeConfig(e.edgeRoot)!;
    const {
      loginUrl: _changedLoginUrl,
      loginRealm: _changedLoginRealm,
      loginServername: _changedLoginServername,
      loginBrowserUrl: _changedLoginBrowserUrl,
      loginCertificate: _changedLoginCertificate,
      ...persistedConnection
    } = persisted;
    assert.deepEqual(persistedConnection, changed);
    assert.equal(persisted?.loginUrl, f.owners.url);
    assert.equal(persisted?.loginRealm, "harness");
    assert.equal(persisted?.loginBrowserUrl, f.owners.url);
    const listed = await e.command({ kind: "task-list" });
    const rows = listed.rows as Array<{ readonly taskId?: string }>;
    assert.deepEqual(
      rows
        .map((row) => row.taskId)
        .filter((taskId) => taskId?.startsWith("synced-"))
        .sort(),
      ["synced-0", "synced-1"],
    );
  },
);

test(
  "an existing edge config missing loginRealm is repaired from center OIDC discovery",
  { timeout: 180_000 },
  async (t) => {
    let publishedAuthority: { readonly url: string; readonly realm: string; readonly clientId: string } | null = null;
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, () => publishedAuthority, true),
      e = await fleetEdgeHostFixture(t, f),
      current = readFleetEdgeConfig(e.edgeRoot)!;
    publishedAuthority = {
      url: "https://login.example",
      realm: "tenant-realm",
      clientId: "harness-node-node-one",
    };
    writeFleetEdgeConfig(e.edgeRoot, { ...current, loginUrl: f.owners.url });
    const { waitTimeoutMs: _wait, loginUrl: _loginUrl, ...connection } = readFleetEdgeConfig(e.edgeRoot)!;
    const response = await e.rpc.handle({
      jsonrpc: "2.0",
      id: 201,
      method: "daemon.fleet.edge.sync",
      params: { payload: { ...connection, workspaceRoot: e.edgeRoot, timeoutMs: 30_000 } },
    });
    assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
    assert.equal((response.result as Record<string, unknown>).ok, true, JSON.stringify(response.result));
    assert.equal(readFleetEdgeConfig(e.edgeRoot)?.loginRealm, publishedAuthority.realm);
  },
);

test(
  "an unattended edge with a legacy config obtains a machine token through its resident replica stream",
  { timeout: 180_000 },
  async (t) => {
    let publishedAuthority: { readonly url: string; readonly realm: string; readonly clientId: string } | null = null;
    const f = await fleetNodeClaimFixture(
      t,
      undefined,
      undefined,
      undefined,
      () => publishedAuthority,
      true,
      undefined,
      undefined,
      undefined,
      { replicaAdmission: true },
    );
    publishedAuthority = {
      url: f.owners.url,
      realm: "harness",
      clientId: "harness-node-node-one",
    };
    let machineTokenExchanges = 0;
    const keycloakFetch = f.owners.keycloak.fetch;
    f.owners.keycloak.fetch = (async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/protocol/openid-connect/token")) {
        const form = init?.body as URLSearchParams;
        if (form.get("grant_type") === "client_credentials" && form.get("client_id") === "harness-node-node-one")
          machineTokenExchanges += 1;
      }
      return keycloakFetch(input, init);
    }) as typeof fetch;

    const edge = await fleetEdgeHostFixture(t, f, {
      humanSession: false,
      beforeOpen: (edgeRoot) => {
        const config = readFleetEdgeConfig(edgeRoot)!;
        writeFleetEdgeConfig(edgeRoot, { ...config, loginUrl: f.owners.url });
      },
    });
    assert.equal(readFleetEdgeConfig(edge.edgeRoot)?.loginRealm, undefined, "the persisted config predates loginRealm");
    const ready = await waitForFleetReplicaReady({ viewRoot: edge.viewRoot, repoId: "lease-repo", nodeId: "node-one" });
    assert.equal(
      ready,
      true,
      JSON.stringify(readReplicaHealth(path.join(edge.viewRoot, "repos", "lease-repo", "views", "node-one"))),
    );
    const generation = readReplicaGeneration(path.join(edge.viewRoot, "repos", "lease-repo", "views", "node-one"));
    assert.equal(generation?.metadata.readerProfile?.personId, "person-one");
    assert.ok(machineTokenExchanges > 0, "the production edge host exchanged its node secret without a human session");
  },
);

test("a stale humanClientId cannot override the node-derived azp during edge sync", { timeout: 180_000 }, async (t) => {
  const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
  const e = await fleetEdgeHostFixture(t, f);
  f.owners.keycloak.interactiveSession(
    "person-one",
    "node-one",
    f.owners.url,
    "device-token-node-one",
    "harness-node-node-one",
  );
  const observedAzp: unknown[] = [],
    keycloakFetch = f.owners.keycloak.fetch;
  f.owners.keycloak.fetch = (async (input, init) => {
    const response = await keycloakFetch(input, init);
    if (String(input).endsWith("/protocol/openid-connect/token/introspect")) {
      const claims = (await response.clone().json()) as { readonly azp?: unknown };
      observedAzp.push(claims.azp);
    }
    return response;
  }) as typeof fetch;
  const { waitTimeoutMs: _wait, ...connection } = readFleetEdgeConfig(e.edgeRoot)!,
    sync = async () => {
      const response = await e.rpc.handle({
        jsonrpc: "2.0",
        id: 200,
        method: "daemon.fleet.edge.sync",
        params: { payload: { ...connection, workspaceRoot: e.edgeRoot, timeoutMs: 30_000 } },
      });
      assert.ok(response && !Array.isArray(response), JSON.stringify(response));
      return "result" in response ? (response.result as Record<string, unknown>) : {};
    };
  writeFileSync(
    path.join(e.edgeRoot, "fleet-edge.json"),
    JSON.stringify({ schema: "fleet-edge-config/v1", ...connection, humanClientId: "harness-gui" }),
  );
  const synced = await sync();
  assert.equal(observedAzp[0], "harness-node-node-one");
  assert.equal(synced.ok, true, JSON.stringify(synced));
  assert.equal(synced.outcome, "applied", JSON.stringify(synced));
  const persisted = JSON.parse(readFileSync(path.join(e.edgeRoot, "fleet-edge.json"), "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(Object.hasOwn(persisted, "humanClientId"), false);
});

test(
  "edge sync refuses a workspace whose origin differs from the center repository",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true),
      centerOrigin = path.join(f.root, "center-origin.git");
    execFileSync("git", ["-C", f.repo, "remote", "add", "origin", centerOrigin]);
    const e = await fleetEdgeHostFixture(t, f),
      { waitTimeoutMs: _wait, ...connection } = readFleetEdgeConfig(e.edgeRoot)!;
    execFileSync("git", ["-C", e.edgeRoot, "remote", "add", "origin", path.join(f.root, "wrong-origin.git")]);
    const response = await e.rpc.handle({
      jsonrpc: "2.0",
      id: 301,
      method: "daemon.fleet.edge.sync",
      params: { payload: { ...connection, workspaceRoot: e.edgeRoot, timeoutMs: 30_000 } },
    });
    assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
    assert.equal((response.result as Record<string, unknown>).code, "edge_origin_mismatch", JSON.stringify(response));
    assert.match(String((response.result as Record<string, unknown>).rejectionExplanation), /origin does not match/u);
  },
);

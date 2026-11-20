// harness-test-tier: integration
// `ha daemon fleet edge sync` on a fresh edge: the admitted connection becomes the node's
// fleet-edge.json and the resident replica stream starts on it; a sync with a changed connection
// rewrites the file and restarts the stream on the new settings.
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { createIdentitySession } from "../src/daemon-host/authorization-provider.ts";
import {
  fleetEdgeConfigPath,
  readFleetEdgeConfig,
  writeFleetEdgeConfig,
} from "../src/daemon-host/client/fleet-edge-config.ts";
import { readReplicaGeneration } from "../src/fleet-sync/fleet/replica-generation.ts";
import { readReplicaHealth, recordReplicaHealth } from "../src/fleet-sync/fleet/replica-health.ts";
import { waitForFleetReplicaReady } from "../src/daemon-host/fleet/replica-sync.ts";
import { fleetBaseBackupTrace } from "@harness-anything/storage";
import { oidcCenterSelections } from "../src/daemon-host/oidc-center-selection.ts";

async function listenFleetLoginProxy(
  t: TestContext,
  input: { readonly root: string; readonly keycloak: { readonly fetch: typeof fetch } },
): Promise<{
  readonly url: string;
  readonly certificate: string;
  readonly setKeycloakFetch: (fetcher: typeof fetch) => void;
}> {
  let keycloakFetch: typeof fetch | undefined,
    loginUrl = "";
  const certificate = readFileSync(path.join(input.root, "tls.crt"), "utf8"),
    loginServer = createHttpsServer(
      { key: readFileSync(path.join(input.root, "tls.key")), cert: certificate },
      (request, response) => {
        void (async () => {
          let raw = "";
          for await (const chunk of request) raw += String(chunk);
          const answer = await (keycloakFetch ?? input.keycloak.fetch)(`${loginUrl}${request.url}`, {
            method: request.method,
            headers: request.headers as Record<string, string>,
            ...(raw === "" ? {} : { body: new URLSearchParams(raw) }),
          });
          response.statusCode = answer.status;
          response.setHeader("content-type", "application/json");
          response.end(Buffer.from(await answer.arrayBuffer()));
        })().catch(() => {
          response.statusCode = 500;
          response.end("{}");
        });
      },
    );
  loginServer.listen(0, "127.0.0.1");
  await once(loginServer, "listening");
  const loginAddress = loginServer.address();
  assert.ok(loginAddress && typeof loginAddress !== "string");
  loginUrl = `https://localhost:${loginAddress.port}`;
  t.after(
    () =>
      new Promise<void>((resolve) => {
        loginServer.closeAllConnections();
        loginServer.close(() => resolve());
      }),
  );
  return {
    url: loginUrl,
    certificate,
    setKeycloakFetch: (fetcher) => {
      keycloakFetch = fetcher;
    },
  };
}

test(
  "a successful edge sync persists its connection and starts the resident stream",
  { timeout: 180_000 },
  async (t) => {
    let publishedAuthority: {
      readonly url: string;
      readonly realm: string;
      readonly clientId: string;
      readonly browserUrl?: string;
      readonly servername?: string;
      readonly certificate?: string;
    } | null = null;
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
    const configFile = fleetEdgeConfigPath(e.edgeUser, "lease-repo");
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
    const persistedFirst = readFleetEdgeConfig(e.edgeUser, "lease-repo")!;
    const {
      loginUrl: _loginUrl,
      loginRealm: _loginRealm,
      writerEpoch: firstWriterEpoch,
      spkiSha256: _firstSpki,
      ...persistedFirstConnection
    } = persistedFirst;
    assert.deepEqual(persistedFirstConnection, connection);
    assert.equal(persistedFirst.loginUrl, publishedAuthority.url);
    assert.equal(persistedFirst.loginRealm, publishedAuthority.realm);
    assert.equal(typeof firstWriterEpoch, "number");
    assert.equal(statSync(configFile).mode & 0o777, 0o600, "the file carries the machine credential");

    writeFleetEdgeConfig(e.edgeUser, "lease-repo", {
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
    const persisted = readFleetEdgeConfig(e.edgeUser, "lease-repo")!;
    const {
      loginUrl: _changedLoginUrl,
      loginRealm: _changedLoginRealm,
      loginServername: _changedLoginServername,
      loginBrowserUrl: _changedLoginBrowserUrl,
      loginCertificate: _changedLoginCertificate,
      writerEpoch: _writerEpoch,
      spkiSha256: _spkiSha256,
      ...persistedConnection
    } = persisted;
    assert.deepEqual(persistedConnection, changed);
    assert.equal(persisted?.loginUrl, f.owners.url);
    assert.equal(persisted?.loginRealm, "tenant-realm");
    assert.equal(persisted?.loginBrowserUrl, undefined);
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
      current = readFleetEdgeConfig(e.edgeUser, "lease-repo")!;
    publishedAuthority = {
      url: "https://login.example",
      realm: "tenant-realm",
      clientId: "harness-node-node-one",
    };
    writeFleetEdgeConfig(e.edgeUser, "lease-repo", { ...current, loginUrl: f.owners.url });
    const { waitTimeoutMs: _wait, loginUrl: _loginUrl, ...connection } = readFleetEdgeConfig(e.edgeUser, "lease-repo")!;
    const response = await e.rpc.handle({
      jsonrpc: "2.0",
      id: 201,
      method: "daemon.fleet.edge.sync",
      params: { payload: { ...connection, workspaceRoot: e.edgeRoot, timeoutMs: 30_000 } },
    });
    assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
    assert.equal((response.result as Record<string, unknown>).ok, true, JSON.stringify(response.result));
    assert.equal(readFleetEdgeConfig(e.edgeUser, "lease-repo")?.loginUrl, publishedAuthority.url);
    assert.equal(readFleetEdgeConfig(e.edgeUser, "lease-repo")?.loginRealm, publishedAuthority.realm);
  },
);

test(
  "an unattended edge with a legacy config obtains a machine token through its resident replica stream",
  { timeout: 180_000 },
  async (t) => {
    let publishedAuthority: {
      readonly url: string;
      readonly realm: string;
      readonly clientId: string;
      readonly certificate: string;
    } | null = null;
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
    const login = await listenFleetLoginProxy(t, { root: f.root, keycloak: f.owners.keycloak });
    publishedAuthority = {
      url: login.url,
      realm: "harness",
      clientId: "harness-node-node-one",
      certificate: login.certificate,
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
      beforeOpen: (_edgeRoot, edgeUser) => {
        const config = readFleetEdgeConfig(edgeUser, "lease-repo")!;
        writeFleetEdgeConfig(edgeUser, "lease-repo", { ...config, loginUrl: "https://old-login.example" });
      },
    });
    assert.equal(
      readFleetEdgeConfig(edge.edgeUser, "lease-repo")?.loginRealm,
      undefined,
      "the persisted config predates loginRealm",
    );
    assert.equal(readFleetEdgeConfig(edge.edgeUser, "lease-repo")?.loginUrl, "https://old-login.example");
    const ready = await waitForFleetReplicaReady({ viewRoot: edge.viewRoot, repoId: "lease-repo", nodeId: "node-one" });
    assert.equal(
      ready,
      true,
      JSON.stringify(readReplicaHealth(path.join(edge.viewRoot, "repos", "lease-repo", "views", "node-one"))),
    );
    const generation = readReplicaGeneration(path.join(edge.viewRoot, "repos", "lease-repo", "views", "node-one"));
    assert.equal(generation?.metadata.readerProfile?.personId, "person-one");
    assert.ok(machineTokenExchanges > 0, "the production edge host exchanged its node secret without a human session");

    const { schema: _schema, waitTimeoutMs: _waitTimeoutMs, ...connection } = edge.config,
      sync = await edge.rpc.handle({
        jsonrpc: "2.0",
        id: 301,
        method: "daemon.fleet.edge.sync",
        params: { payload: { ...connection, workspaceRoot: edge.edgeRoot, timeoutMs: 30_000 } },
      });
    assert.ok(sync && !Array.isArray(sync) && "result" in sync, JSON.stringify(sync));
    assert.equal((sync.result as Record<string, unknown>).ok, true, JSON.stringify(sync.result));
    assert.equal(readFleetEdgeConfig(edge.edgeUser, "lease-repo")?.loginUrl, publishedAuthority.url);
    assert.equal(readFleetEdgeConfig(edge.edgeUser, "lease-repo")?.loginRealm, "harness");
    assert.equal(
      await waitForFleetReplicaReady({ viewRoot: edge.viewRoot, repoId: "lease-repo", nodeId: "node-one" }),
      true,
      "the resident stream remains ready after the legacy authority repair",
    );
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
  const { waitTimeoutMs: _wait, ...connection } = readFleetEdgeConfig(e.edgeUser, "lease-repo")!,
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
    fleetEdgeConfigPath(e.edgeUser, "lease-repo"),
    JSON.stringify({ schema: "fleet-edge-config/v1", ...connection, humanClientId: "harness-gui" }),
  );
  const synced = await sync();
  assert.equal(observedAzp[0], "harness-node-node-one");
  assert.equal(synced.ok, true, JSON.stringify(synced));
  assert.equal(synced.outcome, "applied", JSON.stringify(synced));
  const persisted = JSON.parse(readFileSync(fleetEdgeConfigPath(e.edgeUser, "lease-repo"), "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(Object.hasOwn(persisted, "humanClientId"), false);
});

test(
  "edge sync refuses an origin whose default branch history does not contain the center head",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true),
      centerOrigin = path.join(f.root, "center-origin.git"),
      centerBranch = execFileSync("git", ["-C", f.repo, "symbolic-ref", "--short", "HEAD"], {
        encoding: "utf8",
      }).trim();
    execFileSync("git", ["init", "--bare", "-q", centerOrigin]);
    execFileSync("git", ["-C", f.repo, "remote", "add", "origin", centerOrigin]);
    execFileSync("git", ["-C", f.repo, "push", "-q", "-u", "origin", centerBranch]);
    execFileSync("git", ["--git-dir", centerOrigin, "symbolic-ref", "HEAD", `refs/heads/${centerBranch}`]);
    const wrongSource = path.join(f.root, "wrong-source"),
      wrongOrigin = path.join(f.root, "wrong-origin.git");
    execFileSync("git", ["init", "-q", "-b", centerBranch, wrongSource]);
    execFileSync("git", [
      "-C",
      wrongSource,
      "-c",
      "user.name=Edge Test",
      "-c",
      "user.email=edge@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "unrelated repository",
    ]);
    execFileSync("git", ["clone", "--quiet", "--bare", wrongSource, wrongOrigin]);
    execFileSync("git", ["--git-dir", wrongOrigin, "symbolic-ref", "HEAD", `refs/heads/${centerBranch}`]);
    const e = await fleetEdgeHostFixture(t, f),
      { waitTimeoutMs: _wait, ...connection } = readFleetEdgeConfig(e.edgeUser, "lease-repo")!;
    execFileSync("git", ["-C", e.edgeRoot, "branch", "-M", centerBranch]);
    execFileSync("git", ["-C", e.edgeRoot, "remote", "add", "origin", wrongOrigin]);
    const response = await e.rpc.handle({
      jsonrpc: "2.0",
      id: 301,
      method: "daemon.fleet.edge.sync",
      params: { payload: { ...connection, workspaceRoot: e.edgeRoot, timeoutMs: 30_000 } },
    });
    assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
    assert.equal((response.result as Record<string, unknown>).code, "edge_origin_mismatch", JSON.stringify(response));
    assert.match(
      String((response.result as Record<string, unknown>).rejectionExplanation),
      new RegExp(`origin's ${centerBranch} default branch history`, "u"),
    );
  },
);

test(
  "edge repoint verifies the replacement lineage and resumes its retained suffix without basebackup",
  { timeout: 180_000 },
  async (t) => {
    let publishedAuthority: import("../src/daemon-host/fleet/command-protocol.ts").FleetLoginAuthority | null = null;
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
    const oldLoginProxy = await listenFleetLoginProxy(t, { root: f.root, keycloak: f.owners.keycloak }),
      loginProxy = await listenFleetLoginProxy(t, { root: f.root, keycloak: f.owners.keycloak });
    publishedAuthority = {
      url: oldLoginProxy.url,
      realm: "harness",
      clientId: "harness-node-node-one",
      browserUrl: "https://old-browser.example.test",
      servername: "localhost",
      certificate: oldLoginProxy.certificate,
    };
    await f.command("center-node", { kind: "task-create", taskId: "repoint-base", title: "Repoint base" });
    const e = await fleetEdgeHostFixture(t, f),
      configFile = fleetEdgeConfigPath(e.edgeUser, "lease-repo"),
      certificate = readFileSync(path.join(f.root, "tls.crt")),
      spkiSha256 = createHash("sha256")
        .update(new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" }))
        .digest("hex");
    writeFleetEdgeConfig(e.edgeUser, "lease-repo", { ...readFleetEdgeConfig(e.edgeUser, "lease-repo")!, spkiSha256 });
    const { waitTimeoutMs: _waitTimeoutMs, ...initialConfig } = readFleetEdgeConfig(e.edgeUser, "lease-repo")!;
    const syncResponse = await e.rpc.handle({
      jsonrpc: "2.0",
      id: 770,
      method: "daemon.fleet.edge.sync",
      params: { payload: { ...initialConfig, workspaceRoot: e.edgeRoot, timeoutMs: 30_000 } },
    });
    assert.ok(syncResponse && !Array.isArray(syncResponse) && "result" in syncResponse, JSON.stringify(syncResponse));
    assert.equal((syncResponse.result as Record<string, unknown>).ok, true, JSON.stringify(syncResponse.result));
    const connection = { ...readFleetEdgeConfig(e.edgeUser, "lease-repo")! };
    assert.equal(connection.loginUrl, oldLoginProxy.url);
    assert.equal(await waitForFleetReplicaReady({
      viewRoot: e.viewRoot,
      repoId: "lease-repo",
      nodeId: "node-one",
    }), true);
    const beforeGeneration = readReplicaGeneration(
        path.join(e.viewRoot, "repos", "lease-repo", "views", "node-one"),
      )!,
      priorRevision = beforeGeneration.metadata.position.revision,
      localMarker = path.join(e.edgeRoot, "harness", "operator-local.txt");
    writeFileSync(localMarker, "operator-owned state\n");
    const selection = oidcCenterSelections(e.edgeUser),
      selectionValue = {
        issuer: "https://old-center.example.test/realms/harness",
        authority: { url: "https://old-center.example.test", realm: "harness", clientId: "harness-gui" },
      };
    selection.write(e.edgeRoot, selectionValue);
    selection.read(e.edgeRoot);
    selection.write(undefined, selectionValue);
    const oldSelectionFile = path.join(e.edgeUser, "rbac", "oidc-centers", `${selection.key(e.edgeRoot)}.json`);
    const otherSelectionFile = path.join(e.edgeUser, "rbac", "oidc-centers", `${selection.key()}.json`),
      oldConfigIdentity = {
        repoId: connection.repoId,
        host: connection.host,
        port: connection.port,
        caPath: connection.caPath,
        ...(connection.servername ? { servername: connection.servername } : {}),
      },
      viewDir = path.join(e.viewRoot, "repos", "lease-repo", "views", "node-one");
    assert.equal(existsSync(oldSelectionFile), true);
    assert.equal(existsSync(otherSelectionFile), true);
    recordReplicaHealth(viewDir, { syncFailure: { code: "CENTER_MOVED", message: "The old center was retired." } });
    const movedStatus = await e.rpc.handle({
      jsonrpc: "2.0",
      id: 772,
      method: "repo.fleet.overview.read",
      params: { repo: { repoId: "lease-repo" } },
    });
    assert.ok(movedStatus && !Array.isArray(movedStatus) && "result" in movedStatus, JSON.stringify(movedStatus));
    const movedFailure = movedStatus.result as Record<string, unknown>;
    assert.equal(movedFailure.code, "CENTER_MOVED", JSON.stringify(movedFailure));
    assert.match(String(movedFailure.rejectionExplanation), /run ha daemon fleet edge repoint/u);
    recordReplicaHealth(viewDir, { syncFailure: null });
    const backupRepos: string[] = [],
      onBackup = (span: { readonly repoId: string | null }) => {
        if (span.repoId) backupRepos.push(span.repoId);
      };
    fleetBaseBackupTrace.start.subscribe(onBackup);
    t.after(() => fleetBaseBackupTrace.start.unsubscribe(onBackup));

    await f.center.close();
    await f.closeHost(f.host);
    const relocatedHost = await f.openHost();
    publishedAuthority = {
      url: loginProxy.url,
      realm: "harness",
      clientId: "harness-node-node-one",
      browserUrl: "https://relocated-browser.example.test",
      servername: "localhost",
      certificate: loginProxy.certificate,
    };
    const replacement = await f.openCenter(relocatedHost),
      repointPayload = {
        host: "127.0.0.1",
        port: replacement.port,
        caPath: path.join(f.root, "tls.crt"),
        spkiSha256,
        nodeId: "node-one",
        credential: "secret-node-one",
        repoId: "lease-repo",
        viewRoot: connection.viewRoot,
        quotaBytes: connection.quotaBytes,
        workspaceRoot: e.edgeRoot,
        servername: "localhost",
        timeoutMs: 30_000,
        repoint: true,
      };
    const repoint = async (payload: typeof repointPayload) => {
      const response = await e.rpc.handle({
        jsonrpc: "2.0",
        id: 771,
        method: "daemon.fleet.edge.sync",
        params: { payload },
      });
      assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
      return response.result as Record<string, unknown>;
    };
    const beforeRejected = readFileSync(configFile, "utf8");
    const wrongPin = await repoint({ ...repointPayload, spkiSha256: "0".repeat(64) });
    assert.equal(wrongPin.code, "pin_mismatch", JSON.stringify(wrongPin));
    assert.equal(readFileSync(configFile, "utf8"), beforeRejected);
    const fork = await fleetNodeClaimFixture(
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
    await fork.command("center-node", { kind: "task-create", taskId: "forked-base", title: "Forked base" });
    const forkCA = path.join(fork.root, "tls.crt"),
      forkPin = createHash("sha256")
        .update(new X509Certificate(readFileSync(forkCA)).publicKey.export({ type: "spki", format: "der" }))
        .digest("hex");
    loginProxy.setKeycloakFetch(fork.owners.keycloak.fetch);
    const forked = await repoint({ ...repointPayload, port: fork.center.port, caPath: forkCA, spkiSha256: forkPin });
    loginProxy.setKeycloakFetch(f.owners.keycloak.fetch);
    assert.equal(forked.code, "lineage_tip_mismatch", JSON.stringify(forked));
    assert.equal(readFileSync(configFile, "utf8"), beforeRejected);
    assert.deepEqual(
      readReplicaGeneration(path.join(e.viewRoot, "repos", "lease-repo", "views", "node-one")),
      beforeGeneration,
    );
    assert.equal(
      (
        await f.commandOn(replacement, "center-node", {
          kind: "task-create",
          taskId: "repoint-suffix",
          title: "Repoint suffix",
        })
      ).outcome,
      "applied",
    );
    const receipt = await repoint(repointPayload);
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.basebackup, false);
    assert.equal(receipt.lastAppliedRevision, priorRevision);
    assert.equal(readFleetEdgeConfig(e.edgeUser, "lease-repo")?.port, replacement.port);
    assert.equal(readFleetEdgeConfig(e.edgeUser, "lease-repo")?.writerEpoch, receipt.writerEpoch);
    assert.equal(readFleetEdgeConfig(e.edgeUser, "lease-repo")?.loginUrl, publishedAuthority.url);
    assert.equal(readFleetEdgeConfig(e.edgeUser, "lease-repo")?.loginRealm, publishedAuthority.realm);
    assert.equal(JSON.parse(readFileSync(oldSelectionFile, "utf8")), null);
    assert.equal(JSON.parse(readFileSync(otherSelectionFile, "utf8")), null);
    assert.equal(selection.read(e.edgeRoot, oldConfigIdentity), undefined);
    assert.equal(selection.read(undefined), undefined);
    const loginRequests: string[] = [],
      loginConfig = readFleetEdgeConfig(e.edgeUser, "lease-repo")!,
      identity = createIdentitySession(e.edgeUser, {
        fetch: (async (input) => {
          loginRequests.push(String(input));
          return Response.json({ issuer: `${publishedAuthority.url}/realms/${publishedAuthority.realm}` });
        }) as typeof fetch,
        loginAuthority: async () => ({
          url: loginConfig.loginUrl!,
          realm: loginConfig.loginRealm!,
          clientId: `harness-node-${loginConfig.nodeId}`,
          ...(loginConfig.loginBrowserUrl ? { browserUrl: loginConfig.loginBrowserUrl } : {}),
          ...(loginConfig.loginCertificate ? { certificate: loginConfig.loginCertificate } : {}),
          ...(loginConfig.loginServername ? { servername: loginConfig.loginServername } : {}),
        }),
      }),
      login = await identity.begin("http://127.0.0.1:43123/callback", e.edgeRoot);
    assert.equal(
      loginRequests[0],
      `${publishedAuthority.url}/realms/${publishedAuthority.realm}/.well-known/openid-configuration`,
    );
    assert.equal(new URL(String(login.authorizationUrl)).origin, publishedAuthority.browserUrl);
    assert.equal(readFleetEdgeConfig(e.edgeUser, "lease-repo")?.loginBrowserUrl, publishedAuthority.browserUrl);
    assert.equal(readFleetEdgeConfig(e.edgeUser, "lease-repo")?.loginServername, publishedAuthority.servername);
    assert.equal(readFleetEdgeConfig(e.edgeUser, "lease-repo")?.loginCertificate, publishedAuthority.certificate);
    assert.equal(readFileSync(localMarker, "utf8"), "operator-owned state\n");
    const afterGeneration = readReplicaGeneration(path.join(e.viewRoot, "repos", "lease-repo", "views", "node-one"))!;
    assert.equal(afterGeneration.id, beforeGeneration.id);
    assert.equal(afterGeneration.metadata.position.sequence, receipt.replicationSequence);
    assert.equal(readFleetEdgeConfig(e.edgeUser, "lease-repo")?.resumeOnly, undefined);
    assert.deepEqual(backupRepos, []);
  },
);

import assert from "node:assert/strict";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import {
  readManagedRbacRelocationBundle,
  writeManagedRbacRelocationBundle,
} from "@harness-anything/authorization/keycloak";
import { IDENTITY_RELOCATION_ACCESS_ADMIN_JOURNAL_SCHEMA } from "@harness-anything/kernel/internal/ports/identity-management-port.ts";
import {
  closeSqliteEventStoresUnder,
  DEFAULT_REPLICA_LOG_WINDOW_COMMITS,
  fleetBaseBackupTrace,
  openSqliteEventStore,
  writeCenterSwitchoverFence,
} from "@harness-anything/storage";
import { createIdentitySession } from "../src/daemon-host/authorization-provider.ts";
import { oidcCenterSelections } from "../src/daemon-host/oidc-center-selection.ts";
import { daemonBuildStamp } from "../src/daemon-host/build-identity.ts";
import {
  fleetEdgeConfigPath,
  readFleetEdgeConfig,
  writeFleetEdgeConfig,
} from "../src/daemon-host/client/fleet-edge-config.ts";
import { localUserDaemonEndpoint } from "../src/daemon-host/client/local-daemon-target.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { autoRepointFleetEdgeOnCenterMovedInsideFence } from "../src/daemon-host/fleet-edge-auto-repoint.ts";
import {
  listenFleetTls,
  prepareCenterSymmetricIdentity,
  relocateFleetCenter,
} from "../src/daemon-host/fleet/center.ts";
import { readFleetRepositoryMetadataClient, runFleetTaskCommandClient } from "../src/daemon-host/fleet/peer.ts";
import { waitForFleetReplicaReady, waitForFleetReplicaRevision } from "../src/daemon-host/fleet/replica-sync.ts";
import { requestFleetReplicaToken } from "../src/daemon-host/fleet/replica-token.ts";
import { createJsonRpcProtocolServer } from "../src/daemon-host/protocol/json-rpc-server.ts";
import { authenticateRuntimeExecutionPrincipal } from "../src/daemon-host/runtime-execution-credential.ts";
import { createUnixSocketTransportServer } from "../src/daemon-host/transport/unix-socket.ts";
import { readReplicaGeneration } from "../src/fleet-sync/fleet/replica-generation.ts";
import { readReplicaHealth } from "../src/fleet-sync/fleet/replica-health.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetHostWriterOptions } from "./fleet-store.fixture.ts";
import { IdentitySessionPort, serveKeycloak, signInAt } from "./keycloak.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const execFileAsync = promisify(execFile);

interface TestCertBundle {
  readonly key: Buffer;
  readonly cert: Buffer;
  /** Standard production TLS chain: leaf + intermediate CA, intentionally OMITTING the self-signed root CA. */
  readonly chainWithoutRoot: Buffer;
  readonly keyPath: string;
  readonly certPath: string;
  readonly spkiSha256: string;
}

function createSignedClusterMaterial(root: string): {
  readonly caKeyPath: string;
  readonly caCertPath: string;
  readonly caCertPem: Buffer;
  readonly intermediateCertPem: Buffer;
  readonly issueServerCert: (name: string) => TestCertBundle;
} {
  const caDir = path.join(root, "cluster-ca");
  mkdirSync(caDir, { recursive: true });
  const caKeyPath = path.join(caDir, "ca.key"),
    caCertPath = path.join(caDir, "ca.crt"),
    interKeyPath = path.join(caDir, "intermediate.key"),
    interCsrPath = path.join(caDir, "intermediate.csr"),
    interExtPath = path.join(caDir, "intermediate.ext"),
    interCertPath = path.join(caDir, "intermediate.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKeyPath,
      "-out",
      caCertPath,
      "-subj",
      "/CN=Harness Test Cluster Root CA",
      "-days",
      "1",
      "-addext",
      "basicConstraints=critical,CA:TRUE,pathlen:1",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      interKeyPath,
      "-out",
      interCsrPath,
      "-subj",
      "/CN=Harness Test Cluster Intermediate CA",
    ],
    { stdio: "ignore" },
  );
  writeFileSync(interExtPath, "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n");
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      interCsrPath,
      "-CA",
      caCertPath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-out",
      interCertPath,
      "-days",
      "1",
      "-extfile",
      interExtPath,
    ],
    { stdio: "ignore" },
  );
  const intermediateCertPem = readFileSync(interCertPath);
  const issueServerCert = (name: string): TestCertBundle => {
    const dir = path.join(root, `cert-${name}`);
    mkdirSync(dir, { recursive: true });
    const keyPath = path.join(dir, "tls.key"),
      csrPath = path.join(dir, "tls.csr"),
      extPath = path.join(dir, "tls.ext"),
      certPath = path.join(dir, "tls.crt");
    execFileSync(
      "openssl",
      ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", csrPath, "-subj", "/CN=localhost"],
      { stdio: "ignore" },
    );
    writeFileSync(
      extPath,
      "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n",
    );
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        csrPath,
        "-CA",
        interCertPath,
        "-CAkey",
        interKeyPath,
        "-CAcreateserial",
        "-out",
        certPath,
        "-days",
        "1",
        "-extfile",
        extPath,
      ],
      { stdio: "ignore" },
    );
    const cert = readFileSync(certPath),
      key = readFileSync(keyPath);
    return {
      key,
      cert,
      chainWithoutRoot: Buffer.concat([cert, intermediateCertPem]),
      keyPath,
      certPath,
      spkiSha256: computeSpkiSha256(cert),
    };
  };
  return {
    caKeyPath,
    caCertPath,
    caCertPem: readFileSync(caCertPath),
    intermediateCertPem,
    issueServerCert,
  };
}

function createSelfSignedCert(directory: string): TestCertBundle {
  mkdirSync(directory, { recursive: true });
  const keyPath = path.join(directory, "tls.key"),
    certPath = path.join(directory, "tls.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(certPath),
    key = readFileSync(keyPath);
  return { key, cert, chainWithoutRoot: cert, keyPath, certPath, spkiSha256: computeSpkiSha256(cert) };
}

function computeSpkiSha256(certPem: Buffer): string {
  return createHash("sha256")
    .update(new X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

async function listenLoginProxy(
  t: TestContext,
  input: { readonly key: Buffer; readonly cert: Buffer; readonly keycloak: { readonly fetch: typeof fetch } },
): Promise<{
  readonly url: string;
  readonly certificate: string;
  readonly requests: () => number;
  readonly close: () => Promise<void>;
}> {
  const certificate = input.cert.toString("utf8");
  let requestCount = 0;
  const server = createHttpsServer({ key: input.key, cert: input.cert }, (request, response) => {
    requestCount += 1;
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const url = new URL(request.url ?? "/", "https://localhost"),
        answer = await input.keycloak.fetch(`https://fixture-keycloak.invalid${url.pathname}${url.search}`, {
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
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let closed = false;
  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  };
  t.after(close);
  return { url: `https://localhost:${address.port}`, certificate, requests: () => requestCount, close };
}

function createLifecycleCodeWaiter(): {
  readonly recordLifecycle: Parameters<typeof openDaemonHost>[0]["recordLifecycle"];
  readonly waitForCode: (expectedCode: string, timeoutMs?: number) => Promise<void>;
  readonly events: () => readonly Record<string, unknown>[];
} {
  const seen = new Set<string>(),
    recorded: Record<string, unknown>[] = [],
    waiters = new Map<string, Set<() => void>>();
  const recordLifecycle: NonNullable<Parameters<typeof openDaemonHost>[0]["recordLifecycle"]> = (entry) => {
    recorded.push(entry as unknown as Record<string, unknown>);
    const code = "code" in entry && typeof entry.code === "string" ? entry.code : null;
    if (!code) return;
    seen.add(code);
    const pending = waiters.get(code);
    if (!pending) return;
    waiters.delete(code);
    for (const resolve of pending) resolve();
  };
  const waitForCode = (expectedCode: string, timeoutMs = 20_000): Promise<void> => {
    if (seen.has(expectedCode)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const pending = waiters.get(expectedCode) ?? new Set<() => void>();
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const onTimeout = () => {
        pending.delete(done);
        reject(
          new Error(
            `Timed out after ${String(timeoutMs)}ms waiting for lifecycle code ${expectedCode}; recorded=${JSON.stringify(recorded)}`,
          ),
        );
      };
      const done = () => {
        timeoutSignal.removeEventListener("abort", onTimeout);
        pending.delete(done);
        resolve();
      };
      timeoutSignal.addEventListener("abort", onTimeout, { once: true });
      pending.add(done);
      waiters.set(expectedCode, pending);
    });
  };
  return { recordLifecycle, waitForCode, events: () => recorded };
}

async function syncEdgeViaRpc(
  edge: Awaited<ReturnType<typeof fleetEdgeHostFixture>>,
  extraPayload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const {
    schema: _schema,
    loginUrl: _loginUrl,
    loginRealm: _loginRealm,
    loginServername: _loginServername,
    loginBrowserUrl: _loginBrowserUrl,
    loginCertificate: _loginCertificate,
    waitTimeoutMs: _waitTimeoutMs,
    ...conn
  } = edge.config;
  const response = await edge.rpc.handle({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100_000),
    method: "daemon.fleet.edge.sync",
    params: {
      payload: {
        ...conn,
        workspaceRoot: edge.edgeRoot,
        timeoutMs: 30_000,
        ...extraPayload,
      },
    },
  });
  assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
  return response.result as Record<string, unknown>;
}

function readRepoRevision(repoRoot: string, repoId: string): number {
  const store = openSqliteEventStore({ rootInput: repoRoot, repoId, readOnly: true });
  try {
    return store.revision();
  } finally {
    store.close();
  }
}

function alignSourceReplicationSlotsForSwitchover(sourceStateRoot: string, writerEpochStateRoot: string): void {
  const sourceSlots = path.join(sourceStateRoot, "replication-slots.sqlite"),
    targetSlots = path.join(writerEpochStateRoot, "replication-slots.sqlite");
  if (!existsSync(sourceSlots) || path.resolve(sourceSlots) === path.resolve(targetSlots)) return;
  mkdirSync(writerEpochStateRoot, { recursive: true });
  copyFileSync(sourceSlots, targetSlots);
}

function trackBaseBackups(t: TestContext): {
  readonly starts: () => number;
  readonly repos: () => readonly string[];
} {
  let startCount = 0;
  const repos: string[] = [];
  const onStart = () => {
    startCount += 1;
  };
  const onAsyncStart = (span: { readonly repoId: string | null }) => {
    if (span.repoId) repos.push(span.repoId);
  };
  fleetBaseBackupTrace.start.subscribe(onStart);
  fleetBaseBackupTrace.asyncStart.subscribe(onAsyncStart);
  t.after(() => {
    fleetBaseBackupTrace.start.unsubscribe(onStart);
    fleetBaseBackupTrace.asyncStart.unsubscribe(onAsyncStart);
  });
  return { starts: () => startCount, repos: () => repos };
}

export async function runSwitchoverSlice2Mode1E2e(t: TestContext): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "ha-switchover-slice2-mode1-")),
    repoId = "lease-repo",
    cluster = createSignedClusterMaterial(root),
    certB = cluster.issueServerCert("center-b"),
    rogueCert = createSelfSignedCert(path.join(root, "rogue-center"));
  let hostBAsCenter: Awaited<ReturnType<typeof openDaemonHost>> | null = null,
    centerB: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
    fencedCenterA: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
    fencedHostA: Awaited<ReturnType<typeof openDaemonHost>> | null = null;

  try {
    let stableAuthorityProvider:
      | ((nodeId: string) => {
          readonly url: string;
          readonly realm: string;
          readonly clientId: string;
          readonly servername: string;
          readonly certificate: string;
        })
      | null = null;
    const nodeA = await fleetNodeClaimFixture(
      t,
      undefined,
      undefined,
      undefined,
      (nodeId) => {
        if (!stableAuthorityProvider) throw new Error("stableAuthorityProvider not initialized");
        return stableAuthorityProvider(nodeId);
      },
      false,
      undefined,
      undefined,
      undefined,
      { replicaAdmission: true },
    );
    const stableLoginProxy = await listenLoginProxy(t, {
      key: readFileSync(path.join(nodeA.root, "tls.key")),
      cert: readFileSync(path.join(nodeA.root, "tls.crt")),
      keycloak: nodeA.owners.keycloak,
    });
    const authorityFor = (nodeId: string) => ({
      url: stableLoginProxy.url,
      realm: "harness",
      clientId: `harness-node-${nodeId}`,
      servername: "localhost",
      certificate: stableLoginProxy.certificate,
    });
    stableAuthorityProvider = authorityFor;

    for (const id of ["node-a-sym", "node-c-ca", "node-c-spki", "node-d-no-anchor", "node-e-untrusted"]) {
      nodeA.owners.reassign(id, "person-one");
    }
    prepareCenterSymmetricIdentity(nodeA.userRoot, {
      repoId,
      nodeId: "node-a-sym",
      credential: "secret-node-a-sym",
      viewRoot: path.join(root, "node-a-views"),
      quotaBytes: 64 * 1024 * 1024,
    });

    assert.equal(
      (await nodeA.command("center-node", { kind: "task-create", taskId: "s2-t1", title: "Task 1 on A" })).outcome,
      "applied",
    );
    const rev1 = readRepoRevision(nodeA.repo, repoId);

    // Candidate B (node-one) + Observer Edge C (cluster CA anchor) + Observer Edge C2 (SPKI pin anchor)
    // + Edge D (no trustAnchors) + Edge E (untrusted SPKI anchor).
    const edgeB = await fleetEdgeHostFixture(t, nodeA, {
      name: "cand-b",
      nodeId: "node-one",
      writeEdgeConfig: false,
      oidcPorts: { loginAuthority: () => Promise.resolve(authorityFor("node-one")) },
    });
    const edgeCCaLifecycle = createLifecycleCodeWaiter(),
      edgeCSpkiLifecycle = createLifecycleCodeWaiter();
    const edgeCCa = await fleetEdgeHostFixture(t, nodeA, {
      name: "edge-c-ca",
      nodeId: "node-c-ca",
      writeEdgeConfig: false,
      oidcPorts: { loginAuthority: () => Promise.resolve(authorityFor("node-c-ca")) },
      recordLifecycle: edgeCCaLifecycle.recordLifecycle,
    });
    const edgeCSpki = await fleetEdgeHostFixture(t, nodeA, {
      name: "edge-c-spki",
      nodeId: "node-c-spki",
      writeEdgeConfig: false,
      oidcPorts: { loginAuthority: () => Promise.resolve(authorityFor("node-c-spki")) },
      recordLifecycle: edgeCSpkiLifecycle.recordLifecycle,
    });
    const edgeDLifecycle = createLifecycleCodeWaiter(),
      edgeELifecycle = createLifecycleCodeWaiter();
    const edgeDNoAnchor = await fleetEdgeHostFixture(t, nodeA, {
      name: "edge-d-no-anchor",
      nodeId: "node-d-no-anchor",
      writeEdgeConfig: false,
      oidcPorts: { loginAuthority: () => Promise.resolve(authorityFor("node-d-no-anchor")) },
      recordLifecycle: edgeDLifecycle.recordLifecycle,
    });
    const edgeEUntrusted = await fleetEdgeHostFixture(t, nodeA, {
      name: "edge-e-untrusted",
      nodeId: "node-e-untrusted",
      writeEdgeConfig: false,
      oidcPorts: { loginAuthority: () => Promise.resolve(authorityFor("node-e-untrusted")) },
      recordLifecycle: edgeELifecycle.recordLifecycle,
    });

    // Sync all edges and pre-provision trustAnchors via daemon.fleet.edge.sync!
    const syncB = await syncEdgeViaRpc(edgeB);
    assert.equal(syncB.ok, true, JSON.stringify(syncB));
    const syncCCa = await syncEdgeViaRpc(edgeCCa, { trustAnchors: { caPaths: [cluster.caCertPath] } });
    assert.equal(syncCCa.ok, true, JSON.stringify(syncCCa));
    const syncCSpki = await syncEdgeViaRpc(edgeCSpki, {
      trustAnchors: { spkiSha256: [`sha256:${certB.spkiSha256}`] },
    });
    assert.equal(syncCSpki.ok, true, JSON.stringify(syncCSpki));
    const syncD = await syncEdgeViaRpc(edgeDNoAnchor);
    assert.equal(syncD.ok, true, JSON.stringify(syncD));
    const syncE = await syncEdgeViaRpc(edgeEUntrusted, { trustAnchors: { spkiSha256: [rogueCert.spkiSha256] } });
    assert.equal(syncE.ok, true, JSON.stringify(syncE));

    for (const [edge, nodeId] of [
      [edgeB, "node-one"],
      [edgeCCa, "node-c-ca"],
      [edgeCSpki, "node-c-spki"],
      [edgeDNoAnchor, "node-d-no-anchor"],
      [edgeEUntrusted, "node-e-untrusted"],
    ] as const) {
      assert.equal(
        await waitForFleetReplicaReady({ viewRoot: edge.viewRoot, repoId, nodeId }, AbortSignal.timeout(30_000)),
        true,
      );
      await waitForFleetReplicaRevision({ viewRoot: edge.viewRoot, repoId, nodeId }, rev1, AbortSignal.timeout(30_000));
    }

    // Verify pre-provisioned trustAnchors persisted properly and legacy config D has none.
    assert.deepEqual(readFleetEdgeConfig(edgeCCa.edgeUser, repoId)?.trustAnchors, {
      caPaths: [cluster.caCertPath],
    });
    assert.deepEqual(readFleetEdgeConfig(edgeCSpki.edgeUser, repoId)?.trustAnchors, {
      spkiSha256: [certB.spkiSha256],
    });
    assert.equal(readFleetEdgeConfig(edgeDNoAnchor.edgeUser, repoId)?.trustAnchors, undefined);

    // Write task 2 on A and let B catch up while C/C2/D/E also replicate.
    assert.equal(
      (await nodeA.command("center-node", { kind: "task-create", taskId: "s2-t2", title: "Task 2 on A" })).outcome,
      "applied",
    );
    const rev2 = readRepoRevision(nodeA.repo, repoId);
    for (const [edge, nodeId] of [
      [edgeB, "node-one"],
      [edgeCCa, "node-c-ca"],
      [edgeCSpki, "node-c-spki"],
      [edgeDNoAnchor, "node-d-no-anchor"],
      [edgeEUntrusted, "node-e-untrusted"],
    ] as const) {
      await waitForFleetReplicaRevision({ viewRoot: edge.viewRoot, repoId, nodeId }, rev2, AbortSignal.timeout(30_000));
    }

    // Record pre-switchover generation IDs and exact fleet-edge.json bytes for negative controls.
    const viewDirCCa = path.join(edgeCCa.viewRoot, "repos", repoId, "views", "node-c-ca"),
      viewDirCSpki = path.join(edgeCSpki.viewRoot, "repos", repoId, "views", "node-c-spki"),
      viewDirD = path.join(edgeDNoAnchor.viewRoot, "repos", repoId, "views", "node-d-no-anchor"),
      viewDirE = path.join(edgeEUntrusted.viewRoot, "repos", repoId, "views", "node-e-untrusted"),
      genIdCCaBefore = readReplicaGeneration(viewDirCCa)?.id,
      genIdCSpkiBefore = readReplicaGeneration(viewDirCSpki)?.id,
      rawConfigDBefore = readFileSync(fleetEdgeConfigPath(edgeDNoAnchor.edgeUser, repoId), "utf8"),
      rawConfigEBefore = readFileSync(fleetEdgeConfigPath(edgeEUntrusted.edgeUser, repoId), "utf8");
    assert.ok(genIdCCaBefore && genIdCSpkiBefore);

    // Copy RBAC config onto B userRoot, stop candidate B's edge host & Center A, and run Switchover A -> B!
    mkdirSync(path.join(edgeB.edgeUser, "rbac"), { recursive: true });
    if (existsSync(path.join(nodeA.userRoot, "rbac", "config.json"))) {
      writeFileSync(
        path.join(edgeB.edgeUser, "rbac", "config.json"),
        readFileSync(path.join(nodeA.userRoot, "rbac", "config.json")),
      );
    }
    const oldPortA = nodeA.center.port;
    edgeB.rpc.close();
    await edgeB.host.close();
    await nodeA.center.close();
    await nodeA.closeHost(nodeA.host);
    alignSourceReplicationSlotsForSwitchover(nodeA.stateRoot, nodeA.writerEpochStateRoot);

    // Subscribe to basebackup trace BEFORE cutover: auto-repoint MUST trigger ZERO basebackups!
    const basebackups = trackBaseBackups(t);

    let portB = 0;
    const switchAB = await relocateFleetCenter(
      [
        "fleet",
        "center",
        "switch",
        "--root",
        nodeA.repo,
        "--repo",
        repoId,
        "--to",
        "node-one",
        "--switchover-id",
        "sw_slice2_mode1",
        "--user-root",
        nodeA.userRoot,
        "--state-root",
        nodeA.writerEpochStateRoot,
        "--target-root",
        edgeB.edgeRoot,
        "--target-user-root",
        edgeB.edgeUser,
        "--target-state-root",
        path.join(edgeB.edgeUser, "fleet"),
        "--target-external-url",
        "https://127.0.0.1:9443",
        "--target-login-url",
        stableLoginProxy.url,
        "--target-spki-sha256",
        `sha256:${certB.spkiSha256}`,
        "--target-ca",
        cluster.caCertPath,
        "--target-servername",
        "localhost",
      ],
      nodeA.userRoot,
      {
        switchover: {
          probeTls: async () => ({ ok: true }),
          probeAuth: async () => ({ ok: true }),
          freezeAndDrain: async () => undefined,
          afterTargetActivated: async () => {
            nodeA.owners.bind(edgeB.edgeUser);
            hostBAsCenter = await openDaemonHost({
              daemonId: "center-b-mode1",
              userRoot: edgeB.edgeUser,
              oidc: createIdentitySession(edgeB.edgeUser, { fetch: nodeA.owners.keycloak.fetch }),
            });
            await hostBAsCenter.attachmentsSettled();
            centerB = await listenFleetTls({
              host: hostBAsCenter,
              stateRoot: path.join(edgeB.edgeUser, "fleet"),
              ...fleetHostWriterOptions(edgeB.edgeUser, [repoId]),
              key: certB.key,
              // F-26862503: Serve standard production leaf + intermediate chain OMITTING the root CA!
              cert: certB.chainWithoutRoot,
              hostname: "127.0.0.1",
              port: 0,
              replicaDiskQuotaBytes: 64 * 1024 * 1024,
              authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
              nodeOwner: nodeA.owners.nodeOwner,
              verifyHuman: nodeA.owners.verifyHuman,
              authenticateExecutionPrincipal: nodeA.owners.authenticateExecutionPrincipal,
              verifyReplica: (authCtx) =>
                createIdentitySession(edgeB.edgeUser, { fetch: nodeA.owners.keycloak.fetch }).bindReplica!(authCtx),
              loginAuthority: (nodeId) => authorityFor(nodeId),
            });
            portB = centerB.port;
          },
        },
      },
    );
    assert.equal(switchAB.exitCode, 0, JSON.stringify(switchAB.receipt));
    assert.ok(portB > 0);
    const activationAB = switchAB.receipt.activation as { readonly oldEpoch: number; readonly newEpoch: number };

    // Write task 3 on new Center B!
    assert.equal(
      (
        await hostBAsCenter!.run(
          repoId,
          { kind: "task-create", taskId: "s2-t3-on-b", title: "Task 3 on Center B" },
          auth,
        )
      ).outcome,
      "applied",
    );
    const rev3 = readRepoRevision(edgeB.edgeRoot, repoId);
    assert.ok(rev3 > rev2);

    // Update A's persisted switchover fence to advertise B's real bound ephemeral port, then reopen A's listener
    // on oldPortA so edges C/C2/D/E reconnect to old Center A and receive structured CENTER_MOVED!
    const fenceA = readFileSync(
      path.join(nodeA.userRoot, "fleet", "center-switchover-fence", `${repoId}.json`),
      "utf8",
    );
    const parsedFenceA = JSON.parse(fenceA) as Parameters<typeof writeCenterSwitchoverFence>[1];
    writeCenterSwitchoverFence(nodeA.userRoot, {
      ...parsedFenceA,
      newExternalUrl: `https://127.0.0.1:${String(portB)}`,
      newLoginUrl: stableLoginProxy.url,
      spkiSha256: `sha256:${certB.spkiSha256}`,
    });

    fencedHostA = await openDaemonHost({
      daemonId: "fenced-old-center-a",
      userRoot: nodeA.userRoot,
      oidc: createIdentitySession(nodeA.userRoot, { fetch: nodeA.owners.keycloak.fetch }),
    });
    fencedCenterA = await listenFleetTls({
      host: fencedHostA,
      stateRoot: nodeA.writerEpochStateRoot,
      relocationRoot: nodeA.userRoot,
      writerEpochStateRoot: nodeA.writerEpochStateRoot,
      centerRepoId: repoId,
      replicaDiskQuotaBytes: 64 * 1024 * 1024,
      key: readFileSync(path.join(nodeA.root, "tls.key")),
      cert: readFileSync(path.join(nodeA.root, "tls.crt")),
      hostname: "127.0.0.1",
      port: oldPortA,
      authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
      nodeOwner: nodeA.owners.nodeOwner,
      verifyHuman: nodeA.owners.verifyHuman,
    });

    // Positive Controls: Both Edge C (cluster CA anchor) and Edge C2 (SPKI pin anchor) MUST auto-repoint
    // to Center B with ZERO basebackup and replicate rev3!
    await waitForFleetReplicaRevision(
      { viewRoot: edgeCCa.viewRoot, repoId, nodeId: "node-c-ca" },
      rev3,
      AbortSignal.timeout(30_000),
    ).catch((error: unknown) => {
      throw new Error(
        `Edge C (CA) did not reach rev ${String(rev3)}: ${String(error)}; health=${JSON.stringify(readReplicaHealth(viewDirCCa))}; cfg=${JSON.stringify(readFleetEdgeConfig(edgeCCa.edgeUser, repoId))}; lifecycle=${JSON.stringify(edgeCCaLifecycle.events())}`,
      );
    });
    await waitForFleetReplicaRevision(
      { viewRoot: edgeCSpki.viewRoot, repoId, nodeId: "node-c-spki" },
      rev3,
      AbortSignal.timeout(30_000),
    ).catch((error: unknown) => {
      throw new Error(
        `Edge C2 (SPKI) did not reach rev ${String(rev3)}: ${String(error)}; health=${JSON.stringify(readReplicaHealth(viewDirCSpki))}; cfg=${JSON.stringify(readFleetEdgeConfig(edgeCSpki.edgeUser, repoId))}; lifecycle=${JSON.stringify(edgeCSpkiLifecycle.events())}`,
      );
    });

    assert.equal(basebackups.starts(), 0, "Auto-repoint MUST NOT start any basebackup!");
    assert.deepEqual(basebackups.repos(), [], "Auto-repoint MUST NOT trigger any basebackup!");
    assert.equal(readReplicaGeneration(viewDirCCa)?.id, genIdCCaBefore, "Edge C generation preserved (no basebackup)");
    assert.equal(
      readReplicaGeneration(viewDirCSpki)?.id,
      genIdCSpkiBefore,
      "Edge C2 generation preserved (no basebackup)",
    );

    const updatedCCa = readFleetEdgeConfig(edgeCCa.edgeUser, repoId),
      updatedCSpki = readFleetEdgeConfig(edgeCSpki.edgeUser, repoId);
    assert.equal(updatedCCa?.port, portB);
    assert.ok(
      (updatedCCa?.writerEpoch ?? 0) >= activationAB.newEpoch && (updatedCCa?.writerEpoch ?? 0) > activationAB.oldEpoch,
      `Expected Edge C writerEpoch >= ${String(activationAB.newEpoch)}, got ${String(updatedCCa?.writerEpoch)}`,
    );
    assert.deepEqual(updatedCCa?.trustAnchors, { caPaths: [cluster.caCertPath] });
    assert.equal(updatedCCa?.loginUrl, stableLoginProxy.url, "Independent stable loginUrl stays unchanged!");
    assert.equal(updatedCSpki?.port, portB);
    assert.equal(updatedCSpki?.writerEpoch, updatedCCa?.writerEpoch);
    assert.equal(updatedCSpki?.spkiPinOnly, true, "SPKI-only auto-repoint MUST persist spkiPinOnly=true");
    assert.deepEqual(updatedCSpki?.trustAnchors, { spkiSha256: [certB.spkiSha256] });
    assert.equal(updatedCSpki?.loginUrl, stableLoginProxy.url);

    // Verify Edge C (CA anchor) AND Edge C2 (SPKI-only over rootless leaf+intermediate chain) can both execute
    // authenticated writes against Center B using the independent stable loginUrl!
    const edgeCWrite = await edgeCCa.command({
      kind: "task-create",
      taskId: "s2-edge-c-write-on-b",
      title: "Write from Edge C after auto-repoint (stable loginUrl)",
    });
    assert.equal(edgeCWrite.outcome, "applied", JSON.stringify(edgeCWrite));
    const edgeCSpkiWrite = await edgeCSpki.command({
      kind: "task-create",
      taskId: "s2-edge-c2-spki-write-on-b",
      title: "Write from SPKI-only Edge C2 over rootless chain",
    });
    assert.equal(edgeCSpkiWrite.outcome, "applied", JSON.stringify(edgeCSpkiWrite));
    const rev4 = readRepoRevision(edgeB.edgeRoot, repoId);
    assert.ok(rev4 > rev3);
    await waitForFleetReplicaRevision(
      { viewRoot: edgeCSpki.viewRoot, repoId, nodeId: "node-c-spki" },
      rev4,
      AbortSignal.timeout(30_000),
    );

    // F-26862503 Restart verification: fully restart SPKI-only Edge C2 daemon and confirm its persisted
    // spkiPinOnly config reconnects over Center B's rootless leaf+intermediate chain and replicates new commits!
    edgeCSpki.rpc.close();
    await edgeCSpki.host.close();
    const restartedCSpki = await openDaemonHost({
      daemonId: "edge-c-spki-restarted",
      userRoot: edgeCSpki.edgeUser,
      oidc: createIdentitySession(edgeCSpki.edgeUser, { fetch: nodeA.owners.keycloak.fetch }),
    });
    t.after(() => restartedCSpki.close());
    await restartedCSpki.attachmentsSettled();
    assert.equal(
      (
        await hostBAsCenter!.run(
          repoId,
          { kind: "task-create", taskId: "s2-after-spki-restart", title: "After SPKI edge restart" },
          auth,
        )
      ).outcome,
      "applied",
    );
    const rev5 = readRepoRevision(edgeB.edgeRoot, repoId);
    assert.ok(rev5 > rev4);
    await waitForFleetReplicaRevision(
      { viewRoot: edgeCSpki.viewRoot, repoId, nodeId: "node-c-spki" },
      rev5,
      AbortSignal.timeout(30_000),
    );
    assert.equal(basebackups.starts(), 0, "Restarted SPKI-only edge MUST resume with ZERO basebackup");
    assert.equal(readReplicaGeneration(viewDirCSpki)?.id, genIdCSpkiBefore);

    // F-26862503 Negative controls: spkiPinOnly MUST still enforce SPKI pin and SAN hostname identity!
    await assert.rejects(
      readFleetRepositoryMetadataClient({
        hostname: "127.0.0.1",
        port: portB,
        ca: certB.chainWithoutRoot,
        servername: "localhost",
        spkiSha256: rogueCert.spkiSha256,
        spkiPinOnly: true,
        nodeId: "node-c-spki",
        credential: "secret-node-c-spki",
        repoId,
        actionKind: "repository-read",
        readAccessToken: nodeA.owners.readAccessToken("node-c-spki"),
      }),
      { code: "pin_mismatch" },
    );
    await assert.rejects(
      readFleetRepositoryMetadataClient({
        hostname: "127.0.0.1",
        port: portB,
        ca: certB.chainWithoutRoot,
        servername: "wrong-host.example.invalid",
        spkiSha256: certB.spkiSha256,
        spkiPinOnly: true,
        nodeId: "node-c-spki",
        credential: "secret-node-c-spki",
        repoId,
        actionKind: "repository-read",
        readAccessToken: nodeA.owners.readAccessToken("node-c-spki"),
      }),
      { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
    );

    // Negative Control 1: Edge D (no trustAnchors) MUST refuse auto-repoint and keep fleet-edge.json byte-identical!
    await edgeDLifecycle.waitForCode("center_moved_no_trust_anchors", 20_000);
    assert.equal(readReplicaHealth(viewDirD).syncFailure?.code, "center_moved_no_trust_anchors");
    assert.equal(
      readFileSync(fleetEdgeConfigPath(edgeDNoAnchor.edgeUser, repoId), "utf8"),
      rawConfigDBefore,
      "Unanchored Edge D fleet-edge.json MUST remain byte-for-byte unchanged",
    );

    // Negative Control 2: Edge E (untrusted SPKI anchor) MUST refuse auto-repoint and keep fleet-edge.json byte-identical!
    await edgeELifecycle.waitForCode("center_moved_untrusted_target", 20_000);
    assert.equal(readReplicaHealth(viewDirE).syncFailure?.code, "center_moved_untrusted_target");
    assert.equal(
      readFileSync(fleetEdgeConfigPath(edgeEUntrusted.edgeUser, repoId), "utf8"),
      rawConfigEBefore,
      "Untrusted Edge E fleet-edge.json MUST remain byte-for-byte unchanged",
    );

    // Negative Control 3: Stale/non-advancing epoch in CENTER_MOVED MUST hard-refuse and keep fleet-edge.json unchanged!
    const rawCCaBeforeStale = readFileSync(fleetEdgeConfigPath(edgeCCa.edgeUser, repoId), "utf8");
    await assert.rejects(
      autoRepointFleetEdgeOnCenterMovedInsideFence({
        userRoot: edgeCCa.edgeUser,
        workspaceRoot: edgeCCa.edgeRoot,
        repoId,
        centerMoved: {
          newExternalUrl: `https://127.0.0.1:${String(portB)}`,
          newLoginUrl: stableLoginProxy.url,
          newEpoch: updatedCCa!.writerEpoch!, // Equal (not strictly greater) than current epoch!
          spkiSha256: `sha256:${certB.spkiSha256}`,
        },
      }),
      { code: "center_moved_epoch_not_advanced" },
    );
    assert.equal(readFileSync(fleetEdgeConfigPath(edgeCCa.edgeUser, repoId), "utf8"), rawCCaBeforeStale);
  } finally {
    if (fencedCenterA) await fencedCenterA.close();
    if (fencedHostA) await fencedHostA.close();
    if (centerB) await centerB.close();
    if (hostBAsCenter) await hostBAsCenter.close();
    closeSqliteEventStoresUnder(root);
    removeTempRepository(root);
  }
}

export async function runSwitchoverSlice2Mode2E2e(t: TestContext): Promise<void> {
  assert.equal(DEFAULT_REPLICA_LOG_WINDOW_COMMITS, 1024);
  const root = mkdtempSync(path.join(tmpdir(), "ha-switchover-slice2-mode2-")),
    repoId = "lease-repo",
    cluster = createSignedClusterMaterial(root),
    certB = cluster.issueServerCert("center-b-rbac"),
    rbacBundleDir = path.join(root, "rbac-relocation-bundle"),
    cliEntry = path.resolve("packages/cli/src/index.ts");
  let hostBAsCenter: Awaited<ReturnType<typeof openDaemonHost>> | null = null,
    centerB: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
    fencedCenterA: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
    fencedHostA: Awaited<ReturnType<typeof openDaemonHost>> | null = null;

  try {
    let oldAuthorityProvider:
      | ((nodeId: string) => {
          readonly url: string;
          readonly realm: string;
          readonly clientId: string;
          readonly servername: string;
          readonly certificate: string;
        })
      | null = null;
    const nodeA = await fleetNodeClaimFixture(
      t,
      undefined,
      undefined,
      undefined,
      (nodeId) => {
        if (!oldAuthorityProvider) throw new Error("oldAuthorityProvider not initialized");
        return oldAuthorityProvider(nodeId);
      },
      false,
      undefined,
      undefined,
      undefined,
      { replicaAdmission: true },
    );
    // RBAC Mode 2 (F-26862505): Old Center A uses its own identity backend (nodeA.owners) behind oldLoginProxy;
    // New Center B will run a COMPLETELY INDEPENDENT identity backend (ownersB) initialized solely by importing
    // the exported ManagedRbacRelocationBundle!
    const oldLoginProxy = await listenLoginProxy(t, {
      key: readFileSync(path.join(nodeA.root, "tls.key")),
      cert: readFileSync(path.join(nodeA.root, "tls.crt")),
      keycloak: nodeA.owners.keycloak,
    });
    const oldAuthorityFor = (nodeId: string) => ({
      url: oldLoginProxy.url,
      realm: "harness",
      clientId: `harness-node-${nodeId}`,
      servername: "localhost",
      certificate: oldLoginProxy.certificate,
    });
    oldAuthorityProvider = oldAuthorityFor;

    for (const id of ["node-a-sym", "node-c-rbac", "node-f-stale"]) {
      nodeA.owners.reassign(id, "person-one");
    }
    // F-B3467403: Register a narrowly-scoped principal on Center A's actual authorization store:
    // granted `repository-read` + `task-create`, explicitly NOT granted `task-start`.
    nodeA.owners.keycloak.account("person-scoped");
    nodeA.owners.keycloak.permit("person-scoped", repoId, ["repository-read", "task-create"]);
    nodeA.owners.keycloak.node("node-scoped", "person-scoped");
    nodeA.owners.keycloak.interactiveSession(
      "person-scoped",
      "node-scoped",
      nodeA.owners.url,
      "device-token-node-scoped",
    );
    prepareCenterSymmetricIdentity(nodeA.userRoot, {
      repoId,
      nodeId: "node-a-sym",
      credential: "secret-node-a-sym",
      viewRoot: path.join(root, "node-a-views"),
      quotaBytes: 64 * 1024 * 1024,
    });

    assert.equal(
      (await nodeA.command("center-node", { kind: "task-create", taskId: "m2-t1", title: "Task 1" })).outcome,
      "applied",
    );
    // Verify the scoped principal's real allowed & denied policy decisions on Center A BEFORE export/switchover!
    const runCommandOnCenterA = (taskId: string, action: Record<string, unknown>, nodeId: string) =>
      runFleetTaskCommandClient({
        hostname: "127.0.0.1",
        port: nodeA.center.port,
        ca: readFileSync(path.join(nodeA.root, "tls.crt")),
        servername: "localhost",
        nodeId,
        credential: `secret-${nodeId}`,
        readAccessToken: async () => `device-token-${nodeId}`,
        opId: randomUUID(),
        repoId,
        taskId,
        action: action as never,
        waitMs: 10_000,
      });
    const scopedAllowedOnA = await runCommandOnCenterA(
      "m2-scoped-a",
      { kind: "task-create", taskId: "m2-scoped-a", title: "Scoped principal allowed on A" },
      "node-scoped",
    );
    assert.equal(scopedAllowedOnA.outcome, "applied", JSON.stringify(scopedAllowedOnA));
    const revBeforeScopedDeniedOnA = readRepoRevision(nodeA.repo, repoId);
    const scopedDeniedOnA = await runCommandOnCenterA(
      "m2-scoped-a",
      { kind: "task-start", taskId: "m2-scoped-a", executionId: "exe-scoped-denied-a" },
      "node-scoped",
    );
    assert.equal(scopedDeniedOnA.outcome, "op_rejected", JSON.stringify(scopedDeniedOnA));
    assert.equal(scopedDeniedOnA.code, "authorization_denied", JSON.stringify(scopedDeniedOnA));
    assert.equal(readRepoRevision(nodeA.repo, repoId), revBeforeScopedDeniedOnA);
    const rev1 = readRepoRevision(nodeA.repo, repoId);

    // Candidate B + Online Edge C (will follow RBAC relocation) + Edge F (will go offline & fall beyond default 1024 window).
    const edgeB = await fleetEdgeHostFixture(t, nodeA, {
      name: "cand-b-m2",
      nodeId: "node-one",
      writeEdgeConfig: false,
      oidcPorts: { loginAuthority: () => Promise.resolve(oldAuthorityFor("node-one")) },
    });
    const edgeCRbac = await fleetEdgeHostFixture(t, nodeA, {
      name: "edge-c-rbac",
      nodeId: "node-c-rbac",
      writeEdgeConfig: false,
      oidcPorts: { loginAuthority: () => Promise.resolve(oldAuthorityFor("node-c-rbac")) },
    });
    const edgeFStale = await fleetEdgeHostFixture(t, nodeA, {
      name: "edge-f-stale",
      nodeId: "node-f-stale",
      writeEdgeConfig: false,
      oidcPorts: { loginAuthority: () => Promise.resolve(oldAuthorityFor("node-f-stale")) },
    });

    const syncBM2 = await syncEdgeViaRpc(edgeB);
    assert.equal(syncBM2.ok, true, JSON.stringify(syncBM2));
    const syncCM2 = await syncEdgeViaRpc(edgeCRbac, { trustAnchors: { caPaths: [cluster.caCertPath] } });
    assert.equal(syncCM2.ok, true, JSON.stringify(syncCM2));
    const syncFM2 = await syncEdgeViaRpc(edgeFStale, { trustAnchors: { caPaths: [cluster.caCertPath] } });
    assert.equal(syncFM2.ok, true, JSON.stringify(syncFM2));
    assert.equal(readFleetEdgeConfig(edgeCRbac.edgeUser, repoId)?.loginUrl, oldLoginProxy.url);
    assert.equal(readFleetEdgeConfig(edgeFStale.edgeUser, repoId)?.loginUrl, oldLoginProxy.url);

    for (const [edge, nodeId] of [
      [edgeB, "node-one"],
      [edgeCRbac, "node-c-rbac"],
      [edgeFStale, "node-f-stale"],
    ] as const) {
      assert.equal(
        await waitForFleetReplicaReady({ viewRoot: edge.viewRoot, repoId, nodeId }, AbortSignal.timeout(30_000)),
        true,
      );
      await waitForFleetReplicaRevision({ viewRoot: edge.viewRoot, repoId, nodeId }, rev1, AbortSignal.timeout(30_000));
    }

    const viewDirB = path.join(edgeB.viewRoot, "repos", repoId, "views", "node-one"),
      viewDirF = path.join(edgeFStale.viewRoot, "repos", repoId, "views", "node-f-stale"),
      seqEdgeFOffline = readReplicaGeneration(viewDirF)?.metadata.position.sequence ?? 0;
    assert.ok(seqEdgeFOffline > 0);

    // Take Edge F offline BEFORE advancing > DEFAULT_REPLICA_LOG_WINDOW_COMMITS (1024) commits!
    await edgeFStale.host.close();

    // F-26862506: Advance Center A by >1024 real replication_log commits (1030 eventless commits + 1 task write)
    // so Candidate B's real production default window (DEFAULT_REPLICA_LOG_WINDOW_COMMITS = 1024) prunes Edge F's position!
    const overflowCommits = DEFAULT_REPLICA_LOG_WINDOW_COMMITS + 6;
    const centerAStore = openSqliteEventStore({ rootInput: nodeA.repo, repoId });
    try {
      const activeFence = centerAStore.writerFence();
      assert.ok(activeFence, "Center A canonical store must hold an active writer fence");
      for (let i = 1; i <= overflowCommits; i += 1) {
        const opId = `op_window_overflow_${String(i)}`,
          intentDigest = `sha256:${createHash("sha256").update(opId).digest("hex")}` as const;
        centerAStore.appendCommand({
          fence: activeFence,
          intent: { opId, intentDigest, summary: `window-overflow-${String(i)}` },
          events: [],
          rejectionCode: "window_overflow_marker",
        });
      }
    } finally {
      centerAStore.close();
    }
    assert.equal(
      (await nodeA.command("center-node", { kind: "task-create", taskId: "m2-t2-post-1024", title: "Post-1024 Task" }))
        .outcome,
      "applied",
    );
    const revAfterOverflow = readRepoRevision(nodeA.repo, repoId);
    await waitForFleetReplicaRevision(
      { viewRoot: edgeB.viewRoot, repoId, nodeId: "node-one" },
      revAfterOverflow,
      AbortSignal.timeout(45_000),
    );
    await waitForFleetReplicaRevision(
      { viewRoot: edgeCRbac.viewRoot, repoId, nodeId: "node-c-rbac" },
      revAfterOverflow,
      AbortSignal.timeout(45_000),
    );
    const seqCandidateB = readReplicaGeneration(viewDirB)?.metadata.position.sequence ?? 0;
    assert.ok(
      seqCandidateB - seqEdgeFOffline > DEFAULT_REPLICA_LOG_WINDOW_COMMITS,
      `Expected Edge F lag > ${String(DEFAULT_REPLICA_LOG_WINDOW_COMMITS)}, got ${String(seqCandidateB - seqEdgeFOffline)}`,
    );

    // F-26862505 & F-B3467403: Export A's ACTUAL accounts, node credentials, and authorization policies directly
    // from nodeA.owners.keycloak (zero hardcoded action lists or B-only accounts) into ManagedRbacRelocationBundle,
    // and initialize a completely independent empty identity backend (ownersB) strictly from that bundle!
    const exportedNodes = [...nodeA.owners.keycloak.nodeClients.values()].map((client) => {
      const device = JSON.parse(client.attributes.harness_device) as {
        readonly nodeId: string;
        readonly personId: string;
        readonly state: string;
        readonly revocation: string;
      };
      return {
        nodeId: device.nodeId,
        personId: device.personId,
        secret: client.secret,
        state: device.state,
        revocation: device.revocation,
      };
    });
    const exportedAccounts = [
      ...new Set(
        [...nodeA.owners.keycloak.users.values()]
          .map((user) => user.attributes.harness_person_id?.[0])
          .filter((personId): personId is string => typeof personId === "string" && personId.length > 0),
      ),
    ];
    const exportedGrants: Array<{
      readonly personId: string;
      readonly repoId: string;
      readonly actions: readonly string[];
    }> = [];
    for (const permission of nodeA.owners.keycloak.permissions.values()) {
      const resourceNames = permission.resources
        .map((resourceId) => nodeA.owners.keycloak.resources.get(resourceId)?.name)
        .filter((name): name is string => typeof name === "string");
      const personIds = permission.policies
        .flatMap((policyId) => nodeA.owners.keycloak.userPolicies.get(policyId)?.users ?? [])
        .map((userId) => nodeA.owners.keycloak.users.get(userId)?.attributes.harness_person_id?.[0])
        .filter((personId): personId is string => typeof personId === "string");
      for (const personId of personIds) {
        for (const resourceName of resourceNames) {
          exportedGrants.push({ personId, repoId: resourceName, actions: [...permission.scopes] });
        }
      }
    }
    assert.ok(exportedGrants.length > 0, "Center A authorization store must export non-empty live policies");
    writeManagedRbacRelocationBundle(rbacBundleDir, {
      realm: "harness",
      realmJson: JSON.stringify({
        realm: "harness",
        accounts: exportedAccounts,
        nodes: exportedNodes,
        grants: exportedGrants,
      }),
      centerClientSecret: "slice2-relocated-center-secret",
      edgeJoinJournal: {
        schema: IDENTITY_RELOCATION_ACCESS_ADMIN_JOURNAL_SCHEMA,
        entries: exportedNodes.map((entry) => JSON.stringify({ nodeId: entry.nodeId, personId: entry.personId })),
      },
    });

    // Independent identity backend for Center B (zero shared state with nodeA.owners!).
    const ownersB = await serveKeycloak();
    t.after(() => ownersB.close());
    assert.equal(ownersB.keycloak.nodeClients.size, 0, "Fresh B identity backend MUST start empty before import");
    assert.equal(ownersB.keycloak.permissions.size, 0, "Fresh B identity backend MUST start with zero policies");

    const relocatedRbacBundle = readManagedRbacRelocationBundle(rbacBundleDir);
    assert.equal(relocatedRbacBundle.realm, "harness");
    assert.equal(relocatedRbacBundle.centerClientSecret, "slice2-relocated-center-secret");
    const importedRealm = JSON.parse(relocatedRbacBundle.realmJson) as {
      readonly accounts: readonly string[];
      readonly nodes: readonly {
        readonly nodeId: string;
        readonly personId: string;
        readonly secret: string;
      }[];
      readonly grants: readonly {
        readonly personId: string;
        readonly repoId: string;
        readonly actions: readonly string[];
      }[];
    };
    for (const personId of importedRealm.accounts) ownersB.keycloak.account(personId);
    for (const grant of importedRealm.grants) ownersB.keycloak.permit(grant.personId, grant.repoId, grant.actions);
    for (const node of importedRealm.nodes) {
      ownersB.keycloak.node(node.nodeId, node.personId);
      const client = ownersB.keycloak.nodeClients.get(`harness-node-${node.nodeId}`);
      assert.ok(client);
      client.secret = node.secret;
      ownersB.keycloak.interactiveSession(node.personId, node.nodeId, ownersB.url, `b-device-token-${node.nodeId}`);
    }

    const newLoginProxy = await listenLoginProxy(t, {
      key: certB.key,
      cert: certB.chainWithoutRoot,
      keycloak: ownersB.keycloak,
    });
    const newAuthorityFor = (nodeId: string) => ({
      url: newLoginProxy.url,
      realm: "harness",
      clientId: `harness-node-${nodeId}`,
      servername: "localhost",
      browserUrl: newLoginProxy.url,
      certificate: cluster.caCertPem.toString("utf8"),
    });
    const ownerOfOnB = (nodeId: string): string | null => {
      const client = ownersB.keycloak.nodeClients.get(`harness-node-${nodeId}`);
      if (!client) return null;
      const device = JSON.parse(client.attributes.harness_device) as {
        readonly state: string;
        readonly revocation: string;
        readonly personId: string;
      };
      return device.state === "active" && device.revocation === "complete" ? device.personId : null;
    };
    const authenticateOnB = (nodeId: string, credential: string): boolean => {
      const client = ownersB.keycloak.nodeClients.get(`harness-node-${nodeId}`);
      return client !== undefined && client.enabled !== false && client.secret === credential;
    };

    // Switchover A -> B with managed RBAC rebinding to independent ownersB + newLoginProxy!
    const oldPortA = nodeA.center.port;
    edgeB.rpc.close();
    await edgeB.host.close();
    await nodeA.center.close();
    await nodeA.closeHost(nodeA.host);
    // Shut down oldLoginProxy BEFORE cutover finishes so Edge C CANNOT authenticate via A's login proxy!
    await oldLoginProxy.close();
    alignSourceReplicationSlotsForSwitchover(nodeA.stateRoot, nodeA.writerEpochStateRoot);

    const basebackups = trackBaseBackups(t);

    let portB = 0;
    const switchAB = await relocateFleetCenter(
      [
        "fleet",
        "center",
        "switch",
        "--root",
        nodeA.repo,
        "--repo",
        repoId,
        "--to",
        "node-one",
        "--switchover-id",
        "sw_slice2_mode2",
        "--user-root",
        nodeA.userRoot,
        "--state-root",
        nodeA.writerEpochStateRoot,
        "--target-root",
        edgeB.edgeRoot,
        "--target-user-root",
        edgeB.edgeUser,
        "--target-state-root",
        path.join(edgeB.edgeUser, "fleet"),
        "--target-external-url",
        "https://127.0.0.1:9443",
        "--target-login-url",
        newLoginProxy.url,
        "--target-spki-sha256",
        `sha256:${certB.spkiSha256}`,
        "--target-ca",
        cluster.caCertPath,
        "--target-servername",
        "localhost",
      ],
      nodeA.userRoot,
      {
        switchover: {
          probeTls: async () => ({ ok: true }),
          probeAuth: async () => ({ ok: true }),
          freezeAndDrain: async () => undefined,
          afterTargetActivated: async () => {
            oidcCenterSelections(edgeB.edgeUser).clearAll();
            ownersB.bind(edgeB.edgeUser);
            signInAt(edgeB.edgeUser, "lease-owner");
            hostBAsCenter = await openDaemonHost({
              daemonId: "center-b-mode2",
              userRoot: edgeB.edgeUser,
              oidc: createIdentitySession(edgeB.edgeUser, { fetch: ownersB.keycloak.fetch }),
            });
            await hostBAsCenter.attachmentsSettled();
            centerB = await listenFleetTls({
              host: hostBAsCenter,
              stateRoot: path.join(edgeB.edgeUser, "fleet"),
              ...fleetHostWriterOptions(edgeB.edgeUser, [repoId]),
              key: certB.key,
              cert: certB.chainWithoutRoot,
              hostname: "127.0.0.1",
              port: 0,
              // F-26862506: NO small-window override! Uses real promoted DEFAULT_REPLICA_LOG_WINDOW_COMMITS = 1024!
              replicaDiskQuotaBytes: 64 * 1024 * 1024,
              authenticate: authenticateOnB,
              nodeOwner: ownerOfOnB,
              verifyHuman: (authCtx) => IdentitySessionPort(edgeB.edgeUser).bind(authCtx),
              authenticateExecutionPrincipal: (credential) =>
                authenticateRuntimeExecutionPrincipal(() => IdentitySessionPort(edgeB.edgeUser).center(), credential),
              verifyReplica: (authCtx) =>
                createIdentitySession(edgeB.edgeUser, { fetch: ownersB.keycloak.fetch }).bindReplica!(authCtx),
              loginAuthority: (nodeId) => newAuthorityFor(nodeId),
            });
            portB = centerB.port;
          },
        },
      },
    );
    assert.equal(switchAB.exitCode, 0, JSON.stringify(switchAB.receipt));
    assert.ok(portB > 0);

    // Write a new task on Center B (lag=1 for online Edge C <= 1024, lag > 1024 for offline Edge F!).
    const t6 = await hostBAsCenter!.run(repoId, { kind: "task-create", taskId: "m2-t6", title: "Task 6 on B" }, auth);
    assert.equal(t6.outcome, "applied", JSON.stringify(t6));
    const rev6 = readRepoRevision(edgeB.edgeRoot, repoId);

    // Update A's fence to advertise B's bound port + newLoginProxy.url and reopen old Center A listener
    // (using static credential check so nodeA.owners can be stopped cleanly!).
    const fenceA = JSON.parse(
      readFileSync(path.join(nodeA.userRoot, "fleet", "center-switchover-fence", `${repoId}.json`), "utf8"),
    ) as Parameters<typeof writeCenterSwitchoverFence>[1];
    writeCenterSwitchoverFence(nodeA.userRoot, {
      ...fenceA,
      newExternalUrl: `https://127.0.0.1:${String(portB)}`,
      newLoginUrl: newLoginProxy.url,
      spkiSha256: `sha256:${certB.spkiSha256}`,
    });
    fencedHostA = await openDaemonHost({
      daemonId: "fenced-old-center-a-m2",
      userRoot: nodeA.userRoot,
      oidc: createIdentitySession(nodeA.userRoot, { fetch: ownersB.keycloak.fetch }),
    });
    fencedCenterA = await listenFleetTls({
      host: fencedHostA,
      stateRoot: nodeA.writerEpochStateRoot,
      relocationRoot: nodeA.userRoot,
      writerEpochStateRoot: nodeA.writerEpochStateRoot,
      centerRepoId: repoId,
      replicaDiskQuotaBytes: 64 * 1024 * 1024,
      key: readFileSync(path.join(nodeA.root, "tls.key")),
      cert: readFileSync(path.join(nodeA.root, "tls.crt")),
      hostname: "127.0.0.1",
      port: oldPortA,
      authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
      nodeOwner: () => "person-one",
      verifyHuman: (authCtx) => IdentitySessionPort(edgeB.edgeUser).bind(authCtx),
    });

    // Completely shut down A's identity backend NOW — before Edge C even finishes auto-repointing!
    await nodeA.owners.close();

    // RBAC Mode 2 Verification: Edge C auto-repoints to B with ZERO basebackup, authenticates strictly against
    // independent ownersB via newLoginProxy (since A's login proxy & identity backend are both stopped!),
    // and refreshes loginUrl/loginCertificate!
    await waitForFleetReplicaRevision(
      { viewRoot: edgeCRbac.viewRoot, repoId, nodeId: "node-c-rbac" },
      rev6,
      AbortSignal.timeout(30_000),
    ).catch((error: unknown) => {
      throw new Error(
        `Mode 2 Edge C did not reach rev ${String(rev6)}: ${String(error)}; health=${JSON.stringify(readReplicaHealth(path.join(edgeCRbac.viewRoot, "repos", repoId, "views", "node-c-rbac")))}; cfg=${JSON.stringify(readFleetEdgeConfig(edgeCRbac.edgeUser, repoId))}; proxyRequests=${String(newLoginProxy.requests())}`,
      );
    });
    assert.equal(basebackups.starts(), 0, "Online Edge C auto-repoint MUST use zero basebackup");
    assert.deepEqual(basebackups.repos(), [], "Online Edge C auto-repoint MUST use zero basebackup");
    const refreshedEdgeC = readFleetEdgeConfig(edgeCRbac.edgeUser, repoId);
    assert.equal(refreshedEdgeC?.port, portB);
    assert.equal(refreshedEdgeC?.loginUrl, newLoginProxy.url, "Edge C MUST refresh loginUrl to relocated RBAC");
    assert.equal(
      refreshedEdgeC?.loginCertificate,
      cluster.caCertPem.toString("utf8"),
      "Edge C MUST refresh loginCertificate to relocated RBAC CA cert",
    );
    assert.ok(
      newLoginProxy.requests() > 0,
      "Auto-repoint MUST authenticate against independent B identity backend via newLoginProxy over HTTPS",
    );

    // Now bring stale offline Edge F (>1024 commits behind!) back online so it receives CENTER_MOVED from A
    // and proves auto-repoint refuses silent basebackup under the real DEFAULT 1024-commit window!
    const rawConfigFBefore = readFileSync(fleetEdgeConfigPath(edgeFStale.edgeUser, repoId), "utf8"),
      genIdFBefore = readReplicaGeneration(viewDirF)?.id;
    assert.ok(genIdFBefore);

    const edgeFLifecycle = createLifecycleCodeWaiter();
    const restartedHostF = await openDaemonHost({
      daemonId: "edge-f-restarted",
      userRoot: edgeFStale.edgeUser,
      oidc: createIdentitySession(edgeFStale.edgeUser, { fetch: ownersB.keycloak.fetch }),
      recordLifecycle: edgeFLifecycle.recordLifecycle,
    });
    t.after(() => restartedHostF.close());
    await restartedHostF.attachmentsSettled();

    // Negative Control A: Auto-repoint on CENTER_MOVED MUST refuse silent basebackup (>1024 default window)
    // and preserve fleet-edge.json byte-for-byte!
    await edgeFLifecycle.waitForCode("replication_resume_unavailable", 20_000);
    assert.equal(readReplicaHealth(viewDirF).syncFailure?.code, "replication_resume_unavailable");
    assert.equal(
      readFileSync(fleetEdgeConfigPath(edgeFStale.edgeUser, repoId), "utf8"),
      rawConfigFBefore,
      "Stale Edge F auto-repoint refusal MUST leave fleet-edge.json untouched",
    );
    assert.equal(basebackups.starts(), 0, "Auto-repoint MUST NEVER trigger silent basebackup");
    assert.deepEqual(basebackups.repos(), [], "Auto-repoint MUST NEVER trigger silent basebackup");

    // Shut down old Center A listener & host completely: Center A + oldLoginProxy + nodeA.owners are ALL dead!
    await fencedCenterA.close();
    fencedCenterA = null;
    await fencedHostA.close();
    fencedHostA = null;

    // F-26862505 Post-shutdown B Identity Verification (A and A's backend are 100% stopped!):
    // 1) Re-issue fresh machine replica token from independent ownersB over HTTPS newLoginProxy (and reject bad secret).
    const freshMachineToken = await requestFleetReplicaToken({
      url: newLoginProxy.url,
      realm: "harness",
      clientId: "harness-node-node-c-rbac",
      servername: "localhost",
      nodeId: "node-c-rbac",
      credential: "secret-node-c-rbac",
      ca: cluster.caCertPem.toString("utf8"),
    });
    assert.equal(freshMachineToken, "node-token-harness-node-node-c-rbac");
    await assert.rejects(
      requestFleetReplicaToken({
        url: newLoginProxy.url,
        realm: "harness",
        clientId: "harness-node-node-c-rbac",
        servername: "localhost",
        nodeId: "node-c-rbac",
        credential: "wrong-secret",
        ca: cluster.caCertPem.toString("utf8"),
      }),
    );

    // 2) F-B3467403: Verify the EXACT SAME migrated scoped principal (`person-scoped` / `node-scoped`) on Center B
    // after A, oldLoginProxy, and nodeA.owners are ALL stopped: allowed action succeeds & replicates, restricted action is denied!
    const runCommandOnCenterB = (taskId: string, action: Record<string, unknown>, nodeId = "center-node") =>
      runFleetTaskCommandClient({
        hostname: "127.0.0.1",
        port: portB,
        ca: cluster.caCertPem,
        servername: "localhost",
        nodeId,
        credential: `secret-${nodeId}`,
        readAccessToken: async () => `b-device-token-${nodeId}`,
        opId: randomUUID(),
        repoId,
        taskId,
        action: action as never,
        waitMs: 10_000,
      });
    const scopedAllowedOnB = await runCommandOnCenterB(
      "m2-scoped-b",
      { kind: "task-create", taskId: "m2-scoped-b", title: "Scoped principal allowed on B after RBAC migration" },
      "node-scoped",
    );
    assert.equal(scopedAllowedOnB.outcome, "applied", JSON.stringify(scopedAllowedOnB));
    const rev7 = readRepoRevision(edgeB.edgeRoot, repoId);
    await waitForFleetReplicaRevision(
      { viewRoot: edgeCRbac.viewRoot, repoId, nodeId: "node-c-rbac" },
      rev7,
      AbortSignal.timeout(30_000),
    );

    // 3) Restricted action (`task-start`) for the EXACT SAME migrated scoped principal MUST remain denied on Center B!
    const scopedDeniedOnB = await runCommandOnCenterB(
      "m2-scoped-b",
      { kind: "task-start", taskId: "m2-scoped-b", executionId: "exe-scoped-denied-b" },
      "node-scoped",
    );
    assert.equal(scopedDeniedOnB.outcome, "op_rejected", JSON.stringify(scopedDeniedOnB));
    assert.equal(scopedDeniedOnB.code, "authorization_denied", JSON.stringify(scopedDeniedOnB));
    assert.equal(readRepoRevision(edgeB.edgeRoot, repoId), rev7, "Denied action MUST NOT advance Center B revision");

    // F-26862506 & F-B3467402: Expose restartedHostF on its real local Unix socket and invoke REAL CLI
    // `ha daemon fleet edge repoint` (without and with `--allow-basebackup`, including legacy `resumeOnly: true` state)!
    oidcCenterSelections(edgeFStale.edgeUser).clearAll();
    ownersB.bind(edgeFStale.edgeUser);
    signInAt(edgeFStale.edgeUser, "person-one", [], "b-device-token-node-f-stale");
    const startEdgeFCliSocket = async (hostInstance: Awaited<ReturnType<typeof openDaemonHost>>) => {
      const server = createUnixSocketTransportServer({
        daemonId: "edge-f-restarted",
        socketPath: localUserDaemonEndpoint(edgeFStale.edgeUser, "edge-f-restarted"),
        createProtocolServer: (authContext, emit) =>
          createJsonRpcProtocolServer({
            host: hostInstance,
            build: daemonBuildStamp(),
            authContext,
            sessionPrincipal: (method, params) => hostInstance.sessionPrincipal(authContext, method, params),
            emit,
          }),
      });
      await server.start();
      return server;
    };
    let activeHostF: Awaited<ReturnType<typeof openDaemonHost>> | null = restartedHostF,
      activeSocketF: Awaited<ReturnType<typeof startEdgeFCliSocket>> | null = await startEdgeFCliSocket(restartedHostF);
    t.after(async () => {
      if (activeSocketF) await activeSocketF.stop();
      if (activeHostF && activeHostF !== restartedHostF) await activeHostF.close();
    });

    const runRepointCli = async (extraArgs: readonly string[]) => {
      const cliArgs = [
        cliEntry,
        "daemon",
        "fleet",
        "edge",
        "repoint",
        "--user-root",
        edgeFStale.edgeUser,
        "--daemon-id",
        "edge-f-restarted",
        "--root",
        edgeFStale.edgeRoot,
        "--host",
        "127.0.0.1",
        "--port",
        String(portB),
        "--ca",
        cluster.caCertPath,
        "--servername",
        "localhost",
        "--spki-sha256",
        certB.spkiSha256,
        "--timeout-ms",
        "45000",
        "--json",
        ...extraArgs,
      ];
      const cliEnv: NodeJS.ProcessEnv = { ...process.env };
      delete cliEnv.HARNESS_EXECUTION_CREDENTIAL;
      try {
        const { stdout, stderr } = await execFileAsync(process.execPath, cliArgs, {
          env: cliEnv,
          timeout: 60_000,
        });
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        const failed = error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string };
        return {
          exitCode: typeof failed.code === "number" ? failed.code : 1,
          stdout: failed.stdout ?? "",
          stderr: failed.stderr ?? "",
        };
      }
    };

    // Negative Control B (REAL CLI): `ha daemon fleet edge repoint` WITHOUT --allow-basebackup MUST refuse!
    const cliRefused = await runRepointCli([]);
    assert.notEqual(cliRefused.exitCode, 0, `Expected non-zero CLI exit: ${cliRefused.stdout} ${cliRefused.stderr}`);
    assert.match(
      `${cliRefused.stdout}\n${cliRefused.stderr}`,
      /replication_resume_unavailable/u,
      `${cliRefused.stdout}\n${cliRefused.stderr}`,
    );
    assert.match(
      `${cliRefused.stdout}\n${cliRefused.stderr}`,
      /--allow-basebackup/u,
      `${cliRefused.stdout}\n${cliRefused.stderr}`,
    );
    assert.equal(readFileSync(fleetEdgeConfigPath(edgeFStale.edgeUser, repoId), "utf8"), rawConfigFBefore);
    assert.equal(basebackups.starts(), 0, "Default CLI repoint MUST NOT trigger basebackup");
    assert.deepEqual(basebackups.repos(), [], "Default CLI repoint MUST NOT trigger basebackup");

    // F-B3467402: Simulate a legacy pre-upgrade interrupted repoint leaving `resumeOnly: true` for target B on disk,
    // restart Edge F's daemon host, and prove REAL CLI `ha daemon fleet edge repoint --allow-basebackup` does NOT
    // fall back to legacy `resumeOnly: true` and completes basebackup rebuild cleanly!
    await activeSocketF.stop();
    activeSocketF = null;
    await restartedHostF.close();
    activeHostF = null;
    const legacyConfigF = readFleetEdgeConfig(edgeFStale.edgeUser, repoId)!;
    writeFleetEdgeConfig(edgeFStale.edgeUser, repoId, {
      ...legacyConfigF,
      host: "127.0.0.1",
      port: portB,
      caPath: cluster.caCertPath,
      servername: "localhost",
      spkiSha256: certB.spkiSha256,
      writerEpoch: refreshedEdgeC!.writerEpoch,
      resumeOnly: true,
    });
    const rawLegacyConfigF = readFileSync(fleetEdgeConfigPath(edgeFStale.edgeUser, repoId), "utf8");
    activeHostF = await openDaemonHost({
      daemonId: "edge-f-restarted",
      userRoot: edgeFStale.edgeUser,
      oidc: createIdentitySession(edgeFStale.edgeUser, { fetch: ownersB.keycloak.fetch }),
    });
    await activeHostF.attachmentsSettled();
    activeSocketF = await startEdgeFCliSocket(activeHostF);

    // Even from legacy resumeOnly:true config, CLI without --allow-basebackup MUST still refuse silent basebackup!
    const legacyCliRefused = await runRepointCli([]);
    assert.notEqual(legacyCliRefused.exitCode, 0, `${legacyCliRefused.stdout} ${legacyCliRefused.stderr}`);
    assert.match(`${legacyCliRefused.stdout}\n${legacyCliRefused.stderr}`, /replication_resume_unavailable/u);
    assert.equal(readFileSync(fleetEdgeConfigPath(edgeFStale.edgeUser, repoId), "utf8"), rawLegacyConfigF);
    assert.equal(
      basebackups.starts(),
      0,
      "Legacy resumeOnly config without --allow-basebackup MUST NOT trigger basebackup",
    );

    // Positive Control (REAL CLI from legacy resumeOnly:true): `--allow-basebackup` MUST override legacy resumeOnly & rebuild!
    const cliRebuilt = await runRepointCli(["--allow-basebackup"]);
    assert.equal(cliRebuilt.exitCode, 0, `${cliRebuilt.stdout}\n${cliRebuilt.stderr}`);
    const cliReceipt = JSON.parse(cliRebuilt.stdout.trim()) as {
      readonly ok?: boolean;
      readonly basebackup?: boolean;
    };
    assert.equal(cliReceipt.ok, true, cliRebuilt.stdout);
    assert.equal(cliReceipt.basebackup, true, cliRebuilt.stdout);
    assert.ok(basebackups.starts() > 0, "Explicit CLI --allow-basebackup MUST start basebackup rebuild");
    assert.ok(basebackups.repos().includes(repoId), "Explicit CLI --allow-basebackup MUST trigger basebackup rebuild");
    assert.notEqual(
      readReplicaGeneration(viewDirF)?.id,
      genIdFBefore,
      "Stale edge installed new basebackup generation via CLI",
    );
    assert.equal(readReplicaGeneration(viewDirF)?.metadata.position.revision, rev7);
    const rebuiltConfigF = readFleetEdgeConfig(edgeFStale.edgeUser, repoId);
    assert.equal(rebuiltConfigF?.port, portB);
    assert.equal(rebuiltConfigF?.resumeOnly, undefined, "CLI --allow-basebackup rebuild MUST clear legacy resumeOnly");
    assert.equal(rebuiltConfigF?.loginUrl, newLoginProxy.url);
    assert.deepEqual(rebuiltConfigF?.trustAnchors, {
      caPaths: [cluster.caCertPath],
    });

    // Subsequent incremental commit on B replicates normally to rebuilt Edge F!
    const t8 = await runCommandOnCenterB("m2-t8", {
      kind: "task-create",
      taskId: "m2-t8",
      title: "Task 8 after CLI rebuild",
    });
    assert.equal(t8.outcome, "applied", JSON.stringify(t8));
    const rev8 = readRepoRevision(edgeB.edgeRoot, repoId);
    await waitForFleetReplicaRevision(
      { viewRoot: edgeFStale.viewRoot, repoId, nodeId: "node-f-stale" },
      rev8,
      AbortSignal.timeout(30_000),
    );
  } finally {
    if (fencedCenterA) await fencedCenterA.close();
    if (fencedHostA) await fencedHostA.close();
    if (centerB) await centerB.close();
    if (hostBAsCenter) await hostBAsCenter.close();
    closeSqliteEventStoresUnder(root);
    removeTempRepository(root);
  }
}

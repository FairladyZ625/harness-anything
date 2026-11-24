// @vitest-environment node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { it } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import {
  createJsonRpcProtocolServer,
  createUnixSocketTransportServer,
  localUserDaemonEndpoint,
} from "@harness-anything/daemon/client";
import { acquireDaemonSingleton } from "@harness-anything/daemon/internal/daemon-singleton";
import {
  prepareCenterSwitchoverCandidate,
  prepareCenterSymmetricIdentity,
  relocateFleetCenter,
  signSwitchoverCededProof,
} from "@harness-anything/daemon/internal/fleet/center";
import { readDaemonRegistry } from "@harness-anything/kernel/daemon-registry";
import { auth } from "../../daemon/test/daemon-host-recovery.fixture.ts";
import { fleetEdgeHostFixture } from "../../daemon/test/fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture } from "../../daemon/test/fleet-node-claim.fixtures.ts";
import { signInAt, signOutAt } from "../../daemon/test/keycloak.fixtures.ts";
import {
  waitForFleetReplicaReady,
  waitForFleetReplicaRevision,
} from "../../daemon/src/daemon-host/fleet/replica-sync.ts";
import {
  FLEET_UPLOAD_MAX_BYTES,
  measureFleetTransferPayload,
} from "../../daemon/src/daemon-host/fleet/command-protocol.ts";
import { measureSwitchoverRemoteActivationTransfer } from "../../daemon/src/daemon-host/fleet/center-switchover-transport.ts";
import { readCenterFrozenCut } from "../../storage/src/center-switchover.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { registerCenterSettingsIpc } from "../src/main/center-settings-ipc.ts";
import { createCenterSwitchPort } from "../src/main/center-switch-port.ts";
import { centerSettingsPreloadApi } from "../src/preload/center-settings-preload.ts";

function spkiSha256FromCertPem(certPem: Buffer): string {
  const x509 = new X509Certificate(certPem);
  return `sha256:${createHash("sha256")
    .update(x509.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
}

function createSelfSignedCert(
  directory: string,
  commonName = "localhost",
  san = `DNS:${commonName},IP:127.0.0.1`,
): {
  readonly keyPath: string;
  readonly certPath: string;
  readonly keyPem: string;
  readonly certPem: string;
  readonly spkiSha256: string;
} {
  mkdirSync(directory, { recursive: true });
  const keyPath = path.join(directory, `${commonName.replace(/[^a-z0-9.-]/giu, "_")}.key`);
  const certPath = path.join(directory, `${commonName.replace(/[^a-z0-9.-]/giu, "_")}.crt`);
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
      `/CN=${commonName}`,
      "-days",
      "1",
      "-addext",
      `subjectAltName=${san}`,
    ],
    { stdio: "ignore" },
  );
  const keyPem = readFileSync(keyPath, "utf8");
  const certPem = readFileSync(certPath, "utf8");
  return { keyPath, certPath, keyPem, certPem, spkiSha256: spkiSha256FromCertPem(Buffer.from(certPem, "utf8")) };
}

function createIntermediateCertChain(
  directory: string,
  commonName: string,
  san: string,
): {
  readonly rootCaPath: string;
  readonly rootCaPem: string;
  readonly intermediateCaPem: string;
  readonly leafKeyPath: string;
  readonly leafKeyPem: string;
  readonly leafOnlyPath: string;
  readonly leafPem: string;
  readonly fullChainPath: string;
  readonly fullChainPem: string;
  readonly pathLenViolatingChainPath: string;
  readonly missingKeyCertSignChainPath: string;
  readonly spkiSha256: string;
} {
  mkdirSync(directory, { recursive: true });
  const rootKeyPath = path.join(directory, "root-ca.key"),
    rootCaPath = path.join(directory, "root-ca.crt"),
    interKeyPath = path.join(directory, "inter-ca.key"),
    interCsrPath = path.join(directory, "inter-ca.csr"),
    interCertPath = path.join(directory, "inter-ca.crt"),
    interExtPath = path.join(directory, "inter-ca.ext"),
    subInterKeyPath = path.join(directory, "sub-inter-ca.key"),
    subInterCsrPath = path.join(directory, "sub-inter-ca.csr"),
    subInterCertPath = path.join(directory, "sub-inter-ca.crt"),
    subLeafCertPath = path.join(directory, "sub-leaf.crt"),
    pathLenViolatingChainPath = path.join(directory, "pathlen-violating-chain.crt"),
    badKuInterKeyPath = path.join(directory, "bad-ku-inter.key"),
    badKuInterCsrPath = path.join(directory, "bad-ku-inter.csr"),
    badKuInterExtPath = path.join(directory, "bad-ku-inter.ext"),
    badKuInterCertPath = path.join(directory, "bad-ku-inter.crt"),
    badKuLeafCertPath = path.join(directory, "bad-ku-leaf.crt"),
    missingKeyCertSignChainPath = path.join(directory, "missing-keycertsign-chain.crt"),
    leafKeyPath = path.join(directory, "leaf.key"),
    leafCsrPath = path.join(directory, "leaf.csr"),
    leafOnlyPath = path.join(directory, "leaf.crt"),
    leafExtPath = path.join(directory, "leaf.ext"),
    fullChainPath = path.join(directory, "fullchain.crt");

  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      rootKeyPath,
      "-out",
      rootCaPath,
      "-subj",
      "/CN=Fleet Test Root CA",
      "-days",
      "2",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      interKeyPath,
      "-out",
      interCsrPath,
      "-subj",
      "/CN=Fleet Test Intermediate CA",
    ],
    { stdio: "ignore" },
  );
  writeFileSync(
    interExtPath,
    "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n",
    "utf8",
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      interCsrPath,
      "-CA",
      rootCaPath,
      "-CAkey",
      rootKeyPath,
      "-CAcreateserial",
      "-out",
      interCertPath,
      "-days",
      "2",
      "-extfile",
      interExtPath,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      leafKeyPath,
      "-out",
      leafCsrPath,
      "-subj",
      `/CN=${commonName}`,
    ],
    { stdio: "ignore" },
  );
  writeFileSync(
    leafExtPath,
    `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`,
    "utf8",
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      leafCsrPath,
      "-CA",
      interCertPath,
      "-CAkey",
      interKeyPath,
      "-CAcreateserial",
      "-out",
      leafOnlyPath,
      "-days",
      "1",
      "-extfile",
      leafExtPath,
    ],
    { stdio: "ignore" },
  );
  const rootCaPem = readFileSync(rootCaPath, "utf8"),
    intermediateCaPem = readFileSync(interCertPath, "utf8"),
    leafKeyPem = readFileSync(leafKeyPath, "utf8"),
    leafPem = readFileSync(leafOnlyPath, "utf8"),
    fullChainPem = `${leafPem.trim()}\n${intermediateCaPem.trim()}\n`;
  writeFileSync(fullChainPath, fullChainPem, "utf8");

  // F8 pathlen:0 negative chain: Root -> Inter (pathlen:0) -> SubInter (CA:TRUE, pathlen:0) -> Leaf (EXACT same leaf SPKI & SAN).
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      subInterKeyPath,
      "-out",
      subInterCsrPath,
      "-subj",
      "/CN=Fleet Test Subordinate CA Violating PathLen",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      subInterCsrPath,
      "-CA",
      interCertPath,
      "-CAkey",
      interKeyPath,
      "-CAcreateserial",
      "-out",
      subInterCertPath,
      "-days",
      "2",
      "-extfile",
      interExtPath,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      leafCsrPath,
      "-CA",
      subInterCertPath,
      "-CAkey",
      subInterKeyPath,
      "-CAcreateserial",
      "-out",
      subLeafCertPath,
      "-days",
      "1",
      "-extfile",
      leafExtPath,
    ],
    { stdio: "ignore" },
  );
  writeFileSync(
    pathLenViolatingChainPath,
    `${readFileSync(subLeafCertPath, "utf8").trim()}\n${readFileSync(subInterCertPath, "utf8").trim()}\n${intermediateCaPem.trim()}\n`,
    "utf8",
  );

  // F8 keyUsage negative chain: Root -> BadKuInter (CA:TRUE, keyUsage=digitalSignature without keyCertSign) -> Leaf (EXACT same leaf SPKI & SAN).
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      badKuInterKeyPath,
      "-out",
      badKuInterCsrPath,
      "-subj",
      "/CN=Fleet Test CA Without KeyCertSign",
    ],
    { stdio: "ignore" },
  );
  writeFileSync(badKuInterExtPath, "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature\n", "utf8");
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      badKuInterCsrPath,
      "-CA",
      rootCaPath,
      "-CAkey",
      rootKeyPath,
      "-CAcreateserial",
      "-out",
      badKuInterCertPath,
      "-days",
      "2",
      "-extfile",
      badKuInterExtPath,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      leafCsrPath,
      "-CA",
      badKuInterCertPath,
      "-CAkey",
      badKuInterKeyPath,
      "-CAcreateserial",
      "-out",
      badKuLeafCertPath,
      "-days",
      "1",
      "-extfile",
      leafExtPath,
    ],
    { stdio: "ignore" },
  );
  writeFileSync(
    missingKeyCertSignChainPath,
    `${readFileSync(badKuLeafCertPath, "utf8").trim()}\n${readFileSync(badKuInterCertPath, "utf8").trim()}\n`,
    "utf8",
  );

  return {
    rootCaPath,
    rootCaPem,
    intermediateCaPem,
    leafKeyPath,
    leafKeyPem,
    leafOnlyPath,
    leafPem,
    fullChainPath,
    fullChainPem,
    pathLenViolatingChainPath,
    missingKeyCertSignChainPath,
    spkiSha256: spkiSha256FromCertPem(Buffer.from(leafPem, "utf8")),
  };
}

function readLedgerSnapshot(databasePath: string): {
  readonly revision: number;
  readonly history: string;
  readonly writerEpoch: number;
} {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const revRow = db.prepare("SELECT COALESCE(MAX(revision), 0) AS rev FROM event").get() as { readonly rev: unknown };
    const repRow = db.prepare("SELECT history FROM replication_state LIMIT 1").get() as { readonly history: unknown };
    const fenceRow = db.prepare("SELECT epoch FROM writer_lease LIMIT 1").get() as
      | { readonly epoch: unknown }
      | undefined;
    return {
      revision: Number(revRow?.rev ?? 0),
      history: String(repRow?.history ?? ""),
      writerEpoch: Number(fenceRow?.epoch ?? 0),
    };
  } finally {
    db.close();
  }
}

function wireCenterSettingsPreload(port: ReturnType<typeof createCenterSwitchPort>) {
  let handler: ((event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>) | undefined;
  registerCenterSettingsIpc(
    {
      handle: (_channel, listener) => {
        handler = listener;
      },
    },
    { isTrustedWebContentsId: (id) => id === 9, rendererUrl: { packagedRendererUrl: "file:///renderer/index.html" } },
    {
      daemonRequest: async () => ({ ok: true }),
      fleetRequest: async () => ({ ok: true }),
      centerSwitch: port.centerSwitch,
      promoteFromEdge: port.promoteFromEdge,
      edgeLocalState: port.edgeLocalState,
      dialog: { selectFile: async () => null },
    },
  );
  const sender = Object.assign(new EventEmitter(), { id: 9 });
  const event = { sender, senderFrame: { url: "file:///renderer/index.html" } } as IpcMainInvokeEvent;
  return {
    preload: centerSettingsPreloadApi((_channel, request) => handler!(event, request)),
  };
}

async function withCleanupContext(fn: (t: TestContext) => Promise<void>): Promise<void> {
  const cleanups: Array<() => unknown> = [];
  const t = {
    after: (cleanup: () => unknown) => {
      cleanups.push(cleanup);
    },
  } as unknown as TestContext;
  try {
    await fn(t);
  } finally {
    for (let index = cleanups.length - 1; index >= 0; index -= 1) {
      await cleanups[index]!();
    }
  }
}

async function startLiveDaemonSocketServer(input: {
  readonly userRoot: string;
  readonly daemonId: string;
  readonly host: Parameters<typeof createJsonRpcProtocolServer>[0]["host"];
}) {
  const endpoint = localUserDaemonEndpoint(input.userRoot, input.daemonId);
  const singleton = await acquireDaemonSingleton({ userRoot: input.userRoot, daemonId: input.daemonId, endpoint });
  assert.equal(singleton.claim, "acquired");
  let releaseLock: (() => void) | null = singleton.release;
  let stopping = false;
  const transport = createUnixSocketTransportServer({
    daemonId: input.daemonId,
    socketPath: endpoint,
    createProtocolServer: (authContext, emit) =>
      createJsonRpcProtocolServer({
        host: input.host,
        build: { commit: null },
        authContext,
        emit,
        stopping: () => stopping,
        requestShutdown: () => {
          if (stopping) return;
          stopping = true;
          void (async () => {
            await transport.stop();
            releaseLock?.();
            releaseLock = null;
          })();
        },
      }),
  });
  await transport.start();
  return {
    stop: async () => {
      if (!stopping) {
        stopping = true;
        await transport.stop();
      }
      releaseLock?.();
      releaseLock = null;
    },
  };
}

it("F8/F12/F11: intermediate CA chain switchover & rollback, pre-Phase-1 target admin authorization parity, and exact 64 MiB auth-field frame boundary", async () => {
  await withCleanupContext(async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-gui-f8-f12-f11-"));
    let daemonSocketA: { readonly stop: () => Promise<void> } | null = null;
    try {
      const repoId = "lease-repo",
        nodeAId = "node-a-chain",
        nodeBId = "node-b-chain",
        daemonIdA = "lease-center",
        nodeAViewRoot = path.join(root, "node-a-views");

      // 1. Live Center A with a real 3-tier X.509 chain (Root CA -> Intermediate CA -> Leaf).
      //    Edge B configures ONLY the Root CA in its caPath (`tls.crt`) + leaf SPKI pin!
      const nodeA = await fleetNodeClaimFixture(
        t,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        {},
        undefined,
        undefined,
        { replicaAdmission: true },
      );
      await nodeA.center.close();
      const chainA = createIntermediateCertChain(
        path.join(nodeA.userRoot, "chain-a"),
        "fleet-a.example.test",
        "DNS:fleet-a.example.test,DNS:localhost,IP:127.0.0.1",
      );
      writeFileSync(path.join(nodeA.root, "tls.crt"), chainA.rootCaPem, "utf8");
      writeFileSync(path.join(nodeA.root, "tls.key"), chainA.leafKeyPem, "utf8");
      nodeA.owners.keycloak.node(nodeAId, "person-one", `secret-${nodeAId}`);
      nodeA.owners.keycloak.node(nodeBId, "person-one", `secret-${nodeBId}`);
      nodeA.owners.keycloak.interactiveSession("person-one", nodeBId, nodeA.owners.url, `device-token-${nodeBId}`);

      const startA = await nodeA.host.fleet.startCenter(
        {
          port: 0,
          bind: "127.0.0.1",
          keyPath: chainA.leafKeyPath,
          certPath: chainA.fullChainPath,
          repoId,
          quotaBytes: 64 * 1024 * 1024,
        },
        auth,
      );
      assert.equal(startA.ok, true, JSON.stringify(startA));
      const centerPortA = Number(startA.port);

      daemonSocketA = await startLiveDaemonSocketServer({
        userRoot: nodeA.userRoot,
        daemonId: daemonIdA,
        host: nodeA.host,
      });
      prepareCenterSymmetricIdentity(nodeA.userRoot, {
        repoId,
        nodeId: nodeAId,
        credential: `secret-${nodeAId}`,
        viewRoot: nodeAViewRoot,
        quotaBytes: 64 * 1024 * 1024,
      });

      assert.equal(
        (await nodeA.host.run(repoId, { kind: "task-create", taskId: "chain-seed", title: "Chain Seed" }, auth))
          .outcome,
        "applied",
      );
      const ledgerAPath = path.join(nodeA.repo, ".harness", "store", "generations", "3", "ledger.sqlite");
      const cutA = readLedgerSnapshot(ledgerAPath);

      // 2. Live Candidate Edge B syncing from Center A over Root CA -> Intermediate CA -> Leaf TLS + SPKI pin.
      const edgeB = await fleetEdgeHostFixture(
        t,
        { ...nodeA, center: { port: centerPortA } },
        {
          nodeId: nodeBId,
          beforeOpen: (_edgeRoot, edgeUser) => {
            nodeA.owners.bind(edgeUser);
          },
        },
      );
      const {
        schema: _schema,
        loginUrl: _loginUrl,
        loginRealm: _loginRealm,
        loginServername: _loginServername,
        loginBrowserUrl: _loginBrowserUrl,
        loginCertificate: _loginCertificate,
        waitTimeoutMs: _waitTimeoutMs,
        ...initialConn
      } = edgeB.config;
      const syncRes = await edgeB.rpc.handle({
        jsonrpc: "2.0",
        id: 501,
        method: "daemon.fleet.edge.sync",
        params: {
          payload: {
            ...initialConn,
            spkiSha256: chainA.spkiSha256.replace(/^sha256:/u, ""),
            workspaceRoot: edgeB.edgeRoot,
            timeoutMs: 30_000,
          },
        },
      });
      assert.equal(
        (syncRes as { readonly result?: { readonly ok?: boolean } }).result?.ok,
        true,
        JSON.stringify(syncRes),
      );
      assert.equal(
        await waitForFleetReplicaReady(
          { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
          AbortSignal.timeout(30_000),
        ),
        true,
      );
      await waitForFleetReplicaRevision(
        { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
        cutA.revision,
        AbortSignal.timeout(30_000),
      );

      const certB = createSelfSignedCert(
        path.join(edgeB.edgeUser, "cert-fleet-b"),
        "fleet-b.example.test",
        "DNS:fleet-b.example.test,IP:127.0.0.1",
      );
      const startB = await edgeB.host.fleet.startCenter(
        {
          port: 0,
          bind: "127.0.0.1",
          keyPath: certB.keyPath,
          certPath: certB.certPath,
          repoId,
          quotaBytes: 64 * 1024 * 1024,
        },
        auth,
      );
      assert.equal(startB.ok, true, JSON.stringify(startB));
      const candidatePortB = Number(startB.port);
      prepareCenterSwitchoverCandidate(nodeA.userRoot, {
        repoId,
        nodeId: nodeBId,
        targetExternalUrl: `https://127.0.0.1:${String(candidatePortB)}`,
        targetLoginUrl: nodeA.owners.url,
        targetSpkiSha256: certB.spkiSha256,
        targetServername: "fleet-b.example.test",
      });

      const portA = createCenterSwitchPort({
        userRoot: () => nodeA.userRoot,
        readOnly: () => false,
        daemonId: () => daemonIdA,
      });
      const { preload: preloadA } = wireCenterSettingsPreload(portA);
      const fencePathA = path.join(nodeA.userRoot, "fleet", "center-switchover-fence", `${repoId}.json`);

      // Prepare admin principal `person-one` with a valid 4 KiB personal access token (used for writability checks, F8 & F11!).
      const longAdminToken = `device-token-${nodeAId}-${"t".repeat(4096)}`;
      nodeA.owners.keycloak.interactiveSession("person-one", nodeAId, nodeA.owners.url, longAdminToken);

      // F12.1: No personal human session (logged out / replica-only) MUST fail BOTH dry-run AND formal switch BEFORE Phase 1!
      signOutAt(nodeA.userRoot);
      const noSessionDryRun = await preloadA.centerSwitch!({ repoId, targetNodeId: nodeBId, dryRun: true });
      assert.equal(noSessionDryRun.ok, false, JSON.stringify(noSessionDryRun));
      assert.ok(
        noSessionDryRun.preflight?.blockingCodes.includes("auth_surface_unreachable"),
        JSON.stringify(noSessionDryRun.preflight),
      );
      const noSessionFormal = await preloadA.centerSwitch!({
        repoId,
        targetNodeId: nodeBId,
        dryRun: false,
        switchoverId: "sw_f12_no_session",
      });
      assert.equal(noSessionFormal.ok, false, JSON.stringify(noSessionFormal));
      assert.equal(existsSync(fencePathA), false, "F12.1: no Phase 1 fence may be written without personal session");
      signInAt(nodeA.userRoot, "person-one", [], longAdminToken, nodeA.repo);
      const postNoSessionWrite = await nodeA.host.run(
        repoId,
        { kind: "task-create", taskId: "f12-nosess-ok", title: "Writable" },
        auth,
      );
      assert.equal(postNoSessionWrite.outcome, "applied", JSON.stringify(postNoSessionWrite));

      // F12.2: Personal human session holding ONLY repository-read (NO daemon-fleet-center-switch) MUST fail BOTH dry-run AND formal switch BEFORE Phase 1!
      nodeA.owners.keycloak.account("person-reader-f12");
      nodeA.owners.keycloak.permit("person-reader-f12", repoId, ["repository-read"]);
      nodeA.owners.keycloak.node(nodeAId, "person-reader-f12", `secret-${nodeAId}`);
      nodeA.owners.keycloak.interactiveSession(
        "person-reader-f12",
        nodeAId,
        nodeA.owners.url,
        `device-token-reader-${nodeAId}`,
      );
      signInAt(nodeA.userRoot, "person-reader-f12", [], `device-token-reader-${nodeAId}`, nodeA.repo);
      const readerDryRun = await preloadA.centerSwitch!({ repoId, targetNodeId: nodeBId, dryRun: true });
      assert.equal(readerDryRun.ok, false, JSON.stringify(readerDryRun));
      assert.ok(
        readerDryRun.preflight?.blockingCodes.includes("auth_surface_unreachable"),
        JSON.stringify(readerDryRun.preflight),
      );
      const readerFormal = await preloadA.centerSwitch!({
        repoId,
        targetNodeId: nodeBId,
        dryRun: false,
        switchoverId: "sw_f12_reader_only",
      });
      assert.equal(readerFormal.ok, false, JSON.stringify(readerFormal));
      assert.equal(existsSync(fencePathA), false, "F12.2: no Phase 1 fence may be written for repository-read session");

      // Restore admin principal `person-one` and prove Source A remained unfenced and writable after F12.2!
      nodeA.owners.keycloak.node(nodeAId, "person-one", `secret-${nodeAId}`);
      nodeA.owners.keycloak.interactiveSession("person-one", nodeAId, nodeA.owners.url, longAdminToken);
      signInAt(nodeA.userRoot, "person-one", [], longAdminToken, nodeA.repo);
      const postReaderWrite = await nodeA.host.run(
        repoId,
        { kind: "task-create", taskId: "f12-reader-ok", title: "Writable" },
        auth,
      );
      assert.equal(postReaderWrite.outcome, "applied", JSON.stringify(postReaderWrite));

      const cutAfterF12 = readLedgerSnapshot(ledgerAPath);
      await waitForFleetReplicaRevision(
        { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
        cutAfterF12.revision,
        AbortSignal.timeout(30_000),
      );

      // F8.1 NEGATIVE: Leaf-only cert (missing Intermediate CA!) is rejected BEFORE Phase 1!
      const missingInter = await relocateFleetCenter(
        [
          "fleet",
          "center",
          "switch",
          "--root",
          nodeA.repo,
          "--repo",
          repoId,
          "--user-root",
          nodeA.userRoot,
          "--state-root",
          nodeA.writerEpochStateRoot,
          "--daemon-id",
          daemonIdA,
          "--to",
          nodeBId,
          "--source-cert",
          chainA.leafOnlyPath,
          "--switchover-id",
          "sw_f8_missing_inter",
        ],
        nodeA.userRoot,
      );
      assert.equal(missingInter.receipt.ok, false, JSON.stringify(missingInter.receipt));
      assert.equal(missingInter.receipt.fencedCeded, undefined);
      assert.equal(existsSync(fencePathA), false, "F8.1: leaf without intermediate CA must fail pre-Phase-1");
      assert.equal(
        (await nodeA.host.run(repoId, { kind: "task-create", taskId: "f8-nointer-ok", title: "Writable" }, auth))
          .outcome,
        "applied",
      );

      // F8.1b NEGATIVE: RFC 5280 pathlen:0 violation (Root -> Inter[pathlen:0] -> SubInter -> Leaf with SAME SPKI & SAN) MUST fail BEFORE Phase 1!
      const pathLenViolation = await relocateFleetCenter(
        [
          "fleet",
          "center",
          "switch",
          "--root",
          nodeA.repo,
          "--repo",
          repoId,
          "--user-root",
          nodeA.userRoot,
          "--state-root",
          nodeA.writerEpochStateRoot,
          "--daemon-id",
          daemonIdA,
          "--to",
          nodeBId,
          "--source-cert",
          chainA.pathLenViolatingChainPath,
          "--switchover-id",
          "sw_f8_pathlen_violation",
        ],
        nodeA.userRoot,
      );
      assert.equal(pathLenViolation.receipt.ok, false, JSON.stringify(pathLenViolation.receipt));
      assert.equal(pathLenViolation.receipt.fencedCeded, undefined);
      assert.equal(existsSync(fencePathA), false, "F8.1b: pathlen:0 violation must fail pre-Phase-1");

      // F8.1c NEGATIVE: Intermediate CA lacking keyCertSign in keyUsage (SAME SPKI & SAN) MUST fail BEFORE Phase 1!
      const missingKeyCertSign = await relocateFleetCenter(
        [
          "fleet",
          "center",
          "switch",
          "--root",
          nodeA.repo,
          "--repo",
          repoId,
          "--user-root",
          nodeA.userRoot,
          "--state-root",
          nodeA.writerEpochStateRoot,
          "--daemon-id",
          daemonIdA,
          "--to",
          nodeBId,
          "--source-cert",
          chainA.missingKeyCertSignChainPath,
          "--switchover-id",
          "sw_f8_missing_keycertsign",
        ],
        nodeA.userRoot,
      );
      assert.equal(missingKeyCertSign.receipt.ok, false, JSON.stringify(missingKeyCertSign.receipt));
      assert.equal(missingKeyCertSign.receipt.fencedCeded, undefined);
      assert.equal(existsSync(fencePathA), false, "F8.1c: CA missing keyCertSign must fail pre-Phase-1");
      assert.equal(
        (await nodeA.host.run(repoId, { kind: "task-create", taskId: "f8-pathlen-ok", title: "Writable" }, auth))
          .outcome,
        "applied",
      );

      // F12.3 NEGATIVE: Mid-catchup logout (session disappears after preflight + catchup, BEFORE Phase 1 fence!) MUST fail BEFORE Phase 1 and leave Source A unfenced & writable!
      const cutBeforeMidLogout = readLedgerSnapshot(ledgerAPath);
      await waitForFleetReplicaRevision(
        { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
        cutBeforeMidLogout.revision,
        AbortSignal.timeout(30_000),
      );
      const midCatchupLogout = await relocateFleetCenter(
        [
          "fleet",
          "center",
          "switch",
          "--root",
          nodeA.repo,
          "--repo",
          repoId,
          "--user-root",
          nodeA.userRoot,
          "--state-root",
          nodeA.writerEpochStateRoot,
          "--daemon-id",
          daemonIdA,
          "--to",
          nodeBId,
          "--switchover-id",
          "sw_f12_mid_catchup_logout",
        ],
        nodeA.userRoot,
        {
          switchover: {
            awaitTargetCatchup: async ({ frozenCut }) => {
              signOutAt(nodeA.userRoot);
              return {
                repoId: frozenCut.repoId,
                revision: frozenCut.finalRevision,
                tipHash: frozenCut.tipHash,
                history: frozenCut.history,
                sequence: frozenCut.sequence,
              };
            },
          },
        },
      );
      assert.equal(midCatchupLogout.receipt.ok, false, JSON.stringify(midCatchupLogout.receipt));
      assert.equal(midCatchupLogout.receipt.code, "authentication_required", JSON.stringify(midCatchupLogout.receipt));
      assert.equal(midCatchupLogout.receipt.fencedCeded, undefined);
      assert.equal(existsSync(fencePathA), false, "F12.3: mid-catchup logout must fail BEFORE Phase 1 fence");
      signInAt(nodeA.userRoot, "person-one", [], longAdminToken, nodeA.repo);
      assert.equal(
        (await nodeA.host.run(repoId, { kind: "task-create", taskId: "f12-midlogout-ok", title: "Writable" }, auth))
          .outcome,
        "applied",
      );

      // F12.4 NEGATIVE: Mid-catchup session swap to repository-read-only user MUST be re-verified on target BEFORE Phase 1 fence and rejected!
      const cutBeforeMidSwap = readLedgerSnapshot(ledgerAPath);
      await waitForFleetReplicaRevision(
        { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
        cutBeforeMidSwap.revision,
        AbortSignal.timeout(30_000),
      );
      const midCatchupSwap = await relocateFleetCenter(
        [
          "fleet",
          "center",
          "switch",
          "--root",
          nodeA.repo,
          "--repo",
          repoId,
          "--user-root",
          nodeA.userRoot,
          "--state-root",
          nodeA.writerEpochStateRoot,
          "--daemon-id",
          daemonIdA,
          "--to",
          nodeBId,
          "--switchover-id",
          "sw_f12_mid_catchup_swap",
        ],
        nodeA.userRoot,
        {
          switchover: {
            awaitTargetCatchup: async ({ frozenCut }) => {
              nodeA.owners.keycloak.node(nodeAId, "person-reader-f12", `secret-${nodeAId}`);
              signInAt(nodeA.userRoot, "person-reader-f12", [], `device-token-reader-${nodeAId}`, nodeA.repo);
              return {
                repoId: frozenCut.repoId,
                revision: frozenCut.finalRevision,
                tipHash: frozenCut.tipHash,
                history: frozenCut.history,
                sequence: frozenCut.sequence,
              };
            },
          },
        },
      );
      assert.equal(midCatchupSwap.receipt.ok, false, JSON.stringify(midCatchupSwap.receipt));
      assert.equal(midCatchupSwap.receipt.fencedCeded, undefined);
      assert.equal(existsSync(fencePathA), false, "F12.4: mid-catchup reader swap must fail BEFORE Phase 1 fence");
      nodeA.owners.keycloak.node(nodeAId, "person-one", `secret-${nodeAId}`);
      nodeA.owners.keycloak.interactiveSession("person-one", nodeAId, nodeA.owners.url, longAdminToken);
      signInAt(nodeA.userRoot, "person-one", [], longAdminToken, nodeA.repo);
      assert.equal(
        (await nodeA.host.run(repoId, { kind: "task-create", taskId: "f12-midswap-ok", title: "Writable" }, auth))
          .outcome,
        "applied",
      );

      // F8.2 AUDITED ROLLBACK with Root CA -> Intermediate CA -> Leaf:
      const cutBeforeRollback = readLedgerSnapshot(ledgerAPath);
      await waitForFleetReplicaRevision(
        { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
        cutBeforeRollback.revision,
        AbortSignal.timeout(30_000),
      );
      const failAfterPhase1 = await relocateFleetCenter(
        [
          "fleet",
          "center",
          "switch",
          "--root",
          nodeA.repo,
          "--repo",
          repoId,
          "--user-root",
          nodeA.userRoot,
          "--state-root",
          nodeA.writerEpochStateRoot,
          "--daemon-id",
          daemonIdA,
          "--to",
          nodeBId,
          "--switchover-id",
          "sw_f8_chain_rollback",
        ],
        nodeA.userRoot,
        {
          switchover: {
            beforeTargetActivation: async () => {
              throw new Error("simulated post-Phase-1 link drop");
            },
          },
        },
      );
      assert.equal(failAfterPhase1.receipt.ok, false, JSON.stringify(failAfterPhase1.receipt));
      assert.equal(failAfterPhase1.receipt.fencedCeded, true, JSON.stringify(failAfterPhase1.receipt));
      assert.equal(existsSync(fencePathA), true);

      await daemonSocketA.stop();
      daemonSocketA = null;
      await nodeA.closeHost(nodeA.host);

      const rollbackChain = await preloadA.centerSwitch!({
        repoId,
        targetNodeId: nodeBId,
        abortRollback: true,
        switchoverId: "sw_f8_chain_rollback",
        reason: "F8 intermediate CA rollback proof",
      });
      assert.equal(rollbackChain.ok, true, JSON.stringify(rollbackChain));
      assert.equal(rollbackChain.phase, "aborted_rolled_back");
      assert.equal(rollbackChain.rollback?.rollbackEpoch, cutBeforeRollback.writerEpoch + 2);
      assert.equal(existsSync(fencePathA), false, "F8.2: audited rollback with intermediate CA must clear fence");
      const invalidatedPathB = path.join(edgeB.edgeUser, "fleet", "switchover-invalidated", `${repoId}.json`);
      assert.equal(existsSync(invalidatedPathB), true);
      assert.ok(readFileSync(invalidatedPathB, "utf8").includes("sw_f8_chain_rollback"));

      const hostA2 = await nodeA.openHost();
      daemonSocketA = await startLiveDaemonSocketServer({
        userRoot: nodeA.userRoot,
        daemonId: daemonIdA,
        host: hostA2,
      });
      assert.equal(
        (await hostA2.run(repoId, { kind: "task-create", taskId: "f8-after-rb", title: "Post-RB" }, auth)).outcome,
        "applied",
      );

      // F11 EXACT 64 MiB AUTH-FIELD BOUNDARY:
      // Build a replication_log window that fits strictly <= 64 MiB WITHOUT accessToken + short messageId,
      // but EXCEEDS 64 MiB once the real 4 KiB accessToken + peer messageId are included!
      const cutForF11 = readLedgerSnapshot(ledgerAPath);
      await waitForFleetReplicaRevision(
        { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
        cutForF11.revision,
        AbortSignal.timeout(30_000),
      );
      const existingFrozen = readCenterFrozenCut({
        rootInput: nodeA.repo,
        repoId,
        maxLogWindowCommits: 3000,
      });
      const sampleProof = signSwitchoverCededProof({
        repoId,
        switchoverId: "sw_f11_boundary",
        sourceNodeId: nodeAId,
        targetNodeId: nodeBId,
        oldEpoch: cutForF11.writerEpoch,
        cededEpoch: cutForF11.writerEpoch + 1,
        finalRevision: cutForF11.revision,
        tipHash: existingFrozen.cut.tipHash,
        fencedAt: new Date().toISOString(),
        sourceKeyPem: chainA.leafKeyPem,
        sourceCertificatePem: chainA.fullChainPem,
      });
      const fullWriterChunk = "w".repeat(32 * 1024);
      const baseRows = Array.from({ length: 2042 }, (_, idx) => ({
        sequence: 100_000 + idx,
        revision: cutForF11.revision,
        outcomeOpId: null,
        writerJson: fullWriterChunk,
      }));
      const baseFrameBytes = measureFleetTransferPayload({
        schema: "fleet.switchover.activate/v1",
        messageId: "precheck_activate",
        repoId,
        switchoverId: "sw_f11_boundary",
        expectedTargetNodeId: nodeBId,
        expectedOldEpoch: cutForF11.writerEpoch,
        newEpoch: cutForF11.writerEpoch + 1,
        frozenCut: existingFrozen.cut,
        sourceReplicationLogWindow: [...existingFrozen.replicationLogWindow, ...baseRows],
        retentionWindowCommits: 3000,
        cededProof: sampleProof,
        targetExternalUrl: `https://127.0.0.1:${String(candidatePortB)}`,
        targetLoginUrl: nodeA.owners.url,
      });
      const gap = FLEET_UPLOAD_MAX_BYTES - baseFrameBytes - 1500;
      const tailRows: Array<{
        readonly sequence: number;
        readonly revision: number;
        readonly outcomeOpId: null;
        readonly writerJson: string;
      }> = [];
      let remaining = gap;
      let tailSeq = 100_000 + baseRows.length;
      while (remaining > 0) {
        const piece = Math.min(32 * 1024, Math.max(1, remaining - 70));
        tailRows.push({
          sequence: tailSeq++,
          revision: cutForF11.revision,
          outcomeOpId: null,
          writerJson: "x".repeat(piece),
        });
        remaining -= piece + 65;
      }
      const boundaryRows = [...baseRows, ...tailRows];
      const fullBoundaryWindow = [...existingFrozen.replicationLogWindow, ...boundaryRows];
      const withoutTokenCheck = measureSwitchoverRemoteActivationTransfer({
        repoId,
        switchoverId: "sw_f11_boundary",
        expectedTargetNodeId: nodeBId,
        expectedOldEpoch: cutForF11.writerEpoch,
        newEpoch: cutForF11.writerEpoch + 1,
        frozenCut: existingFrozen.cut,
        sourceReplicationLogWindow: fullBoundaryWindow,
        retentionWindowCommits: 3000,
        replicationSlots: [],
        cededProof: sampleProof,
        targetExternalUrl: `https://127.0.0.1:${String(candidatePortB)}`,
        targetLoginUrl: nodeA.owners.url,
      });
      assert.equal(withoutTokenCheck.ok, true, "F11 calibration: without 4 KiB accessToken payload must fit <= 64 MiB");
      const withTokenCheck = measureSwitchoverRemoteActivationTransfer({
        repoId,
        switchoverId: "sw_f11_boundary",
        expectedTargetNodeId: nodeBId,
        expectedOldEpoch: cutForF11.writerEpoch,
        newEpoch: cutForF11.writerEpoch + 1,
        frozenCut: existingFrozen.cut,
        sourceReplicationLogWindow: fullBoundaryWindow,
        retentionWindowCommits: 3000,
        replicationSlots: [],
        cededProof: sampleProof,
        callerNodeId: nodeAId,
        accessToken: longAdminToken,
        targetExternalUrl: `https://127.0.0.1:${String(candidatePortB)}`,
        targetLoginUrl: nodeA.owners.url,
      });
      assert.equal(
        withTokenCheck.ok,
        false,
        "F11: adding real 4 KiB accessToken + peer messageId MUST trip 64 MiB pre-Phase-1 check",
      );

      // Exercise the live production switch path with those exact boundary rows in ledger.sqlite!
      const ledgerDb = new DatabaseSync(ledgerAPath);
      try {
        ledgerDb.exec("BEGIN");
        const ins = ledgerDb.prepare(
          "INSERT INTO replication_log(sequence, revision, outcome_op_id, writer_json) VALUES (?, ?, NULL, ?)",
        );
        for (const row of boundaryRows) ins.run(row.sequence, row.revision, row.writerJson);
        ledgerDb.exec("COMMIT");
      } finally {
        ledgerDb.close();
      }
      try {
        const boundaryReject = await relocateFleetCenter(
          [
            "fleet",
            "center",
            "switch",
            "--root",
            nodeA.repo,
            "--repo",
            repoId,
            "--user-root",
            nodeA.userRoot,
            "--state-root",
            nodeA.writerEpochStateRoot,
            "--daemon-id",
            daemonIdA,
            "--to",
            nodeBId,
            "--replication-log-window",
            "3000",
            "--switchover-id",
            "sw_f11_boundary_live",
          ],
          nodeA.userRoot,
        );
        assert.equal(boundaryReject.receipt.ok, false, JSON.stringify(boundaryReject.receipt));
        assert.equal(boundaryReject.receipt.code, "switchover_payload_untransferable");
        assert.equal(boundaryReject.receipt.fencedCeded, undefined);
        assert.equal(existsSync(fencePathA), false, "F11: 64 MiB auth-field overflow must reject BEFORE Phase 1");
      } finally {
        const cleanDb = new DatabaseSync(ledgerAPath);
        try {
          cleanDb.exec("DELETE FROM replication_log WHERE sequence >= 100000");
        } finally {
          cleanDb.close();
        }
      }
      assert.equal(
        (await hostA2.run(repoId, { kind: "task-create", taskId: "f11-boundary-writable", title: "Writable" }, auth))
          .outcome,
        "applied",
      );
      const cutBeforeChainSwitch = readLedgerSnapshot(ledgerAPath);
      await waitForFleetReplicaRevision(
        { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
        cutBeforeChainSwitch.revision,
        AbortSignal.timeout(30_000),
      );

      // F8.3 POSITIVE: Formal live switchover A -> B with Root CA -> Intermediate CA -> Leaf SUCCEEDS!
      const liveChainSwitch = await preloadA.centerSwitch!({
        repoId,
        targetNodeId: nodeBId,
        dryRun: false,
        switchoverId: "sw_f8_chain_live",
      });
      assert.equal(liveChainSwitch.ok, true, JSON.stringify(liveChainSwitch));
      assert.equal(liveChainSwitch.phase, "demoted_edge");
      assert.equal(
        readDaemonRegistry({ userRoot: edgeB.edgeUser }).repos.find((r) => r.repoId === repoId)?.mode,
        "local",
      );
      assert.equal(
        (await edgeB.host.run(repoId, { kind: "task-create", taskId: "f8-b-live-write", title: "B Writes" }, auth))
          .outcome,
        "applied",
      );

      await daemonSocketA.stop();
      daemonSocketA = null;
    } finally {
      if (daemonSocketA) await daemonSocketA.stop();
      removeTempRepository(root);
    }
  });
}, 180_000);

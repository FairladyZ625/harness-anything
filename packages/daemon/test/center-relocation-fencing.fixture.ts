import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as cryptoSign, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { createIdentitySession } from "../src/daemon-host/authorization-provider.ts";
import type { readFleetEdgeConfig } from "../src/daemon-host/client/fleet-edge-config.ts";
import type { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { listenFleetTls } from "../src/daemon-host/fleet/center.ts";
import { runFleetReplicaSync } from "../src/daemon-host/fleet/replica-sync.ts";
import { rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { fleetHostWriterOptions, fleetNodeOwners } from "./fleet-store.fixture.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";

function derNode(tag: number, content: Buffer): Buffer {
  const len = content.length,
    header =
      len < 0x80
        ? Buffer.from([tag, len])
        : len < 0x100
          ? Buffer.from([tag, 0x81, len])
          : Buffer.from([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([header, content]);
}

function utcTime(date: Date): Buffer {
  const iso = date
    .toISOString()
    .slice(2)
    .replace(/[-:T]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  return derNode(0x17, Buffer.from(iso, "ascii"));
}

export function writeSelfSignedLocalhostCertificate(keyPath: string, certPath: string): void {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
    spki = publicKey.export({ type: "spki", format: "der" }),
    ecdsaWithSha256 = derNode(0x30, Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])),
    cnAttr = derNode(
      0x30,
      Buffer.concat([Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]), derNode(0x0c, Buffer.from("localhost", "utf8"))]),
    ),
    name = derNode(0x30, derNode(0x31, cnAttr)),
    now = Date.now(),
    validity = derNode(0x30, Buffer.concat([utcTime(new Date(now - 60_000)), utcTime(new Date(now + 86_400_000))])),
    sanValue = derNode(
      0x30,
      Buffer.concat([derNode(0x82, Buffer.from("localhost", "ascii")), derNode(0x87, Buffer.from([127, 0, 0, 1]))]),
    ),
    sanExt = derNode(0x30, Buffer.concat([Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x11]), derNode(0x04, sanValue)])),
    extensions = derNode(0xa3, derNode(0x30, sanExt)),
    tbs = derNode(
      0x30,
      Buffer.concat([
        derNode(0xa0, Buffer.from([0x02, 0x01, 0x02])),
        Buffer.from([0x02, 0x01, 0x01]),
        ecdsaWithSha256,
        name,
        validity,
        name,
        spki,
        extensions,
      ]),
    ),
    signature = cryptoSign("sha256", tbs, privateKey),
    certDer = derNode(
      0x30,
      Buffer.concat([tbs, ecdsaWithSha256, derNode(0x03, Buffer.concat([Buffer.from([0x00]), signature]))]),
    ),
    lines = certDer.toString("base64").match(/.{1,64}/gu) ?? [];
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(certPath, `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`);
}

export function startFencingCenter(input: {
  readonly host: Awaited<ReturnType<typeof openDaemonHost>>;
  readonly centerUser: string;
  readonly repoId: string;
  readonly owners: Awaited<ReturnType<typeof fleetNodeOwners>>;
  readonly key: Buffer;
  readonly cert: Buffer;
  readonly loginUrl: string;
  readonly loginCert?: Buffer;
  readonly verifyReplica?: boolean;
  readonly relocationRoot?: string;
}) {
  return listenFleetTls({
    host: input.host,
    stateRoot: path.join(input.relocationRoot ?? input.centerUser, "fleet"),
    ...(input.relocationRoot ? { relocationRoot: input.relocationRoot, centerRepoId: input.repoId } : {}),
    ...fleetHostWriterOptions(input.centerUser, [input.repoId]),
    key: input.key,
    cert: input.cert,
    hostname: "127.0.0.1",
    port: 0,
    replicaDiskQuotaBytes: 64 * 1024 * 1024,
    authenticate: (id, credential) => credential === `secret-${id}`,
    nodeOwner: input.owners.nodeOwner,
    verifyHuman: input.owners.verifyHuman,
    ...(input.verifyReplica
      ? {
          verifyReplica: (authCtx) =>
            createIdentitySession(input.centerUser, { fetch: input.owners.keycloak.fetch }).bindReplica!(authCtx),
        }
      : {}),
    ...(input.loginCert
      ? {
          loginAuthority: (id) => ({
            url: input.loginUrl,
            realm: "harness",
            clientId: `harness-node-${id}`,
            servername: "localhost",
            certificate: input.loginCert!.toString("utf8"),
          }),
        }
      : {}),
  });
}

export function createFencingStreamHooks(input: {
  readonly readAccessToken: () => Promise<string | undefined>;
  readonly setActive: (ctrl: AbortController | null, task: Promise<void> | null) => void;
  readonly getActive: () => { readonly ctrl: AbortController | null; readonly task: Promise<void> | null };
  readonly onReplicaHealthChange?: () => void;
}) {
  return {
    startStagedStream: (stagedConfig: NonNullable<ReturnType<typeof readFleetEdgeConfig>>) => {
      const ctrl = new AbortController(),
        task = runFleetReplicaSync({
          hostname: stagedConfig.host,
          port: stagedConfig.port,
          ca: readFileSync(stagedConfig.caPath),
          ...(stagedConfig.servername ? { servername: stagedConfig.servername } : {}),
          ...(stagedConfig.spkiSha256 ? { spkiSha256: stagedConfig.spkiSha256 } : {}),
          ...(stagedConfig.spkiPinOnly ? { spkiPinOnly: true } : {}),
          resumeOnly: stagedConfig.resumeOnly,
          stagedRepointProbe: true,
          nodeId: stagedConfig.nodeId,
          credential: stagedConfig.credential,
          repoId: stagedConfig.repoId,
          viewRoot: stagedConfig.viewRoot,
          diskQuotaBytes: stagedConfig.quotaBytes,
          readAccessToken: input.readAccessToken,
          signal: ctrl.signal,
          ...(input.onReplicaHealthChange ? { onReplicaHealthChange: input.onReplicaHealthChange } : {}),
        });
      input.setActive(ctrl, task);
    },
    abortStagedStream: async () => {
      const { ctrl, task } = input.getActive();
      ctrl?.abort();
      if (task) await task;
      input.setActive(null, null);
    },
    commitStagedStream: () => undefined,
  };
}

export async function setupThreeCenterFencingFixture(
  t: { readonly after: (fn: () => Promise<void>) => void },
  prefix: string,
  repoId: string,
  nodeId: string,
) {
  const root = mkdtempSync(path.join(tmpdir(), prefix)),
    repoDir = path.join(root, "repo"),
    edgeWorkspace = path.join(root, "edge-workspace"),
    centerUser = path.join(root, "center-user"),
    edgeUser = path.join(root, "edge-user"),
    viewRoot = path.join(root, "edge-views"),
    viewDir = path.join(viewRoot, "repos", repoId, "views", nodeId),
    tlsDir = path.join(root, "tls");
  rosterRepo(repoDir, repoId);
  rosterRepo(edgeWorkspace, repoId);
  registerDaemonRepo({ canonicalRoot: repoDir, repoId, userRoot: centerUser, createConvenienceLinks: false });
  registerDaemonRepo({
    canonicalRoot: edgeWorkspace,
    repoId,
    mode: "remote-edge",
    userRoot: edgeUser,
    createConvenienceLinks: false,
  });
  const owners = await fleetNodeOwners({
    userRoot: centerUser,
    owners: { [nodeId]: "person-one" },
    repoIds: [repoId],
    localPersonId: "owner-center",
  });
  mkdirSync(tlsDir, { recursive: true });
  for (const label of ["a", "b", "c"])
    writeSelfSignedLocalhostCertificate(path.join(tlsDir, `${label}.key`), path.join(tlsDir, `${label}.crt`));
  const keyA = readFileSync(path.join(tlsDir, "a.key")),
    certA = readFileSync(path.join(tlsDir, "a.crt")),
    keyB = readFileSync(path.join(tlsDir, "b.key")),
    certB = readFileSync(path.join(tlsDir, "b.crt")),
    keyC = readFileSync(path.join(tlsDir, "c.key")),
    certC = readFileSync(path.join(tlsDir, "c.crt")),
    spkiOf = (pem: Buffer) =>
      createHash("sha256")
        .update(new X509Certificate(pem).publicKey.export({ format: "der", type: "spki" }))
        .digest("hex");
  const loginServer = createHttpsServer({ key: keyB, cert: certB }, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: `node-token-harness-node-${nodeId}`, expires_in: 300 }));
  });
  loginServer.listen(0, "127.0.0.1");
  await once(loginServer, "listening");
  const loginAddr = loginServer.address();
  assert.ok(loginAddr && typeof loginAddr !== "string");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        loginServer.closeAllConnections();
        loginServer.close(() => resolve());
      }),
  );
  return {
    root,
    repoDir,
    edgeWorkspace,
    centerUser,
    edgeUser,
    viewRoot,
    viewDir,
    owners,
    keyA,
    certA,
    keyB,
    certB,
    keyC,
    certC,
    spkiB: spkiOf(certB),
    spkiC: spkiOf(certC),
    loginUrl: `https://127.0.0.1:${String(loginAddr.port)}`,
  };
}

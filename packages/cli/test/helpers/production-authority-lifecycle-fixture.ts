import { execFileSync } from "node:child_process";
import { sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import {
  createAuthorityKeyRegistryV1,
  firstPinAuthorityKeyV1
} from "../../../application/src/index.ts";
import { openLocalAuthorityKeyStore } from "../../../daemon/src/index.ts";
import { makeJournaledWriteCoordinator } from "../../../kernel/src/index.ts";
import { defaultCliAdapterProvider } from "../../src/composition/adapter-registry.ts";
import { authorityNamespaceProofBytes } from "../../src/daemon/authority-production-state.ts";

export interface ProductionAuthorityLifecycleFixture {
  readonly root: string;
  readonly repoRoot: string;
  readonly authoredRoot: string;
  readonly serviceRoot: string;
  readonly manifestPath: string;
  readonly registryPath: string;
}

export function createProductionAuthorityLifecycleFixture(): ProductionAuthorityLifecycleFixture {
  const root = mkdtempSync(path.join(tmpdir(), "ha-production-authority-"));
  const repoRoot = path.join(root, "repo");
  const authoredRoot = path.join(repoRoot, "harness");
  const serviceRoot = path.join(root, "service-state");
  const keyStateDirectory = path.join(serviceRoot, "keys/canonical");
  mkdirSync(path.join(authoredRoot, "tasks/task_A"), { recursive: true });
  mkdirSync(serviceRoot, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(authoredRoot, "tasks/task_A/INDEX.md"), "---\ntask_id: task_A\nstatus: active\n---\n");
  writeFileSync(path.join(authoredRoot, "people.yaml"), [
    "schema: harness-people/v1",
    "people:",
    "  - personId: person_alice",
    "    displayName: Alice",
    "    primaryEmail: alice@example.test",
    "    roles: [owner]",
    "    credentials:",
    "      - kind: unix-socket-owner-boundary",
    `        issuer: host:${hostname()}`,
    `        subject: ${process.getuid?.() ?? 0}`,
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]",
    ""
  ].join("\n"));
  const keyStore = openLocalAuthorityKeyStore({
    serviceStateRoot: serviceRoot,
    stateDirectory: keyStateDirectory,
    workspaceRoot: repoRoot,
    authorityId: "authority.production",
    issuer: "authority.production"
  });
  const now = Date.now();
  const prepublished = keyStore.createPrepublishedKey({ generation: 1, nowMs: now - 1_000 });
  const prepublishedRegistry = createAuthorityKeyRegistryV1({
    authorityId: "authority.production",
    generation: 1,
    globalRevocationEpoch: 1,
    revision: 1,
    entries: [prepublished]
  });
  const registry = firstPinAuthorityKeyV1({
    registry: prepublishedRegistry,
    keyId: prepublished.keyId,
    expectedPinnedKeyId: prepublished.keyId,
    pinEvidence: "fixture-out-of-band-pin",
    verifierAcknowledgement: "fixture-verifier-ack",
    activatedAtMs: now - 999
  });
  const registryPath = path.join(authoredRoot, "authority-key-registry.json");
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  const unsignedNamespace = {
    schema: "operation-namespace/v1" as const,
    workspaceId: "workspace-production",
    deviceId: "device-production",
    authorityGeneration: 1n,
    namespaceId: "namespace-production",
    expiresAt: BigInt(now + 60 * 60_000),
    issuer: "authority.production",
    keyId: prepublished.keyId
  };
  const proof = sign(
    null,
    authorityNamespaceProofBytes(unsignedNamespace),
    keyStore.signingProfile(registry, now).privateKey
  );
  const manifestPath = path.join(serviceRoot, "authority-production.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    schema: "authority-production-composition/v1",
    serviceStateRoot: serviceRoot,
    repos: [{
      repoId: "canonical",
      canonicalRoot: repoRoot,
      workspaceId: "workspace-production",
      deviceId: "device-production",
      viewId: "view-production",
      sessionId: "session-production",
      authorityId: "authority.production",
      issuer: "authority.production",
      keyRegistryPath: registryPath,
      keyStateDirectory,
      schemaTuple: productionTuple(),
      authorityGeneration: 1,
      revocationEpochs: {
        global: "1", workspace: "1", device: "1", view: "1", principal: "1", executor: "1"
      },
      admissionTokenRef: "admission-production",
      allowedExecutorAgentIds: ["codex"],
      operationNamespace: {
        ...unsignedNamespace,
        authorityGeneration: unsignedNamespace.authorityGeneration.toString(),
        expiresAt: unsignedNamespace.expiresAt.toString(),
        proof: proof.toString("base64url")
      }
    }]
  }, null, 2)}\n`);
  fixtureGit(authoredRoot, "init", "-q");
  fixtureGit(authoredRoot, "add", ".");
  fixtureGit(authoredRoot, "commit", "-q", "-m", "seed authority fixture");
  return { root, repoRoot, authoredRoot, serviceRoot, manifestPath, registryPath };
}

export function productionTuple() {
  return {
    wire: 2, event: 2, receipt: 2, digest: 2, policy: 2,
    commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1,
    localState: 1, applyJournal: 1
  } as const;
}

export function productionWriterRuntime(authoredRoot: string) {
  const repoRoot = path.dirname(authoredRoot);
  return {
    createAttributedCoordinator: (input: Omit<Parameters<typeof makeJournaledWriteCoordinator>[0], "rootDir">) =>
      makeJournaledWriteCoordinator({ ...input, rootDir: repoRoot, autoMaterialize: false }),
    enqueueMaterializerBatch: async ({ sessionId }: { readonly sessionId: string }) =>
      defaultCliAdapterProvider().runLedgerMaterializer(repoRoot, { sessionId }),
    assertWriteFenceHeld: async () => undefined
  };
}

export function fixtureGit(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ZeyuLi",
      GIT_AUTHOR_EMAIL: "33339424+FairladyZ625@users.noreply.github.com",
      GIT_COMMITTER_NAME: "ZeyuLi",
      GIT_COMMITTER_EMAIL: "33339424+FairladyZ625@users.noreply.github.com"
    },
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

import { execFileSync } from "node:child_process";
import { sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import {
  createAuthorityKeyRegistryV1,
  firstPinAuthorityKeyV1
} from "../../../application/src/index.ts";
import {
  createDaemonGenerationWitness,
  openLocalAuthorityKeyStore,
  publishNextDaemonGeneration,
  readOrCreateDaemonMachineId
} from "../../../daemon/src/index.ts";
import { makeJournaledWriteCoordinator } from "../../../kernel/src/index.ts";
import { defaultCliAdapterProvider } from "../../src/composition/adapter-registry.ts";
import { authorityNamespaceProofBytes } from "@harness-anything/daemon";

export interface ProductionAuthorityLifecycleFixture {
  readonly root: string;
  readonly repoRoot: string;
  readonly authoredRoot: string;
  readonly serviceRoot: string;
  readonly manifestPath: string;
  readonly registryPath: string;
  readonly repos: ReadonlyArray<ProductionAuthorityLifecycleRepoFixture>;
}

export interface ProductionAuthorityLifecycleRepoFixture {
  readonly repoId: string;
  readonly repoRoot: string;
  readonly authoredRoot: string;
  readonly registryPath: string;
  readonly keyStateDirectory: string;
}

export function createProductionAuthorityLifecycleFixture(
  options: { readonly repoIds?: ReadonlyArray<string> } = {}
): ProductionAuthorityLifecycleFixture {
  const root = mkdtempSync(path.join(tmpdir(), "ha-production-authority-"));
  const serviceRoot = path.join(root, "service-state");
  mkdirSync(serviceRoot, { recursive: true, mode: 0o700 });
  const repoIds = options.repoIds ?? ["canonical"];
  if (repoIds.length === 0 || new Set(repoIds).size !== repoIds.length) {
    throw new Error("production authority fixture requires unique repo ids");
  }
  const now = Date.now();
  const repos = repoIds.map((repoId, index): ProductionAuthorityLifecycleRepoFixture & { readonly manifest: Record<string, unknown> } => {
    const legacyCanonical = repoIds.length === 1 && repoId === "canonical";
    const fixtureSuffix = legacyCanonical ? "production" : repoId;
    const repoRoot = path.join(root, repoIds.length === 1 ? "repo" : `repo-${repoId}`);
    const authoredRoot = path.join(repoRoot, "harness");
    const keyStateDirectory = path.join(serviceRoot, `keys/${repoId}`);
    mkdirSync(path.join(authoredRoot, "tasks/task_A"), { recursive: true });
    writeFileSync(path.join(authoredRoot, "harness.yaml"), [
      "schema: harness-anything/v1",
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      "settings:",
      "  identity:",
      "    personId: person_alice",
      "    displayName: Alice",
      ""
    ].join("\n"));
    writeFileSync(path.join(authoredRoot, "tasks/task_A/INDEX.md"), "---\ntask_id: task_A\nstatus: active\n---\n");
    writeFileSync(path.join(authoredRoot, "people.yaml"), fixturePeopleRoster());
    const keyStore = openLocalAuthorityKeyStore({
      serviceStateRoot: serviceRoot,
      stateDirectory: keyStateDirectory,
      workspaceRoot: repoRoot,
      authorityId: "authority.production",
      issuer: "authority.production"
    });
    const prepublished = keyStore.createPrepublishedKey({ generation: 1, nowMs: now - 1_000 - index });
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
      pinEvidence: legacyCanonical ? "fixture-out-of-band-pin" : `fixture-out-of-band-pin-${repoId}`,
      verifierAcknowledgement: legacyCanonical ? "fixture-verifier-ack" : `fixture-verifier-ack-${repoId}`,
      activatedAtMs: now - 999 - index
    });
    const registryPath = path.join(authoredRoot, "authority-key-registry.json");
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    const unsignedNamespace = {
      schema: "operation-namespace/v1" as const,
      workspaceId: `workspace-${fixtureSuffix}`,
      deviceId: `device-${fixtureSuffix}`,
      authorityGeneration: 1n,
      namespaceId: `namespace-${fixtureSuffix}`,
      expiresAt: BigInt(now + 60 * 60_000),
      issuer: "authority.production",
      keyId: prepublished.keyId
    };
    const proof = sign(
      null,
      authorityNamespaceProofBytes(unsignedNamespace),
      keyStore.signingProfile(registry, now).privateKey
    );
    fixtureGit(authoredRoot, "init", "-q");
    fixtureGit(authoredRoot, "add", ".");
    fixtureGit(authoredRoot, "commit", "-q", "-m", "seed authority fixture");
    return {
      repoId,
      repoRoot,
      authoredRoot,
      registryPath,
      keyStateDirectory,
      manifest: {
        repoId,
        canonicalRoot: repoRoot,
        workspaceId: unsignedNamespace.workspaceId,
        deviceId: unsignedNamespace.deviceId,
        viewId: `view-${fixtureSuffix}`,
        sessionId: `session-${fixtureSuffix}`,
        authorityId: "authority.production",
        issuer: "authority.production",
        keyRegistryPath: registryPath,
        keyStateDirectory,
        schemaTuple: productionTuple(),
        authorityGeneration: 1,
        revocationEpochs: {
          global: "1", workspace: "1", device: "1", view: "1", principal: "1", executor: "1"
        },
        admissionTokenRef: `admission-${fixtureSuffix}`,
        allowedExecutorAgentIds: ["codex"],
        operationNamespace: {
          ...unsignedNamespace,
          authorityGeneration: unsignedNamespace.authorityGeneration.toString(),
          expiresAt: unsignedNamespace.expiresAt.toString(),
          proof: proof.toString("base64url")
        }
      }
    };
  });
  const manifestPath = path.join(serviceRoot, "authority-production.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    schema: "authority-production-composition/v1",
    serviceStateRoot: serviceRoot,
    repos: repos.map((repo) => repo.manifest)
  }, null, 2)}\n`);
  const [primary] = repos;
  if (!primary) throw new Error("production authority fixture requires a primary repo");
  return {
    root,
    repoRoot: primary.repoRoot,
    authoredRoot: primary.authoredRoot,
    serviceRoot,
    manifestPath,
    registryPath: primary.registryPath,
    repos: repos.map(({ manifest: _manifest, ...repo }) => repo)
  };
}

function fixturePeopleRoster(): string {
  return [
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
  ].join("\n");
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
  const userRoot = path.join(path.dirname(repoRoot), "daemon-generation");
  const endpointIdentity = path.join(userRoot, "authority.sock");
  const machineId = readOrCreateDaemonMachineId(userRoot);
  const generation = publishNextDaemonGeneration({
    userRoot,
    endpointIdentity,
    machineId,
    daemonInstanceId: `production-fixture-${process.pid}`
  });
  const generationWitness = createDaemonGenerationWitness({
    userRoot,
    endpointIdentity,
    machineId,
    daemonGeneration: generation.daemonGeneration
  });
  const materialize = ({ sessionId }: { readonly sessionId: string }) =>
    defaultCliAdapterProvider().runLedgerMaterializer(repoRoot, { sessionId });
  return {
    createAttributedCoordinator: (input: Omit<Parameters<typeof makeJournaledWriteCoordinator>[0], "rootDir">) =>
      makeJournaledWriteCoordinator({ ...input, rootDir: repoRoot, autoMaterialize: false }),
    enqueueMaterializerBatch: materialize,
    enqueueAuthorityPublication: async (input: {
      readonly sessionId: string;
      readonly publish: () => Promise<import("../../../kernel/src/index.ts").FlushReport>;
    }) => {
      const flush = await input.publish();
      return { flush, ...(flush.committed && flush.opCount > 0 ? { materialization: materialize(input) } : {}) };
    },
    assertWriteFenceHeld: async () => undefined,
    daemonGenerationCapability: () => ({ mode: "generation" as const }),
    daemonGenerationContext: () => ({
      witness: generationWitness,
      machineId,
      daemonGeneration: generation.daemonGeneration,
      runtimeRegistrationId: "11111111-1111-4111-8111-111111111111"
    })
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

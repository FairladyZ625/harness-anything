// harness-test-tier: integration
import assert from "node:assert/strict";
import { createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AuthorityKeyRegistryV1 } from "../../application/src/index.ts";
import {
  authorityNamespaceProofBytes,
  loadAuthorityProductionManifest,
  openLocalAuthorityKeyStore
} from "@harness-anything/daemon";
import {
  createProductionAuthorityLifecycleFixture as createFixture
} from "./helpers/production-authority-lifecycle-fixture.ts";
import {
  assertPendingReceiptSettlement,
  pollUntil,
  runRawJson,
  stopDaemon,
  waitForReceiptCommitted
} from "./helpers/daemon-cli.ts";

test("authority repo enrollment reaches a production daemon and its first governance write", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = path.join(fixture.root, "enrolled-daemon-user");
  const serviceRoot = path.join(fixture.root, "enrolled-service-state");
  const manifestPath = path.join(serviceRoot, "authority-production.json");
  const env = productionCliEnv(userRoot);
  try {
    const enrolled = runRawJson(fixture.repoRoot, [
      "authority", "repo", "enroll",
      "--repo-id", "enrolled",
      "--repo-root", fixture.repoRoot,
      "--manifest", manifestPath,
      "--service-state-root", serviceRoot,
      "--namespace-ttl-ms", "3600000"
    ], env);
    assert.equal(enrolled.ok, true, JSON.stringify(enrolled));
    const enrollmentReport = receiptReport(enrolled);
    assert.equal(enrollmentReport.trustDomain, "independent-per-repository");
    assert.equal(enrollmentReport.authorityId, "authority.repo.enrolled");
    assert.equal(
      enrollmentReport.nextCommands?.daemonStart,
      "ha --repo enrolled daemon start --service --authority-manifest " + JSON.stringify(manifestPath)
    );
    assert.doesNotMatch(JSON.stringify(enrolled), /BEGIN [A-Z ]*PRIVATE KEY|privateKey|\.pk8/u);

    const started = runRawJson(fixture.repoRoot, [
      "--repo", "enrolled",
      "daemon", "start", "--service",
      "--authority-manifest", manifestPath,
      "--user-root", userRoot
    ], env);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.command, "daemon-start");

    const firstWrite = runRawJson(fixture.repoRoot, [
      "--repo", "enrolled",
      "task", "create",
      "--title", "first governance write"
    ], env);
    assert.equal(firstWrite.ok, true, JSON.stringify(firstWrite));
    const taskData = receiptData(firstWrite);
    assert.equal(taskData.status, "planned");
    assert.equal(typeof taskData.taskId, "string");
    const pending = assertPendingReceiptSettlement(firstWrite);
    await waitForReceiptCommitted(fixture.repoRoot, pending.receiptId, env);

    const committedOperations = await pollUntil(
      () => operationRecords(serviceRoot, "enrolled"),
      (records) => {
        const byId = new Map(records.map((record) => [record.opId, record]));
        return pending.authorityOperationIds.every((opId) => byId.get(opId)?.state === "COMMITTED");
      },
      (records, error) => JSON.stringify({ opIds: pending.authorityOperationIds, records, error: String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    const operation = committedOperations.find((record) =>
      record.opId === pending.authorityOperationIds.at(-1));
    assert.ok(operation, JSON.stringify(committedOperations));
    assert.equal(operation.state, "COMMITTED", JSON.stringify(operation));
    assert.equal(operation.receipt?.tag, "COMMITTED", JSON.stringify(operation));
    assert.equal(pending.authorityOperationIds.includes(operation.opId!), true, JSON.stringify(operation));
    assert.equal(typeof operation.commitSha, "string", JSON.stringify(operation));
    const manifest = loadAuthorityProductionManifest(manifestPath);
    const config = manifest.repos.find((repo) => repo.repoId === "enrolled");
    assert.ok(config);
    assert.equal(config.authorityId, "authority.repo.enrolled");
    assert.equal(verifyNamespace(config, readRegistry(config.keyRegistryPath)), true);
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("authority repo resign preserves the old public domain, switches the manifest, and records both proofs", () => {
  const fixture = createFixture({ repoIds: ["repo-a", "repo-b"] });
  const manifestJson = JSON.parse(readFileSync(fixture.manifestPath, "utf8")) as {
    readonly schema: string;
    readonly serviceStateRoot: string;
    repos: Array<Record<string, unknown>>;
  };
  const repoB = manifestJson.repos.find((repo) => repo.repoId === "repo-b");
  const repoAFixture = fixture.repos.find((repo) => repo.repoId === "repo-a");
  assert.ok(repoB);
  assert.ok(repoAFixture);
  try {
    const oldRegistry = readRegistry(repoAFixture.registryPath);
    const oldKeyStore = openLocalAuthorityKeyStore({
      serviceStateRoot: fixture.serviceRoot,
      stateDirectory: repoAFixture.keyStateDirectory,
      workspaceRoot: repoAFixture.repoRoot,
      authorityId: "authority.production",
      issuer: "authority.production"
    });
    const activeOldKey = oldRegistry.entries.find((entry) => entry.state === "ACTIVE_SIGNING");
    assert.ok(activeOldKey);
    const oldNamespace = repoB.operationNamespace as Record<string, string>;
    const unsignedSharedNamespace = {
      schema: "operation-namespace/v1" as const,
      workspaceId: oldNamespace.workspaceId,
      deviceId: oldNamespace.deviceId,
      authorityGeneration: BigInt(oldNamespace.authorityGeneration),
      namespaceId: oldNamespace.namespaceId,
      expiresAt: BigInt(oldNamespace.expiresAt),
      issuer: "authority.production",
      keyId: activeOldKey.keyId
    };
    const oldProfile = oldKeyStore.signingProfile(oldRegistry, Date.now());
    if (oldProfile.algorithm !== "Ed25519") throw new Error("test fixture did not create an Ed25519 key");
    const oldProof = sign(null, authorityNamespaceProofBytes(unsignedSharedNamespace), oldProfile.privateKey);
    manifestJson.repos = manifestJson.repos.map((repo) => repo.repoId === "repo-b"
      ? {
          ...repo,
          keyRegistryPath: repoAFixture.registryPath,
          keyStateDirectory: repoAFixture.keyStateDirectory,
          operationNamespace: {
            ...unsignedSharedNamespace,
            authorityGeneration: unsignedSharedNamespace.authorityGeneration.toString(),
            expiresAt: unsignedSharedNamespace.expiresAt.toString(),
            proof: oldProof.toString("base64url")
          }
        }
      : repo);
    writeFileSync(fixture.manifestPath, JSON.stringify(manifestJson, null, 2) + "\n");

    const beforeManifest = loadAuthorityProductionManifest(fixture.manifestPath);
    const before = beforeManifest.repos.find((repo) => repo.repoId === "repo-b");
    assert.ok(before);
    assert.equal(verifyNamespace(before, oldRegistry), true);
    const beforeSide = {
      authorityId: before.authorityId,
      registryManifestDigest: oldRegistry.manifestDigest,
      namespaceId: before.operationNamespace.namespaceId
    };

    const resigned = runRawJson(fixture.repoRoot, [
      "authority", "repo", "resign",
      "--repo-id", "repo-b",
      "--manifest", fixture.manifestPath
    ], { HARNESS_DAEMON_MODE: "local" });
    assert.equal(resigned.ok, true, JSON.stringify(resigned));
    assert.doesNotMatch(JSON.stringify(resigned), /BEGIN [A-Z ]*PRIVATE KEY|privateKey|\.pk8/u);
    const resignReport = receiptReport(resigned);
    const switchRecordPath = String(resignReport.switchRecordPath);
    const switchRecord = JSON.parse(readFileSync(switchRecordPath, "utf8")) as Record<string, any>;
    assert.equal(switchRecord.state, "applied");
    assert.equal(switchRecord.sharedAuthorityDetected, true);
    assert.equal(switchRecord.previous.namespaceProofVerified, true);
    assert.equal(switchRecord.next.namespaceProofVerified, true);
    assert.equal(switchRecord.previous.registryManifestDigest, beforeSide.registryManifestDigest);
    assert.equal(switchRecord.previous.namespace.namespaceId, beforeSide.namespaceId);
    assert.equal(switchRecord.previous.publicKeyRegistry.manifestDigest, oldRegistry.manifestDigest);
    assert.doesNotMatch(JSON.stringify(switchRecord), /BEGIN [A-Z ]*PRIVATE KEY|privateKey|\.pk8/u);

    const afterManifest = loadAuthorityProductionManifest(fixture.manifestPath);
    const after = afterManifest.repos.find((repo) => repo.repoId === "repo-b");
    const repoAAfter = afterManifest.repos.find((repo) => repo.repoId === "repo-a");
    assert.ok(after);
    assert.ok(repoAAfter);
    const nextRegistry = readRegistry(after.keyRegistryPath);
    assert.notEqual(after.authorityId, beforeSide.authorityId);
    assert.notEqual(after.authorityId, repoAAfter.authorityId);
    assert.equal(verifyNamespace(after, nextRegistry), true);
    assert.equal(switchRecord.next.authorityId, after.authorityId);
    assert.equal(switchRecord.next.registryManifestDigest, nextRegistry.manifestDigest);
    assert.equal(repoAAfter.authorityId, "authority.production");
    assert.equal(repoAAfter.keyRegistryPath, repoAFixture.registryPath);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function productionCliEnv(userRoot: string): Readonly<Record<string, string>> {
  return {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    HARNESS_DAEMON_REQUEST_TIMEOUT_MS: "35000",
    CODEX_THREAD_ID: "authority-repo-enrollment-integration"
  };
}

function receiptData(receipt: Record<string, unknown>): Record<string, any> {
  const details = receipt.details as Record<string, unknown> | undefined;
  return (details?.data as Record<string, any> | undefined) ?? {};
}

function receiptReport(receipt: Record<string, unknown>): Record<string, any> {
  const report = receiptData(receipt).report;
  assert.ok(report && typeof report === "object" && !Array.isArray(report), JSON.stringify(receipt));
  return report as Record<string, any>;
}

function operationRecords(serviceRoot: string, repoId: string): ReadonlyArray<Record<string, any>> {
  const operationPath = path.join(serviceRoot, "authority", Buffer.from(repoId, "utf8").toString("base64url"), "operations.jsonl");
  const rows = readFileSync(operationPath, "utf8").split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      readonly table?: string;
      readonly key?: string;
      readonly value?: Record<string, any>;
    })
    .filter((row) => row.table === "operation" && row.key && row.value);
  assert.ok(rows.length > 0, operationPath);
  const latest = new Map<string, Record<string, any>>();
  for (const row of rows) latest.set(row.key!, row.value!);
  return [...latest.values()];
}

function readRegistry(registryPath: string): AuthorityKeyRegistryV1 {
  return JSON.parse(readFileSync(registryPath, "utf8")) as AuthorityKeyRegistryV1;
}

function verifyNamespace(
  config: ReturnType<typeof loadAuthorityProductionManifest>["repos"][number],
  registry: AuthorityKeyRegistryV1
): boolean {
  const entry = registry.entries.find((candidate) =>
    candidate.keyId === config.operationNamespace.keyId
    && candidate.authorityId === config.authorityId
    && candidate.issuer === config.issuer
    && candidate.generation === config.authorityGeneration
  );
  assert.ok(entry);
  const publicKey = createPublicKey({
    key: Buffer.from(entry.publicKeySpki, "base64url"),
    format: "der",
    type: "spki"
  });
  return verify(null, authorityNamespaceProofBytes({
    schema: config.operationNamespace.schema,
    workspaceId: config.operationNamespace.workspaceId,
    deviceId: config.operationNamespace.deviceId,
    authorityGeneration: config.operationNamespace.authorityGeneration,
    namespaceId: config.operationNamespace.namespaceId,
    expiresAt: config.operationNamespace.expiresAt,
    issuer: config.operationNamespace.issuer,
    keyId: config.operationNamespace.keyId
  }), publicKey, config.operationNamespace.proof);
}

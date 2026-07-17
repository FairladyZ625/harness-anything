// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  createAuthorityCutoverEntityRegistryQualification,
  createAuthorityCutoverControlService,
  createAuthorityKeyRegistryV1,
  isCompleteAuthorityCommittedReceiptV2
} from "../../application/src/index.ts";
import { protocolSchemaTupleDigest } from "../../application/src/authority/cutover-control.ts";
import {
  channelDigest32,
  connectionGeneration,
  openLocalAuthorityKeyStore
} from "../../daemon/src/index.ts";
import { entityRegistry, entityRegistryKinds, taskEntityId, type WriteOp } from "../../kernel/src/index.ts";
import { daemonActorAttribution } from "../src/composition/actor-attribution.ts";
import {
  authorityNamespaceProofBytes,
  loadAuthorityProductionManifest
} from "../src/daemon/authority-production-state.ts";
import { createProductionAuthorityLifecycle } from "../src/daemon/production-authority-lifecycle.ts";
import { createAuthorityProductionScanner } from "../src/daemon/authority-production-scanner.ts";
import { openDurableAuthorityServiceState } from "../src/daemon/authority-service-state.ts";

test("production lifecycle uses external Ed25519 material, durable state, live context and the X V2 event log", async () => {
  const fixture = createFixture();
  try {
    const lifecycle = createProductionAuthorityLifecycle({ manifestPath: fixture.manifestPath });
    const started = await lifecycle.startRepo(
      { repoId: "canonical", canonicalRoot: fixture.repoRoot },
      writerRuntime(fixture.authoredRoot)
    );
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    if (!started.ok) return;
    const actor = {
      personId: "person_alice",
      displayName: "Alice",
      primaryEmail: "alice@example.test",
      providerId: "transport-derived/v1",
      resolvedCredential: {
        kind: "unix-socket-owner-boundary" as const,
        issuer: `host:${hostname()}`,
        subject: String(process.getuid?.() ?? 0)
      }
    };
    const submission = started.component.bindConnection({
      schema: "authority-connection-context/v1",
      connectionId: "production-connection",
      connectionGeneration: connectionGeneration("production-generation"),
      actor,
      repoId: "canonical",
      channelBinding: { digest: channelDigest32(Buffer.alloc(32, 0x51)), source: "transport-observed" },
      peerCredential: {
        schema: "os-observed-peer-credential/v1",
        platform: "darwin",
        source: "getpeereid",
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0
      }
    });
    const receipt = await submission.submit({
      command: {
        rootDir: fixture.repoRoot,
        json: true,
        action: { kind: "progress-append", taskId: "task_A", text: "production authority path\n" }
      },
      attribution: daemonActorAttribution(actor, { kind: "agent", id: "codex" }),
      currentSession: {
        runtime: "codex",
        sessionId: "session-production",
        source: "manual",
        detectedAt: new Date().toISOString()
      },
      canonicalEntityId: taskEntityId("task_A")
    });

    assert.equal(receipt.tag, "COMMITTED", JSON.stringify(receipt));
    if (receipt.tag === "COMMITTED") assert.equal(isCompleteAuthorityCommittedReceiptV2(receipt), true);
    assert.match(readFileSync(path.join(fixture.authoredRoot, "tasks/task_A/progress.md"), "utf8"), /production authority path/u);
    const eventFiles = execFileSync("find", [path.join(fixture.authoredRoot, "authority-attribution-events/v2"), "-type", "f"], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
    assert.equal(eventFiles.length, 1);
    const eventBody = readFileSync(eventFiles[0]!, "utf8");
    assert.match(eventBody, /attribution-event\/v2/u);
    assert.doesNotMatch(eventBody, /PRIVATE KEY/u);
    assert.equal(readFileSync(path.join(fixture.serviceRoot, "authority/Y2Fub25pY2Fs/bindings.jsonl"), "utf8").includes("token:"), true);
    await lifecycle.stopAll("daemon-shutdown");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("production manifest rejects service state that overlaps the canonical repository", () => {
  const fixture = createFixture();
  try {
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8")) as Record<string, unknown>;
    manifest.serviceStateRoot = path.join(fixture.repoRoot, "service-state");
    writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(
      () => loadAuthorityProductionManifest(fixture.manifestPath),
      /AUTHORITY_PRODUCTION_SERVICE_STATE_MUST_BE_EXTERNAL/u
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("cutover qualification fails closed unless all nine kinds and five facets are present", () => {
  const registrations = [
    "task", "decision", "fact", "relation", "module", "session", "execution", "consent", "review"
  ].map((kind) => ({
    kind,
    identityCodecStatus: "ready",
    storageLocatorStatus: "ready",
    mutationContractStatus: "ready",
    semanticDiffStatus: "typed-only",
    projectionFacetStatus: "ready",
    mutationActions: kind === "consent" ? ["grant", "consume", "expire"] : ["write"]
  }));
  assert.doesNotThrow(() => createAuthorityCutoverEntityRegistryQualification(registrations));
  assert.throws(
    () => createAuthorityCutoverEntityRegistryQualification(registrations.filter((row) => row.kind !== "consent")),
    /AUTHORITY_CUTOVER_REGISTRY_KIND_SET_INVALID/u
  );
  assert.throws(
    () => createAuthorityCutoverEntityRegistryQualification(registrations.map((row) => row.kind === "consent"
      ? { ...row, projectionFacetStatus: "deferred" }
      : row)),
    /AUTHORITY_CUTOVER_REGISTRY_FACET_NOT_QUALIFIED:consent/u
  );
  assert.throws(
    () => createAuthorityCutoverEntityRegistryQualification(registrations.map((row) => row.kind === "consent"
      ? { ...row, mutationActions: ["grant", "consume"] }
      : row)),
    /AUTHORITY_CUTOVER_CONSENT_ACTIONS_INCOMPLETE/u
  );
});

test("production cutover drain closes admission and requires recorded-tuple classifications", async () => {
  const fixture = createFixture();
  const tuple = productionTuple();
  try {
    const seeded = openDurableAuthorityServiceState({
      serviceStateRoot: fixture.serviceRoot,
      repoId: "canonical"
    });
    await seeded.operationRegistry.put({
      workspaceId: "workspace-production",
      opId: "pending-before-drain",
      semanticDigest: "a".repeat(64),
      state: "RECEIVED",
      recordedProtocol: {
        kind: "semantic-mutation-envelope/v2",
        schemaTuple: tuple
      }
    });
    await seeded.close();

    const lifecycle = createProductionAuthorityLifecycle({ manifestPath: fixture.manifestPath });
    const started = await lifecycle.startRepo(
      { repoId: "canonical", canonicalRoot: fixture.repoRoot },
      writerRuntime(fixture.authoredRoot)
    );
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    if (!started.ok) return;

    let releaseAdmittedOperation!: () => void;
    let drainSettled = false;
    const admittedOperation = started.component.cutoverControl.runDuringOpenAdmission(() => new Promise<void>((resolve) => {
      releaseAdmittedOperation = resolve;
    }));
    const blockedPromise = started.component.cutoverControl.drain({ classifications: [] }).finally(() => {
      drainSettled = true;
    });
    await Promise.resolve();
    assert.equal(started.component.cutoverControl.status().admission, "closed");
    assert.equal(drainSettled, false);
    releaseAdmittedOperation();
    await admittedOperation;
    const blocked = await blockedPromise;
    assert.equal(blocked.status, "BLOCKED_UNCLASSIFIED_OPERATIONS");
    assert.deepEqual(blocked.unclassifiedOperationIds, ["pending-before-drain"]);
    assert.equal(blocked.admission, "closed");

    await assert.rejects(started.component.cutoverControl.drain({
      classifications: [{
        opId: "pending-before-drain",
        disposition: "retryable-not-committed",
        recordedTupleDigest: "f".repeat(64),
        evidenceRef: "rehearsal/wrong-tuple-must-be-ignored"
      }]
    }), /AUTHORITY_CUTOVER_RECORDED_TUPLE_MISMATCH/u);

    const classified = await started.component.cutoverControl.drain({
      classifications: [{
        opId: "pending-before-drain",
        disposition: "retryable-not-committed",
        recordedTupleDigest: protocolSchemaTupleDigest(tuple),
        evidenceRef: "rehearsal/pending-before-drain"
      }]
    });
    assert.equal(classified.status, "DRAINED");
    assert.equal(classified.unclassifiedOperationIds.length, 0);
    assert.equal(classified.admission, "closed");

    await lifecycle.stopAll("daemon-shutdown");
    const recoveredLifecycle = createProductionAuthorityLifecycle({ manifestPath: fixture.manifestPath });
    const recovered = await recoveredLifecycle.startRepo(
      { repoId: "canonical", canonicalRoot: fixture.repoRoot },
      writerRuntime(fixture.authoredRoot)
    );
    assert.equal(recovered.ok, true, recovered.ok ? "" : recovered.error);
    if (!recovered.ok) return;
    assert.equal(recovered.component.cutoverControl.status().phase, "DRAINED");
    assert.equal(recovered.component.cutoverControl.status().admission, "closed");
    assert.equal(recovered.component.cutoverControl.status().lastDrainReceiptId, classified.receiptId);
    await recoveredLifecycle.stopAll("daemon-shutdown");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("production final scan blocks while the enabled V2 writer set covers only task decision and module", async () => {
  const fixture = createFixture();
  try {
    const lifecycle = createProductionAuthorityLifecycle({ manifestPath: fixture.manifestPath });
    const started = await lifecycle.startRepo(
      { repoId: "canonical", canonicalRoot: fixture.repoRoot },
      writerRuntime(fixture.authoredRoot)
    );
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    if (!started.ok) return;
    assert.equal((await started.component.cutoverControl.drain({ classifications: [] })).status, "DRAINED");
    await assert.rejects(
      started.component.cutoverControl.scan({ profileId: "production-final-scan/v1" }),
      /AUTHORITY_CUTOVER_V2_WRITER_KIND_SET_INCOMPLETE:missing=consent,execution,fact,relation,review,session/u
    );
    await lifecycle.stopAll("daemon-shutdown");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fully qualified isolated control issues two independent scans and a durable exact-equality receipt", async () => {
  const fixture = createFixture();
  try {
    const firstState = qualifiedCutoverControl(fixture);
    const control = firstState.control;
    assert.equal((await control.drain({ classifications: [] })).status, "DRAINED");
    const first = await control.scan({ profileId: "production-final-scan/v1" });
    const second = await control.scan({ profileId: "production-final-scan/v1" });
    assert.notEqual(first.scanId, second.scanId);
    assert.equal(first.canonicalDigest, second.canonicalDigest);
    assert.equal(first.snapshot.admission, "closed");
    assert.equal(first.snapshot.pendingOperationCount, 0);
    assert.match(first.snapshot.configurationDigest, /^[a-f0-9]{64}$/u);
    assert.equal(first.snapshot.barrier.status, "HELD");
    assert.equal(first.snapshot.entityRegistryQualification.matrixCellCount, 45);
    assert.deepEqual(first.snapshot.entityRegistryQualification.requiredKinds, [
      "task", "decision", "fact", "relation", "module", "session", "execution", "consent", "review"
    ]);
    assert.deepEqual(first.snapshot.entityRegistryQualification.requiredFacets, [
      "identityCodec", "storageLocator", "mutationContract", "semanticDiff", "projectionFacet"
    ]);
    assert.deepEqual(
      first.snapshot.entityRegistryQualification.rows.find((row) => row.kind === "consent")?.mutationActions,
      ["grant", "consume", "expire"]
    );
    assert.match(first.snapshot.entityRegistryQualification.qualificationDigest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(first.snapshot.writerInventory.configuredFreshWriters, [{
      protocol: "authority-operation/v1",
      state: "disabled"
    }, {
      protocol: "semantic-mutation-envelope/v2",
      state: "admission-closed"
    }]);

    const equality = control.confirmEquality({
      firstScanId: first.scanId,
      secondScanId: second.scanId
    });
    assert.equal(equality.status, "DOUBLE_FINAL_SCAN_PASS");
    assert.equal(equality.canonicalDigest, first.canonicalDigest);
    assert.equal(control.status().lastEqualityReceiptId, equality.receiptId);

    await firstState.close();
    const recovered = qualifiedCutoverControl(fixture);
    assert.equal(recovered.control.status().lastEqualityReceiptId, equality.receiptId);
    await recovered.close();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("production scanner detects content changes behind a stable untracked path", async () => {
  const fixture = createFixture();
  try {
    const state = qualifiedCutoverControl(fixture);
    const control = state.control;
    assert.equal((await control.drain({ classifications: [] })).status, "DRAINED");
    const localPath = path.join(fixture.authoredRoot, "untracked-evidence.txt");
    writeFileSync(localPath, "first body\n");
    const first = await control.scan({ profileId: "production-final-scan/v1" });
    writeFileSync(localPath, "second body\n");
    const second = await control.scan({ profileId: "production-final-scan/v1" });

    assert.notEqual(first.snapshot.repository.workingTreeDigest, second.snapshot.repository.workingTreeDigest);
    assert.equal(control.confirmEquality({ firstScanId: first.scanId, secondScanId: second.scanId }).status, "FINAL_SCAN_MISMATCH");
    await state.close();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("named boundary retires the legacy tuple and rollback only freezes then forward re-enables V2", async () => {
  const fixture = createFixture();
  try {
    const firstState = qualifiedCutoverControl(fixture);
    const control = firstState.control;
    assert.equal((await control.drain({ classifications: [] })).status, "DRAINED");
    const first = await control.scan({ profileId: "production-final-scan/v1" });
    const second = await control.scan({ profileId: "production-final-scan/v1" });
    const equality = control.confirmEquality({ firstScanId: first.scanId, secondScanId: second.scanId });

    const boundary = control.activateBoundary({
      boundaryId: "sme-v2-2026-07-17",
      equalityReceiptId: equality.receiptId,
      expectedSelectedSchemaTupleDigest: protocolSchemaTupleDigest(productionTuple())
    });
    assert.equal(boundary.status, "BOUNDARY_ACTIVE");
    assert.equal(boundary.v1FreshWriterRetired, true);
    assert.equal(boundary.entityRegistryQualificationDigest, second.snapshot.entityRegistryQualification.qualificationDigest);
    assert.equal(boundary.retainedV1ReadOnly, true);
    assert.equal(boundary.admission, "open");

    const frozen = control.freeze({
      reason: "forward fix rehearsal",
      expectedBoundaryReceiptDigest: boundary.receiptDigest
    });
    assert.equal(frozen.status, "CONTAINED_WRITES_FROZEN");
    assert.equal(frozen.v1FreshWriterRestored, false);
    await assert.rejects(control.runDuringOpenAdmission(async () => undefined), /AUTHORITY_CUTOVER_ADMISSION_CLOSED/u);

    const frozenFirst = await control.scan({ profileId: "production-final-scan/v1" });
    const frozenSecond = await control.scan({ profileId: "production-final-scan/v1" });
    const frozenEquality = control.confirmEquality({
      firstScanId: frozenFirst.scanId,
      secondScanId: frozenSecond.scanId
    });
    const reenabled = control.reEnable({
      boundaryId: boundary.boundaryId,
      expectedFreezeReceiptDigest: frozen.receiptDigest,
      equalityReceiptId: frozenEquality.receiptId,
      forwardFixRef: "fix/w6-forward-1"
    });
    assert.equal(reenabled.status, "V2_ADMISSION_REENABLED");
    assert.equal(reenabled.v1FreshWriterRestored, false);
    assert.equal(control.status().phase, "BOUNDARY_ACTIVE");
    assert.equal(control.status().admission, "open");
    assert.equal(control.status().v1FreshWriterRetired, true);
    await assert.doesNotReject(control.runDuringOpenAdmission(async () => undefined));

    await firstState.close();
    const recovered = qualifiedCutoverControl(fixture);
    assert.equal(recovered.control.status().phase, "BOUNDARY_ACTIVE");
    assert.equal(recovered.control.status().v1FreshWriterRetired, true);
    await recovered.close();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function qualifiedCutoverControl(fixture: {
  readonly authoredRoot: string;
  readonly serviceRoot: string;
}) {
  const state = openDurableAuthorityServiceState({
    serviceStateRoot: fixture.serviceRoot,
    repoId: "canonical"
  });
  const qualification = createAuthorityCutoverEntityRegistryQualification(
    entityRegistryKinds.map((kind) => {
      const registration = entityRegistry[kind];
      return {
        kind,
        identityCodecStatus: registration.identityCodec.status,
        storageLocatorStatus: registration.storageLocator.status,
        mutationContractStatus: registration.mutationContract.status,
        semanticDiffStatus: registration.semanticDiff.status,
        projectionFacetStatus: registration.projectionFacet.status,
        mutationActions: registration.mutationContract.status === "ready"
          ? registration.mutationContract.actions
          : []
      };
    })
  );
  return {
    control: createAuthorityCutoverControlService({
      repoId: "canonical",
      workspaceId: "workspace-production",
      selectedSchemaTuple: productionTuple(),
      operationRegistry: state.operationRegistry,
      stateStore: state.cutoverState,
      productionScanner: createAuthorityProductionScanner({ authoredRoot: fixture.authoredRoot }),
      productionContext: {
        authorityId: "authority.production",
        configurationDigest: "a".repeat(64),
        entityRegistryQualification: qualification,
        enabledV2WriterKinds: entityRegistryKinds,
        assertWriteFenceHeld: async () => undefined
      }
    }),
    close: state.close
  };
}

function createFixture(): {
  readonly root: string;
  readonly repoRoot: string;
  readonly authoredRoot: string;
  readonly serviceRoot: string;
  readonly manifestPath: string;
} {
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
  const registry = createAuthorityKeyRegistryV1({
    authorityId: "authority.production",
    generation: 1,
    globalRevocationEpoch: 1,
    revision: 1,
    entries: [{ ...prepublished, state: "ACTIVE_SIGNING" }]
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
  git(authoredRoot, "init", "-q");
  git(authoredRoot, "add", ".");
  git(authoredRoot, "commit", "-q", "-m", "seed authority fixture");
  return { root, repoRoot, authoredRoot, serviceRoot, manifestPath };
}

function productionTuple() {
  return {
    wire: 2, event: 2, receipt: 2, digest: 2, policy: 2,
    commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1,
    localState: 1, applyJournal: 1
  } as const;
}

function writerRuntime(authoredRoot: string) {
  return {
    createAttributedCoordinator: () => {
      let pending: WriteOp | undefined;
      return {
        enqueue: (operation: WriteOp) => Effect.sync(() => {
          pending = operation;
          return { opId: operation.opId, entityId: operation.entityId, accepted: true as const };
        }),
        flush: (reason: "debounce" | "count" | "explicit" | "shutdown" | "recovery") => Effect.sync(() => {
          if (!pending) return { reason, opCount: 0, committed: false };
          const payload = pending.payload as { readonly append: string };
          const progressPath = path.join(authoredRoot, "tasks/task_A/progress.md");
          writeFileSync(progressPath, payload.append, { flag: "a" });
          git(authoredRoot, "add", "tasks/task_A/progress.md");
          git(authoredRoot, "commit", "-q", "-m", "append progress through authority");
          return { reason, opCount: 1, committed: true, watermark: git(authoredRoot, "rev-parse", "HEAD") };
        }),
        recover: Effect.succeed({ replayedOps: 0 })
      };
    },
    assertWriteFenceHeld: async () => undefined
  };
}

function git(rootDir: string, ...args: ReadonlyArray<string>): string {
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

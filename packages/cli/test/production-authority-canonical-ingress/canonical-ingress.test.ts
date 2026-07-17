// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  channelDigest32,
  connectionGeneration,
  openLocalAuthorityKeyStore
} from "../../../daemon/src/index.ts";
import { createAuthorityKeyRegistryV1, firstPinAuthorityKeyV1 } from "../../../application/src/index.ts";
import {
  decisionEntityId,
  executionDeclaration,
  makeJournaledWriteCoordinator,
  moduleEntityId,
  taskEntityId
} from "../../../kernel/src/index.ts";
import type { EntityId, ExecutionRecord } from "../../../kernel/src/index.ts";
import type { ParsedCommand } from "../../src/cli/types.ts";
import { daemonActorAttribution } from "../../src/composition/actor-attribution.ts";
import { authorityNamespaceProofBytes } from "../../src/daemon/authority-production-state.ts";
import { createProductionAuthorityLifecycle } from "../../src/daemon/production-authority-lifecycle.ts";

test("production canonical ingress accepts and journals one write for every canonical kind", async () => {
  const fixture = createFixture();
  try {
    const lifecycle = createProductionAuthorityLifecycle({ manifestPath: fixture.manifestPath });
    const started = await lifecycle.startRepo(
      { repoId: "canonical", canonicalRoot: fixture.repoRoot },
      {
        createAttributedCoordinator: ({ attribution }) => makeJournaledWriteCoordinator({
          rootDir: fixture.repoRoot,
          attribution,
          commitAuthor: { name: "ZeyuLi", email: "33339424+FairladyZ625@users.noreply.github.com" },
          autoMaterialize: false
        }),
        assertWriteFenceHeld: async () => undefined
      }
    );
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    if (!started.ok) return;
    const actor = fixture.actor;
    const submission = started.component.bindConnection({
      schema: "authority-connection-context/v1",
      connectionId: "canonical-ingress",
      connectionGeneration: connectionGeneration("canonical-ingress-generation"),
      actor,
      repoId: "canonical",
      channelBinding: { digest: channelDigest32(Buffer.alloc(32, 0x61)), source: "transport-observed" },
      peerCredential: {
        schema: "os-observed-peer-credential/v1",
        platform: "darwin",
        source: "getpeereid",
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0
      }
    });
    const cases: ReadonlyArray<{
      readonly kind: string;
      readonly action: ParsedCommand["action"];
      readonly canonicalEntityId: EntityId;
      readonly authoredPath: string;
      readonly authoredMarker: RegExp;
    }> = [{
      kind: "task",
      action: { kind: "progress-append", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", text: "nine-kind task ingress\n" },
      canonicalEntityId: taskEntityId("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0"),
      authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/progress.md",
      authoredMarker: /nine-kind task ingress/u
    }, {
      kind: "decision",
      action: {
        kind: "decision-propose", decisionId: "dec_INGRESS", title: "Ingress decision",
        question: "Is the production decision writer reachable?", chosen: [{ text: "Yes." }],
        rejected: [{ text: "No.", why_not: "The ingress contract requires reachability." }],
        claims: [{ text: "The write reaches the journal." }], claimLoadBearing: false, fulfillments: [],
        riskTier: "medium", urgency: "medium", modules: [], productLines: [], evidenceRelations: [], dryRun: false
      },
      canonicalEntityId: decisionEntityId("dec_INGRESS"),
      authoredPath: "decisions/decision-dec_INGRESS/decision.md",
      authoredMarker: /dec_INGRESS/u
    }, {
      kind: "module",
      action: { kind: "module-register", moduleKey: "ingress", title: "Ingress", scope: "packages/cli/**", shared: [], dependsOn: [] },
      canonicalEntityId: moduleEntityId("ingress"),
      authoredPath: "modules.json",
      authoredMarker: /ingress/u
    }, {
      kind: "fact",
      action: {
        kind: "record-fact", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", factId: "F-A11CE001",
        statement: "Production fact ingress reaches the journal.", source: "production canonical ingress integration",
        observedAt: "2026-07-17T00:00:00.000Z", confidence: "high", memoryClass: "episodic",
        memoryTags: [], dryRun: false
      },
      canonicalEntityId: taskEntityId("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0"),
      authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/facts.md",
      authoredMarker: /F-A11CE001/u
    }, {
      kind: "relation",
      action: { kind: "decision-relate", decisionId: "dec_INGRESS", anchor: "decision/dec_INGRESS", relationType: "derives", target: "task/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", rationale: "Ingress relation coverage.", dryRun: false },
      canonicalEntityId: decisionEntityId("dec_INGRESS"),
      authoredPath: "decisions/decision-dec_INGRESS/decision.md",
      authoredMarker: /derives/u
    }, {
      kind: "session",
      action: { kind: "session-export", sessionId: "session-ingress", runtime: "codex", source: "manual", detectedAt: "2026-07-17T00:00:00.000Z", transcriptFile: fixture.transcriptPath },
      canonicalEntityId: "session/session-ingress" as EntityId,
      authoredPath: "sessions/session-ingress.md",
      authoredMarker: /session-ingress/u
    }, {
      kind: "execution",
      action: { kind: "task-claim", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", execution: true, executionId: "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG1" },
      canonicalEntityId: "execution/exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG1" as EntityId,
      authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/executions/exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG1.md",
      authoredMarker: /exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG1/u
    }, {
      kind: "review",
      action: {
        kind: "task-review-execution", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", executionId: "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5",
        verdict: "changes_requested", findings: "Ingress review coverage.", evidenceChecked: ["journal"],
        rationale: "A non-approved review exercises the standalone review compiler.", archiveWarningsAcknowledged: true
      },
      canonicalEntityId: "review/rev_01KXQ4WTA7Q4XJ5GDDRS1YXNG2" as EntityId,
      authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/reviews/rev_01KXQ4WTA7Q4XJ5GDDRS1YXNG2.md",
      authoredMarker: /rev_01KXQ4WTA7Q4XJ5GDDRS1YXNG2/u
    }, {
      kind: "consent",
      action: {
        kind: "task-consent-record", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", executionId: "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5",
        utterance: "Approve this exact submitted execution.", consentActions: ["approve_execution"]
      },
      canonicalEntityId: "consent/cns_01KXQ4WTA7Q4XJ5GDDRS1YXNG3" as EntityId,
      authoredPath: "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/consents/cns_01KXQ4WTA7Q4XJ5GDDRS1YXNG3.md",
      authoredMarker: /cns_01KXQ4WTA7Q4XJ5GDDRS1YXNG3/u
    }];
    assert.deepEqual(cases.map((fixtureCase) => fixtureCase.kind).sort(), [
      "consent", "decision", "execution", "fact", "module", "relation", "review", "session", "task"
    ]);
    for (const fixtureCase of cases) {
      const receipt = await submission.submit({
        command: { rootDir: fixture.repoRoot, json: true, action: fixtureCase.action },
        attribution: daemonActorAttribution(actor, { kind: "agent", id: "codex" }),
        currentSession: { runtime: "codex", sessionId: "session-production", source: "manual", detectedAt: "2026-07-17T00:00:00.000Z" },
        canonicalEntityId: fixtureCase.canonicalEntityId
      });
      assert.notEqual(receipt.tag, "REJECTED", `${fixtureCase.kind}:${JSON.stringify(receipt)}`);
      const watermarkPath = path.join(fixture.repoRoot, ".harness/write-journal/watermark.json");
      assert.equal(existsSync(watermarkPath), true, `${fixtureCase.kind}:${JSON.stringify(receipt)}`);
      assert.equal(readFileSync(watermarkPath, "utf8").includes(receipt.opId), true, `${fixtureCase.kind}:journal-watermark:${JSON.stringify(receipt)}`);
      assert.match(readFileSync(path.join(fixture.authoredRoot, fixtureCase.authoredPath), "utf8"), fixtureCase.authoredMarker, fixtureCase.kind);
    }
    await assert.rejects(submission.submit({
      command: { rootDir: fixture.repoRoot, json: true, action: { kind: "help" } },
      attribution: daemonActorAttribution(actor, { kind: "agent", id: "codex" }),
      currentSession: { runtime: "codex", sessionId: "session-production", source: "manual", detectedAt: "2026-07-17T00:00:00.000Z" },
      canonicalEntityId: taskEntityId("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0")
    }), /AUTHORITY_TYPED_COMMAND_UNSUPPORTED.*use progress-append/u);
    await lifecycle.stopAll("daemon-shutdown");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-production-canonical-ingress-"));
  const repoRoot = path.join(root, "repo");
  const authoredRoot = path.join(repoRoot, "harness");
  const serviceRoot = path.join(root, "service-state");
  const keyStateDirectory = path.join(serviceRoot, "keys/canonical");
  mkdirSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0"), { recursive: true });
  mkdirSync(serviceRoot, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/INDEX.md"), "---\ntask_id: task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0\nstatus: active\n---\n");
  mkdirSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4"), { recursive: true });
  writeFileSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/INDEX.md"), "---\ntask_id: task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4\nstatus: active\n---\n");
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
  const submittedExecution: ExecutionRecord = {
    schema: "execution/v2", execution_id: "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5", task_ref: "task/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", state: "submitted",
    primary_actor: { principal: { personId: "person_alice" }, executor: { kind: "agent", id: "codex" }, responsibleHuman: "person_alice" },
    claimed_at: "2026-07-17T00:00:00.000Z", submitted_at: "2026-07-17T00:01:00.000Z", closed_at: null,
    session_bindings: [], outputs: [{ evidence_id: "evidence:ingress", execution_ref: "execution/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5", locator: { substrate: "inline", text: "passed" } }],
    submission: { completion_claim: "Ingress qualified", deliverables: ["journal"], evidence_refs: ["evidence:ingress"], verification_notes: ["integration"], known_gaps: [], residual_risks: [] }
  };
  mkdirSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/executions"), { recursive: true });
  writeFileSync(path.join(authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0/executions/exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5.md"), executionDeclaration.documentCodec.encode(submittedExecution));
  const transcriptPath = path.join(root, "session-transcript.md");
  writeFileSync(transcriptPath, "# Production session ingress\n");
  writeFileSync(path.join(authoredRoot, "people.yaml"), [
    "schema: harness-people/v1", "people:", "  - personId: person_alice", "    displayName: Alice",
    "    primaryEmail: alice@example.test", "    roles: [owner]", "    credentials:",
    "      - kind: unix-socket-owner-boundary", `        issuer: host:${hostname()}`,
    `        subject: ${process.getuid?.() ?? 0}`, "roles:", "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]", ""
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
    authorityId: "authority.production", generation: 1, globalRevocationEpoch: 1, revision: 1,
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
  const proof = sign(null, authorityNamespaceProofBytes(unsignedNamespace), keyStore.signingProfile(registry, now).privateKey);
  const manifestPath = path.join(serviceRoot, "authority-production.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    schema: "authority-production-composition/v1",
    serviceStateRoot: serviceRoot,
    repos: [{
      repoId: "canonical", canonicalRoot: repoRoot, workspaceId: "workspace-production",
      deviceId: "device-production", viewId: "view-production", sessionId: "session-production",
      authorityId: "authority.production", issuer: "authority.production", keyRegistryPath: registryPath,
      keyStateDirectory, schemaTuple: productionTuple(), authorityGeneration: 1,
      revocationEpochs: { global: "1", workspace: "1", device: "1", view: "1", principal: "1", executor: "1" },
      admissionTokenRef: "admission-production", allowedExecutorAgentIds: ["codex"],
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
  git(authoredRoot, "commit", "-q", "-m", "seed canonical ingress fixture");
  return { root, repoRoot, authoredRoot, serviceRoot, manifestPath, actor, transcriptPath };
}

function productionTuple() {
  return {
    wire: 2, event: 2, receipt: 2, digest: 2, policy: 2,
    commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
  } as const;
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
    }
  }).trim();
}

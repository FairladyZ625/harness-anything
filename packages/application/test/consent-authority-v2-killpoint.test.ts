// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalPayloadDigestV2,
  encodeConsentCommandPayloadV2,
  makeConsentSemanticCompilerV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  type HostedDocumentSnapshotV2,
  type RegistryEntityRefV2,
  type SemanticEntityBaseV2,
  type SemanticMutationEnvelopeV2
} from "../src/index.ts";
import {
  executionDeclaration,
  makeJournaledWriteCoordinator,
  type ConsentRecord,
  type ExecutionRecord
} from "../../kernel/src/index.ts";
import { writeAttribution } from "./test-attribution.ts";
import { runEffect } from "./effect-test-helpers.ts";

const taskId = "task_01KXPP248WACVWSM7F4K855RWH";
const executionId = "exe_01KXPP248WACVWSM7F4K855RWJ";
const consentId = "cns_01KXPP248WACVWSM7F4K855RWK";
const executionPath = `tasks/${taskId}/executions/${executionId}.md`;
const consentPath = `tasks/${taskId}/consents/${consentId}.md`;

test("a V2-compiled consent grant recovers exactly once after the WAL-enqueue killpoint", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-consent-authority-v2-killpoint-"));
  try {
    const authoredExecutionPath = path.join(rootDir, "harness", executionPath);
    const authoredConsentPath = path.join(rootDir, "harness", consentPath);
    mkdirSync(path.dirname(authoredExecutionPath), { recursive: true });
    const execution = submittedExecution();
    const executionBody = executionDeclaration.documentCodec.encode(execution);
    writeFileSync(authoredExecutionPath, executionBody, "utf8");
    const executionSnapshot = snapshot(executionBody);
    const executionRef = ref("execution", `execution/${taskId}/${executionId}`);
    const consentRef = ref("consent", `consent/${taskId}/${consentId}`);
    const bases = new Map<string, SemanticEntityBaseV2>([[refKey(executionRef), {
      semanticVersion: "execution-v1",
      stateDigest: Buffer.alloc(32, 0x41)
    }]]);
    const documents = new Map<string, HostedDocumentSnapshotV2>([[executionPath, executionSnapshot]]);
    const payload = {
      schema: "consent.grant/v1" as const,
      taskId,
      executionId,
      consentId,
      utterance: "Approved for this exact submission.",
      actions: ["approve_execution", "complete_task"] as const
    };
    const bytes = encodeConsentCommandPayloadV2(payload);
    const mutationSet = { registryVersion: 1, mutations: [] } as const;
    const envelope: SemanticMutationEnvelopeV2 = {
      schema: semanticMutationEnvelopeV2Schema,
      workspaceId: "workspace-w6-consent-killpoint",
      operationId: {
        namespace: {
          schema: "operation-namespace/v1",
          workspaceId: "workspace-w6-consent-killpoint",
          deviceId: "device-w6",
          authorityGeneration: 1n,
          namespaceId: "namespace-w6",
          expiresAt: 9_000n,
          issuer: "authority.test",
          keyId: "key-w6",
          proof: Buffer.alloc(32, 1)
        },
        clientRandom128: Buffer.alloc(16, 2)
      },
      binding: {
        bindingId: "binding-w6",
        actorAxesBindingDigest: Buffer.alloc(32, 3),
        deviceId: "device-w6",
        viewId: "view-w6",
        sessionId: "session-w6",
        admissionTokenRef: { tokenId: "token-w6", tokenDigest: Buffer.alloc(32, 4) }
      },
      schemaTuple: {
        wire: 2, event: 2, receipt: 2, digest: 2, policy: 2,
        commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1,
        localState: 1, applyJournal: 1
      },
      intent: {
        kind: "typed",
        command: { registryVersion: 1, name: "consent.grant", version: 1 },
        canonicalPayload: { kind: "inline", size: BigInt(bytes.length), bytes },
        canonicalPayloadDigest: canonicalPayloadDigestV2(bytes),
        baseCas: [{
          entityRef: executionRef,
          expectedSemanticVersion: "execution-v1",
          expectedStateDigest: Buffer.alloc(32, 0x41)
        }, {
          entityRef: consentRef,
          expectedSemanticVersion: null,
          expectedStateDigest: null
        }],
        declaredPathCas: [{
          path: executionPath,
          expectedEpoch: executionSnapshot.epoch,
          expectedRevision: executionSnapshot.revision,
          expectedBlobDigest: executionSnapshot.blobDigest
        }]
      },
      claimedMutationSet: mutationSet,
      claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
      claimedSemanticRequestDigest: Buffer.alloc(32, 5)
    };
    const compiled = await makeConsentSemanticCompilerV2({
      state: {
        readEntityBase: async (entityRef) => bases.get(refKey(entityRef)) ?? null,
        readHostedDocument: async (portablePath) => documents.get(portablePath) ?? null
      }
    }).compile(envelope, {
      actor: {
        principal: { personId: "person_zeyu" },
        executor: { kind: "agent", id: "agent_w6" },
        responsibleHuman: "person_zeyu"
      },
      sessionId: "session-w6",
      nowMs: 1_721_000_000_000n
    });
    const firstProcess = makeJournaledWriteCoordinator({
      rootDir,
      attribution: writeAttribution("person_zeyu", "agent_w6")
    });
    await runEffect(firstProcess.enqueue({ ...compiled.operation, opId: "op-consent-v2-killpoint" }));
    assert.equal(existsSync(authoredConsentPath), false, "WAL enqueue alone must not materialize the consent");

    const firstRecovery = await runEffect(makeJournaledWriteCoordinator({
      rootDir,
      attribution: writeAttribution("person_zeyu", "agent_w6")
    }).recover);
    assert.equal(firstRecovery.replayedOps, 1);
    const consent = JSON.parse(readFileSync(authoredConsentPath, "utf8")) as ConsentRecord;
    assert.equal(consent.state, "open");
    assert.deepEqual(consent.principal, { personId: "person_zeyu" });

    const secondRecovery = await runEffect(makeJournaledWriteCoordinator({
      rootDir,
      attribution: writeAttribution("person_zeyu", "agent_w6")
    }).recover);
    assert.equal(secondRecovery.replayedOps, 0);
    assert.equal(JSON.parse(readFileSync(authoredConsentPath, "utf8")).state, "open");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function submittedExecution(): ExecutionRecord {
  return {
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state: "submitted",
    primary_actor: {
      principal: { personId: "person_zeyu" },
      executor: { kind: "agent", id: "agent_w6" },
      responsibleHuman: "person_zeyu"
    },
    claimed_at: "2024-07-15T00:00:00.000Z",
    submitted_at: "2024-07-15T00:10:00.000Z",
    closed_at: null,
    session_bindings: [],
    outputs: [{
      evidence_id: "evidence:w6-consent",
      execution_ref: `execution/${taskId}/${executionId}`,
      locator: { substrate: "inline", text: "passed" }
    }],
    submission: {
      completion_claim: "W6 consent path is qualified",
      deliverables: ["consent authority compiler"],
      evidence_refs: ["evidence:w6-consent"],
      verification_notes: ["integration test"],
      known_gaps: [],
      residual_risks: []
    }
  };
}

function snapshot(body: string): HostedDocumentSnapshotV2 {
  return {
    body,
    epoch: "epoch-w6",
    revision: 7n,
    blobDigest: Buffer.alloc(32, 0x77)
  };
}

function ref(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}

function refKey(entityRef: RegistryEntityRefV2): string {
  return `${entityRef.registryVersion}\0${entityRef.entityKind}\0${entityRef.canonicalRef}`;
}

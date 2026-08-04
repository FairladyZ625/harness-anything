// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalPayloadDigestV2,
  encodeConsentCommandPayloadV2,
  makeConsentSemanticCompilerV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  type AuthoritySemanticCompilerContextV2,
  type ConsentCommandPayloadV2,
  type PathCasV2,
  type SemanticBaseCasV2,
  type SemanticMutationEnvelopeV2,
  type SemanticMutationSetV2
} from "../src/index.ts";
import { consentDeclaration, executionDeclaration, type ConsentRecord, type ExecutionRecord } from "../../kernel/src/index.ts";
import {
  absent,
  authorityState,
  base,
  cas,
  consentId,
  consentRef,
  executionId,
  executionPath,
  executionRef,
  key,
  present,
  schemaTuple,
  snapshot,
  taskId
} from "./consent-semantic-compiler-v2-fixtures.ts";

test("authority consent grant rejects an execution-bound utterance outside the authenticated reviewer session", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-consent-authority-anchor-mismatch-"));
  try {
    const logRoot = path.join(rootDir, "logs");
    mkdirSync(logRoot, { recursive: true });
    writeFileSync(path.join(logRoot, "rollout-2024-07-15T00-00-00-session-w6-worker.jsonl"), `${JSON.stringify({
      timestamp: "2024-07-15T00:11:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Approved only in the authority worker session." }
    })}\n`);
    const execution: ExecutionRecord = {
      ...submittedExecution(),
      session_bindings: [{
        binding_id: "binding-primary-worker",
        session_ref: "session/session-w6-worker",
        role: "primary",
        archive_status: "complete",
        attached_at: "2024-07-15T00:00:00.000Z",
        session: { runtime: "codex", sessionId: "session-w6-worker", source: "runtime", detectedAt: "2024-07-15T00:00:00.000Z" },
        capture_range: null
      }]
    };
    const executionSnapshot = snapshot(executionDeclaration.documentCodec.encode(execution));
    const compiler = makeConsentSemanticCompilerV2({
      state: authorityState(new Map([[key(executionRef()), base("execution-v1")]]), new Map([[executionPath, executionSnapshot]])),
      rootInput: rootDir,
      runtimeLogOptions: { runtimeLogRoots: { codex: [logRoot] } }
    });

    await assert.rejects(compiler.compile(envelope({
      schema: "consent.grant/v1",
      taskId,
      executionId,
      consentId,
      utterance: "Approved only in the authority worker session.",
      standingPolicyDecisionId: null,
      assertedRationale: null,
      actions: ["approve_execution", "complete_task"]
    }, [present(executionRef(), "execution-v1"), absent(consentRef())], [cas(executionPath, executionSnapshot)]), {
      ...context(BigInt(Date.parse("2024-07-15T00:12:00.000Z"))),
      currentSession: {
        runtime: "codex",
        sessionId: "session-w6-consent",
        source: "runtime",
        detectedAt: "2024-07-15T00:12:00.000Z"
      }
    }), /CONSENT_REVIEW_SESSION_MISMATCH/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("legacy authority tokens fail explicitly when transcript consent needs an unbound current session", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-consent-authority-legacy-current-"));
  try {
    const logRoot = path.join(rootDir, "logs");
    mkdirSync(logRoot, { recursive: true });
    writeFileSync(path.join(logRoot, "rollout-2024-07-15T00-00-00-session-w6-worker.jsonl"), `${JSON.stringify({
      timestamp: "2024-07-15T00:11:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Approved only through a legacy execution binding." }
    })}\n`);
    const execution: ExecutionRecord = {
      ...submittedExecution(),
      session_bindings: [{
        binding_id: "binding-primary-worker",
        session_ref: "session/session-w6-worker",
        role: "primary",
        archive_status: "complete",
        attached_at: "2024-07-15T00:00:00.000Z",
        session: { runtime: "codex", sessionId: "session-w6-worker", source: "runtime", detectedAt: "2024-07-15T00:00:00.000Z" },
        capture_range: null
      }]
    };
    const executionSnapshot = snapshot(executionDeclaration.documentCodec.encode(execution));
    const compiler = makeConsentSemanticCompilerV2({
      state: authorityState(new Map([[key(executionRef()), base("execution-v1")]]), new Map([[executionPath, executionSnapshot]])),
      rootInput: rootDir,
      runtimeLogOptions: { runtimeLogRoots: { codex: [logRoot] } }
    });

    await assert.rejects(compiler.compile(envelope({
      schema: "consent.grant/v1",
      taskId,
      executionId,
      consentId,
      utterance: "Approved only through a legacy execution binding.",
      standingPolicyDecisionId: null,
      assertedRationale: null,
      actions: ["approve_execution", "complete_task"]
    }, [present(executionRef(), "execution-v1"), absent(consentRef())], [cas(executionPath, executionSnapshot)]),
    context(BigInt(Date.parse("2024-07-15T00:12:00.000Z")))),
    /legacy authority token.*asserted.*standing-policy/iu);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("legacy authority tokens preserve pre-existing execution-bound transcript consent in the authenticated session", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-consent-authority-legacy-bound-"));
  try {
    const logRoot = path.join(rootDir, "logs");
    mkdirSync(logRoot, { recursive: true });
    writeFileSync(path.join(logRoot, "rollout-2024-07-15T00-00-00-session-w6-consent.jsonl"), `${JSON.stringify({
      timestamp: "2024-07-15T00:11:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Approved in the legacy authenticated execution session." }
    })}\n`);
    const execution: ExecutionRecord = {
      ...submittedExecution(),
      session_bindings: [{
        binding_id: "binding-primary-authenticated",
        session_ref: "session/session-w6-consent",
        role: "primary",
        archive_status: "complete",
        attached_at: "2024-07-15T00:00:00.000Z",
        session: { runtime: "codex", sessionId: "session-w6-consent", source: "runtime", detectedAt: "2024-07-15T00:00:00.000Z" },
        capture_range: null
      }]
    };
    const executionSnapshot = snapshot(executionDeclaration.documentCodec.encode(execution));
    const compiler = makeConsentSemanticCompilerV2({
      state: authorityState(new Map([[key(executionRef()), base("execution-v1")]]), new Map([[executionPath, executionSnapshot]])),
      rootInput: rootDir,
      runtimeLogOptions: { runtimeLogRoots: { codex: [logRoot] } }
    });

    const compiled = await compiler.compile(envelope({
      schema: "consent.grant/v1",
      taskId,
      executionId,
      consentId,
      utterance: "Approved in the legacy authenticated execution session.",
      standingPolicyDecisionId: null,
      assertedRationale: null,
      actions: ["approve_execution", "complete_task"]
    }, [present(executionRef(), "execution-v1"), absent(consentRef())], [cas(executionPath, executionSnapshot)]),
    context(BigInt(Date.parse("2024-07-15T00:12:00.000Z"))));
    const payload = compiled.operation.payload as { readonly entityDocument: { readonly body: string } };
    const consent = consentDeclaration.documentCodec.decode(payload.entityDocument.body) as ConsentRecord;
    assert.equal(consent.source.strength, "transcript-verified");
    assert.equal(consent.source.transcript_anchor?.session_ref, "session/session-w6-consent");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function envelope(
  payload: ConsentCommandPayloadV2,
  baseCas: ReadonlyArray<SemanticBaseCasV2>,
  declaredPathCas: ReadonlyArray<PathCasV2>
): SemanticMutationEnvelopeV2 {
  const bytes = encodeConsentCommandPayloadV2(payload);
  const mutationSet: SemanticMutationSetV2 = { registryVersion: 1, mutations: [] };
  const value: SemanticMutationEnvelopeV2 = {
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId: "workspace-w6-consent",
    operationId: {
      namespace: {
        schema: "operation-namespace/v1", workspaceId: "workspace-w6-consent", deviceId: "device-w6",
        authorityGeneration: 1n, namespaceId: "namespace-w6", expiresAt: 9_000n,
        issuer: "authority.test", keyId: "namespace-key", proof: Buffer.alloc(32, 3)
      },
      clientRandom128: Buffer.alloc(16, 7)
    },
    binding: {
      bindingId: "binding-w6", actorAxesBindingDigest: Buffer.alloc(32, 4), deviceId: "device-w6",
      viewId: "view-w6", sessionId: "session-w6-consent",
      admissionTokenRef: { tokenId: "token-w6", tokenDigest: Buffer.alloc(32, 5) }
    },
    schemaTuple,
    intent: {
      kind: "typed",
      command: { registryVersion: 1, name: payload.schema.replace("/v1", ""), version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(bytes.length), bytes },
      canonicalPayloadDigest: canonicalPayloadDigestV2(bytes),
      baseCas,
      declaredPathCas
    },
    claimedMutationSet: mutationSet,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  };
  return { ...value, claimedSemanticRequestDigest: semanticRequestDigestV2(value) };
}

function context(nowMs: bigint): AuthoritySemanticCompilerContextV2 {
  return {
    actor: {
      principal: { personId: "person_zeyu" },
      executor: { kind: "agent", id: "agent_w6" },
      responsibleHuman: "person_zeyu"
    },
    sessionId: "session-w6-consent",
    nowMs
  };
}

function submittedExecution(): ExecutionRecord {
  return {
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state: "submitted",
    primary_actor: context(0n).actor,
    claimed_at: "2024-07-15T00:00:00.000Z",
    submitted_at: "2024-07-15T00:10:00.000Z",
    closed_at: null,
    session_bindings: [],
    outputs: [],
    submission: {
      completion_claim: "Consent behavior is qualified.",
      deliverables: ["consent authority compiler"],
      evidence_refs: [],
      verification_notes: ["contract test"],
      known_gaps: [],
      residual_risks: []
    }
  };
}

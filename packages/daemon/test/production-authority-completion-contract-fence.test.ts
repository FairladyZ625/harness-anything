// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  canonicalPayloadDigestV2,
  makeSessionExecutionReviewSemanticCompilerV2,
  type ProductionAuthorityCommand,
  type SemanticMutationEnvelopeV2
} from "@harness-anything/application";
import { sha256Text, type ExecutionRecord } from "@harness-anything/kernel";
import { makeDaemonAuthorityWriteCoordinator } from "../src/authority/authority-command-submission.ts";
import { productionLifecycleAttemptIntent } from "../src/authority/production/production-authority-lifecycle-intents.ts";

const taskId = "task_01KXD8H2QFMMA4T203PJZ77AQ5";
const executionId = "exe_01KXD8H2QFMMA4T203PJZ77AQ6";
const actor = {
  principal: { personId: "person_zeyu" },
  executor: { kind: "agent" as const, id: "codex" },
  responsibleHuman: "person:person_zeyu"
};

test("daemon completion intent fences present and absent task-contract snapshots against TOCTOU", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-daemon-completion-contract-"));
  try {
    const authoredRoot = path.join(rootDir, "harness");
    const taskRoot = path.join(authoredRoot, "tasks", `${taskId}-contract-fence`);
    mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), [
      "---", `task_id: ${taskId}`, "task:", "  status: in_review", "---", "", "# Contract fence", ""
    ].join("\n"), "utf8");
    writeFileSync(
      path.join(taskRoot, "executions", `${executionId}.md`),
      `${JSON.stringify(executionRecord(), null, 2)}\n`,
      "utf8"
    );
    const contractPath = path.join(taskRoot, "task-contract.json");

    for (const initial of ["{\"schema\":\"task-contract-snapshot/v1\",\"completionGates\":[]}\n", null] as const) {
      if (initial === null) {
        if (existsSync(contractPath)) unlinkSync(contractPath);
      } else {
        writeFileSync(contractPath, initial, "utf8");
      }
      const evaluatedDigest = initial === null ? null : sha256Text(initial);
      const compileInput = {
        command: {
          rootDir,
          json: true,
          action: {
            kind: "task-complete",
            taskId,
            reviewerId: "person_reviewer",
            completionContractBodySha256: evaluatedDigest
          }
        } as ProductionAuthorityCommand,
        currentSession: {
          runtime: "codex",
          sessionId: "session-contract-fence",
          source: "runtime",
          detectedAt: "2026-07-24T00:00:00.000Z"
        },
        canonicalEntityId: `execution/${executionId}`,
        authoredRoot,
        actor
      } as const;
      const intent = productionLifecycleAttemptIntent(compileInput, {} as never);
      assert.ok(intent);
      assert.equal(intent.declaredPathCas.some((entry) =>
        entry.path === `tasks/${taskId}/task-contract.json`
      ), true);

      writeFileSync(
        contractPath,
        "{\"schema\":\"task-contract-snapshot/v1\",\"completionGates\":[\"ci\"]}\n",
        "utf8"
      );
      assert.throws(
        () => productionLifecycleAttemptIntent(compileInput, {} as never),
        /AUTHORITY_TASK_COMPLETE_CONTRACT_CHANGED/u
      );
      const compiler = makeSessionExecutionReviewSemanticCompilerV2({
        state: {
          readEntityBase: async () => null,
          readHostedDocument: async (logicalPath) => hostedSnapshot(taskRoot, logicalPath)
        }
      });
      await assert.rejects(
        compiler.compile(envelope(intent)),
        /EXECUTION_COMPLETION_CONTRACT_CHANGED|PATH_CAS_CONFLICT/u
      );
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("daemon authority coordinator carries the evaluated contract precondition into canonical completion", async () => {
  const evaluatedDigest = sha256Text("evaluated contract");
  let captured: ProductionAuthorityCommand | null = null;
  const command = {
    rootDir: "/unused",
    json: true,
    action: { kind: "task-complete", taskId }
  } as ProductionAuthorityCommand;
  const coordinator = makeDaemonAuthorityWriteCoordinator({
    submit: async (input) => {
      captured = input.command;
      throw new Error("capture only");
    }
  }, {
    command,
    attribution: {} as never,
    currentSession: {} as never
  });
  await runEffect(coordinator.enqueue({
    opId: "op-contract-fence",
    entityId: `entity/execution/${executionId}`,
    kind: "doc_write",
    payload: {
      preconditions: [{
        taskId,
        path: "task-contract.json",
        bodySha256: evaluatedDigest
      }]
    }
  }));
  await assert.rejects(runEffect(coordinator.flush("explicit")), /capture only/u);
  assert.equal(captured?.action.kind, "task-complete");
  if (captured?.action.kind === "task-complete") {
    assert.equal(captured.action.completionContractBodySha256, evaluatedDigest);
  }
});

function envelope(intent: NonNullable<ReturnType<typeof productionLifecycleAttemptIntent>>): SemanticMutationEnvelopeV2 {
  return {
    schema: "semantic-mutation-envelope/v2",
    workspaceId: "workspace-contract-fence",
    operationId: {
      namespace: {
        schema: "operation-namespace/v1",
        workspaceId: "workspace-contract-fence",
        deviceId: "device-contract-fence",
        authorityGeneration: 1n,
        namespaceId: "namespace-contract-fence",
        expiresAt: 9_999n,
        issuer: "test",
        keyId: "test",
        proof: Buffer.alloc(32)
      },
      clientRandom128: Buffer.alloc(16)
    },
    binding: {
      bindingId: "binding-contract-fence",
      actorAxesBindingDigest: Buffer.alloc(32),
      deviceId: "device-contract-fence",
      viewId: "view-contract-fence",
      sessionId: "session-contract-fence",
      admissionTokenRef: { tokenId: "token-contract-fence", tokenDigest: Buffer.alloc(32) }
    },
    schemaTuple: {
      registryVersion: 1,
      envelopeSchemaVersion: 2,
      mutationSchemaVersion: 2,
      commandSchemaVersion: 1
    },
    intent: {
      kind: "typed",
      command: { registryVersion: 1, name: intent.commandName, version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(intent.payload.length), bytes: intent.payload },
      canonicalPayloadDigest: canonicalPayloadDigestV2(intent.payload),
      baseCas: intent.baseRefs.map((entityRef) => ({
        entityRef,
        expectedSemanticVersion: null,
        expectedStateDigest: null
      })),
      declaredPathCas: intent.declaredPathCas
    },
    claimedMutationSet: { registryVersion: 1, mutations: [] },
    claimedSemanticMutationSetDigest: Buffer.alloc(32),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  };
}

function hostedSnapshot(taskRoot: string, logicalPath: string) {
  const prefix = `tasks/${taskId}/`;
  if (!logicalPath.startsWith(prefix)) return null;
  const filePath = path.join(taskRoot, logicalPath.slice(prefix.length));
  let body: string;
  try {
    body = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const digest = sha256Text(body);
  return { body, epoch: digest, revision: 0n, blobDigest: Buffer.from(digest, "hex") };
}

function executionRecord(): ExecutionRecord {
  return {
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state: "submitted",
    primary_actor: actor,
    claimed_at: "2026-07-24T00:00:00.000Z",
    submitted_at: "2026-07-24T00:01:00.000Z",
    closed_at: null,
    session_bindings: [],
    outputs: [],
    submission: {
      completion_claim: "Complete.",
      deliverables: [],
      evidence_refs: [],
      verification_notes: [],
      known_gaps: [],
      residual_risks: []
    }
  };
}

function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return new Promise((resolve, reject) => {
    Effect.runCallback(effect, {
      onExit: (exit) => exit._tag === "Success" ? resolve(exit.value) : reject(new Error(String(exit.cause)))
    });
  });
}

// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { executionDeclaration, taskEntityId, taskHolderActor, type ExecutionRecord, type WriteOp } from "../../kernel/src/index.ts";
import { daemonActorAttribution } from "../src/composition/actor-attribution.ts";
import { makeDaemonAuthorityWriteCoordinator } from "@harness-anything/daemon";
import { taskClaimAttemptIntent } from "../src/daemon/production-authority-task-claim-intent.ts";
import {
  makeHeldLockAttributedCoordinatorFactory,
  type AuthorityLifecycleRuntime
} from "@harness-anything/daemon";

test("cold task create submits provenance session and task as two ordered canonical operations", async () => {
  const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG9";
  const submittedEntityIds: string[] = [];
  const coordinator = makeDaemonAuthorityWriteCoordinator({
    submitProvenanceSession: async (input) => {
      submittedEntityIds.push(input.operation.entityId);
      return committedReceipt("fixture-session-op", 1);
    },
    submit: async (input) => {
      submittedEntityIds.push(input.canonicalEntityId);
      return committedReceipt("fixture-task-op", 2);
    }
  }, {
    command: {
      rootDir: "/fixture",
      json: true,
      action: {
        kind: "new-task",
        taskId,
        title: "Intent-bound task",
        titleProvided: true,
        slug: "intent-bound-task",
        slugProvided: false,
        allowManualId: false,
        longRunning: false,
        dryRun: false
      }
    },
    attribution: daemonActorAttribution({
      personId: "person_alice",
      displayName: "Alice",
      primaryEmail: "alice@example.test",
      roles: ["owner"],
      providerId: "test",
      resolvedCredential: { kind: "unix-socket-owner-boundary", issuer: "test", subject: "person_alice" }
    }, { kind: "agent", id: "codex" }),
    currentSession: {
      runtime: "codex",
      sessionId: "session-provenance-first",
      source: "runtime",
      detectedAt: "2026-07-18T00:00:00.000Z"
    }
  });

  await runEffect(coordinator.enqueue({
    opId: "session-provenance-op",
    entityId: "entity/session/session-provenance-first",
    kind: "doc_write",
    payload: {}
  }));
  const sessionFlush = await runEffect(coordinator.flush("explicit"));
  await runEffect(coordinator.enqueue({
    opId: "task-create-op",
    entityId: taskEntityId(taskId),
    kind: "package_create",
    payload: {}
  }));
  const taskFlush = await runEffect(coordinator.flush("explicit"));

  assert.deepEqual(submittedEntityIds, ["entity/session/session-provenance-first", taskEntityId(taskId)]);
  assert.equal(sessionFlush.opCount, 1);
  assert.equal(taskFlush.opCount, 1);
  await assert.rejects(runEffect(coordinator.enqueue({
    opId: "unexpected-third-op",
    entityId: taskEntityId(taskId),
    kind: "package_create"
  })), /AUTHORITY_COMMAND_REQUIRES_SINGLE_CANONICAL_OPERATION/u);
});

test("task claim submits the observed execution write through its narrow typed ingress", async () => {
  const executionId = "exe_01KXSVW65Q5QK3M8382FK4C0DR";
  let submittedOperation: unknown;
  const coordinator = makeDaemonAuthorityWriteCoordinator({
    submit: async () => { throw new Error("generic authority submission must not compile task claim"); },
    submitTaskClaim: async (input) => {
      submittedOperation = input.operation;
      return committedReceipt("fixture-task-claim-op", 1);
    }
  }, {
    command: {
      rootDir: "/fixture",
      json: true,
      action: { kind: "task-claim", taskId: "task_01KXSVW65Q5QK3M8382FK4C0DR", execution: true }
    },
    attribution: daemonActorAttribution({
      personId: "person_alice",
      displayName: "Alice",
      primaryEmail: "alice@example.test",
      roles: ["owner"],
      providerId: "test",
      resolvedCredential: { kind: "unix-socket-owner-boundary", issuer: "test", subject: "person_alice" }
    }, { kind: "agent", id: "codex" }),
    currentSession: {
      runtime: "codex",
      sessionId: "session-task-claim",
      source: "runtime",
      detectedAt: "2026-07-18T00:00:00.000Z"
    }
  });
  const operation = {
    opId: "observed-task-claim-op",
    entityId: `entity/execution/${executionId}` as const,
    kind: "doc_write" as const,
    payload: { entityDocument: "observed" }
  };

  await runEffect(coordinator.enqueue(operation));
  const report = await runEffect(coordinator.flush("explicit"));

  assert.equal(submittedOperation, operation);
  assert.equal(report.committed, true);
  assert.equal(report.watermark, "fixture-task-claim-op");
});

test("task claim typed ingress rejects forged entity, actor, and write-set data", () => {
  const taskId = "task_01KXSVW65Q5QK3M8382FK4C0DR";
  const executionId = "exe_01KXSVW65Q5QK3M8382FK4C0DR";
  const attribution = daemonActorAttribution({
    personId: "person_alice",
    displayName: "Alice",
    primaryEmail: "alice@example.test",
    roles: ["owner"],
    providerId: "test",
    resolvedCredential: { kind: "unix-socket-owner-boundary", issuer: "test", subject: "person_alice" }
  }, { kind: "agent", id: "codex" });
  const currentSession = {
    runtime: "codex" as const,
    sessionId: "session-task-claim-strict",
    source: "runtime" as const,
    detectedAt: "2026-07-18T00:00:00.000Z"
  };
  const command = {
    rootDir: "/fixture",
    json: true,
    action: { kind: "task-claim" as const, taskId, execution: true }
  };
  const execution: ExecutionRecord = {
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state: "active",
    primary_actor: taskHolderActor(attribution.taskHolderPrincipal, attribution.executor),
    claimed_at: "2026-07-18T00:00:00.001Z",
    submitted_at: null,
    closed_at: null,
    session_bindings: [{
      binding_id: `primary:${currentSession.sessionId}`,
      session_ref: `session/${currentSession.sessionId}`,
      role: "primary",
      archive_status: "pending",
      attached_at: "2026-07-18T00:00:00.002Z",
      session: currentSession,
      capture_range: {
        range_id: `primary:${currentSession.sessionId}:2026-07-18T00:00:00.002Z`,
        coordinate: "timestamp",
        start_at: "2026-07-18T00:00:00.002Z",
        end_at: null,
        bounds: "inclusive"
      }
    }],
    outputs: [],
    submission: null
  };
  const operation = claimOperation(taskId, execution);

  const intent = taskClaimAttemptIntent(command, attribution, currentSession, operation);
  assert.equal(intent.commandName, "execution.claim");
  assert.equal(intent.physicalEntityId, `entity/execution/${executionId}`);
  assert.throws(() => taskClaimAttemptIntent(command, attribution, currentSession, {
    ...operation,
    entityId: "entity/execution/exe_forged"
  }), /AUTHORITY_TASK_CLAIM_ENTITY_MISMATCH/u);
  assert.throws(() => taskClaimAttemptIntent(command, attribution, currentSession, claimOperation(taskId, {
    ...execution,
    primary_actor: { ...execution.primary_actor, responsibleHuman: "person_forged" }
  })), /AUTHORITY_TASK_CLAIM_ACTOR_MISMATCH/u);
  assert.throws(() => taskClaimAttemptIntent(command, attribution, currentSession, {
    ...operation,
    payload: {
      ...(operation.payload as Record<string, unknown>),
      companionWrites: [{ taskId, path: "INDEX.md", body: "forged" }]
    }
  }), /AUTHORITY_TASK_CLAIM_WRITE_SET_INVALID/u);
});

test("held-lock authority flush uses one atomic publication instead of direct materialization", async () => {
  let pending = 0;
  let atomicPublications = 0;
  let directMaterializations = 0;
  const runtime: AuthorityLifecycleRuntime = {
    createAttributedCoordinator: () => ({
      enqueue: (op) => Effect.sync(() => {
        pending += 1;
        return { opId: op.opId, entityId: op.entityId, accepted: true as const };
      }),
      flush: (reason) => Effect.sync(() => ({ reason, opCount: pending, committed: true })),
      recover: Effect.succeed({ replayedOps: 0 })
    }),
    enqueueMaterializerBatch: async ({ sessionId }) => {
      directMaterializations += 1;
      return { branches: [{ branch: `sessions/${sessionId}`, commitCount: 1, status: "merged" as const }] };
    },
    enqueueAuthorityPublication: async ({ sessionId, publish }) => {
      atomicPublications += 1;
      const flush = await publish();
      return {
        flush,
        materialization: {
          branches: [{ branch: `sessions/${sessionId}`, commitCount: 1, status: "merged" as const }]
        }
      };
    },
    assertWriteFenceHeld: async () => undefined
  };
  const coordinator = makeHeldLockAttributedCoordinatorFactory(runtime).create({
    attribution: {
      actor: { principal: { kind: "person", personId: "person_test" }, executor: { kind: "agent", id: "codex" } },
      principalSource: { kind: "daemon-authenticated", providerId: "test", credentialFingerprint: "sha256:test" },
      executorSource: "client-asserted"
    },
    sessionId: "session-test"
  });
  await runEffect(coordinator.enqueue({
    opId: "authority-atomic-op",
    entityId: "task/task-test",
    kind: "progress_append"
  }));

  const flush = await runEffect(coordinator.flush("explicit"));

  assert.equal(flush.opCount, 1);
  assert.equal(atomicPublications, 1);
  assert.equal(directMaterializations, 0);
});

test("held-lock authority publication preserves materializer error name and message", async () => {
  const runtime: AuthorityLifecycleRuntime = {
    createAttributedCoordinator: () => ({
      enqueue: (op) => Effect.succeed({ opId: op.opId, entityId: op.entityId, accepted: true as const }),
      flush: (reason) => Effect.succeed({ reason, opCount: 1, committed: true }),
      recover: Effect.succeed({ replayedOps: 0 })
    }),
    enqueueMaterializerBatch: async () => { throw new Error("materializer unavailable"); },
    enqueueAuthorityPublication: async ({ publish }) => {
      await publish();
      throw new Error("materializer unavailable");
    },
    assertWriteFenceHeld: async () => undefined
  };
  const coordinator = makeHeldLockAttributedCoordinatorFactory(runtime).create({
    attribution: {
      actor: { principal: { kind: "person", personId: "person_test" }, executor: null },
      principalSource: { kind: "daemon-authenticated", providerId: "test", credentialFingerprint: "sha256:test" },
      executorSource: "none"
    },
    sessionId: "session-test"
  });

  const result = await runEffect(Effect.either(coordinator.flush("explicit")));

  assert.equal(result._tag, "Left");
  if (result._tag === "Left") {
    assert.deepEqual(result.left, {
      _tag: "JournalUnavailable",
      cause: { name: "Error", message: "materializer unavailable" }
    });
  }
});

function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return new Promise((resolve, reject) => {
    Effect.runCallback(effect, {
      onExit: (exit) => exit._tag === "Success" ? resolve(exit.value) : reject(new Error(String(exit.cause)))
    });
  });
}

function committedReceipt(opId: string, revision: number) {
  return {
    tag: "COMMITTED" as const,
    workspaceId: "workspace-command-service",
    opId,
    semanticDigest: "11".repeat(32),
    revision,
    commitSha: String(revision).repeat(40),
    previousCommit: revision === 1 ? null : "1".repeat(40)
  };
}

function claimOperation(taskId: string, execution: ExecutionRecord): WriteOp {
  return {
    opId: "observed-strict-task-claim-op",
    entityId: `entity/execution/${execution.execution_id}`,
    kind: "doc_write",
    payload: {
      entityDocument: {
        declaration: {
          kind: executionDeclaration.kind,
          storageForm: executionDeclaration.storageForm,
          rootResolver: executionDeclaration.rootResolver
        },
        identity: { taskId, executionId: execution.execution_id },
        body: executionDeclaration.documentCodec.encode(execution)
      },
      companionWrites: [],
      preconditions: []
    }
  };
}

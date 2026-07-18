// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { taskEntityId } from "../../kernel/src/index.ts";
import { daemonActorAttribution } from "../src/composition/actor-attribution.ts";
import { makeDaemonAuthorityWriteCoordinator } from "../src/daemon/authority-command-submission.ts";
import {
  makeHeldLockAttributedCoordinatorFactory,
  type AuthorityLifecycleRuntime
} from "../src/daemon/authority-lifecycle.ts";

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

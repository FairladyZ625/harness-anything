// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  makeHeldLockAttributedCoordinatorFactory,
  type AuthorityLifecycleRuntime
} from "@harness-anything/daemon";

test("committed direct authority publication requires no session materialization result", async () => {
  const coordinator = authorityCoordinator(runtimeFixture(async (input) => ({
    flush: await input.publish()
  })), "session-direct");
  await enqueueAuthorityTestOperation(coordinator, "op-direct");

  const report = await runEffect(coordinator.flush("explicit"));

  assert.equal(report.committed, true);
  assert.equal(report.opCount, 1);
});

test("uncommitted authority publication remains uncommitted", async () => {
  const coordinator = authorityCoordinator(runtimeFixture(async (input) => {
    await input.publish();
    return {
      flush: { reason: "explicit", opCount: 1, committed: false },
      materialization: {
        branches: [{
          branch: `sessions/${input.sessionId}`,
          commitCount: 0,
          status: "skipped"
        }]
      }
    };
  }), "session-uncommitted");
  await enqueueAuthorityTestOperation(coordinator, "op-uncommitted");

  const report = await runEffect(coordinator.flush("explicit"));

  assert.equal(report.committed, false);
  assert.equal(report.opCount, 1);
});

test("legacy materializer diagnostics do not gate a committed direct publication", async (context) => {
  const cases = [
    {
      name: "missing result",
      materialization: undefined
    },
    {
      name: "conflicted result",
      materialization: {
        branches: [{
          branch: "sessions/session-unproven",
          commitCount: 1,
          status: "conflict" as const
        }]
      }
    }
  ];
  for (const fixture of cases) {
    await context.test(fixture.name, async () => {
      const coordinator = authorityCoordinator(runtimeFixture(async (input) => ({
        flush: await input.publish(),
        ...(fixture.materialization
          ? { materialization: fixture.materialization }
          : {})
      })), "session-unproven");
      await enqueueAuthorityTestOperation(coordinator, `op-${fixture.name.replaceAll(" ", "-")}`);

      const outcome = await runEffect(coordinator.flush("explicit"));

      assert.equal(outcome.committed, true);
      assert.equal(outcome.opCount, 1);
    });
  }
});

type AuthorityPublication = Parameters<AuthorityLifecycleRuntime["enqueueAuthorityPublication"]>[0];
type AuthorityPublicationReport = Awaited<ReturnType<AuthorityLifecycleRuntime["enqueueAuthorityPublication"]>>;

function runtimeFixture(
  publish: (input: AuthorityPublication) => Promise<AuthorityPublicationReport>
): AuthorityLifecycleRuntime {
  let pending = 0;
  return {
    createAttributedCoordinator: () => ({
      enqueue: (op) => Effect.sync(() => {
        pending += 1;
        return { opId: op.opId, entityId: op.entityId, accepted: true as const };
      }),
      flush: (reason) => Effect.sync(() => ({
        reason,
        opCount: pending,
        committed: true
      })),
      recover: Effect.succeed({ replayedOps: 0 })
    }),
    enqueueMaterializerBatch: async () => ({ branches: [] }),
    enqueueAuthorityPublication: publish,
    assertWriteFenceHeld: async () => undefined
  };
}

function authorityCoordinator(runtime: AuthorityLifecycleRuntime, sessionId: string) {
  return makeHeldLockAttributedCoordinatorFactory(runtime).create({
    attribution: {
      actor: {
        principal: { kind: "person", personId: "person_test" },
        executor: null
      },
      principalSource: {
        kind: "daemon-authenticated",
        providerId: "test",
        credentialFingerprint: "sha256:test"
      },
      executorSource: "none"
    },
    sessionId
  });
}

function enqueueAuthorityTestOperation(
  coordinator: ReturnType<typeof authorityCoordinator>,
  opId: string
) {
  return runEffect(coordinator.enqueue({
    opId,
    entityId: "task/task_test",
    actor: { kind: "human", id: "person_test" },
    payload: { type: "status-set", status: "active" }
  }));
}

function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return new Promise((resolve, reject) => {
    Effect.runCallback(effect, {
      onExit: (exit) => exit._tag === "Success"
        ? resolve(exit.value)
        : reject(new Error(String(exit.cause)))
    });
  });
}

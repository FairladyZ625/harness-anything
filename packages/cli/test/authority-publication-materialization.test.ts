// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { createExactWriteScope, createJournaledBatch, withExactCommit } from "@harness-anything/kernel";
import {
  makeHeldLockAttributedCoordinatorFactory,
  type AuthorityLifecycleRuntime
} from "@harness-anything/daemon";

test("committed authority publication accepts an already-materialized skipped session", async () => {
  const coordinator = authorityCoordinator(runtimeFixture(async (input) => ({
    flush: await input.publish(),
    materialization: {
      branches: [{
        branch: `sessions/${input.sessionId}`,
        commitCount: 0,
        status: "skipped"
      }]
    }
  })), "session-already-materialized");
  const entry = await enqueueAuthorityTestOperation(coordinator, "op-already-materialized");

  const report = await runEffect(coordinator.commitExact("explicit", createJournaledBatch([entry])));

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
  const entry = await enqueueAuthorityTestOperation(coordinator, "op-uncommitted");

  const report = await runEffect(coordinator.commitExact("explicit", createJournaledBatch([entry])));

  assert.equal(report.committed, false);
  assert.equal(report.opCount, 1);
});

test("committed publication without materialization proof remains indeterminate", async (context) => {
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
      const entry = await enqueueAuthorityTestOperation(coordinator, `op-${fixture.name.replaceAll(" ", "-")}`);

      const outcome = await runEffect(Effect.either(
        coordinator.commitExact("explicit", createJournaledBatch([entry]))
      ));

      assert.equal(outcome._tag, "Left");
      if (outcome._tag === "Right") return;
      assert.equal(outcome.left._tag, "JournalUnavailable");
      assert.match(JSON.stringify(outcome.left.cause), /AUTHORITY_SESSION_MATERIALIZATION_FAILED/u);
    });
  }
});

test("separate session scopes materialize only their own publication routes", async () => {
  const publishedSessions: string[] = [];
  const runtime = runtimeFixture(async (input) => {
    publishedSessions.push(input.sessionId);
    return {
      flush: await input.publish(),
      materialization: {
        branches: [{
          branch: `sessions/${input.sessionId}`,
          commitCount: 1,
          status: "merged"
        }]
      }
    };
  });
  const factory = makeHeldLockAttributedCoordinatorFactory(runtime);
  const first = factory.create({
    attribution: authorityAttribution(),
    sessionId: "session-first",
    exactWriteScope: createExactWriteScope()
  });
  const second = factory.create({
    attribution: authorityAttribution(),
    sessionId: "session-second",
    exactWriteScope: createExactWriteScope()
  });
  const firstEntry = await enqueueAuthorityTestOperation(first, "op-first-session");
  await runEffect(first.commitExact("explicit", createJournaledBatch([firstEntry])));

  const secondEntry = await enqueueAuthorityTestOperation(second, "op-second-session");
  await runEffect(second.commitExact("explicit", createJournaledBatch([secondEntry])));

  assert.deepEqual(publishedSessions, ["session-first", "session-second"]);
});

type AuthorityPublication = Parameters<AuthorityLifecycleRuntime["enqueueAuthorityPublication"]>[0];
type AuthorityPublicationReport = Awaited<ReturnType<AuthorityLifecycleRuntime["enqueueAuthorityPublication"]>>;

function runtimeFixture(
  publish: (input: AuthorityPublication) => Promise<AuthorityPublicationReport>
): AuthorityLifecycleRuntime {
  let pending = 0;
  return {
    createAttributedCoordinator: ({ exactWriteScope }) => withExactCommit({
      enqueue: (op) => Effect.sync(() => {
        pending += 1;
        return { opId: op.opId, entityId: op.entityId, accepted: true as const };
      }),
      recover: Effect.succeed({ replayedOps: 0 })
    }, (reason) => Effect.sync(() => ({
        reason,
        opCount: pending,
        committed: true
      })), exactWriteScope),
    enqueueMaterializerBatch: async () => ({ branches: [] }),
    enqueueAuthorityPublication: publish,
    assertWriteFenceHeld: async () => undefined
  };
}

function authorityCoordinator(runtime: AuthorityLifecycleRuntime, sessionId: string) {
  return makeHeldLockAttributedCoordinatorFactory(runtime).create({
    attribution: authorityAttribution(),
    sessionId,
    exactWriteScope: createExactWriteScope()
  });
}

function authorityAttribution() {
  return {
    actor: {
      principal: { kind: "person" as const, personId: "person_test" },
      executor: null
    },
    principalSource: {
      kind: "daemon-authenticated" as const,
      providerId: "test",
      credentialFingerprint: "sha256:test"
    },
    executorSource: "none" as const
  };
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

// harness-test-tier: contract
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reduceTaskEvent, type TaskEventV1, type FrozenGateRequirement } from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { completionSnapshot } from "../../kernel/test/domain/completion.fixtures.ts";
import type { RepoCellOperationalContext } from "../src/repo-cell-action-context.ts";
import type { RepoCellApiContext } from "../src/repo-cell-api.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";
import { centerWitnessAction, runTaskWitnessAction } from "../src/task-witness-action.ts";
import { readBeforeWriteQueue } from "../src/write-queue-external-reads.ts";
import { preparedCiObservation } from "../src/ci-observation-actions.ts";

const requirement: FrozenGateRequirement = {
  gateId: "ci",
  appliesTo: "code",
  witness: {
    ...completionSnapshot.completion.sources["github-actions"],
    adapterId: "github-actions",
    adapterOptions: {
      workflows: ["rewrite-ci"],
      branch: "main",
      event: "push",
      coverage: "exact",
      selection: "newest",
    },
  },
};

function fixture(t: TestContext) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-witness-binding-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Witness Binding Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("commit", "--allow-empty", "-qm", "fixture");
  const commitSha = git("rev-parse", "HEAD");
  let snapshot = lifecycleFixture({ gates: [requirement], complete: false }).snapshot;
  snapshot = {
    ...snapshot,
    executions: snapshot.executions.map((execution) => ({
      ...execution,
      submission: { ...execution.submission!, commitSha },
    })),
  };
  let now = "2026-10-11T00:00:00.000Z",
    observed = false,
    stale = false,
    fenceCalls = 0;
  const events: TaskEventV1[] = [],
    published: RepoCellBinding[] = [];
  const binding: RepoCellBinding = {
    actor: snapshot.task!.createdBy,
    source: { kind: "node", nodeId: "edge-a" },
    writerEpoch: 7,
    writerEpochFence: {
      schema: "harness-writer-epoch-fence/v1",
      stateRoot: "/fixture",
      repoId: "workspace-1",
      holderId: "center",
      epoch: 7,
    },
    withWriterEpochFence: <T>(operation: () => T): T => {
      if (stale) throw Object.assign(new Error("stale fixture writer"), { code: "writer_epoch_stale" });
      fenceCalls += 1;
      return operation();
    },
  };
  const cell = {
    rootDir,
    input: { repoId: "workspace-1" },
    now: () => now,
    requiredCellText: (value: unknown) => String(value),
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    operationId: () => `operation-${snapshot.revision + 1}`,
    projectionReady: () => true,
    projection: {
      read: () => ({ snapshot, packagePath: null }),
      list: ({ status }: { status: string }) => ({
        rows: snapshot.task!.status === status ? [{ taskId: snapshot.task!.taskId, snapshot }] : [],
      }),
      getEntity: () => ({ value: { status: { activeRun: { claimFence: 9 } } } }),
      readCiRunObservations: () => ({
        events: observed
          ? [
              {
                workspaceRevision: snapshot.revision,
                opId: "ci-observation",
                payload: {
                  scope: "run",
                  run: { runId: "1.1", sha: commitSha, branch: "main" },
                  verification: {
                    source: "github-actions",
                    event: "push",
                    workflow: "rewrite-ci",
                    conclusion: "success",
                  },
                },
              },
            ]
          : [],
      }),
      apply: (event: TaskEventV1) => {
        snapshot = reduceTaskEvent(snapshot, event);
      },
    },
    store: {
      readHead: () => ({ revision: snapshot.revision }),
      append: ({ event }: { event: TaskEventV1 }) =>
        binding.withWriterEpochFence!(() => {
          events.push(event);
          return {};
        }),
    },
    publicPublication: () => ({}),
    receiptProof: () => ({}),
    lifecycleReceipt: () => ({ outcome: "applied", opId: "fixture", revision: snapshot.revision }),
    publishGateWitness: (...args: Parameters<RepoCellOperationalContext["publishGateWitness"]>) => {
      published.push(args[4]);
      return { outcome: "applied", opId: "witness", revision: snapshot.revision };
    },
  } as unknown as RepoCellOperationalContext;
  const action = {
    kind: "task-witness-claim",
    taskId: snapshot.task!.taskId,
    executionId: snapshot.executions[0]!.executionId,
    gateId: "ci",
    [centerWitnessAction]: true,
  };
  const sourceBinding: RepoCellBinding = {
    ...binding,
    actor: { principal: binding.actor.principal, executor: { kind: "agent", id: "completion-source:github-actions" } },
  };
  return {
    cell,
    binding,
    sourceBinding,
    action,
    events,
    published,
    snapshot: () => snapshot,
    fenceCalls: () => fenceCalls,
    observe: () => {
      observed = true;
    },
    expire: () => {
      now = "2026-10-11T02:00:00.000Z";
    },
    stale: () => {
      stale = true;
    },
  };
}

function assertBinding(actual: RepoCellBinding, expected: RepoCellBinding): void {
  assert.deepEqual(actual.source, expected.source);
  assert.equal(actual.withWriterEpochFence, expected.withWriterEpochFence);
  assert.equal(actual.writerEpochFence, expected.writerEpochFence);
  assert.equal(actual.writerEpoch, expected.writerEpoch);
  assert.deepEqual(actual.actor.principal, expected.actor.principal);
  assert.deepEqual(actual.actor.executor, { kind: "agent", id: "completion-source:github-actions" });
}

for (const existing of [false, true]) {
  test(`CI settlement preserves the caller binding for ${existing ? "an existing" : "a new"} claim`, (t) => {
    const f = fixture(t);
    if (existing) runTaskWitnessAction(f.cell, f.action, f.sourceBinding);
    f.observe();
    runTaskWitnessAction(f.cell, f.action, f.sourceBinding);
    assert.equal(f.events.length, 1);
    assert.equal(f.published.length, 1);
    assertBinding(f.published[0]!, f.binding);
  });
}

test("queued CI import inherits the request binding for renewal and settlement", async (t) => {
  const f = fixture(t);
  runTaskWitnessAction(f.cell, f.action, f.sourceBinding);
  f.expire();
  f.observe();
  const context = { extracted: f.cell, projection: f.cell.projection } as RepoCellApiContext;
  const action = {
    kind: "ci-observe-pull",
    scheduleId: "ci",
    claimFence: 9,
    [preparedCiObservation]: { requestedRuns: 0, runs: [] },
  };
  const execute = await readBeforeWriteQueue(context, action, f.binding, async () => {
    throw new Error("unexpected fetch");
  });
  assert.ok(execute);
  await execute(action, f.binding);
  assert.equal(f.events.length, 2);
  assert.deepEqual(f.events[1]!.source, f.binding.source);
  assert.equal(f.snapshot().executions[0]!.gateRuns[0]!.state, "cancelled");
  assert.equal(f.published.length, 1);
  assertBinding(f.published[0]!, f.binding);
  // A second edge invocation inside the same writer turn reuses the accepted claim.
  await execute(action, { ...f.binding, source: { kind: "node", nodeId: "edge-b" } });
  assert.equal(f.events.length, 2);
  assertBinding(f.published[1]!, { ...f.binding, source: { kind: "node", nodeId: "edge-b" } });
  assert.equal(f.fenceCalls(), 2);
});

test("a rejected writer append cannot renew or publish, and transport cannot claim", (t) => {
  const f = fixture(t);
  runTaskWitnessAction(f.cell, f.action, f.sourceBinding);
  f.expire();
  f.observe();
  f.stale();
  assert.throws(() => runTaskWitnessAction(f.cell, f.action, f.sourceBinding), { code: "writer_epoch_stale" });
  assert.equal(f.events.length, 1);
  assert.equal(f.snapshot().executions[0]!.gateRuns.length, 1);
  assert.equal(f.published.length, 0);
  assert.throws(() => runTaskWitnessAction(f.cell, { ...f.action, [centerWitnessAction]: false }, f.binding), {
    code: "actor_unauthorized",
  });
});

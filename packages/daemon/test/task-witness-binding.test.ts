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
import type { RepoCellBinding } from "../src/repo-cell-types.ts";
import { centerWitnessAction, runTaskWitnessAction } from "../src/task-witness-action.ts";
import { readBeforeWriteQueue } from "../src/write-queue-external-reads.ts";

const requirement: FrozenGateRequirement = {
  gateId: "lint",
  appliesTo: "code",
  witness: {
    ...completionSnapshot.completion.sources["research/check"],
    adapterId: "research/check",
    adapterOptions: {},
  },
};

function fixture(t: TestContext) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-witness-binding-"));
  const now = "2026-10-18T00:00:00.000Z";
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
  let stale = false,
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
    gateId: "lint",
    [centerWitnessAction]: true,
  };
  const sourceBinding: RepoCellBinding = {
    ...binding,
    actor: { principal: binding.actor.principal, executor: { kind: "agent", id: "completion-source:research/check" } },
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
  assert.deepEqual(actual.actor.executor, { kind: "agent", id: "completion-source:research/check" });
}

for (const existing of [false, true]) {
  test(`generic gate claims preserve the caller binding for ${existing ? "an existing" : "a new"} claim`, (t) => {
    const f = fixture(t);
    if (existing) runTaskWitnessAction(f.cell, f.action, f.sourceBinding);
    const receipt = runTaskWitnessAction(f.cell, f.action, f.sourceBinding);
    assert.equal(f.events.length, existing ? 1 : 1);
    assert.equal(f.events[0]!.source, f.binding.source);
    assert.equal(f.published.length, 0);
    assert.equal(receipt.outcome, existing ? "no_changes" : "applied");
  });
}

test("a rejected writer append cannot record a generic gate claim, and transport cannot claim", (t) => {
  const f = fixture(t);
  f.stale();
  assert.throws(() => runTaskWitnessAction(f.cell, { ...f.action, kind: "task-witness-claim" }, f.sourceBinding), {
    code: "writer_epoch_stale",
  });
  assert.equal(f.events.length, 0);
  assert.equal(f.snapshot().executions[0]!.gateRuns.length, 0);
  assert.equal(f.published.length, 0);
  assert.throws(() => runTaskWitnessAction(f.cell, { ...f.action, [centerWitnessAction]: false }, f.binding), {
    code: "actor_unauthorized",
  });
});

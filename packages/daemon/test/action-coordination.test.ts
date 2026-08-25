// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { ActorIdentity } from "../../kernel/src/index.ts";
import { authorizeAction, createAuthorizationActionEnvelope } from "../src/authorization.ts";
import { coordinateAction, executeActionCoordination } from "../src/action-coordination.ts";

test("coordination plan distinguishes each facet mutation", () => {
  const disabled = {
      dryRun: "disabled",
      wipAdmission: null,
      fleetProvisionalReservation: "disabled",
      fifo: "disabled",
    } as const,
    runtime = { dryRunRequested: true },
    baseline = coordinateAction(disabled, runtime);
  assert.deepEqual(baseline, {
    execution: "execute",
    wipAdmission: null,
    fleetProvisionalReservation: "skip",
    fifo: "bypass",
  });

  const mutations = [
    {
      name: "dryRun",
      facet: { ...disabled, dryRun: "supported" as const },
      field: "execution",
      expected: "preview",
    },
    {
      name: "wipAdmission",
      facet: { ...disabled, wipAdmission: { nextStatus: "active" as const } },
      field: "wipAdmission",
      expected: { nextStatus: "active" },
    },
    {
      name: "fleetProvisionalReservation",
      facet: { ...disabled, fleetProvisionalReservation: "required" as const },
      field: "fleetProvisionalReservation",
      expected: "reserve",
    },
    {
      name: "fifo",
      facet: { ...disabled, fifo: "required" as const },
      field: "fifo",
      expected: "enqueue",
    },
  ] as const;
  for (const mutation of mutations) {
    const plan = coordinateAction(mutation.facet, runtime);
    assert.notDeepEqual(plan, baseline, mutation.name);
    assert.deepEqual(plan[mutation.field], mutation.expected, mutation.name);
  }

  assert.deepEqual(
    coordinateAction(
      {
        dryRun: "supported",
        wipAdmission: { nextStatus: "active" },
        fleetProvisionalReservation: "required",
        fifo: "required",
      },
      runtime,
    ),
    {
      execution: "preview",
      wipAdmission: { nextStatus: "active" },
      fleetProvisionalReservation: "skip",
      fifo: "enqueue",
    },
  );
});

test("coordination consumes declared WIP and dry-run facets without an action-kind branch", async () => {
  const calls: string[] = [];
  const result = await executeActionCoordination(
    coordinateAction(
      {
        dryRun: "supported",
        wipAdmission: { nextStatus: "active" },
        fleetProvisionalReservation: "required",
        fifo: "required",
      },
      {
        dryRunRequested: true,
      },
    ),
    {
      admitWip: (nextStatus) => calls.push(`wip:${nextStatus}`),
      preview: () => {
        calls.push("preview");
        return "previewed";
      },
      execute: () => {
        calls.push("execute");
        return "executed";
      },
    },
  );
  assert.equal(result, "previewed");
  assert.deepEqual(calls, ["wip:active", "preview"]);
});

test("disabled coordination values execute without dry-run or WIP hooks", async () => {
  const calls: string[] = [];
  const result = await executeActionCoordination(
    coordinateAction(
      {
        dryRun: "disabled",
        wipAdmission: null,
        fleetProvisionalReservation: "disabled",
        fifo: "disabled",
      },
      {
        dryRunRequested: true,
      },
    ),
    {
      admitWip: () => calls.push("wip"),
      preview: () => {
        calls.push("preview");
        return "previewed";
      },
      execute: () => {
        calls.push("execute");
        return "executed";
      },
    },
  );
  assert.equal(result, "executed");
  assert.deepEqual(calls, ["execute"]);
});

test("daemon authorization keeps attempt identity independent from caller idempotency", () => {
  const actor: ActorIdentity = {
    principal: { personId: "person-authorization" },
    executor: null,
  };
  const action = createAuthorizationActionEnvelope(
    "task.complete",
    "task/task_authorization",
    actor,
    "authorization-attempt-1",
    "caller-operation-1",
  );
  assert.equal(action.actionId, "authorization-attempt-1");
  assert.equal(action.idempotencyKey, "caller-operation-1");
  assert.notEqual(action.actionId, action.idempotencyKey);
  const retried = createAuthorizationActionEnvelope(
    "task.complete",
    "task/task_authorization",
    actor,
    "authorization-attempt-2",
    "caller-operation-1",
  );
  const separate = createAuthorizationActionEnvelope(
    "task.complete",
    "task/task_authorization",
    actor,
    "authorization-attempt-2",
    "caller-operation-2",
  );
  assert.notEqual(retried.actionId, action.actionId);
  assert.equal(retried.idempotencyKey, action.idempotencyKey);
  assert.notEqual(separate.idempotencyKey, action.idempotencyKey);
  assert.equal(
    authorizeAction(
      "task.complete",
      "task/task_authorization",
      actor,
      "authorization-attempt-3",
      "caller-operation-1",
      { target: { owner: actor }, evaluatedAtCut: "canonical:1" },
    ).outcome,
    "allowed",
  );
});

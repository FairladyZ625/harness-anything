// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  createResourceBudget,
  ResourceBudgetExceeded,
  type ResourceBudgetLimits,
  type ResourceScope,
} from "../src/fleet/resource-budget.ts";

const scope = (nodeId = "node-a", sessionId = "session-a", repoId = "repo-a"): ResourceScope => ({
  nodeId,
  sessionId,
  repoId,
});
const limits: ResourceBudgetLimits = {
  global: { bulkTransfers: 8, controlHandlers: 32, diskBytes: 20 * 1024 ** 3 },
  node: { bulkTransfers: 2, controlHandlers: 8, diskBytes: 2 * 1024 ** 3 },
  session: { bulkTransfers: 2, controlHandlers: 8, diskBytes: 2 * 1024 ** 3 },
  repository: { bulkTransfers: 4, controlHandlers: 16, diskBytes: 8 * 1024 ** 3 },
};

test("one node cannot exhaust the global window by opening sessions or repositories", () => {
  const budget = createResourceBudget(limits);
  const first = budget.reserve(scope(), { bulkTransfers: 1 });
  const second = budget.reserve(scope("node-a", "session-b", "repo-b"), { bulkTransfers: 1 });
  assert.throws(
    () => budget.reserve(scope("node-a", "session-c", "repo-c"), { bulkTransfers: 1 }),
    (error: unknown) => error instanceof ResourceBudgetExceeded && error.scope === "node" && error.available === 0,
  );
  assert.equal(budget.usage(scope()).global.bulkTransfers, 2);
  const other = budget.reserve(scope("node-b"), { bulkTransfers: 1 });
  assert.equal(budget.usage(scope()).global.bulkTransfers, 3);
  first.release();
  first.release();
  second.release();
  other.release();
  assert.deepEqual(budget.usage(scope()), { global: {}, node: {}, session: {}, repository: {} });
});

test("50 nodes contend for eight global slots without leaking denied reservations", () => {
  const budget = createResourceBudget(limits);
  const leases: Array<{ release: () => void }> = [];
  let denied = 0;
  for (let index = 0; index < 50; index += 1) {
    try {
      leases.push(budget.reserve(scope(`node-${index}`, `session-${index}`, `repo-${index}`), { bulkTransfers: 1 }));
    } catch (error) {
      assert.ok(error instanceof ResourceBudgetExceeded);
      assert.equal(error.scope, "global");
      denied += 1;
    }
  }
  assert.equal(leases.length, 8);
  assert.equal(denied, 42);
  assert.equal(budget.usage(scope()).global.bulkTransfers, 8);
  for (const lease of leases) lease.release();
  assert.deepEqual(budget.usage(scope()).global, {});
});

for (const restricted of ["global", "node", "session", "repository"] as const) {
  test(`${restricted} exhaustion rejects the entire resource vector atomically`, () => {
    const budget = createResourceBudget({
      ...limits,
      [restricted]: { ...limits[restricted], diskBytes: 3 },
    });
    assert.throws(
      () => budget.reserve(scope(), { bulkTransfers: 1, diskBytes: 4 }),
      (error: unknown) =>
        error instanceof ResourceBudgetExceeded &&
        error.code === "resource_exhausted" &&
        error.scope === restricted &&
        error.resource === "diskBytes" &&
        error.required === 4 &&
        error.available === 3,
    );
    assert.deepEqual(budget.usage(scope()), { global: {}, node: {}, session: {}, repository: {} });
    budget.reserve(scope(), { bulkTransfers: 1, diskBytes: 3 }).release();
  });
}

test("repository quota is shared by nodes, and a full session leaves another session usable", () => {
  const budget = createResourceBudget({
    ...limits,
    session: { bulkTransfers: 1 },
    repository: { bulkTransfers: 2 },
  });
  const first = budget.reserve(scope(), { bulkTransfers: 1 });
  assert.throws(
    () => budget.reserve(scope(), { bulkTransfers: 1 }),
    (error: unknown) => error instanceof ResourceBudgetExceeded && error.scope === "session",
  );
  const second = budget.reserve(scope("node-b", "session-b"), { bulkTransfers: 1 });
  assert.throws(
    () => budget.reserve(scope("node-c", "session-c"), { bulkTransfers: 1 }),
    (error: unknown) => error instanceof ResourceBudgetExceeded && error.scope === "repository",
  );
  const independent = budget.reserve(scope("node-c", "session-c", "repo-b"), { bulkTransfers: 1 });
  first.release();
  second.release();
  independent.release();
});

test("bulk capacity cannot borrow reserved control slots", () => {
  const budget = createResourceBudget(limits);
  const bulk = Array.from({ length: 8 }, (_, index) =>
    budget.reserve(scope(`node-${index}`, `session-${index}`, `repo-${index}`), { bulkTransfers: 1 }),
  );
  const control = budget.reserve(scope(), { controlHandlers: 1 });
  assert.equal(budget.usage(scope()).global.controlHandlers, 1);
  control.release();
  for (const lease of bulk) lease.release();
});

test("multi-GiB disk reservations share a node quota across repositories", () => {
  const budget = createResourceBudget(limits);
  const first = budget.reserve(scope(), { diskBytes: 1024 ** 3 });
  const second = budget.reserve(scope("node-a", "session-b", "repo-b"), { diskBytes: 1024 ** 3 });
  assert.throws(
    () => budget.reserve(scope("node-a", "session-c", "repo-c"), { diskBytes: 1 }),
    (error: unknown) => error instanceof ResourceBudgetExceeded && error.scope === "node",
  );
  assert.equal(budget.usage(scope()).node.diskBytes, 2 * 1024 ** 3);
  first.release();
  second.release();
});

test("session identifiers are namespaced by authenticated node, not repository", () => {
  const budget = createResourceBudget({ ...limits, session: { bulkTransfers: 1 } });
  const first = budget.reserve(scope(), { bulkTransfers: 1 });
  const other = budget.reserve(scope("node-b"), { bulkTransfers: 1 });
  assert.throws(
    () => budget.reserve(scope("node-a", "session-a", "repo-b"), { bulkTransfers: 1 }),
    (error: unknown) => error instanceof ResourceBudgetExceeded && error.scope === "session",
  );
  first.release();
  other.release();
});

test("policy, reservation and usage snapshots cannot mutate the ledger", () => {
  const policy = structuredClone(limits);
  const budget = createResourceBudget(policy);
  const owner = { ...scope() };
  const cost = { bulkTransfers: 1 };
  const lease = budget.reserve(owner, cost);
  owner.nodeId = "changed";
  cost.bulkTransfers = 8;
  Object.assign(policy.node, { bulkTransfers: 8 });
  Object.assign(budget.usage(scope()).global, { bulkTransfers: 0 });
  assert.equal(budget.usage(scope()).global.bulkTransfers, 1);
  assert.throws(() => budget.reserve(scope(), { bulkTransfers: 2 }), ResourceBudgetExceeded);
  lease.release();
  assert.deepEqual(budget.usage(scope()).global, {});
});

test("invalid costs and limits fail at the reservation boundary; unspecified resources are denied", () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const budget = createResourceBudget(limits);
    assert.throws(() => budget.reserve(scope(), { bulkTransfers: value }), RangeError);
    assert.deepEqual(budget.usage(scope()).global, {});
    assert.throws(() => createResourceBudget({ ...limits, global: { bulkTransfers: value } }), RangeError);
  }
  const budget = createResourceBudget(limits);
  assert.throws(() => budget.reserve(scope(), { sockets: 1 }), ResourceBudgetExceeded);
  budget.reserve(scope(), { bulkTransfers: 0 }).release();
});

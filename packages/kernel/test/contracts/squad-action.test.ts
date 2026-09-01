// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { entityActionCriterionFailure, getEntityKindContract, type EntityActionCompileInput } from "../../src/index.ts";
import { compileSquadInstallAction } from "../../src/domain/squad-action-contract.ts";

const actionInput: EntityActionCompileInput = {
  action: {},
  actor: { principal: { personId: "person-squad-contract" }, executor: null },
  source: "local",
  session: { kind: "local-process", processId: "squad-action-contract" },
  opId: `op_${"a".repeat(64)}`,
  occurredAt: "2026-09-01T00:00:00.000Z",
  workspaceRevision: 1,
};

test("Squad catalog declares the complete command surface and center concurrency subject", () => {
  const catalog = getEntityKindContract("squad")?.actionCatalog;
  assert.ok(catalog);
  assert.equal(catalog.ref, "kernel/squad-action/v1");
  assert.deepEqual(
    catalog.actions.map(({ id }) => id),
    ["install", "validate", "list", "inspect", "run", "status", "cancel"],
  );
  assert.deepEqual(
    catalog.actions.filter(({ execution }) => execution?.read).map(({ id }) => id),
    ["validate", "list", "inspect", "status"],
  );
  const run = catalog.actions.find(({ id }) => id === "run");
  assert.ok(run);
  assert.equal(run.execution?.implementation, "catalog-runtime");
  assert.equal(run.execution?.topology, "ledger-write");
  assert.equal(run.concurrency.leasePolicy.authority, "task-current-execution-lease");
  assert.equal(run.concurrency.expectedVersion.arbitration, "writer-generation-and-epoch");
  assert.equal(run.concurrency.artifactOwnership.mutationRoad, "center-single-write-queue");
});

test("Squad install compiler owns schema and roster predicates by exact ref", () => {
  const declaration = {
    schema: "squad-declaration/v1",
    id: "contract-squad",
    name: "Contract Squad",
    leader: "leader",
    workers: ["worker"],
    leaderTurnBudget: 4,
    roster: "# Contract Squad\n\nLeader coordinates Worker.",
  };
  assert.deepEqual(compileSquadInstallAction({ ...actionInput, action: { declaration } }), {
    kind: "entity",
    entityKind: "squad",
    entity: declaration,
  });
  assert.throws(
    () => compileSquadInstallAction({ ...actionInput, action: { declaration: { ...declaration, workers: "worker" } } }),
    (error: unknown) => {
      assert.deepEqual(entityActionCriterionFailure(error), {
        actionId: "install",
        criterionRef: "squad/declaration-schema",
        nextActions: [],
      });
      return true;
    },
  );
  assert.throws(
    () =>
      compileSquadInstallAction({
        ...actionInput,
        action: { declaration: { ...declaration, roster: "## Squad Roster\n（待补写）" } },
      }),
    (error: unknown) => {
      assert.deepEqual(entityActionCriterionFailure(error), {
        actionId: "install",
        criterionRef: "squad/roster-ready",
        nextActions: [],
      });
      return true;
    },
  );
});

// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getEntityKindContract, makeTaskEventStore, openSqliteEventStore } from "../../kernel/src/index.ts";
import {
  makeDaemonCommandReceipt,
  validateDaemonGuiCommandReceipt,
  canonicalRoot,
  workspaceId,
} from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { evidence, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const owner = {
    actor: {
      principal: { personId: "person-squad-owner" },
      executor: { kind: "agent" as const, id: "squad-owner" },
    },
    source: "local" as const,
  },
  contender = {
    actor: {
      principal: { personId: "person-squad-contender" },
      executor: { kind: "agent" as const, id: "squad-contender" },
    },
    source: "local" as const,
  },
  leader = {
    schema: "agent-declaration/v1",
    id: "squad-leader",
    name: "Squad Leader",
    instructions: "Coordinate the declared workers and synthesize their evidence.",
    runtime_type: "codex",
  },
  worker = {
    schema: "agent-declaration/v1",
    id: "squad-worker",
    name: "Squad Worker",
    instructions: "Complete one bounded assignment and report evidence.",
    runtime_type: "codex",
  },
  squad = {
    schema: "squad-declaration/v1",
    id: "catalog-squad",
    name: "Catalog Squad",
    leader: leader.id,
    workers: [worker.id],
    leaderTurnBudget: 4,
    roster: "# Catalog Squad\n\nLeader coordinates one worker; synthesis is stored under the task execution.",
  };

test("Squad Action catalog owns install, read surfaces, and exact rejected criteria", async () => {
  const rootDir = workspace("catalog"),
    repoId = workspaceId("squad-action-catalog");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    const catalog = getEntityKindContract("squad")?.actionCatalog;
    assert.ok(catalog);
    assert.deepEqual(
      catalog.actions.map(({ id }) => id),
      ["install", "delete", "validate", "list", "inspect", "run", "status", "cancel"],
    );
    assert.deepEqual(
      catalog.actions.filter(({ execution }) => execution?.read).map(({ id }) => id),
      ["validate", "list", "inspect", "status"],
    );

    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "squad-action-catalog" });
    const installed = await installFixture(cell),
      squadInstall = installed.find(({ declaration }) => declaration.schema === "squad-declaration/v1");
    assert.ok(squadInstall);
    assertDurableSquadDeclaration(rootDir, repoId, squadInstall.receipt.opId);

    const listed = await cell.run({ kind: "squad-list" }, owner),
      inspected = await cell.run({ kind: "squad-inspect", squadId: squad.id }, owner),
      listEvidence = {
        schema: "squad-list/v1",
        squads: [
          {
            schema: squad.schema,
            id: squad.id,
            name: squad.name,
            leader: squad.leader,
            workers: squad.workers,
            leaderTurnBudget: squad.leaderTurnBudget,
            layer: "user",
            source: "squads/catalog-squad.json",
            validity: "valid",
            issues: [],
          },
        ],
        status: "ready",
        watermark: listed.revision,
        sourceRevision: listed.revision,
      },
      inspectEvidence = {
        schema: "squad-inspection/v1",
        squad,
        status: "ready",
        watermark: inspected.revision,
        sourceRevision: inspected.revision,
      };
    assertExactReadReceipt(listed, listEvidence, null);
    assertExactReadReceipt(inspected, inspectEvidence, {
      kind: "squad",
      ref: "squad/catalog-squad",
      revision: inspected.revision,
    });

    const explainedCatalog = await cell.read(
        "repo.entity.actions.explain",
        {
          schema: "entity-action-explain-request/v1",
          mode: "catalog",
          entityKind: "squad",
          refs: [],
        },
        owner,
      ),
      explainedObject = await cell.read(
        "repo.entity.actions.explain",
        {
          schema: "entity-action-explain-request/v1",
          mode: "object",
          entityKind: null,
          refs: [`squad/${squad.id}`],
        },
        owner,
      );
    assert.deepEqual(
      explainedCatalog.subjects[0]!.actions.map(({ action }) => action.id),
      ["install", "delete", "validate", "list", "inspect", "run", "status", "cancel"],
    );
    assert.equal(
      explainedCatalog.subjects[0]!.actions.every(({ available }) => available === null),
      true,
    );
    assert.equal(explainedObject.subjects[0]!.ref, `squad/${squad.id}`);
    assert.equal(
      explainedObject.subjects[0]!.actions.find(({ action }) => action.id === "run")?.criteria.find(
        ({ ref }) => ref === "squad/execution-lease-holder",
      )?.status,
      "invocation-required",
    );

    await assertRejectedWithoutEvent(
      rootDir,
      repoId,
      () => cell!.run({ kind: "squad-inspect", squadId: "missing-squad" }, owner),
      "squad/entity-present",
    );
    await assertRejectedWithoutEvent(
      rootDir,
      repoId,
      () => cell!.run({ kind: "squad-status", squadRunId: "not-a-run" }, owner),
      "squad/run-id",
    );
    await assertRejectedWithoutEvent(
      rootDir,
      repoId,
      () => cell!.run({ kind: "squad-install", declaration: squad, expectedVersion: 0 }, owner),
      "squad/entity-revision",
    );
    await assertRejectedWithoutEvent(
      rootDir,
      repoId,
      () =>
        cell!.run(
          {
            kind: "squad-install",
            declaration: { ...squad, id: "placeholder-squad", roster: "## Squad Roster\n（待补写）" },
          },
          owner,
        ),
      "squad/roster-ready",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Squad list retains one invalid declaration projection beside healthy rows", async () => {
  const rootDir = workspace("invalid-list-row"),
    repoId = workspaceId("squad-action-invalid-list-row");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "squad-action-invalid-list-row" });
    await installFixture(cell);
    const invalidId = "broken-squad",
      installed = await cell.run(
        { kind: "squad-install", declaration: { ...squad, id: invalidId, name: "Broken Squad" } },
        owner,
      );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    corruptSquadProjection(rootDir, invalidId);

    const listed = await cell.run({ kind: "squad-list" }, owner),
      rows = evidence(listed).squads as Array<Record<string, unknown>>;
    assert.equal(listed.outcome, "applied", JSON.stringify(listed));
    assert.deepEqual(
      rows.find(({ id }) => id === invalidId),
      {
        id: invalidId,
        layer: "user",
        state: "invalid",
        error: {
          code: "invalid_entity_contract",
          hint: 'squad declaration is missing required field "leader".',
        },
      },
    );
    const healthy = rows.find(({ id }) => id === squad.id);
    assert.equal(healthy?.validity, "valid");
    assert.equal(Object.hasOwn(healthy ?? {}, "state"), false);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("two actors contending for one Task fence reject the non-holder before Squad state or artifacts", async () => {
  const rootDir = workspace("fence"),
    repoId = workspaceId("squad-action-fence"),
    taskId = "task-squad-fence",
    executionId = "execution-squad-fence";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "squad-action-fence" });
    await installFixture(cell);
    const created = await cell.run({ kind: "task-create", taskId, title: "Squad fence contention" }, owner);
    assert.equal(created.outcome, "applied");
    await waitForFixturePublication(cell, created.opId, owner);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, owner)).outcome, "applied");

    const beforeEvents = makeTaskEventStore({ repoId, rootDir, mutable: false }).read().events.length,
      beforeRuns = (await cell.read("repo.squad.runs.list", {}, owner)).runs.length,
      rejected = await cell.run(
        {
          kind: "squad-run",
          squadId: squad.id,
          runtimeInstanceId: "runtime-not-reached",
          taskId,
          cwd: { scope: "repo-root" },
        },
        contender,
      ),
      afterEvents = makeTaskEventStore({ repoId, rootDir, mutable: false }).read().events.length;
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "lease_conflict");
    for (const field of ["opId", "proof", "acceptance", "status"])
      assert.equal(Object.hasOwn(rejected, field), false, field);
    assert.deepEqual(rejected.unmetCriteria, [
      {
        ref: "squad/execution-lease-holder",
        failureCode: "lease_conflict",
        explain: "The authenticated coordinator holds the Task current execution lease.",
      },
    ]);
    assert.ok(rejected.nextActions?.some((next) => next.includes(`ha task release ${taskId}`)));
    assert.equal(afterEvents, beforeEvents, JSON.stringify(rejected));
    assert.equal(
      (await cell.read("repo.squad.runs.list", {}, owner)).runs.length,
      beforeRuns,
      "the losing actor must not create Squad run state",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Squad control failure after a committed child never borrows that child's acceptance", async () => {
  const rootDir = workspace("control-child-failure"),
    repoId = workspaceId("squad-control-child-failure"),
    taskId = "task-squad-control-failure";
  let armed = false,
    injected = false,
    cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "squad-control-failure",
      killpoint: (point) => {
        if (armed && point === "after_sqlite_commit") {
          armed = false;
          injected = true;
          throw new Error("injected failure after the Squad child committed");
        }
      },
    });
    await installFixture(cell);
    const created = await cell.run({ kind: "task-create", taskId, title: "Squad control child failure" }, owner);
    assert.equal(created.outcome, "applied");
    await waitForFixturePublication(cell, created.opId!, owner);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    const beforeReader = makeTaskEventStore({ repoId, rootDir, mutable: false }),
      before = beforeReader.read().revision;
    await beforeReader.drain();
    armed = true;
    const result = await cell.run(
      { kind: "squad-run", squadId: squad.id, taskId, runtimeInstanceId: "not-launched" },
      owner,
    );
    assert.equal(injected, true, "the negative control must fail only after a real accepting commit");
    const reader = makeTaskEventStore({ repoId, rootDir, mutable: false });
    try {
      const head = reader.readHead()!;
      assert.ok(head.revision > before, "Squad lease acquisition must have committed its own child event");
      assert.equal(reader.readCommandOutcome(head.opId)?.status, "accepted_durable");
    } finally {
      await reader.drain();
    }
    assert.equal(result.outcome, "op_rejected", JSON.stringify(result));
    for (const field of ["opId", "proof", "acceptance", "status", "revision", "git", "projection"])
      assert.equal(Object.hasOwn(result, field), false, field);
    const wire = makeDaemonCommandReceipt("squad-run", result);
    assert.equal(wire.ok, false);
    assert.deepEqual(validateDaemonGuiCommandReceipt(wire), []);
  } finally {
    armed = false;
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function installFixture(cell: Awaited<ReturnType<typeof openRepoCell>>) {
  const installed: Array<{
    readonly declaration: typeof leader | typeof worker | typeof squad;
    readonly receipt: Awaited<ReturnType<typeof cell.run>>;
  }> = [];
  for (const declaration of [leader, worker, squad]) {
    const receipt = await cell.run(
      { kind: declaration.schema.startsWith("agent-") ? "agent-install" : "squad-install", declaration },
      owner,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    installed.push({ declaration, receipt });
  }
  return installed;
}

function assertExactReadReceipt(
  receipt: Awaited<ReturnType<Awaited<ReturnType<typeof openRepoCell>>["run"]>>,
  evidence: object,
  updatedProjection: object | null,
) {
  assert.deepEqual(evidenceOf(receipt), evidence);
  assert.deepEqual(
    {
      outcome: receipt.outcome,
      opId: receipt.opId,
      revision: receipt.revision,
      visibility: receipt.visibility,
      proof: receipt.proof,
      unmetCriteria: receipt.unmetCriteria,
      effects: receipt.effects,
      updatedProjection: receipt.updatedProjection,
      rejectionExplanation: receipt.rejectionExplanation,
      nextActions: receipt.nextActions,
    },
    {
      outcome: "applied",
      opId: receipt.opId,
      revision: receipt.revision,
      visibility: "center",
      proof: {
        committedRevision: receipt.revision,
        appliedCut: receipt.revision,
        durable: true,
        canonicalVisible: true,
        worktreeVisible: null,
      },
      unmetCriteria: [],
      effects: [],
      updatedProjection,
      rejectionExplanation: null,
      nextActions: [],
    },
  );
}

function evidenceOf(receipt: Awaited<ReturnType<Awaited<ReturnType<typeof openRepoCell>>["run"]>>): object {
  return JSON.parse(String(receipt.evidence)) as object;
}

function assertDurableSquadDeclaration(rootDir: string, repoId: ReturnType<typeof workspaceId>, opId: string): void {
  const store = openSqliteEventStore({ repoId, rootInput: rootDir, readOnly: true });
  try {
    const event = store.event(opId);
    assert.equal(event?.type, "entity_upserted");
    if (event?.type !== "entity_upserted") throw new Error("accepted Squad event is not an upsert");
    assert.deepEqual(JSON.parse(String(store.readContentObject(event.payload.declarationDocumentClaim.sha256))), squad);
    assert.deepEqual(event.payload.ownedContent, {
      schema: "entity-owned-content/v1",
      ownerRef: "squad/catalog-squad",
      schemaId: "squad-declaration/v1",
      schemaVersion: 1,
      content: [
        {
          sha256: event.payload.declarationDocumentClaim.sha256,
          byteLength: event.payload.declarationDocumentClaim.size,
          mediaType: "application/json",
        },
      ],
      bindings: [
        {
          path: "squads/catalog-squad.json",
          contentSha256: event.payload.declarationDocumentClaim.sha256,
          policyId: "typed-entity/v1",
        },
      ],
      directories: [],
      retirements: [],
      directoryRetirements: [],
    });
  } finally {
    store.close();
  }
}

async function assertRejectedWithoutEvent(
  rootDir: string,
  repoId: ReturnType<typeof workspaceId>,
  run: () => ReturnType<Awaited<ReturnType<typeof openRepoCell>>["run"]>,
  criterionRef: string,
) {
  const before = makeTaskEventStore({ repoId, rootDir, mutable: false }).read().events.length,
    receipt = await run(),
    after = makeTaskEventStore({ repoId, rootDir, mutable: false }).read().events.length;
  assert.equal(receipt.outcome, "op_rejected", JSON.stringify(receipt));
  assert.deepEqual(
    receipt.unmetCriteria?.map(({ ref }) => ref),
    [criterionRef],
    JSON.stringify(receipt),
  );
  assert.equal(after, before, JSON.stringify(receipt));
  return receipt;
}

function workspace(name: string): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-squad-action-${name}-`));
  initRepo(rootDir);
  return rootDir;
}

function corruptSquadProjection(rootDir: string, squadId: string): void {
  const database = new DatabaseSync(path.join(rootDir, ".harness/cache/task.sqlite")),
    { leader: _leader, ...invalid } = { ...squad, id: squadId, name: "Broken Squad" };
  try {
    database
      .prepare("UPDATE entity_projection SET value_json = ? WHERE entity_kind = 'squad' AND entity_id = ?")
      .run(JSON.stringify(invalid), squadId);
  } finally {
    database.close();
  }
}

// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getEntityKindContract, makeTaskEventStore } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
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
      ["install", "validate", "list", "inspect", "run", "status", "cancel"],
    );
    assert.deepEqual(
      catalog.actions.filter(({ execution }) => execution?.read).map(({ id }) => id),
      ["validate", "list", "inspect", "status"],
    );

    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "squad-action-catalog" });
    await installFixture(cell);

    const listed = await cell.run({ kind: "squad-list" }, owner),
      inspected = await cell.run({ kind: "squad-inspect", squadId: squad.id }, owner);
    assert.equal(listed.outcome, "applied", JSON.stringify(listed));
    assert.deepEqual(
      (evidence(listed).squads as Array<{ id: string }>).map(({ id }) => id),
      [squad.id],
    );
    assert.equal((evidence(inspected).squad as { id: string }).id, squad.id);

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
      ["install", "validate", "list", "inspect", "run", "status", "cancel"],
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
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, owner)).outcome, "applied");

    const beforeEvents = makeTaskEventStore({ repoId, rootDir }).read().events.length,
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
      afterEvents = makeTaskEventStore({ repoId, rootDir }).read().events.length;
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "lease_conflict");
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

async function installFixture(cell: Awaited<ReturnType<typeof openRepoCell>>): Promise<void> {
  for (const declaration of [leader, worker, squad]) {
    const receipt = await cell.run(
      { kind: declaration.schema.startsWith("agent-") ? "agent-install" : "squad-install", declaration },
      owner,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  }
}

async function assertRejectedWithoutEvent(
  rootDir: string,
  repoId: ReturnType<typeof workspaceId>,
  run: () => ReturnType<Awaited<ReturnType<typeof openRepoCell>>["run"]>,
  criterionRef: string,
) {
  const before = makeTaskEventStore({ repoId, rootDir }).read().events.length,
    receipt = await run(),
    after = makeTaskEventStore({ repoId, rootDir }).read().events.length;
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

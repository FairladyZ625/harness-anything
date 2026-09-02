// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveRelationId, makeTaskEventStore } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

const binding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-relation-action" },
        executor: { kind: "agent", id: "agent-relation-action" },
      },
      source: "local" as const,
    },
    "repo-write",
  ),
  secondNodeBinding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-relation-action-secondary" },
        executor: { kind: "agent", id: "agent-relation-action-secondary" },
      },
      source: "local" as const,
    },
    "repo-write",
  );

test("Relation actions serialize aggregate revisions and reject cycles and stale writers", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-relation-action-"));
  initRepo(rootDir);
  const repoId = workspaceId("relation-action"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "relation-action-test" });
  try {
    for (const [taskId, title] of [
      ["task_relation_a", "Relation A"],
      ["task_relation_b", "Relation B"],
      ["task_relation_c", "Relation C"],
    ] as const)
      assert.equal((await cell.run({ kind: "task-create", taskId, title }, binding)).outcome, "applied");

    const identity = {
        source: "task/task_relation_a",
        target: "task/task_relation_b",
        type: "depends-on" as const,
        direction: "directed" as const,
      },
      relationId = deriveRelationId(identity),
      created = await cell.run(
        {
          kind: "relation-relate",
          sourceRef: identity.source,
          targetRef: identity.target,
          relationType: identity.type,
          direction: identity.direction,
          origin: "declared",
          rationale: "A waits for B.",
          expectedVersion: 0,
        },
        binding,
      );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    assert.deepEqual(JSON.parse(String(created.evidence)), {
      schema: "relation-action-history/v1",
      relationId,
      eventType: "relation_created",
      aggregateRevision: created.revision,
      executor: binding.actor.executor,
      executionId: null,
    });
    assert.match(String(created.evidence), /agent-relation-action/u);

    const cycle = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: identity.target,
        targetRef: identity.source,
        relationType: "depends-on",
        rationale: "B must not wait for A.",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(cycle.outcome, "op_rejected");
    assert.equal(cycle.code, "relation_cycle");

    const stale = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: identity.source,
        targetRef: identity.target,
        relationType: identity.type,
        rationale: "A different writer supplied stale aggregate state.",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(stale.outcome, "op_rejected");
    assert.equal(stale.code, "revision_conflict");
    const secondaryIdentity = {
        source: "task/task_relation_c",
        target: identity.target,
        type: "relates" as const,
        direction: "directed" as const,
      },
      secondaryId = deriveRelationId(secondaryIdentity),
      secondary = await cell.run(
        {
          kind: "relation-relate",
          sourceRef: secondaryIdentity.source,
          targetRef: secondaryIdentity.target,
          relationType: secondaryIdentity.type,
          rationale: "C remains contextually related to B.",
          expectedVersion: 0,
        },
        binding,
      );
    assert.equal(secondary.outcome, "applied", JSON.stringify(secondary));
    assert.equal(
      makeTaskEventStore({ repoId, rootDir })
        .read()
        .events.filter((event) => event.schema === "relation-event/v1").length,
      2,
    );

    const currentGraph = await cell.run({ kind: "relation-list", freshness: "current" }, binding),
      currentRows = relationRows(currentGraph);
    assert.deepEqual(
      currentRows.map(({ relationId: id, strength }) => ({ id, strength })),
      [
        { id: relationId, strength: "strong" },
        { id: secondaryId, strength: "weak" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    assert.equal(
      currentRows.every(
        ({ targetObservedVersion, currentTargetVersion }) => targetObservedVersion === currentTargetVersion,
      ),
      true,
    );
    const eventCountBeforeTargetUpdate = makeTaskEventStore({ repoId, rootDir }).read().events.length,
      relationEventCountBeforeTargetUpdate = relationEventCount(rootDir, repoId),
      targetUpdated = await cell.run(
        {
          kind: "task-amend",
          taskId: "task_relation_b",
          patches: [{ field: "pinned", value: "true" }],
        },
        binding,
      );
    assert.equal(targetUpdated.outcome, "applied", JSON.stringify(targetUpdated));
    assert.equal(makeTaskEventStore({ repoId, rootDir }).read().events.length, eventCountBeforeTargetUpdate + 1);
    assert.equal(relationEventCount(rootDir, repoId), relationEventCountBeforeTargetUpdate);
    const suspectRows = relationRows(await cell.run({ kind: "relation-list", freshness: "suspect" }, binding));
    assert.deepEqual(suspectRows.map(({ relationId: id }) => id).sort(), [relationId, secondaryId].sort());
    assert.equal(
      suspectRows.every(
        ({ targetObservedVersion, currentTargetVersion }) => targetObservedVersion !== currentTargetVersion,
      ),
      true,
    );

    const [nodeOne, nodeTwo] = await Promise.all([
        cell.run(
          {
            kind: "relation-reconfirm",
            relationId,
            rationale: "Node one reviewed the updated target.",
            expectedVersion: created.revision,
          },
          binding,
        ),
        cell.run(
          {
            kind: "relation-reconfirm",
            relationId,
            rationale: "Node two independently reviewed the updated target.",
            expectedVersion: created.revision,
          },
          secondNodeBinding,
        ),
      ]),
      reconfirmations = [nodeOne, nodeTwo],
      accepted = reconfirmations.find(({ outcome }) => outcome === "applied"),
      conflicted = reconfirmations.find(({ outcome }) => outcome === "op_rejected");
    assert.ok(accepted, JSON.stringify(reconfirmations));
    assert.equal(conflicted?.code, "version_conflict", JSON.stringify(reconfirmations));
    assert.equal(relationRows(await cell.run({ kind: "relation-list", freshness: "current" }, binding)).length, 1);
    assert.equal(relationRows(await cell.run({ kind: "relation-list", freshness: "suspect" }, binding)).length, 1);
    const sameResult = await cell.run(
      {
        kind: "relation-reconfirm",
        relationId,
        rationale: "The current witness was already reviewed.",
        expectedVersion: accepted.revision,
      },
      binding,
    );
    assert.equal(sameResult.outcome, "no_changes", JSON.stringify(sameResult));
    assert.equal((await cell.run({ kind: "projection-rebuild" }, binding)).outcome, "applied");
    assert.equal(relationRows(await cell.run({ kind: "relation-list", freshness: "current" }, binding)).length, 1);
    assert.equal(relationRows(await cell.run({ kind: "relation-list", freshness: "suspect" }, binding)).length, 1);

    const retired = await cell.run(
      {
        kind: "relation-unrelate",
        relationId,
        reason: "B completed independently.",
        expectedVersion: accepted.revision,
      },
      binding,
    );
    assert.equal(retired.outcome, "applied", JSON.stringify(retired));
    const graph = await cell.run({ kind: "relation-list", entity: identity.source }, binding),
      rows = (JSON.parse(String(graph.evidence)) as { rows: readonly { relationId: string; state: string }[] }).rows;
    assert.deepEqual(
      rows.map(({ relationId: id, state }) => ({ id, state })),
      [{ id: relationId, state: "retired" }],
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function relationRows(receipt: { readonly evidence?: unknown }): readonly {
  readonly relationId: string;
  readonly strength: string;
  readonly targetObservedVersion: string | number | null;
  readonly currentTargetVersion: string | number | null;
}[] {
  return (
    JSON.parse(String(receipt.evidence)) as {
      readonly rows: readonly {
        readonly relationId: string;
        readonly strength: string;
        readonly targetObservedVersion: string | number | null;
        readonly currentTargetVersion: string | number | null;
      }[];
    }
  ).rows;
}

function relationEventCount(rootDir: string, repoId: string): number {
  return makeTaskEventStore({ repoId, rootDir })
    .read()
    .events.filter((event) => event.schema === "relation-event/v1").length;
}

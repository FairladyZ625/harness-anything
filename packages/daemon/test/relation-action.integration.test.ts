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
          strength: "strong",
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
    assert.equal(
      makeTaskEventStore({ repoId, rootDir })
        .read()
        .events.filter((event) => event.schema === "relation-event/v1").length,
      1,
    );

    const retired = await cell.run(
      {
        kind: "relation-unrelate",
        relationId,
        reason: "B completed independently.",
        expectedVersion: created.revision,
      },
      binding,
    );
    assert.equal(retired.outcome, "applied", JSON.stringify(retired));
    const graph = await cell.run({ kind: "relation-list", entity: identity.source }, binding),
      rows = (JSON.parse(String(graph.evidence)) as { rows: readonly { relationId: string; state: string }[] }).rows;
    assert.deepEqual(
      rows.map(({ relationId: id, state }) => ({ id, state })),
      [{ id: relationId, state: "edge_retired" }],
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

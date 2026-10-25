// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { deriveRelationId } from "../../src/domain/entity-relation.ts";
import { compileRelationCreatedEvent, relationEventWritePlan } from "../../src/domain/relation-event.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

function initRepo(rootDir: string): void {
  const git = (...args: readonly string[]) =>
    execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet");
  git("config", "user.name", "Relation Cycle Audit Test");
  git("config", "user.email", "relation-cycle-audit@example.invalid");
  writeFileSync(path.join(rootDir, "README.md"), "# Fixture\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "fixture base");
}

function cycleEvent(input: {
  readonly source: string;
  readonly target: string;
  readonly relationType: "depends-on" | "supersedes";
  readonly revision: number;
}) {
  const identity = {
      source: input.source,
      target: input.target,
      type: input.relationType,
      direction: "directed" as const,
    },
    relationId = deriveRelationId(identity);
  return {
    relationId,
    event: compileRelationCreatedEvent({
      record: {
        relation_id: relationId,
        ...identity,
        origin: "declared",
        rationale: "Legacy edge persisted before typed cycle admission.",
        state: "active",
        targetObservedVersion: null,
      },
      actor: { principal: { personId: "relation-cycle-audit" }, executor: null },
      source: "local",
      opId: `op-${relationId}`,
      occurredAt: "2026-10-25T00:00:00.000Z",
      workspaceRevision: input.revision,
    }),
  };
}

test("projection rebuild reports a typed cycle issue without changing the replayed ledger", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const repoId = "relation-cycle-rebuild",
      eventStore = makeTaskEventStore({ repoId, rootDir }),
      first = cycleEvent({
        source: "task/task_cycle_a",
        target: "task/task_cycle_b",
        relationType: "depends-on",
        revision: 1,
      }),
      second = cycleEvent({
        source: "task/task_cycle_b",
        target: "task/task_cycle_a",
        relationType: "depends-on",
        revision: 2,
      });
    for (const { event } of [first, second])
      eventStore.append({ event, plan: relationEventWritePlan(event), blobs: [] });

    const projection = makeTaskProjection({ rootDir, eventStore });
    try {
      const receipt = projection.rebuild();
      assert.equal(receipt.watermark, 2);
      assert.deepEqual(receipt.relationCycleAudit, {
        scannedEdges: 2,
        issues: [
          {
            code: "relation_cycle_detected",
            relationType: "depends-on",
            nodeRefs: ["task/task_cycle_a", "task/task_cycle_b", "task/task_cycle_a"],
            relationIds: [first.relationId, second.relationId],
          },
        ],
      });
    } finally {
      projection.close();
    }
    assert.equal(eventStore.readHead()?.revision, 2);
  });
});

test("projection rebuild reports no issues for an acyclic relation graph", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const repoId = "relation-acyclic-rebuild",
      eventStore = makeTaskEventStore({ repoId, rootDir }),
      only = cycleEvent({
        source: "task/task_cycle_a",
        target: "task/task_cycle_b",
        relationType: "depends-on",
        revision: 1,
      });
    eventStore.append({ event: only.event, plan: relationEventWritePlan(only.event), blobs: [] });

    const projection = makeTaskProjection({ rootDir, eventStore });
    try {
      assert.deepEqual(projection.rebuild().relationCycleAudit, { scannedEdges: 1, issues: [] });
    } finally {
      projection.close();
    }
  });
});

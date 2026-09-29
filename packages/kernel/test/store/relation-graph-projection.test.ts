// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { readLegacyMigrationSource } from "../../src/index.ts";
import { withTempStore } from "./helpers.ts";
import { fact, relation, writeColdHistory, writeLegacyFactEvent } from "./relation-graph-projection.fixtures.ts";

test("equal legacy Fact ids in documents and events both reach deterministic migration re-keying", () => {
  withTempStore((rootDir) => {
    const factRef = "fact/F-DEADBEEF",
      migratedRef = "fact/F-ABCDEFGH";
    writeColdHistory(
      rootDir,
      relation({ source: "decision/dec_COLD/C1", target: factRef, type: "evidenced-by" }),
      relation({ source: "decision/dec_COLD/CH1", target: "task/task-cold", type: "derives" }),
      relation({ source: factRef, target: migratedRef, type: "supersedes-fact" }),
    );
    const firstTaskRoot = path.join(rootDir, "harness/tasks/task-cold"),
      secondTaskRoot = path.join(rootDir, "harness/tasks/task-second");
    mkdirSync(secondTaskRoot, { recursive: true });
    writeFileSync(
      path.join(secondTaskRoot, "INDEX.md"),
      readFileSync(path.join(firstTaskRoot, "INDEX.md"), "utf8").replaceAll("task-cold", "task-second"),
    );
    writeFileSync(
      path.join(secondTaskRoot, "facts.md"),
      readFileSync(path.join(firstTaskRoot, "facts.md"), "utf8").replace(
        "Cold rebuild evidence",
        "Second source observation",
      ),
    );
    for (const [revision, taskId] of [
      [20, "task-cold"],
      [21, "task-second"],
    ] as const)
      writeLegacyFactEvent(rootDir, {
        ...fact(revision),
        eventId: `event-collision-${taskId}`,
        opId: `op-collision-${taskId}`,
        taskId,
        factId: "F-C0FFEE00",
        payload: { ...fact(revision).payload, statement: `${taskId} event observation` },
      });

    const source = readLegacyMigrationSource(rootDir);
    assert.deepEqual(
      source.facts
        .filter(({ factId }) => factId === "F-DEADBEEF")
        .map(({ taskId }) => taskId)
        .sort(),
      ["task-cold", "task-second"],
    );
    assert.deepEqual(
      source.facts
        .filter(({ factId }) => factId === "F-C0FFEE00")
        .map(({ taskId }) => taskId)
        .sort(),
      ["task-cold", "task-second"],
    );
  });
});

test("legacy relation type normalization remains in the migration reader", () => {
  withTempStore((rootDir) => {
    const legacyEvidence = relation({
      source: "decision/dec_COLD/C1",
      target: "fact/F-DEADBEEF",
      type: "supports",
    });
    writeColdHistory(
      rootDir,
      legacyEvidence,
      relation({ source: "decision/dec_COLD/CH1", target: "task/task-cold", type: "derives" }),
      relation({ source: "fact/F-DEADBEEF", target: "fact/F-ABCDEFGH", type: "supersedes-fact" }),
    );
    const migration = readLegacyMigrationSource(rootDir);
    assert.equal(
      migration.truth.edges.some(
        ({ sourceRef, targetRef, relationType }) =>
          sourceRef === legacyEvidence.source && targetRef === legacyEvidence.target && relationType === "evidenced-by",
      ),
      true,
    );
  });
});

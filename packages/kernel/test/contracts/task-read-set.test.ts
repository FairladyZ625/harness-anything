// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { deriveTaskReadSet, READ_SET_SCHEMA } from "../../src/index.ts";
import type { TaskReadSetCounterpart, TaskReadSetEdge } from "../../src/index.ts";

const taskRef = "task/task_readset0000000000",
  cut = { status: "ready" as const, watermark: 42, sourceRevision: 42 };

function edge(
  overrides: Partial<TaskReadSetEdge> & Pick<TaskReadSetEdge, "relationId" | "targetRef">,
): TaskReadSetEdge {
  return {
    sourceRef: taskRef,
    relationType: "relates",
    strength: "weak",
    origin: "declared",
    state: "active",
    freshness: "current",
    rationale: "declared by the task plan",
    targetObservedVersion: 7,
    currentTargetVersion: 7,
    ...overrides,
  };
}

function counterparts(
  rows: readonly (readonly [string, Partial<TaskReadSetCounterpart["witness"]> & { packagePath?: string | null }])[],
): ReadonlyMap<string, TaskReadSetCounterpart> {
  return new Map(
    rows.map(([entityRef, { packagePath, ...witness }]) => [
      entityRef,
      {
        witness: { entityRef, freshness: "current" as const, currentVersion: 7, ...witness },
        ...(packagePath === undefined ? {} : { packagePath }),
      },
    ]),
  );
}

test("an empty edge set yields an empty read set instead of an error or a filename fallback", () => {
  const derived = deriveTaskReadSet({ taskRef, edges: [], counterparts: new Map(), projectionCut: cut });
  assert.equal(derived.schema, READ_SET_SCHEMA);
  assert.deepEqual(derived.entries, []);
  assert.equal(derived.blocked, false);
  assert.deepEqual(derived.blockedReasons, []);
  assert.deepEqual(derived.projectionCut, cut);
});

test("only explicitly declared active edges become reading material", () => {
  const derived = deriveTaskReadSet({
    taskRef,
    edges: [
      edge({ relationId: "rel_declared00000001", targetRef: "task/task_sibling000000000" }),
      edge({
        relationId: "rel_generated0000001",
        sourceRef: "execution/exe_run00000000000000",
        targetRef: taskRef,
        relationType: "executes",
        strength: "strong",
        origin: "generated",
      }),
      edge({
        relationId: "rel_retired000000001",
        targetRef: "task/task_retired000000000",
        state: "retired",
      }),
      edge({
        relationId: "rel_imported00000001",
        targetRef: "fact/F-11111111",
        relationType: "evidences",
        strength: "strong",
        origin: "imported_snapshot",
      }),
    ],
    counterparts: counterparts([
      ["task/task_sibling000000000", { packagePath: "tasks/task_sibling000000000-sibling" }],
      ["fact/F-11111111", {}],
    ]),
    projectionCut: cut,
  });
  assert.deepEqual(
    derived.entries.map(({ entityRef }) => entityRef),
    ["fact/F-11111111", "task/task_sibling000000000"],
  );
});

test("required comes from edge strength and authority from the counterpart kind", () => {
  const derived = deriveTaskReadSet({
    taskRef,
    edges: [
      edge({ relationId: "rel_weak00000000001", targetRef: "task/task_sibling000000000" }),
      edge({
        relationId: "rel_strongfact000001",
        targetRef: "fact/F-22222222",
        relationType: "evidences",
        strength: "strong",
      }),
      edge({
        relationId: "rel_strongdec0000001",
        sourceRef: "decision/dec_ABCDEF0123456789/C1",
        targetRef: taskRef,
        relationType: "derives",
        strength: "strong",
      }),
    ],
    counterparts: counterparts([
      ["task/task_sibling000000000", { packagePath: "tasks/task_sibling000000000-sibling" }],
      ["fact/F-22222222", {}],
      ["decision/dec_ABCDEF0123456789/C1", {}],
    ]),
    projectionCut: cut,
  });
  assert.deepEqual(
    derived.entries.map(({ entityRef, required, authority, locator }) => [entityRef, required, authority, locator]),
    [
      ["decision/dec_ABCDEF0123456789/C1", true, "normative", "decisions/decision-dec_ABCDEF0123456789/decision.md"],
      ["fact/F-22222222", true, "descriptive", "facts/F-22222222.md"],
      ["task/task_sibling000000000", false, "historical", "tasks/task_sibling000000000-sibling"],
    ],
  );
});

test("ordering is stable, total, and independent of input order or file path", () => {
  const rows: readonly TaskReadSetEdge[] = [
    edge({ relationId: "rel_b0000000000000b", targetRef: "task/task_zzzz00000000000" }),
    edge({ relationId: "rel_a0000000000000a", targetRef: "task/task_aaaa00000000000" }),
    edge({
      relationId: "rel_c0000000000000c",
      targetRef: "fact/F-33333333",
      relationType: "evidences",
      strength: "strong",
    }),
    edge({
      relationId: "rel_d0000000000000d",
      targetRef: "fact/F-33333333",
      relationType: "produces",
      strength: "strong",
    }),
  ];
  const map = counterparts([
      ["task/task_zzzz00000000000", { packagePath: "tasks/task_zzzz00000000000-z" }],
      ["task/task_aaaa00000000000", { packagePath: "tasks/task_aaaa00000000000-a" }],
      ["fact/F-33333333", {}],
    ]),
    expected = [
      ["fact/F-33333333", "evidences"],
      ["fact/F-33333333", "produces"],
      ["task/task_aaaa00000000000", "relates"],
      ["task/task_zzzz00000000000", "relates"],
    ];
  const forward = deriveTaskReadSet({ taskRef, edges: rows, counterparts: map, projectionCut: cut }),
    reversed = deriveTaskReadSet({ taskRef, edges: [...rows].reverse(), counterparts: map, projectionCut: cut });
  assert.deepEqual(
    forward.entries.map(({ entityRef, whyIncluded }) => [entityRef, whyIncluded.type]),
    expected,
  );
  assert.deepEqual(forward.entries, reversed.entries);
});

test("suspect entries stay in the set, keep their edge revisions, and never pass as current", () => {
  const derived = deriveTaskReadSet({
    taskRef,
    edges: [
      edge({
        relationId: "rel_suspect000000001",
        targetRef: "task/task_moved00000000000",
        freshness: "suspect",
        targetObservedVersion: 5,
        currentTargetVersion: 9,
      }),
    ],
    counterparts: counterparts([
      ["task/task_moved00000000000", { currentVersion: 9, packagePath: "tasks/task_moved00000000000-moved" }],
    ]),
    projectionCut: cut,
  });
  const [entry] = derived.entries;
  assert.equal(entry?.freshness, "suspect");
  assert.deepEqual(entry?.edgeVersions, { targetObservedVersion: 5, currentTargetVersion: 9 });
  assert.equal(entry?.contentVersion, 9);
  assert.equal(derived.blocked, false);
});

test("a required orphaned or unwitnessed counterpart blocks the whole set and names the gap", () => {
  const orphaned = deriveTaskReadSet({
    taskRef,
    edges: [
      edge({
        relationId: "rel_orphaned00000001",
        targetRef: "fact/F-44444444",
        relationType: "evidences",
        strength: "strong",
        freshness: "orphaned",
      }),
    ],
    counterparts: counterparts([["fact/F-44444444", { freshness: "orphaned", currentVersion: null }]]),
    projectionCut: cut,
  });
  assert.equal(orphaned.blocked, true);
  assert.equal(orphaned.entries.length, 1);
  assert.deepEqual(
    orphaned.blockedReasons.map(({ entityRef, code }) => [entityRef, code]),
    [["fact/F-44444444", "required_target_orphaned"]],
  );

  const unwitnessed = deriveTaskReadSet({
    taskRef,
    edges: [
      edge({
        relationId: "rel_unknown000000001",
        targetRef: "fact/F-55555555",
        relationType: "evidences",
        strength: "strong",
      }),
    ],
    counterparts: new Map(),
    projectionCut: cut,
  });
  assert.equal(unwitnessed.blocked, true);
  assert.deepEqual(
    unwitnessed.blockedReasons.map(({ code }) => code),
    ["required_target_unknown"],
  );
});

test("a required entry the projection cannot locate blocks instead of guessing a path", () => {
  const derived = deriveTaskReadSet({
    taskRef,
    edges: [
      edge({
        relationId: "rel_nolocator0000001",
        targetRef: "task/task_unindexed00000",
        relationType: "depends-on",
        strength: "strong",
      }),
    ],
    counterparts: counterparts([["task/task_unindexed00000", { packagePath: null }]]),
    projectionCut: cut,
  });
  assert.equal(derived.blocked, true);
  assert.equal(derived.entries[0]?.locator, null);
  assert.deepEqual(
    derived.blockedReasons.map(({ code }) => code),
    ["required_locator_unresolved"],
  );
});

test("every entry says which edge admitted it and the cut it was read at", () => {
  const derived = deriveTaskReadSet({
    taskRef,
    edges: [
      edge({
        relationId: "rel_why00000000001a",
        targetRef: "decision/dec_0123456789ABCDEF",
        relationType: "implements",
        strength: "strong",
        rationale: "the task implements this decision",
      }),
    ],
    counterparts: counterparts([["decision/dec_0123456789ABCDEF", {}]]),
    projectionCut: cut,
  });
  assert.deepEqual(derived.entries[0]?.whyIncluded, {
    source: "task-relation",
    relationId: "rel_why00000000001a",
    type: "implements",
    rationale: "the task implements this decision",
  });
  assert.deepEqual(derived.projectionCut, cut);
});

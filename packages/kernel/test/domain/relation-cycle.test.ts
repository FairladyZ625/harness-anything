// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { findRelationCycleWitnesses, type RelationCycleEdge } from "../../src/domain/relation-cycle.ts";
import {
  isAcyclicRelationType,
  relationTypeDeclarations,
  type RelationType,
} from "../../src/domain/relation-type-registry.ts";

const acyclicTypes = relationTypeDeclarations.filter(({ acyclic }) => acyclic).map(({ type }) => type);

function edge(
  relationId: string,
  sourceRef: string,
  targetRef: string,
  relationType: RelationType,
  options: Partial<Pick<RelationCycleEdge, "direction" | "state">> = {},
): RelationCycleEdge {
  return {
    relationId,
    sourceRef,
    targetRef,
    relationType,
    direction: options.direction ?? "directed",
    state: options.state ?? "active",
  };
}

test("write admission checks every declared acyclic type for target-to-source reachability", () => {
  for (const relationType of acyclicTypes) {
    const existing = edge(`${relationType}-ab`, "task/a", "task/b", relationType);
    assert.deepEqual(
      findRelationCycleWitnesses([existing], edge(`${relationType}-bc`, "task/b", "task/c", relationType)),
      [],
      `${relationType} forward extension must remain admissible`,
    );
    assert.deepEqual(
      findRelationCycleWitnesses([existing], edge(`${relationType}-ba`, "task/b", "task/a", relationType)),
      [
        {
          relationType,
          nodeRefs: ["task/b", "task/a", "task/b"],
          relationIds: [`${relationType}-ba`, `${relationType}-ab`],
        },
      ],
      `${relationType} reverse edge must return an auditable witness`,
    );
  }
});

test("self edges are cycles and retired, undirected, or cross-type paths do not participate", () => {
  const candidate = edge("candidate", "task/a", "task/b", "depends-on");
  assert.deepEqual(findRelationCycleWitnesses([], edge("self", "task/a", "task/a", "derives"))[0]?.nodeRefs, [
    "task/a",
    "task/a",
  ]);
  assert.deepEqual(
    findRelationCycleWitnesses(
      [
        edge("retired", "task/b", "task/a", "depends-on", { state: "retired" }),
        edge("undirected", "task/b", "task/a", "depends-on", { direction: "undirected" }),
        edge("other-type", "task/b", "task/a", "derives"),
      ],
      candidate,
    ),
    [],
  );
  assert.equal(isAcyclicRelationType("relates"), false);
  assert.deepEqual(findRelationCycleWitnesses([], edge("network", "task/a", "task/a", "relates")), []);
});

test("projection audit reports type-local active directed cycle witnesses", () => {
  const cycles = findRelationCycleWitnesses([
    edge("depends-ab", "task/a", "task/b", "depends-on"),
    edge("depends-ba", "task/b", "task/a", "depends-on"),
    edge("supersedes-xy", "decision/x", "decision/y", "supersedes"),
    edge("supersedes-yx", "decision/y", "decision/x", "supersedes"),
    edge("retired-uv", "task/u", "task/v", "derives", { state: "retired" }),
  ]);
  assert.deepEqual(cycles, [
    {
      relationType: "depends-on",
      nodeRefs: ["task/a", "task/b", "task/a"],
      relationIds: ["depends-ab", "depends-ba"],
    },
    {
      relationType: "supersedes",
      nodeRefs: ["decision/x", "decision/y", "decision/x"],
      relationIds: ["supersedes-xy", "supersedes-yx"],
    },
  ]);
});

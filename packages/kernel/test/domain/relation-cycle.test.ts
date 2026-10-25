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

test("write admission reads only reachable source adjacency from the candidate target", () => {
  const sourcesRead: string[] = [],
    edgesRead: string[] = [],
    adjacency = new Map<string, RelationCycleEdge[]>([
      ["task/target", [edge("reachable-1", "task/target", "task/middle", "depends-on")]],
      ["task/middle", [edge("reachable-2", "task/middle", "task/source", "depends-on")]],
      ...Array.from({ length: 2_000 }, (_, index) => {
        const sourceRef = `task/unreachable-${String(index)}`;
        return [
          sourceRef,
          [edge(`unreachable-${String(index)}`, sourceRef, `task/other-${String(index)}`, "depends-on")],
        ] as const;
      }),
    ]);
  const witnesses = findRelationCycleWitnesses(
    {
      readOutgoing: (_relationType: RelationType, sourceRef: string) => {
        sourcesRead.push(sourceRef);
        const outgoing = adjacency.get(sourceRef) ?? [];
        edgesRead.push(...outgoing.map(({ relationId }) => relationId));
        return outgoing;
      },
    },
    edge("candidate", "task/source", "task/target", "depends-on"),
  );

  assert.deepEqual(witnesses, [
    {
      relationType: "depends-on",
      nodeRefs: ["task/source", "task/target", "task/middle", "task/source"],
      relationIds: ["candidate", "reachable-1", "reachable-2"],
    },
  ]);
  assert.deepEqual(sourcesRead, ["task/target", "task/middle"]);
  assert.deepEqual(edgesRead, ["reachable-1", "reachable-2"]);
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

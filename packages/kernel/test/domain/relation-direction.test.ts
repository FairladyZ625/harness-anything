// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedRelationKindTriple, relationTypes } from "../../src/domain/entity-relation.ts";
import {
  canonicalRelationDirections,
  incomingRelations,
  type CanonicalRelationDirection,
  type RelationEndpointKind,
} from "../../src/domain/relation-direction.ts";

const kinds: readonly RelationEndpointKind[] = [
  "task",
  "decision",
  "fact",
  "execution",
  "review",
  "agent",
  "runtime-session",
  "policy",
];

function row(
  sourceKind: RelationEndpointKind,
  type: (typeof relationTypes)[number],
  targetKind: RelationEndpointKind,
): CanonicalRelationDirection | undefined {
  return canonicalRelationDirections.find(
    (direction) =>
      direction.sourceKind === sourceKind && direction.type === type && direction.targetKind === targetKind,
  );
}

test("the canonical direction registry is the allowlist: every triple agrees, cell for cell", () => {
  for (const sourceKind of kinds) {
    for (const type of relationTypes) {
      for (const targetKind of kinds) {
        assert.equal(
          isAllowedRelationKindTriple(sourceKind, type, targetKind),
          row(sourceKind, type, targetKind) !== undefined &&
            row(sourceKind, type, targetKind)?.registration !== "derived",
          `${sourceKind} --${type}--> ${targetKind}: allowlist and registry disagree`,
        );
      }
    }
  }
});

test("every reversed-direction pair keeps exactly one canonical writable side", () => {
  // Evidence: decision --evidenced-by--> fact is canonical; fact --supports--> decision is retired.
  assert.equal(isAllowedRelationKindTriple("decision", "evidenced-by", "fact"), true);
  assert.equal(isAllowedRelationKindTriple("fact", "supports", "decision"), false);
  // Refutation: decision --refuted-by--> fact is canonical; fact --invalidated-by--> decision is retired.
  assert.equal(isAllowedRelationKindTriple("decision", "refuted-by", "fact"), true);
  assert.equal(isAllowedRelationKindTriple("fact", "invalidated-by", "decision"), false);
  // Blocking: task --depends-on--> task blocks the source; the mirrored task --blocks--> task is retired.
  assert.equal(isAllowedRelationKindTriple("task", "depends-on", "task"), true);
  assert.equal(isAllowedRelationKindTriple("task", "blocks", "task"), false);
});

test("every replaced reverse alias is refused on the mirrored endpoint pair", () => {
  for (const direction of canonicalRelationDirections) {
    const alias = direction.replacedReverseAlias;
    if (!alias) continue;
    assert.equal(
      isAllowedRelationKindTriple(direction.targetKind, alias, direction.sourceKind),
      false,
      `retired alias ${direction.targetKind} --${alias}--> ${direction.sourceKind} must stay unwritable (mirror of ${direction.sourceKind} --${direction.type}--> ${direction.targetKind})`,
    );
  }
});

test("the reverse query agrees with the canonical direction for every registry row", () => {
  for (const direction of canonicalRelationDirections) {
    const source = `${direction.sourceKind}/source`;
    const target = `${direction.targetKind}/target`;
    const edge = { source, target, type: direction.type };
    const noise = { source: target, target: source, type: direction.type };
    const edges = [noise, edge];
    assert.deepEqual(
      incomingRelations(target, direction.type, edges).map((hit) => hit.source),
      [source],
      `reverse query at the target of ${direction.sourceKind} --${direction.type}--> ${direction.targetKind} must return the canonical source only`,
    );
    assert.deepEqual(
      incomingRelations(source, direction.type, edges),
      [noise],
      `asking at the source with the same verb returns only the literal target-side edges`,
    );
  }
});

test("semantics with no registered reading are flagged, not silently ratified", () => {
  const unregistered = canonicalRelationDirections.filter(({ registration }) => registration === "unregistered");
  assert.deepEqual(
    unregistered.map(({ type }) => type).sort(),
    ["blocks"],
    "only the decision->decision blocks cell lacks registered semantics",
  );
  for (const direction of unregistered) {
    assert.equal(direction.sourceKind, "decision");
    assert.equal(direction.targetKind, "decision");
  }
});

test("a non-canonical active edge is refused at the write boundary", () => {
  // The same validation the daemon and frontmatter ingest path apply to active edges.
  assert.equal(isAllowedRelationKindTriple("fact", "invalidated-by", "decision"), false);
  assert.equal(isAllowedRelationKindTriple("task", "blocks", "task"), false);
});

test("Phase 1 relation directions are registered and owns remains derived-only", () => {
  assert.equal(isAllowedRelationKindTriple("execution", "executes", "task"), true);
  assert.equal(isAllowedRelationKindTriple("runtime-session", "executes", "task"), true);
  assert.equal(isAllowedRelationKindTriple("review", "reviews", "execution"), true);
  assert.equal(isAllowedRelationKindTriple("task", "owns", "agent"), false);
  assert.equal(isAllowedRelationKindTriple("agent", "dispatches", "runtime-session"), true);
  assert.equal(isAllowedRelationKindTriple("policy", "authorizes", "execution"), true);
  assert.equal(canonicalRelationDirections.find((row) => row.type === "owns")?.registration, "derived");
});

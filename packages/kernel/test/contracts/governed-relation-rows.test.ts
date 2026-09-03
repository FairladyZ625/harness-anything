// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canonicalGovernedRelationAuthority,
  type GovernedRelationCompilationAuthority,
} from "../../src/domain/governed-relation-direction.ts";
import { isAllowedRelationKindTriple, isAllowedRelationRecord } from "../../src/domain/entity-relation.ts";
import { parseEntityRef } from "../../src/domain/entity-ref.ts";
import { assertRelationAdmission } from "../../src/domain/relation-event.ts";
import {
  acceptVerticalRegistryCandidate,
  compiledRelationDirections,
  compileVerticalContract,
  emptyCompiledVerticalRegistry,
} from "../../src/domain/vertical-contract.ts";

const baseVertical = JSON.parse(
    readFileSync(new URL("../../fixtures/schemas/vertical-definition/valid.json", import.meta.url), "utf8"),
  ) as Record<string, unknown> & { entityKinds: unknown[]; projectionSchemas: unknown[] },
  governancePin = canonicalGovernedRelationAuthority.decisions[0]!.contentPin,
  artifactType = "custom/engineering/architecture-decision-record@1";

test("governed triples compile into the one canonical runtime registry", () => {
  const compiled = compileVerticalContract(verticalWith(artifact({ relations: [relation()] }))),
    rows = compiledRelationDirections(compiled);
  assert.deepEqual(rows, [
    {
      type: "relates",
      sourceKind: artifactType,
      targetKind: "decision",
      reads: "the architecture decision record relates to the target decision",
      registration: "ratified",
      strength: "weak",
      governance: {
        decisionClaimRef: "decision/dec_29CCC98CD0241D0C9806AC1CF1/CH1",
        decisionContentPin: governancePin,
      },
    },
  ]);

  const accepted = acceptVerticalRegistryCandidate({
    current: emptyCompiledVerticalRegistry(),
    expectedRevision: 0,
    source: verticalWith(artifact({ relations: [relation()] })),
  });
  assert.equal(isAllowedRelationKindTriple(artifactType, "relates", "decision"), false);
  assert.equal(isAllowedRelationKindTriple(artifactType, "relates", "decision", accepted.relationDirections), true);
  assert.equal(
    isAllowedRelationRecord(
      { type: "relates", strength: "weak" },
      artifactType,
      "decision",
      accepted.relationDirections,
    ),
    true,
  );
  assert.equal(
    isAllowedRelationRecord(
      { type: "relates", strength: "strong" },
      artifactType,
      "decision",
      accepted.relationDirections,
    ),
    false,
  );
  assert.equal(Object.isFrozen(accepted.relationDirections), true);
  assert.equal(
    accepted.relationDirections.every((row) => Object.isFrozen(row)),
    true,
  );
});

test("an artifact entity is a relation endpoint for its declared triple only", () => {
  const accepted = acceptVerticalRegistryCandidate({
      current: emptyCompiledVerticalRegistry(),
      expectedRevision: 0,
      source: verticalWith(artifact({ relations: [relation()] })),
    }),
    artifactRef = `${artifactType}/ADR-0123456789abcdef`,
    declared = { source: artifactRef, target: "decision/dec_29CCC98CD0241D0C9806AC1CF1", type: "relates" } as const;
  assert.deepEqual(parseEntityRef(artifactRef), {
    raw: artifactRef,
    kind: artifactType,
    id: "ADR-0123456789abcdef",
    externalHarness: false,
  });
  assertRelationAdmission(declared, accepted.relationDirections);
  assert.throws(
    () => assertRelationAdmission({ ...declared, type: "derives" }, accepted.relationDirections),
    (error: unknown) =>
      (error as { readonly code?: string }).code === "relation_triple_undeclared" &&
      /custom\/engineering\/architecture-decision-record@1 --derives--> decision/u.test(String(error)),
  );
  assert.throws(() => assertRelationAdmission(declared), /is not declared in the canonical direction registry/u);
});

for (const counterexample of [
  {
    name: "missing decision ref",
    source() {
      const { decisionClaimRef: _omitted, ...withoutDecision } = relation();
      return verticalWith(artifact({ relations: [withoutDecision] }));
    },
    message: /decisionClaimRef/is,
  },
  {
    name: "decision is not in_effect",
    source: () => verticalWith(artifact({ relations: [relation()] })),
    authority: authority({ state: "proposed" }),
    message: /is proposed.*must be in_effect/is,
  },
  {
    name: "decision content pin mismatch",
    source: () => verticalWith(artifact({ relations: [relation({ decisionContentPin: `sha256:${"0".repeat(64)}` })] })),
    message: /content pin mismatch/is,
  },
  {
    name: "load-bearing relation type",
    source: () => verticalWith(artifact({ relations: [relation({ type: "derives" })] })),
    message: /derives is not open/is,
  },
  {
    name: "reversed duplicate direction",
    source: () =>
      verticalWith(
        artifact({
          relations: [
            relation(),
            relation({
              sourceKind: "decision",
              targetKind: "architecture-decision-record",
              reads: "the decision relates to the target architecture decision record",
            }),
          ],
        }),
      ),
    message: /duplicated in reverse/is,
  },
  {
    name: "builtin-only endpoints",
    source: () =>
      verticalWith(
        artifact({
          relations: [relation({ sourceKind: "decision", targetKind: "task" })],
        }),
      ),
    message: /must include an artifact kind/is,
  },
  {
    name: "unregistered endpoint kind",
    source: () => verticalWith(artifact({ relations: [relation({ targetKind: "unregistered-report" })] })),
    message: /target kind unregistered-report is not registered/is,
  },
  {
    name: "duplicate triple with conflicting governance",
    source: () =>
      verticalWith(
        artifact({
          relations: [
            relation({
              type: "supersedes",
              targetKind: "architecture-decision-record",
              reads: "the architecture decision record supersedes the target record",
            }),
            relation({
              type: "supersedes",
              targetKind: "architecture-decision-record",
              reads: "the newer architecture decision record supersedes the target record",
              strength: "strong",
              rationale: "A reviewed replacement may carry the stronger lineage signal.",
            }),
          ],
        }),
      ),
    message: /conflicting reads, strength, or decision governance/is,
  },
] as const) {
  test(`the whole vertical fails closed on ${counterexample.name}`, () => {
    assert.throws(
      () => compileVerticalContract(counterexample.source(), counterexample.authority),
      counterexample.message,
    );
  });
}

test("identical duplicate triples fold into one row", () => {
  const declaration = relation(),
    compiled = compileVerticalContract(verticalWith(artifact({ relations: [declaration, { ...declaration }] })));
  assert.equal(compiledRelationDirections(compiled).length, 1);
});

test("same-kind supersedes may be strong only with a rationale", () => {
  const strong = relation({
    type: "supersedes",
    targetKind: "architecture-decision-record",
    reads: "the architecture decision record supersedes the target record",
    strength: "strong",
    rationale: "The replacement was explicitly reviewed by the vertical owner.",
  });
  assert.equal(
    compiledRelationDirections(compileVerticalContract(verticalWith(artifact({ relations: [strong] }))))[0]?.strength,
    "strong",
  );
  assert.throws(
    () => compileVerticalContract(verticalWith(artifact({ relations: [{ ...strong, rationale: undefined }] }))),
    /require a non-blank rationale/is,
  );
});

test("the governed vocabulary stays narrowed to relates and same-kind supersedes", () => {
  assert.throws(
    () =>
      compileVerticalContract(
        verticalWith(artifact({ relations: [relation({ type: "relates", strength: "strong" })] })),
      ),
    /relates rows must have strength weak/is,
  );
  assert.throws(
    () =>
      compileVerticalContract(
        verticalWith(
          artifact({
            relations: [
              relation({
                type: "supersedes",
                targetKind: "decision",
                reads: "the architecture decision record supersedes the target decision",
              }),
            ],
          }),
        ),
      ),
    /supersedes rows must have the same source and target kind/is,
  );
  assert.throws(
    () => compileVerticalContract(verticalWith(artifact({ relations: [relation({ type: "references" })] }))),
    /vertical definition decode failed/is,
  );
});

test("decision approval must resolve the exact decision anchor", () => {
  assert.throws(
    () =>
      compileVerticalContract(
        verticalWith(
          artifact({
            relations: [
              relation({
                decisionClaimRef: "decision/dec_29CCC98CD0241D0C9806AC1CF1/CH2",
              }),
            ],
          }),
        ),
      ),
    /does not exist in the compilation authority/is,
  );
});

test("configuration removal denies new writes without mutating an existing active edge", () => {
  const first = acceptVerticalRegistryCandidate({
      current: emptyCompiledVerticalRegistry(),
      expectedRevision: 0,
      source: verticalWith(artifact({ relations: [relation()] })),
    }),
    existingEdge = Object.freeze({
      type: "relates" as const,
      strength: "weak" as const,
      state: "active" as const,
      eventHistory: Object.freeze(["relation_created"]),
    }),
    removed = acceptVerticalRegistryCandidate({
      current: first,
      expectedRevision: 1,
      source: verticalWith(artifact({ relations: [] })),
    });
  assert.equal(isAllowedRelationRecord(existingEdge, artifactType, "decision", first.relationDirections), true);
  assert.equal(isAllowedRelationRecord(existingEdge, artifactType, "decision", removed.relationDirections), false);
  assert.equal(existingEdge.state, "active");
  assert.deepEqual(existingEdge.eventHistory, ["relation_created"]);

  const explicitlyRetired = Object.freeze({
    ...existingEdge,
    state: "retired" as const,
    eventHistory: Object.freeze([...existingEdge.eventHistory, "relation_retired"]),
  });
  assert.equal(explicitlyRetired.state, "retired");
  assert.deepEqual(explicitlyRetired.eventHistory, ["relation_created", "relation_retired"]);
});

test("the center serializes competing edge candidates on the registry revision fence", () => {
  const initial = emptyCompiledVerticalRegistry(),
    edgeOne = verticalWith(artifact({ relations: [relation()] })),
    edgeTwo = verticalWith(
      artifact({
        relations: [
          relation({
            type: "supersedes",
            targetKind: "architecture-decision-record",
            reads: "the architecture decision record supersedes the target record",
          }),
        ],
      }),
    ),
    accepted = acceptVerticalRegistryCandidate({ current: initial, expectedRevision: 0, source: edgeOne });
  assert.throws(
    () => acceptVerticalRegistryCandidate({ current: accepted, expectedRevision: 0, source: edgeTwo }),
    (error: unknown) => (error as { code?: string }).code === "stale_vertical_registry_revision",
  );
  assert.equal(isAllowedRelationKindTriple(artifactType, "relates", "decision", accepted.relationDirections), true);
  assert.equal(
    isAllowedRelationKindTriple(artifactType, "supersedes", artifactType, accepted.relationDirections),
    false,
  );
});

function authority(
  overrides: Partial<GovernedRelationCompilationAuthority["decisions"][number]> = {},
): GovernedRelationCompilationAuthority {
  return {
    decisions: [
      {
        decisionId: "dec_29CCC98CD0241D0C9806AC1CF1",
        state: "in_effect",
        contentPin: governancePin,
        claimIds: ["CH1"],
        ...overrides,
      },
    ],
  };
}

function verticalWith(...artifacts: readonly unknown[]): Record<string, unknown> {
  return {
    ...baseVertical,
    id: "custom/engineering",
    version: "1.0.0",
    entityKinds: [...baseVertical.entityKinds, ...artifacts],
    projectionSchemas: [
      ...baseVertical.projectionSchemas,
      { id: "artifact-descriptor", schemaRef: "schema://artifact-descriptor" },
    ],
  };
}

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "architecture-decision-record",
    entityType: "artifact",
    version: 1,
    idPrefix: "ADR",
    display: { singular: "Architecture Decision Record", plural: "Architecture Decision Records" },
    descriptorSchemaRef: "schema://artifact-descriptor",
    store: { pathTemplate: "entities/architecture-decision-records/{id}.json" },
    locatorKinds: ["repository-path"],
    relations: [],
    ...overrides,
  };
}

function relation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "relates",
    sourceKind: "architecture-decision-record",
    targetKind: "decision",
    reads: "the architecture decision record relates to the target decision",
    strength: "weak",
    decisionClaimRef: "decision/dec_29CCC98CD0241D0C9806AC1CF1/CH1",
    decisionContentPin: governancePin,
    ...overrides,
  };
}

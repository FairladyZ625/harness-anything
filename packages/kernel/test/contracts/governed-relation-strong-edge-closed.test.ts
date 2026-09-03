// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalGovernedRelationAuthority } from "../../src/domain/governed-relation-direction.ts";
import { relationTypes } from "../../src/domain/entity-relation.ts";
import { compiledRelationDirections, compileVerticalContract } from "../../src/domain/vertical-contract.ts";

const baseVertical = JSON.parse(
    readFileSync(new URL("../../fixtures/schemas/vertical-definition/valid.json", import.meta.url), "utf8"),
  ) as Record<string, unknown> & { entityKinds: unknown[]; projectionSchemas: unknown[] },
  governancePin = canonicalGovernedRelationAuthority.decisions[0]!.contentPin;

test("the complete relation vocabulary keeps load-bearing vertical edges closed", () => {
  for (const type of relationTypes) {
    const sameKind = type === "supersedes",
      declaration = relation({
        type,
        targetKind: sameKind ? "architecture-decision-record" : "decision",
        strength: type === "relates" ? "weak" : "strong",
        ...(sameKind ? { rationale: "The replacement was explicitly reviewed." } : {}),
      }),
      compile = () => compileVerticalContract(verticalWith(artifact({ relations: [declaration] })));
    if (type === "relates" || type === "supersedes") {
      assert.equal(compiledRelationDirections(compile())[0]?.type, type);
    } else {
      assert.throws(compile, new RegExp(`Relation type ${type} is not open to governed vertical configuration\\.`));
    }
  }
});

test("relates cannot be configured as a strong edge", () => {
  assert.throws(
    () => compileVerticalContract(verticalWith(artifact({ relations: [relation({ strength: "strong" })] }))),
    /User-configured relates rows must have strength weak\./u,
  );
});

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

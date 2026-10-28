// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeVerticalDefinition } from "../../src/schemas/vertical-definition.ts";
import { compiledRelationDirections, compileVerticalContract } from "../../src/domain/vertical-contract.ts";
import { resolveGovernedRelationAuthority } from "../../src/domain/governed-relation-authority.ts";
import type { DecisionDocumentState } from "../../src/domain/decision-event-types.ts";

const baseVertical = JSON.parse(
    readFileSync(new URL("../../fixtures/schemas/vertical-definition/valid.json", import.meta.url), "utf8"),
  ) as Record<string, unknown> & { entityKinds: unknown[]; projectionSchemas: unknown[] },
  kindId = "KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94",
  otherPin = `sha256:${"b".repeat(64)}` as const,
  canonicalPin = "sha256:f8ccb58e91a8da7c67fe57d1e02e78bdb1bf1972abc721d4a542d27f5919ffdb" as const;

test("a relation may cite any accepted decision, not only the canonical receipt", () => {
  const definition = decodedVertical(artifact(relation())),
    authority = resolveGovernedRelationAuthority(
      { readDecisionDocumentState: () => decisionState({ decisionId: "dec_OTHER", contentPin: otherPin }) },
      definition,
    ),
    compiled = compileVerticalContract(definition, authority),
    governance = compiledRelationDirections(compiled, authority)[0]?.governance;
  assert.equal(authority.decisions.find(({ decisionId }) => decisionId === "dec_OTHER")?.contentPin, otherPin);
  assert.equal(governance?.decisionClaimRef, "decision/dec_OTHER/CH1");
  assert.equal(governance?.decisionContentPin, otherPin);
});

test("a declared pin the decision never recorded compiles as a pin mismatch", () => {
  const definition = decodedVertical(artifact(relation({ decisionContentPin: `sha256:${"c".repeat(64)}` }))),
    authority = resolveGovernedRelationAuthority(
      { readDecisionDocumentState: () => decisionState({ decisionId: "dec_OTHER", contentPin: otherPin }) },
      definition,
    );
  assert.throws(() => compileVerticalContract(definition, authority), /pin mismatch/iu);
});

test("an unreadable, non-canonical decision is named instead of silently approved", () => {
  const definition = decodedVertical(artifact(relation())),
    authority = resolveGovernedRelationAuthority({ readDecisionDocumentState: () => null }, definition);
  assert.throws(() => compileVerticalContract(definition, authority), /does not exist in the compilation authority/u);
});

test("the canonical receipt remains the fallback when the projection cannot show its decision", () => {
  const definition = decodedVertical(artifact(canonicalRelation())),
    authority = resolveGovernedRelationAuthority({ readDecisionDocumentState: () => null }, definition);
  assert.doesNotThrow(() => compileVerticalContract(definition, authority));
});

test("the shipped canonical vertical compiles against the real decision shape", () => {
  // The production projection stores chosen options as `CH*` and fulfillment claims as `C*`; the
  // governed relations in this asset all cite CH1. Reading `claims` here used to break the whole
  // compiled vertical, so this test compiles the real file instead of a synthesized authority.
  const definition = decodeVerticalDefinition(
      JSON.parse(
        readFileSync(new URL("../../../preset/assets/software-coding/vertical.json", import.meta.url), "utf8"),
      ) as unknown,
    ),
    authority = resolveGovernedRelationAuthority(
      {
        readDecisionDocumentState: (decisionId) =>
          decisionId === "dec_29CCC98CD0241D0C9806AC1CF1"
            ? decisionState({ decisionId, contentPin: canonicalPin })
            : null,
      },
      definition,
    ),
    compiled = compileVerticalContract(definition, authority),
    directions = compiledRelationDirections(compiled, authority);
  assert.equal(directions.length, 4, JSON.stringify(directions));
  assert.ok(directions.every(({ governance }) => governance?.decisionClaimRef.endsWith("/CH1")));
});

function decisionState(input: {
  readonly decisionId: string;
  readonly contentPin: `sha256:${string}`;
}): DecisionDocumentState {
  return {
    decisionId: input.decisionId,
    state: "in_effect",
    chosen: [{ id: "CH1", text: "chosen option" }],
    rejected: [],
    claims: [{ id: "C1", text: "fulfillment claim", loadBearing: true, fulfillment: null }],
    contentPins: [{ digest: input.contentPin, state: "in_effect", pinnedAt: "2026-10-29T00:00:00.000Z" }],
  } as unknown as DecisionDocumentState;
}

function decodedVertical(...artifacts: readonly unknown[]): ReturnType<typeof decodeVerticalDefinition> {
  return decodeVerticalDefinition({
    ...baseVertical,
    id: "custom/engineering",
    version: "1.0.0",
    entityKinds: [...baseVertical.entityKinds, ...artifacts],
    projectionSchemas: [
      ...baseVertical.projectionSchemas,
      { id: "artifact-descriptor", schemaRef: "schema://artifact-descriptor" },
    ],
  });
}

function artifact(...relations: readonly unknown[]): Record<string, unknown> {
  return {
    kindId,
    id: "architecture-decision-record",
    entityType: "artifact",
    schemaVersions: [{ version: 1, attributes: {} }],
    idPrefix: "ADR",
    display: { singular: "Architecture Decision Record", plural: "Architecture Decision Records" },
    descriptorSchemaRef: "schema://artifact-descriptor",
    store: { pathTemplate: "entities/architecture-decision-records/{id}.json" },
    locatorKinds: ["repository-path"],
    relations,
  };
}

function relation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "relates",
    sourceKind: "architecture-decision-record",
    targetKind: "decision",
    reads: "the architecture decision record relates to the target decision",
    strength: "weak",
    decisionClaimRef: "decision/dec_OTHER/CH1",
    decisionContentPin: otherPin,
    ...overrides,
  };
}

function canonicalRelation(): Record<string, unknown> {
  return relation({
    decisionClaimRef: "decision/dec_29CCC98CD0241D0C9806AC1CF1/CH1",
    decisionContentPin: "sha256:f8ccb58e91a8da7c67fe57d1e02e78bdb1bf1972abc721d4a542d27f5919ffdb",
  });
}

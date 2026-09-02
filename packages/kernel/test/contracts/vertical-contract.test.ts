// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { baseEntityActionIds } from "../../src/domain/base-entity.ts";
import {
  acceptVerticalRegistryCandidate,
  compileVerticalContract,
  emptyCompiledVerticalRegistry,
} from "../../src/domain/vertical-contract.ts";

const baseVertical = JSON.parse(
  readFileSync(new URL("../../fixtures/schemas/vertical-definition/valid.json", import.meta.url), "utf8"),
) as Record<string, unknown> & {
  entityKinds: unknown[];
  projectionSchemas: unknown[];
};

test("artifact declarations compile to immutable BaseEntity and generic entity-store contracts", () => {
  const compiled = compileVerticalContract(verticalWith(artifact()));
  assert.equal(compiled.schema, "compiled-vertical-contract/v1");
  assert.equal(compiled.typeIdentity, "custom/engineering@1.0.0");
  assert.equal(compiled.artifactKinds.length, 1);

  const artifactContract = compiled.artifactKinds[0]!;
  assert.equal(artifactContract.typeIdentity, "custom/engineering/architecture-decision-record@1");
  assert.deepEqual(artifactContract.entityTypeContract.residency, { authored: "ledger" });
  assert.equal(artifactContract.entityTypeContract.relationEndpoint.eligible, true);
  assert.deepEqual(artifactContract.entityTypeContract.baseActions, baseEntityActionIds);
  assert.equal(
    artifactContract.entityKindContract.entityStore?.document.pathTemplate,
    "entities/architecture-decision-records/{id}.json",
  );
  assert.deepEqual(artifactContract.entityKindContract.authoring, {
    kind: "generic-entity-store",
    contractRef: "entity-event/v1",
  });
  assert.equal(artifactContract.entityKindContract.actionCatalog, null);
  assert.deepEqual(Object.keys(artifactContract.entityKindContract.schema.properties), [
    "schema",
    "typeIdentity",
    "entityId",
    "title",
    "locator",
    "contentVersion",
    "source",
  ]);
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.definition.entityKinds), true);
  assert.equal(Object.isFrozen(artifactContract.entityKindContract.schema.properties.locator), true);
});

test("artifact declaration decoding rejects unknown fields at every nested contract level", () => {
  const contaminated = artifact() as Record<string, unknown>;
  contaminated.freshness = "fresh";
  assert.throws(
    () => compileVerticalContract(verticalWith(contaminated)),
    /Vertical definition decode failed:.*freshness/is,
  );

  const nested = artifact() as Record<string, unknown> & { display: Record<string, unknown> };
  nested.display.abbreviation = "ADR";
  assert.throws(
    () => compileVerticalContract(verticalWith(nested)),
    /Vertical definition decode failed:.*abbreviation/is,
  );
});

test("artifact compilation rejects builtin identities and duplicate prefixes or paths", () => {
  assert.throws(
    () => compileVerticalContract(verticalWith(artifact({ id: "task", idPrefix: "WORK" }))),
    /Duplicate artifact kind id: task/u,
  );
  assert.throws(
    () =>
      compileVerticalContract(
        verticalWith(
          artifact(),
          artifact({
            id: "research-report",
            store: { pathTemplate: "entities/research-reports/{id}.json" },
          }),
        ),
      ),
    /Duplicate artifact idPrefix: ADR/u,
  );
  assert.throws(
    () =>
      compileVerticalContract(
        verticalWith(
          artifact(),
          artifact({
            id: "research-report",
            idPrefix: "RPT",
            store: { pathTemplate: "ENTITIES/architecture-decision-records/{id}.json" },
          }),
        ),
      ),
    /Duplicate artifact store\.pathTemplate/u,
  );
});

test("artifact compilation rejects non-portable paths and relation verbs outside the code vocabulary", () => {
  for (const pathTemplate of ["/entities/{id}.json", "entities/../outside/{id}.json", "entities\\{id}.json"]) {
    assert.throws(
      () => compileVerticalContract(verticalWith(artifact({ store: { pathTemplate } }))),
      /normalized portable relative path/u,
    );
  }

  assert.throws(
    () =>
      compileVerticalContract(
        verticalWith(
          artifact({
            relations: [
              {
                type: "invented-by",
                sourceKind: "architecture-decision-record",
                targetKind: "decision",
                decisionClaimRef: "decision/dec_governance/CH1",
              },
            ],
          }),
        ),
      ),
    /Vertical definition decode failed:.*invented-by/is,
  );
});

test("the center revision fence compiles only the accepted edge candidate", () => {
  const initial = emptyCompiledVerticalRegistry(),
    edgeOne = verticalWith(artifact()),
    accepted = acceptVerticalRegistryCandidate({ current: initial, expectedRevision: 0, source: edgeOne });
  assert.equal(accepted.revision, 1);
  assert.deepEqual(
    accepted.verticals[0]?.artifactKinds.map(({ typeIdentity }) => typeIdentity),
    ["custom/engineering/architecture-decision-record@1"],
  );

  const staleEdgeCandidate = verticalWith(
    artifact({ id: "research-report", idPrefix: "RPT", store: { pathTemplate: "../invalid/{id}.json" } }),
  );
  assert.throws(
    () =>
      acceptVerticalRegistryCandidate({
        current: accepted,
        expectedRevision: 0,
        source: staleEdgeCandidate,
      }),
    (error: unknown) => (error as { code?: string }).code === "stale_vertical_registry_revision",
  );
  assert.equal(accepted.revision, 1);
  assert.equal(accepted.verticals[0]?.artifactKinds[0]?.declaration.id, "architecture-decision-record");
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

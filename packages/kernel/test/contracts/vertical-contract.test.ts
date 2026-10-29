// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { baseEntityActionIds } from "../../src/domain/base-entity.ts";
import { decodeVerticalDefinition } from "../../src/schemas/vertical-definition.ts";
import { applyVerticalKindCommand } from "../../src/domain/vertical-declaration.ts";
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
  const compiled = compileVerticalContract(decodedVertical(artifact()));
  assert.equal(compiled.schema, "compiled-vertical-contract/v1");
  assert.equal(compiled.typeIdentity, "custom/engineering@1.0.0");
  assert.equal(compiled.artifactKinds.length, 1);

  const artifactContract = compiled.artifactKinds[0]!;
  assert.equal(artifactContract.typeIdentity, `entity-kind/${adrKindId}`);
  assert.equal(artifactContract.verticalId, "custom/engineering");
  assert.deepEqual(
    artifactContract.schemaVersions.map(({ version }) => version),
    [1],
  );
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
  assert.equal(artifactContract.entityKindContract.actionCatalog?.actions[0]?.id, "import");
  assert.equal(
    artifactContract.entityKindContract.actionCatalog?.actions[0]?.execution?.implementation,
    "catalog-runtime",
  );
  assert.deepEqual(Object.keys(artifactContract.entityKindContract.schema.properties), [
    "schema",
    "typeIdentity",
    "kindVersion",
    "entityId",
    "title",
    "locator",
    "contentVersion",
    "attributes",
    "source",
  ]);
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.definition.entityKinds), true);
  assert.equal(Object.isFrozen(artifactContract.entityKindContract.schema.properties.locator), true);
});

test("artifact declaration decoding rejects unknown fields at every nested contract level", () => {
  const contaminated = artifact() as Record<string, unknown>;
  contaminated.freshness = "fresh";
  assert.throws(() => decodeVerticalDefinition(verticalWith(contaminated)), /freshness/is);

  const nested = artifact() as Record<string, unknown> & { display: Record<string, unknown> };
  nested.display.abbreviation = "ADR";
  assert.throws(() => decodeVerticalDefinition(verticalWith(nested)), /abbreviation/is);
});

test("artifact compilation rejects builtin identities and duplicate prefixes or paths", () => {
  assert.throws(
    () => compileVerticalContract(decodedVertical(artifact({ id: "task", idPrefix: "WORK" }))),
    /Duplicate artifact kind id: task/u,
  );
  assert.throws(
    () =>
      compileVerticalContract(
        decodedVertical(
          artifact(),
          artifact({
            kindId: "KND-4c8f3d0b2e6a7f9d1b5c3e4a6f8d0b27",
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
        decodedVertical(
          artifact(),
          artifact({
            kindId: "KND-4c8f3d0b2e6a7f9d1b5c3e4a6f8d0b27",
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
      () => compileVerticalContract(decodedVertical(artifact({ store: { pathTemplate } }))),
      /normalized portable relative path/u,
    );
  }

  assert.throws(
    () =>
      decodeVerticalDefinition(
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
    /invented-by/is,
  );
});

test("the center revision fence compiles only the accepted edge candidate", () => {
  const initial = emptyCompiledVerticalRegistry(),
    accepted = acceptVerticalRegistryCandidate({
      current: initial,
      expectedRevision: 0,
      definition: decodedVertical(artifact()),
    });
  assert.equal(accepted.revision, 1);
  assert.deepEqual(
    accepted.verticals[0]?.artifactKinds.map(({ typeIdentity }) => typeIdentity),
    [`entity-kind/${adrKindId}`],
  );

  const staleEdgeCandidate = decodedVertical(
    artifact({
      kindId: "KND-4c8f3d0b2e6a7f9d1b5c3e4a6f8d0b27",
      id: "research-report",
      idPrefix: "RPT",
      store: { pathTemplate: "../invalid/{id}.json" },
    }),
  );
  assert.throws(
    () =>
      acceptVerticalRegistryCandidate({
        current: accepted,
        expectedRevision: 0,
        definition: staleEdgeCandidate,
      }),
    (error: unknown) => (error as { code?: string }).code === "stale_vertical_registry_revision",
  );
  assert.equal(accepted.revision, 1);
  assert.equal(accepted.verticals[0]?.artifactKinds[0]?.declaration.id, "architecture-decision-record");
});

test("an upsert cannot rewrite identity facets or the retirement lifecycle", () => {
  const current = artifact({ revision: 4 }),
    definition = decodedVertical(current),
    upsert = (declaration: Record<string, unknown>) =>
      applyVerticalKindCommand({
        definition,
        acceptedRevision: 9,
        expectedVersion: 4,
        kind: "upsert",
        kindId: adrKindId,
        declaration,
      });
  const rejects = (declaration: Record<string, unknown>, match: RegExp): void =>
    assert.throws(
      () => upsert(declaration),
      (error: unknown) =>
        (error as { readonly code?: string }).code === "destructive_kind_change" &&
        match.test((error as Error).message),
    );
  rejects({ ...current, descriptorSchemaRef: "schema://task-frontmatter" }, /descriptorSchemaRef/u);
  rejects({ ...current, locatorKinds: ["url"] }, /locatorKinds/u);
  rejects({ ...current, retired: false }, /Retirement is not an upsert facet/u);
  rejects({ ...current, retiredAt: "2030-01-01T00:00:00.000Z" }, /Retirement is not an upsert facet/u);
  rejects({ ...current, reason: "rewritten" }, /Retirement is not an upsert facet/u);

  // Restating the immutable facets exactly as read is what the GUI edit form does; only changing
  // them is destructive, so a display edit still lands and moves the fence.
  const restated = upsert({ ...current, display: { singular: "ADR", plural: "ADRs" } }),
    restatedRow = restated.definition.entityKinds.find(({ kindId }) => kindId === adrKindId) as
      | { readonly revision?: number; readonly descriptorSchemaRef?: string; readonly locatorKinds?: readonly string[] }
      | undefined;
  assert.equal(restatedRow?.revision, 9);
  assert.equal(restatedRow?.descriptorSchemaRef, "schema://artifact-descriptor");
  assert.deepEqual(restatedRow?.locatorKinds, ["repository-path"]);

  // A retired Kind stays retired through an upsert that tries to bring it back.
  const retired = applyVerticalKindCommand({
    definition,
    acceptedRevision: 9,
    expectedVersion: 4,
    kind: "retire",
    kindId: adrKindId,
    reason: "Superseded.",
    retiredAt: "2026-10-29T00:00:00.000Z",
  });
  assert.throws(
    () =>
      applyVerticalKindCommand({
        definition: retired.definition,
        acceptedRevision: 10,
        expectedVersion: 9,
        kind: "upsert",
        kindId: adrKindId,
        declaration: { ...artifact({ revision: 9 }), retired: false },
      }),
    (error: unknown) =>
      (error as { readonly code?: string }).code === "destructive_kind_change" &&
      /Retirement is not an upsert facet/u.test((error as Error).message),
  );

  assert.throws(
    () =>
      applyVerticalKindCommand({
        definition: decodedVertical(),
        acceptedRevision: 1,
        expectedVersion: 0,
        kind: "upsert",
        kindId: "new-kind",
        mintedKindId: "KND-0123456789abcdef0123456789abcdef",
        declaration: { ...artifact({ kindId: undefined, revision: undefined }), retired: true },
      }),
    (error: unknown) =>
      (error as { readonly code?: string }).code === "invalid_field" &&
      /is not a declaration facet/u.test((error as Error).message),
  );
});

function decodedVertical(...artifacts: readonly unknown[]): ReturnType<typeof decodeVerticalDefinition> {
  return decodeVerticalDefinition(verticalWith(...artifacts));
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

const adrKindId = "KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94";

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kindId: adrKindId,
    id: "architecture-decision-record",
    entityType: "artifact",
    schemaVersions: [{ version: 1, attributes: {} }],
    idPrefix: "ADR",
    display: { singular: "Architecture Decision Record", plural: "Architecture Decision Records" },
    descriptorSchemaRef: "schema://artifact-descriptor",
    store: { pathTemplate: "entities/architecture-decision-records/{id}.json" },
    locatorKinds: ["repository-path"],
    relations: [],
    ...overrides,
  };
}

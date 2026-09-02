// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  artifactEntityContractSnapshot,
  artifactImportOperationId,
  artifactObservationId,
  canonicalSourceIdentity,
  compileEntityContentObserved,
  compileEntityTargetMissing,
  compileVerticalContract,
  createEntityStore,
  decodeArtifactDescriptor,
  deriveArtifactContentVersion,
  deriveArtifactEntityId,
  type ArtifactDescriptor,
  type EntityStoreKindContract,
} from "../../src/index.ts";
import { canonicalArtifactUrl, encodeArtifactDescriptor } from "../../src/domain/artifact-entity.ts";
import { assertEntityEventInputs } from "../../src/domain/entity-event.ts";

const vertical = JSON.parse(
  readFileSync(new URL("../../fixtures/schemas/vertical-definition/valid.json", import.meta.url), "utf8"),
) as Record<string, unknown> & { entityKinds: unknown[]; projectionSchemas: unknown[] };
const actor = { principal: { personId: "person-artifact" }, executor: null } as const;

test("Artifact descriptor codec is seven-field exact and repository paths use the portable path contract", () => {
  const artifact = compiledArtifact(1),
    source = canonicalSourceIdentity({
      kind: "repository-path",
      repositoryId: "canonical",
      path: "docs/adr-0001.md",
    }),
    descriptor = makeDescriptor(artifact, source);
  assert.deepEqual(Object.keys(decodeArtifactDescriptor(artifact.entityKindContract, descriptor)), [
    "schema",
    "typeIdentity",
    "entityId",
    "title",
    "locator",
    "contentVersion",
    "source",
  ]);
  assert.equal(
    JSON.parse(encodeArtifactDescriptor(artifact.entityKindContract, descriptor)).entityId,
    descriptor.entityId,
  );
  for (const unknown of ["body", "summary", "attachments", "embedding", "freshness"])
    assert.throws(
      () => decodeArtifactDescriptor(artifact.entityKindContract, { ...descriptor, [unknown]: "forbidden" }),
      /unknown; remove it/u,
    );
  for (const value of ["/absolute.md", "../outside.md", "docs\\windows.md"])
    assert.throws(
      () =>
        decodeArtifactDescriptor(artifact.entityKindContract, {
          ...descriptor,
          locator: { kind: "repository-path", value },
        }),
      /path|relative|backslash|absolute/iu,
    );
});

test("source-derived identity is stable across content and relink, while schema identity changes it", () => {
  const v1 = compiledArtifact(1),
    v2 = compiledArtifact(2, "ADR2"),
    source = canonicalSourceIdentity({ kind: "repository-path", repositoryId: "canonical", path: "docs/adr.md" }),
    idV1 = deriveArtifactEntityId({ idPrefix: "ADR", typeIdentity: v1.typeIdentity, sourceIdentity: source }),
    changedContentVersion = deriveArtifactContentVersion({ kind: "content", content: "changed\r\nbody\r\n" }),
    normalizedContentVersion = deriveArtifactContentVersion({ kind: "content", content: "changed\nbody\n" });
  assert.equal(changedContentVersion, normalizedContentVersion);
  assert.notEqual(changedContentVersion, deriveArtifactContentVersion({ kind: "content", content: "original" }));
  assert.equal(
    idV1,
    deriveArtifactEntityId({ idPrefix: "ADR", typeIdentity: v1.typeIdentity, sourceIdentity: source }),
  );
  assert.notEqual(
    idV1,
    deriveArtifactEntityId({ idPrefix: "ADR2", typeIdentity: v2.typeIdentity, sourceIdentity: source }),
  );
  assert.equal(
    idV1.slice("ADR-".length),
    deriveArtifactEntityId({ idPrefix: "ALT", typeIdentity: v2.typeIdentity, sourceIdentity: source }).slice(
      "ALT-".length,
    ),
    "the digest is exactly sha256(canonicalSourceIdentity), independent of type and edge",
  );
  const relinked = makeDescriptor(v1, source, { locator: { kind: "repository-path", value: "docs/moved/adr.md" } });
  assert.equal(decodeArtifactDescriptor(v1.entityKindContract, relinked).entityId, idV1);
  assert.equal(canonicalArtifactUrl("HTTPS://Example.COM:443/a?z=2&a=1#fragment"), "https://example.com/a?a=1&z=2");
});

test("observed and missing artifact events are self-validating generic entity events", () => {
  const artifact = compiledArtifact(1),
    source = canonicalSourceIdentity({ kind: "repository-path", repositoryId: "canonical", path: "docs/adr.md" }),
    descriptor = makeDescriptor(artifact, source),
    snapshot = artifactEntityContractSnapshot(artifact);
  const compiledObserved = compileObservedWithDerivedIds(artifact, descriptor);
  assert.equal(compiledObserved.event.type, "entity_content_observed");
  assert.doesNotThrow(() =>
    assertEntityEventInputs(compiledObserved.event, compiledObserved.plan, compiledObserved.blobs),
  );
  const rebuiltStore = createEntityStore({
    read: () => ({ schema: "canonical-event-stream/v1", revision: 1, events: [compiledObserved.event] }),
    readContentBlob: (sha256) =>
      sha256 === compiledObserved.blobs[0].sha256 ? Buffer.from(compiledObserved.blobs[0].body) : null,
  });
  assert.equal(
    rebuiltStore.get<ArtifactDescriptor>(artifact.typeIdentity, descriptor.entityId)?.value.contentVersion,
    descriptor.contentVersion,
    "the generic store must rebuild a compiled kind from the event snapshot without a kind-specific store",
  );
  assert.throws(() =>
    assertEntityEventInputs(compiledObserved.event, compiledObserved.plan, [
      { ...compiledObserved.blobs[0], body: `${compiledObserved.blobs[0].body} ` },
    ]),
  );

  const missingResolution = "missing:ENOENT",
    locator = descriptor.locator,
    ids = observationIds(descriptor.entityId, locator, missingResolution),
    missing = compileEntityTargetMissing({
      contractSnapshot: snapshot,
      entityId: descriptor.entityId,
      locator,
      sourceIdentity: source,
      resolver: "repository:canonical",
      observationId: ids.observationId,
      reason: "ENOENT",
      eventId: `event-${ids.observationId}`,
      opId: ids.opId,
      workspaceRevision: 2,
      actor,
      source: "local",
      occurredAt: "2026-09-02T00:01:00.000Z",
    });
  assert.equal(missing.event.type, "entity_target_missing");
  assert.doesNotThrow(() => assertEntityEventInputs(missing.event, missing.plan, missing.blobs));
  assert.equal(
    missing.plan.targets.some(({ kind }) => kind === "authored_file"),
    false,
  );
});

function compiledArtifact(version: number, idPrefix = "ADR") {
  return compileVerticalContract({
    ...vertical,
    id: "custom/engineering",
    entityKinds: [
      ...vertical.entityKinds,
      {
        id: "architecture-decision-record",
        entityType: "artifact",
        version,
        idPrefix,
        display: { singular: "ADR", plural: "ADRs" },
        descriptorSchemaRef: "schema://artifact-descriptor",
        store: { pathTemplate: "entities/adrs/{id}.json" },
        locatorKinds: ["repository-path", "url", "external-key"],
        relations: [],
      },
    ],
    projectionSchemas: [
      ...vertical.projectionSchemas,
      { id: "artifact-descriptor", schemaRef: "schema://artifact-descriptor" },
    ],
  }).artifactKinds[0]!;
}

function makeDescriptor(
  artifact: ReturnType<typeof compiledArtifact>,
  source: string,
  overrides: Partial<ArtifactDescriptor> = {},
): ArtifactDescriptor {
  return {
    schema: "schema://artifact-descriptor",
    typeIdentity: artifact.typeIdentity,
    entityId: deriveArtifactEntityId({
      idPrefix: artifact.declaration.idPrefix,
      typeIdentity: artifact.typeIdentity,
      sourceIdentity: source,
    }),
    title: "ADR One",
    locator: { kind: "repository-path", value: "docs/adr.md" },
    contentVersion: deriveArtifactContentVersion({ kind: "content", content: "# ADR One\n" }),
    source,
    ...overrides,
  };
}

function observationIds(entityId: string, locator: ArtifactDescriptor["locator"], resolution: string) {
  return {
    observationId: artifactObservationId({ entityId, locator, resolution }),
    opId: artifactImportOperationId({ entityId, locator, resolution }),
  };
}

function compileObservedWithDerivedIds(artifact: ReturnType<typeof compiledArtifact>, descriptor: ArtifactDescriptor) {
  const ids = observationIds(descriptor.entityId, descriptor.locator, descriptor.contentVersion);
  return compileEntityContentObserved({
    contract: artifact.entityKindContract as EntityStoreKindContract,
    contractSnapshot: artifactEntityContractSnapshot(artifact),
    descriptor,
    resolver: "repository:canonical",
    observationId: ids.observationId,
    eventId: `event-${ids.observationId}`,
    opId: ids.opId,
    workspaceRevision: 1,
    actor,
    source: "local",
    occurredAt: "2026-09-02T00:00:00.000Z",
  });
}

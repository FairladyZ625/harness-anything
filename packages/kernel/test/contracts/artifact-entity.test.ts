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
  mintArtifactEntityId,
  ARTIFACT_ENTITY_ID_BYTES,
  pinnedArtifactKindContract,
  type ArtifactDescriptor,
  type EntityEventV1,
  type EntityStoreKindContract,
} from "../../src/index.ts";
import {
  artifactEntityContractFromSnapshot,
  artifactMutationOperationId,
  canonicalArtifactUrl,
  decodeArtifactEntityContractSnapshot,
} from "../../src/domain/artifact-entity.ts";
import {
  assertEntityEventInputs,
  validateCurrentEntityEvent,
  validateEntityEvent,
} from "../../src/domain/entity-event.ts";
import { compileEntityUpdated } from "../../src/domain/entity-event-compile.ts";
import { assertContentInputs } from "../../src/store/task-event-store-validation.ts";

const vertical = JSON.parse(
  readFileSync(new URL("../../fixtures/schemas/vertical-definition/valid.json", import.meta.url), "utf8"),
) as Record<string, unknown> & { entityKinds: unknown[]; projectionSchemas: unknown[] };
const actor = { principal: { personId: "person-artifact" }, executor: null } as const;

function entitySource(events: readonly EntityEventV1[], blobs: Map<string, Uint8Array>) {
  return {
    readBatch: (cursor: string | null, maxItems: number) => {
      const start = cursor === null ? 0 : Number(cursor),
        selected = events.slice(start, start + maxItems),
        next = start + selected.length;
      return {
        sourceRevision: events.length,
        events: selected,
        cursor: selected.length ? String(next) : cursor,
        done: next >= events.length,
        accessedItems: selected.length,
      };
    },
    readContentBlob: (sha256: string) => blobs.get(sha256) ?? null,
  };
}

test("artifact snapshots require explicit positive integral schema pins on live decode and replay", () => {
  const artifact = compiledArtifact(),
    snapshot = artifactEntityContractSnapshot({ ...artifact, kindVersion: 1 });
  for (const kindVersion of [1, 2]) {
    const pinned = { ...snapshot, kindVersion },
      bytes = JSON.stringify(pinned),
      decoded = decodeArtifactEntityContractSnapshot(JSON.parse(bytes)),
      contract = artifactEntityContractFromSnapshot(decoded);
    assert.equal(JSON.stringify(decoded), bytes, "decoding preserves accepted snapshot fields");
    assert.equal(contract.schema.$id, `${snapshot.descriptorSchemaRef}#${snapshot.typeIdentity}/v${kindVersion}`);
    const descriptor = makeDescriptor(artifact, "repo:canonical:docs/adr.md", { kindVersion });
    assert.equal(decodeArtifactDescriptor(contract, descriptor).kindVersion, kindVersion);
    assert.throws(() => decodeArtifactDescriptor(contract, { ...descriptor, kindVersion: 3 }), /kindVersion/u);
  }
  const { kindVersion: _pin, ...unpinned } = snapshot;
  for (const invalid of [
    unpinned,
    ...[undefined, null, 0, -1, 1.5, "1", true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((kindVersion) => ({
      ...snapshot,
      kindVersion,
    })),
  ]) {
    assert.throws(() => decodeArtifactEntityContractSnapshot(invalid), /kindVersion/u);
    assert.throws(() => artifactEntityContractFromSnapshot(invalid), /kindVersion/u);
  }
  const historical = decodeArtifactEntityContractSnapshot(unpinned, true);
  assert.equal(historical.kindVersion, 1);
  assert.equal(
    artifactEntityContractFromSnapshot(unpinned, true).schema.$id,
    `${snapshot.descriptorSchemaRef}#${snapshot.typeIdentity}/v1`,
  );
});

test("canonical artifact event admission and content replay reject a missing snapshot pin", () => {
  const artifact = compiledArtifact(),
    descriptor = makeDescriptor(artifact, "repo:canonical:docs/adr.md"),
    compiled = compileObservedWithDerivedIds(artifact, descriptor),
    { kindVersion: _pin, ...unpinned } = compiled.event.payload.artifactContract,
    event = { ...compiled.event, payload: { ...compiled.event.payload, artifactContract: unpinned } };
  assert.deepEqual(validateCurrentEntityEvent(compiled.event), []);
  assert.deepEqual(validateEntityEvent(compiled.event), []);
  assert.notDeepEqual(validateCurrentEntityEvent(event), []);
  assert.notDeepEqual(validateEntityEvent(event), []);
  const store = createEntityStore(
    entitySource([event as EntityEventV1], new Map([[compiled.blobs[0].sha256, Buffer.from(compiled.blobs[0].body)]])),
  );
  assert.throws(() => store.get(artifact.typeIdentity, descriptor.entityId), /entityId/u);
});

test("Artifact descriptor codec is nine-field exact and repository paths use the portable path contract", () => {
  const artifact = compiledArtifact(),
    source = canonicalSourceIdentity({
      kind: "repository-path",
      repositoryId: "canonical",
      path: "docs/adr-0001.md",
    }),
    descriptor = makeDescriptor(artifact, source);
  assert.deepEqual(Object.keys(decodeArtifactDescriptor(artifact.entityKindContract, descriptor)), [
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
  assert.throws(
    () => decodeArtifactDescriptor(artifact.entityKindContract, { ...descriptor, attributes: { undeclared: "x" } }),
    /unknown; remove it/u,
    "attributes are closed over exactly the names the pinned schema version declares",
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

test("instance identity survives a schema publication and a kind rename", () => {
  const v1 = compiledArtifact(),
    // The same kind after publishing version 2 and renaming it: one identity, two schema versions.
    v2 = compiledArtifact({
      id: "site-observation",
      schemaVersions: [
        { version: 1, attributes: {} },
        { version: 2, attributes: { confidence: { type: "integer" } } },
      ],
    }),
    source = canonicalSourceIdentity({ kind: "repository-path", repositoryId: "canonical", path: "docs/adr.md" }),
    idV1 = mintArtifactEntityId({ idPrefix: "ADR", randomBytes: new Uint8Array(ARTIFACT_ENTITY_ID_BYTES).fill(7) }),
    changedContentVersion = deriveArtifactContentVersion({ kind: "content", content: "changed\r\nbody\r\n" }),
    normalizedContentVersion = deriveArtifactContentVersion({ kind: "content", content: "changed\nbody\n" });
  assert.equal(changedContentVersion, normalizedContentVersion);
  assert.notEqual(changedContentVersion, deriveArtifactContentVersion({ kind: "content", content: "original" }));
  assert.equal(v2.typeIdentity, v1.typeIdentity, "publishing a version and renaming keep the kind identity");
  assert.equal(v2.latestVersion, 2);
  assert.match(idV1, /^ADR-[0-9a-f]{32}$/u, "an instance identity is a 128-bit opaque suffix");
  // Two mints of the same kind from the same source are two identities: nothing about the source seeds them.
  assert.notEqual(
    mintArtifactEntityId({ idPrefix: "ADR", randomBytes: new Uint8Array(ARTIFACT_ENTITY_ID_BYTES).fill(8) }),
    idV1,
  );
  assert.throws(
    () => mintArtifactEntityId({ idPrefix: "ADR", randomBytes: new Uint8Array(8) }),
    /random bytes/u,
    "a short mint is refused rather than padded into a narrower identity",
  );
  // A version-1 descriptor is still admitted by the kind after version 2 exists.
  const pinnedV1 = pinnedArtifactKindContract(v2, 1),
    relinked = makeDescriptor(v1, source, { locator: { kind: "repository-path", value: "docs/moved/adr.md" } });
  assert.equal(decodeArtifactDescriptor(pinnedV1, relinked).entityId, idV1);
  assert.throws(
    () => decodeArtifactDescriptor(pinnedArtifactKindContract(v2, 2), relinked),
    /kindVersion/u,
    "a version-1 descriptor is not silently readable as version 2",
  );
  assert.equal(canonicalArtifactUrl("HTTPS://Example.COM:443/a?z=2&a=1#fragment"), "https://example.com/a?a=1&z=2");
});

test("observed and missing artifact events are self-validating generic entity events", () => {
  const artifact = compiledArtifact(),
    source = canonicalSourceIdentity({ kind: "repository-path", repositoryId: "canonical", path: "docs/adr.md" }),
    descriptor = makeDescriptor(artifact, source),
    snapshot = artifactEntityContractSnapshot({ ...artifact, kindVersion: 1 });
  const compiledObserved = compileObservedWithDerivedIds(artifact, descriptor);
  assert.equal(compiledObserved.event.type, "entity_content_observed");
  assert.doesNotThrow(() =>
    assertEntityEventInputs(compiledObserved.event, compiledObserved.plan, compiledObserved.blobs),
  );
  const rebuiltStore = createEntityStore(
    entitySource(
      [compiledObserved.event],
      new Map([[compiledObserved.blobs[0].sha256, Buffer.from(compiledObserved.blobs[0].body)]]),
    ),
  );
  assert.equal(
    rebuiltStore.get<ArtifactDescriptor>(artifact.typeIdentity, descriptor.entityId)?.value.contentVersion,
    descriptor.contentVersion,
    "the generic store must rebuild a compiled kind from the event snapshot without a kind-specific store",
  );
  assert.throws(() =>
    assertContentInputs(
      [compiledObserved.event.payload.declarationDocumentClaim],
      [{ ...compiledObserved.blobs[0], body: `${compiledObserved.blobs[0].body} ` }],
      "entity observed",
    ),
  );

  const missingResolution = "missing:ENOENT",
    locator = descriptor.locator,
    ids = observationIds(descriptor.entityId, source, locator, missingResolution, descriptor.typeIdentity),
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

test("an entity update restates owned content as manifest metadata without carrying its bytes", () => {
  const artifact = compiledArtifact(),
    source = canonicalSourceIdentity({ kind: "repository-path", repositoryId: "canonical", path: "docs/adr.md" }),
    descriptor = makeDescriptor(artifact, source),
    opId = artifactMutationOperationId({
      mutation: "update",
      entityId: descriptor.entityId,
      expectedVersion: 1,
      request: { entityKind: descriptor.typeIdentity, title: "ADR One revised" },
    }),
    carried = {
      relativePath: "notes/keep.md",
      sha256: "b".repeat(64),
      size: 5,
      mediaType: "text/markdown",
      policyId: "markdown-body-replaceable/v1",
    },
    updated = compileEntityUpdated({
      contract: artifact.entityKindContract as EntityStoreKindContract,
      contractSnapshot: artifactEntityContractSnapshot({ ...artifact, kindVersion: 1 }),
      descriptor,
      sourceContent: [carried],
      eventId: `event-${opId}`,
      opId,
      workspaceRevision: 2,
      actor,
      source: "local",
      occurredAt: "2026-09-10T00:00:00.000Z",
    });
  // The manifest still binds what the entity owns, restated from metadata alone …
  const binding = updated.event.payload.ownedContent.bindings.find(({ path }) => path.endsWith("notes/keep.md"));
  assert.equal(binding?.contentSha256, carried.sha256);
  assert.deepEqual(
    updated.event.payload.ownedContent.content.find(({ sha256 }) => sha256 === carried.sha256),
    {
      sha256: carried.sha256,
      byteLength: carried.size,
      mediaType: carried.mediaType,
    },
  );
  // … but the bundle carries only the declaration's bytes: the store already holds the carried object,
  // and a claim with neither a blob nor a stored object is rejected at the store boundary.
  assert.equal(updated.blobs.length, 1);
  assert.equal(updated.blobs[0].sha256, updated.event.payload.declarationDocumentClaim.sha256);
});

const adrKindId = "KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94";

function compiledArtifact(overrides: Record<string, unknown> = {}) {
  return compileVerticalContract({
    ...vertical,
    id: "custom/engineering",
    entityKinds: [
      ...vertical.entityKinds,
      {
        kindId: adrKindId,
        id: "architecture-decision-record",
        entityType: "artifact",
        schemaVersions: [{ version: 1, attributes: {} }],
        idPrefix: "ADR",
        display: { singular: "ADR", plural: "ADRs" },
        descriptorSchemaRef: "schema://artifact-descriptor",
        store: { pathTemplate: "entities/adrs/{id}.json" },
        locatorKinds: ["repository-path", "url", "external-key"],
        relations: [],
        ...overrides,
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
    kindVersion: 1,
    entityId: mintArtifactEntityId({
      idPrefix: artifact.declaration.idPrefix,
      randomBytes: new Uint8Array(ARTIFACT_ENTITY_ID_BYTES).fill(7),
    }),
    title: "ADR One",
    locator: { kind: "repository-path", value: "docs/adr.md" },
    contentVersion: deriveArtifactContentVersion({ kind: "content", content: "# ADR One\n" }),
    attributes: {},
    source,
    ...overrides,
  };
}

function observationIds(
  entityId: string,
  sourceIdentity: string,
  locator: ArtifactDescriptor["locator"],
  resolution: string,
  entityKind: string,
) {
  return {
    observationId: artifactObservationId({ entityId, locator, resolution }),
    opId: artifactImportOperationId({ entityKind, sourceIdentity, locator, resolution }),
  };
}

function compileObservedWithDerivedIds(artifact: ReturnType<typeof compiledArtifact>, descriptor: ArtifactDescriptor) {
  const ids = observationIds(
    descriptor.entityId,
    descriptor.source,
    descriptor.locator,
    descriptor.contentVersion,
    descriptor.typeIdentity,
  );
  return compileEntityContentObserved({
    contract: artifact.entityKindContract as EntityStoreKindContract,
    contractSnapshot: artifactEntityContractSnapshot({ ...artifact, kindVersion: 1 }),
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

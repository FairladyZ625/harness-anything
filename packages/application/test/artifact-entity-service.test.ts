// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ARTIFACT_ENTITY_ID_BYTES,
  compileVerticalContract,
  type ArtifactDescriptor,
  type EntityEventV1,
} from "@harness-anything/kernel";
import { makeArtifactEntityService } from "../src/artifact-entity-service.ts";

const sourceVertical = JSON.parse(
  readFileSync(new URL("../../kernel/fixtures/schemas/vertical-definition/valid.json", import.meta.url), "utf8"),
) as Record<string, unknown> & { entityKinds: unknown[]; projectionSchemas: unknown[] };
const contract = compileVerticalContract({
  ...sourceVertical,
  id: "custom/engineering",
  entityKinds: [
    ...sourceVertical.entityKinds,
    {
      id: "architecture-decision-record",
      entityType: "artifact",
      kindId: "KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94",
      schemaVersions: [{ version: 1, attributes: {} }],
      idPrefix: "ADR",
      display: { singular: "ADR", plural: "ADRs" },
      descriptorSchemaRef: "schema://artifact-descriptor",
      store: { pathTemplate: "entities/adrs/{id}.json" },
      locatorKinds: ["repository-path"],
      relations: [],
    },
  ],
  projectionSchemas: [
    ...sourceVertical.projectionSchemas,
    { id: "artifact-descriptor", schemaRef: "schema://artifact-descriptor" },
  ],
}).artifactKinds[0]!;
const actor = { principal: { personId: "person-edge" }, executor: null } as const,
  envelope = { actor, source: "local" as const, occurredAt: "2026-09-02T00:00:00.000Z", workspaceRevision: 1 };

test("two edges derive one identity and operation; replay precedes the Entity revision fence", async () => {
  let content = "# ADR\nfirst\n",
    current: { descriptor: ArtifactDescriptor; revision: number } | null = null;
  const operations = new Map<string, EntityEventV1>(),
    service = makeArtifactEntityService({
      contracts: [contract],
      resolveSource: async (locator) => ({
        status: "observed",
        source: { kind: "repository-path", repositoryId: "canonical", path: locator.value },
        witness: { kind: "content", content },
        title: "ADR",
        resolver: "repository:canonical",
      }),
      readCurrent: () => current,
      resolveSourceBinding: () => ({
        entityId: current?.descriptor.entityId ?? null,
        generation: 0,
      }),
      randomEntityIdBytes: () => new Uint8Array(ARTIFACT_ENTITY_ID_BYTES),
      readOperation: (opId) => operations.get(opId) ?? null,
      countRelationChanges: () => 3,
    }),
    request = { kind: contract.typeIdentity, locator: "docs/adr.md", expectedVersion: 0, mode: "snapshot" as const },
    edgeOne = await service.prepare(request, envelope);
  operations.set(edgeOne.bundle.event.opId, edgeOne.bundle.event);
  current = { descriptor: JSON.parse(edgeOne.bundle.blobs[0]!.body) as ArtifactDescriptor, revision: 1 };

  const edgeTwo = await service.prepare(request, { ...envelope, workspaceRevision: 2 });
  assert.equal(edgeOne.preview.entityId, edgeTwo.preview.entityId);
  assert.equal(edgeOne.bundle.event.opId, edgeTwo.bundle.event.opId);
  assert.equal(edgeTwo.replay?.opId, edgeOne.bundle.event.opId);
  assert.equal(edgeTwo.preview.relationChanges, 3);
  assert.equal(edgeOne.preview.artifactOwner, `entity/${edgeOne.preview.entityId}/revision/1`);

  content = "# ADR\nsecond\n";
  await assert.rejects(
    service.prepare(request, { ...envelope, workspaceRevision: 2 }),
    (error: unknown) => (error as { code?: string }).code === "revision_conflict",
  );
  const updated = await service.prepare({ ...request, expectedVersion: 1 }, { ...envelope, workspaceRevision: 2 });
  assert.equal(updated.preview.entityId, edgeOne.preview.entityId);
  assert.notEqual(updated.preview.candidateContentVersion, edgeOne.preview.candidateContentVersion);
  assert.notEqual(updated.bundle.event.opId, edgeOne.bundle.event.opId);
});

test("dry-run and missing resolution compile plans without mutating any dependency", async () => {
  let reads = 0;
  const service = makeArtifactEntityService({
      contracts: [contract],
      resolveSource: async (locator) => ({
        status: "missing",
        source: { kind: "repository-path", repositoryId: "canonical", path: locator.value },
        reason: "ENOENT",
        resolver: "repository:canonical",
      }),
      readCurrent: () => {
        reads += 1;
        return null;
      },
      resolveSourceBinding: () => ({ entityId: null, generation: 0 }),
      randomEntityIdBytes: () => new Uint8Array(ARTIFACT_ENTITY_ID_BYTES),
      readOperation: () => null,
      countRelationChanges: () => 0,
    }),
    prepared = await service.prepare(
      { kind: contract.typeIdentity, locator: "docs/missing.md", expectedVersion: 0, mode: "snapshot", dryRun: true },
      envelope,
    );
  assert.equal(prepared.bundle, null);
  assert.equal(prepared.preview.eventType, "entity_target_missing");
  assert.equal(prepared.bundle, null);
  assert.equal(prepared.preview.candidateContentVersion, null);
  assert.equal(prepared.preview.dryRun, true);
  assert.equal(reads, 0);
});

test("a resolver network error is unknown, not an authoritative missing observation", async () => {
  const current = { descriptor: null, revision: 4 } as const;
  let operationReads = 0;
  const service = makeArtifactEntityService({
    contracts: [contract],
    resolveSource: async () => {
      throw new Error("network unavailable");
    },
    readCurrent: () => current,
    resolveSourceBinding: () => ({ entityId: null, generation: 0 }),
    randomEntityIdBytes: () => new Uint8Array(ARTIFACT_ENTITY_ID_BYTES),
    readOperation: () => {
      operationReads += 1;
      return null;
    },
    countRelationChanges: () => 0,
  });
  await assert.rejects(
    service.prepare(
      { kind: contract.typeIdentity, locator: "docs/adr.md", expectedVersion: 4, mode: "snapshot" },
      { ...envelope, workspaceRevision: 5 },
    ),
    (error: unknown) => (error as { code?: string }).code === "source_resolution_failed",
  );
  assert.deepEqual(current, { descriptor: null, revision: 4 });
  assert.equal(operationReads, 0, "a network error does not become an observation operation");
});

test("reference mode registers URL, local path, and external key without resolving content", async () => {
  let resolverCalls = 0;
  const referenceContract = {
    ...contract,
    declaration: {
      ...contract.declaration,
      locatorKinds: ["repository-path", "url", "external-key", "local-path"] as const,
    },
  } as typeof contract;
  const service = makeArtifactEntityService({
    repositoryId: "canonical",
    contracts: [referenceContract],
    resolveSource: async () => {
      resolverCalls += 1;
      throw new Error("reference must not resolve");
    },
    readCurrent: () => null,
    resolveSourceBinding: () => ({ entityId: null, generation: 0 }),
    randomEntityIdBytes: () => new Uint8Array(ARTIFACT_ENTITY_ID_BYTES),
    readOperation: () => null,
    countRelationChanges: () => 2,
  });
  for (const request of [
    {
      locator: "https://feishu.example/minutes?id=2",
      locatorKind: "url" as const,
      contentVersion: "revision-2",
    },
    {
      locator: "/Users/example/ZeYu-AI-Brain/minutes.md",
      locatorKind: "local-path" as const,
      contentVersion: "sha256:declared",
    },
    {
      locator: "local-kb:brain:minutes/2026-10-28",
      locatorKind: "external-key" as const,
    },
  ]) {
    const prepared = await service.prepare(
      { kind: referenceContract.typeIdentity, expectedVersion: 0, mode: "reference", ...request },
      { ...envelope, sourceNodeId: "node-edge-1" },
    );
    assert.equal(prepared.preview.mode, "reference");
    assert.equal(prepared.preview.contentState, "unobserved");
    assert.equal(prepared.preview.candidateContentVersion, null);
    assert.equal(prepared.preview.relationChanges, 2);
    assert.equal(prepared.bundle?.event.type, "entity_reference_declared");
    assert.equal(prepared.bundle?.blobs.length, 0);
  }
  assert.equal(resolverCalls, 0);
});

test("import mode is required and its guidance is executable", async () => {
  const service = makeArtifactEntityService({
    contracts: [contract],
    resolveSource: async () => {
      throw new Error("not reached");
    },
    readCurrent: () => null,
    resolveSourceBinding: () => ({ entityId: null, generation: 0 }),
    randomEntityIdBytes: () => new Uint8Array(ARTIFACT_ENTITY_ID_BYTES),
    readOperation: () => null,
    countRelationChanges: () => 0,
  });
  await assert.rejects(
    service.prepare(
      {
        kind: contract.typeIdentity,
        locator: "https://feishu.example/minutes?id=2&view=full",
        locatorKind: "url",
        expectedVersion: 0,
      },
      envelope,
    ),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.match(message, /reference records only the locator/u);
      assert.match(message, /snapshot reads and stores the source bytes/u);
      assert.match(
        message,
        /--locator 'https:\/\/feishu\.example\/minutes\?id=2&view=full' --locator-kind url --mode reference --expected-version 0/u,
      );
      assert.match(
        message,
        /--locator 'https:\/\/feishu\.example\/minutes\?id=2&view=full' --locator-kind url --mode snapshot --expected-version 0/u,
      );
      return true;
    },
  );

  await assert.rejects(
    service.prepare(
      {
        kind: contract.typeIdentity,
        locator: "/Users/example/ZeYu-AI-Brain/minutes.md",
        locatorKind: "local-path",
        expectedVersion: 0,
      },
      envelope,
    ),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.match(message, /--locator-kind local-path --mode reference/u);
      assert.match(message, /Snapshot reads repository-path or URL sources/u);
      assert.match(message, /--locator 'docs\/minutes\.md' --locator-kind repository-path --mode snapshot/u);
      return true;
    },
  );
});

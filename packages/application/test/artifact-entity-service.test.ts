// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileVerticalContract, type ArtifactDescriptor, type EntityEventV1 } from "../../kernel/src/index.ts";
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
      version: 1,
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
      readOperation: (opId) => operations.get(opId) ?? null,
      countRelationChanges: () => 3,
    }),
    request = { kind: contract.typeIdentity, locator: "docs/adr.md", expectedVersion: 0 },
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
      readOperation: () => null,
      countRelationChanges: () => 0,
    }),
    prepared = await service.prepare(
      { kind: contract.typeIdentity, locator: "docs/missing.md", expectedVersion: 0, dryRun: true },
      envelope,
    );
  assert.equal(prepared.bundle.event.type, "entity_target_missing");
  assert.equal(prepared.bundle.blobs.length, 0);
  assert.equal(prepared.preview.candidateContentVersion, null);
  assert.equal(prepared.preview.dryRun, true);
  assert.equal(reads, 1);
});

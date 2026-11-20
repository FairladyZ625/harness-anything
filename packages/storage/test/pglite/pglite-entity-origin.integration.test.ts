// harness-test-tier: integration
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  ARTIFACT_ENTITY_ID_BYTES,
  artifactEntityContractSnapshot,
  artifactImportOperationId,
  artifactObservationId,
  canonicalSourceIdentity,
  compileEntityContentObserved,
  deriveArtifactContentVersion,
  mintArtifactEntityId,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { artifactEntityContractFromSnapshot } from "@harness-anything/kernel/internal/domain/artifact-entity.ts";
import { makeTaskProjection, makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { initRepo } from "../store/task-event-store.fixtures.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

const repoId = "snapshot-entity-origin";
const typeIdentity = "entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94";
const entityId = mintArtifactEntityId({
  idPrefix: "ADR",
  randomBytes: new Uint8Array(ARTIFACT_ENTITY_ID_BYTES).fill(7),
});
const contractSnapshot = artifactEntityContractSnapshot({
  typeIdentity,
  kindVersion: 1,
  declaration: {
    descriptorSchemaRef: "schema://artifact-descriptor",
    idPrefix: "ADR",
    locatorKinds: ["repository-path"],
    store: { pathTemplate: "entities/adrs/{id}.json" },
  },
});

function snapshotObservation(workspaceRevision: number, personId: string, nodeId: string) {
  const path = "docs/adr.md",
    locator = { kind: "repository-path", value: path } as const,
    sourceIdentity = canonicalSourceIdentity({ kind: "repository-path", repositoryId: repoId, path }),
    resolution = deriveArtifactContentVersion({ kind: "content", content: `# ADR version ${workspaceRevision}\n` });
  return compileEntityContentObserved({
    contract: artifactEntityContractFromSnapshot(contractSnapshot),
    contractSnapshot,
    descriptor: {
      schema: contractSnapshot.descriptorSchemaRef,
      typeIdentity,
      kindVersion: 1,
      entityId,
      title: "Example ADR",
      locator,
      contentVersion: resolution,
      attributes: {},
      source: sourceIdentity,
    },
    resolver: "repository:canonical",
    observationId: artifactObservationId({ entityId, locator, resolution }),
    opId: artifactImportOperationId({ entityKind: typeIdentity, sourceIdentity, locator, resolution }),
    eventId: `event-snapshot-${workspaceRevision}`,
    workspaceRevision,
    actor: { principal: { personId }, executor: null },
    source: { kind: "node", nodeId },
    occurredAt: "2026-11-20T01:00:00.000Z",
  });
}

function assertSnapshotOrigin(queries: Pick<TaskProjectionQueries, "listEntities">) {
  const [plain] = queries.listEntities(typeIdentity);
  assert.equal(plain?.id, entityId);
  assert.equal(plain?.workspaceRevision, 2);
  assert.equal(plain?.createdByPersonId, undefined);
  assert.deepEqual(
    queries.listEntities(typeIdentity, true).map(({ id, createdByPersonId, originNodeId }) => ({
      id,
      createdByPersonId,
      originNodeId,
    })),
    [{ id: entityId, createdByPersonId: "person_alice", originNodeId: "edge-a" }],
  );
}

test("SQLite attributes a snapshot import to its first observer after an update and rebuild", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId, rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore });
    try {
      for (const bundle of [
        snapshotObservation(1, "person_alice", "edge-a"),
        snapshotObservation(2, "person_bob", "edge-b"),
      ]) {
        eventStore.append(bundle);
        projection.apply(bundle.event, bundle.plan);
      }
      assertSnapshotOrigin(projection);
      assert.equal(projection.rebuild().watermark, 2);
      assertSnapshotOrigin(projection);
    } finally {
      projection.close();
      await eventStore.drain();
    }
  });
});

pgliteIntegrationSuite("PGlite snapshot entity origin", () => {
  test("PGlite attributes a snapshot import to its first observer after an update", async () => {
    await withTempStoreAsync(async (rootDir) => {
      initRepo(rootDir);
      const storage = {
        backend: "pglite" as const,
        dataDir: join(rootDir, "database"),
        materialize: false,
        scope: { tenantId: repoId, projectId: repoId, policyEpoch: 1 },
      };
      const eventStore = makeTaskEventStore({ repoId, rootDir, storage }),
        reader = makeTaskProjectionReader({ repoId, storage });
      try {
        eventStore.append(snapshotObservation(1, "person_alice", "edge-a"));
        eventStore.append(snapshotObservation(2, "person_bob", "edge-b"));
        reader.withSession(assertSnapshotOrigin);
      } finally {
        reader.close();
        await eventStore.drain();
      }
    });
  });
});

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect, Schema } from "effect";
import {
  decodeEntityDeclaration,
  jsonEntityDocumentCodec,
  resolveEntityDocumentPath,
  writeDeclaredEntity
} from "../../src/entity/declaration.ts";
import {
  projectDeclaredEntities,
  readDeclaredProjectionRows
} from "../../src/projection/entity-declaration-projection.ts";
import { entityRegistry } from "../../src/entity/registry.ts";
import { stablePayloadHash } from "../../src/integrity/stable-hash.ts";
import { writeContentAddressedBlob } from "../../src/store/content-addressed-blob-store.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/write-journal-coordinator.ts";
import { withTempStore } from "./helpers.ts";

const FixtureSchema = Schema.Struct({
  schema: Schema.Literal("fixture-entity/v1"),
  fixture_id: Schema.String,
  title: Schema.String,
  bodyRef: Schema.optional(Schema.Unknown)
});

function declarationWithStorageForm(storageForm: unknown): Record<string, unknown> {
  return {
    kind: "fixture",
    schema: FixtureSchema,
    documentCodec: jsonEntityDocumentCodec,
    mutabilityContract: {
      schema: { mutability: "immutable", read: [{ kind: "show", path: "fixture.schema" }], write: [], reason: "schema discriminator" },
      fixture_id: { mutability: "immutable", read: [{ kind: "projection", path: "fixture_id", queryable: true }], write: [], reason: "stable identity" },
      title: { mutability: "amendable", read: [{ kind: "projection", path: "title", queryable: true }], write: [{ kind: "amend", operation: "replace" }] },
      bodyRef: { mutability: "lifecycle", read: [{ kind: "show", path: "fixture.bodyRef" }], write: [{ kind: "lifecycle", operation: "snapshot" }] }
    },
    anchors: { entityRef: "fixture/{fixture_id}", anchors: [] },
    dispositionMatrix: {
      entries: {
        retire: { level: "D1", action: "retire", supported: false, writeOpKinds: [], reason: "fixture only" },
        supersede: { level: "D1", action: "supersede", supported: false, writeOpKinds: [], reason: "fixture only" },
        invalidate: { level: "D1", action: "invalidate", supported: false, writeOpKinds: [], reason: "fixture only" },
        archive: { level: "D2", action: "archive", supported: false, writeOpKinds: [], reason: "fixture only" },
        tombstone: { level: "D3", action: "tombstone", supported: false, writeOpKinds: [], reason: "fixture only" },
        "hard-delete": { level: "D4", action: "hard-delete", supported: false, writeOpKinds: [], reason: "fixture only" }
      }
    },
    storageForm,
    rootResolver: {
      pathTemplate: "fixtures/{id}.md",
      identity: ["id"]
    },
    projection: {
      table: "fixture_projection",
      columns: [
        { name: "fixture_id", field: "fixture_id", type: "text", primaryKey: true },
        { name: "title", field: "title", type: "text" }
      ]
    }
  };
}

test("entity declaration storage vocabulary rejects operational and unknown forms", () => {
  assert.throws(
    () => decodeEntityDeclaration(declarationWithStorageForm("runtime-cas")),
    /unsupported entity storage form: runtime-cas/u
  );
  assert.throws(
    () => decodeEntityDeclaration(declarationWithStorageForm("invented-form")),
    /unsupported entity storage form: invented-form/u
  );
});

test("hosted entity roots are declaration-driven and require an existing host package", () => {
  withTempStore((rootDir) => {
    const declaration = decodeEntityDeclaration({
      ...declarationWithStorageForm("hosted-entity"),
      rootResolver: {
        pathTemplate: "tasks/{taskId}/fixture-items/{id}.md",
        identity: ["taskId", "id"],
        host: {
          entityKind: "task",
          pathTemplate: "tasks/{taskId}",
          identity: ["taskId"]
        }
      }
    });

    assert.throws(
      () => resolveEntityDocumentPath(rootDir, declaration, { taskId: "task_missing", id: "fx_1" }),
      /host entity package not found: task\/task_missing/u
    );

    mkdirSync(path.join(rootDir, "harness/tasks/task_present"), { recursive: true });
    assert.equal(
      resolveEntityDocumentPath(rootDir, declaration, { taskId: "task_present", id: "fx_1" }),
      path.join(rootDir, "harness/tasks/task_present/fixture-items/fx_1.md")
    );
  });
});

test("composite manifest declarations require a content-addressed blob reference field", () => {
  assert.throws(
    () => decodeEntityDeclaration(declarationWithStorageForm("composite-manifest-blob")),
    /composite-manifest-blob declaration must name its blob reference field/u
  );
});

test("projection declaration discovers manifests and derives a normalized table", () => {
  withTempStore((rootDir) => {
    const declaration = decodeEntityDeclaration({
      ...declarationWithStorageForm("composite-manifest-blob"),
      rootResolver: {
        pathTemplate: "fixture-sessions/{id}.md",
        identity: ["id"]
      },
      blob: { referenceField: "bodyRef", store: "content-addressed" }
    });
    const manifestPath = resolveEntityDocumentPath(rootDir, declaration, { id: "fx_session_1" });
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, jsonEntityDocumentCodec.encode({
      schema: "fixture-entity/v1",
      fixture_id: "fx_session_1",
      title: "Projected fixture",
      bodyRef: "sha256:0123456789abcdef"
    }), "utf8");

    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const result = projectDeclaredEntities(rootDir, declaration, projectionPath);

    assert.deepEqual(result.rows, [{ fixture_id: "fx_session_1", title: "Projected fixture" }]);
    assert.deepEqual(readDeclaredProjectionRows(projectionPath, declaration), result.rows);
  });
});

test("fixture declarations resolve, coordinate writes, and project hosted and composite entities", () => {
  withTempStore((rootDir) => {
    mkdirSync(path.join(rootDir, "harness/tasks/task_fixture_host"), { recursive: true });
    const hosted = decodeEntityDeclaration({
      ...declarationWithStorageForm("hosted-entity"),
      rootResolver: {
        pathTemplate: "tasks/{taskId}/fixture-items/{id}.md",
        identity: ["taskId", "id"],
        host: {
          entityKind: "task",
          pathTemplate: "tasks/{taskId}",
          identity: ["taskId"]
        }
      },
      projection: {
        table: "fixture_hosted_projection",
        columns: [
          { name: "fixture_id", field: "fixture_id", type: "text", primaryKey: true },
          { name: "title", field: "title", type: "text" }
        ]
      }
    });
    const composite = decodeEntityDeclaration({
      ...declarationWithStorageForm("composite-manifest-blob"),
      rootResolver: { pathTemplate: "fixture-sessions/{id}.md", identity: ["id"] },
      blob: { referenceField: "bodyRef", store: "content-addressed" },
      projection: {
        table: "fixture_composite_projection",
        columns: [
          { name: "fixture_id", field: "fixture_id", type: "text", primaryKey: true },
          { name: "title", field: "title", type: "text" }
        ]
      }
    });
    const coordinator = makeJournaledWriteCoordinator({
      rootDir,
      actor: { kind: "agent", id: "test" }
    });
    const hostedIdentity = { taskId: "task_fixture_host", id: "fx_hosted_1" };
    const compositeIdentity = { id: "fx_composite_1" };
    const bodyRef = writeContentAddressedBlob(rootDir, "fixture transcript", "text/plain");

    Effect.runSync(writeDeclaredEntity(coordinator, stablePayloadHash, hosted, hostedIdentity, {
      schema: "fixture-entity/v1",
      fixture_id: "fx_hosted_1",
      title: "Hosted fixture"
    }));
    Effect.runSync(writeDeclaredEntity(coordinator, stablePayloadHash, composite, compositeIdentity, {
      schema: "fixture-entity/v1",
      fixture_id: "fx_composite_1",
      title: "Composite fixture",
      bodyRef
    }));

    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    assert.deepEqual(projectDeclaredEntities(rootDir, hosted, projectionPath).rows, [
      { fixture_id: "fx_hosted_1", title: "Hosted fixture" }
    ]);
    assert.deepEqual(projectDeclaredEntities(rootDir, composite, projectionPath).rows, [
      { fixture_id: "fx_composite_1", title: "Composite fixture" }
    ]);
    const manifest = jsonEntityDocumentCodec.decode(readFileSync(
      resolveEntityDocumentPath(rootDir, composite, compositeIdentity),
      "utf8"
    )) as { readonly bodyRef?: unknown };
    assert.deepEqual(manifest.bodyRef, bodyRef);
  });
});

test("entity registry declares the five-tuple surface for decision task fact relation and session", () => {
  assert.deepEqual(Object.keys(entityRegistry).sort(), ["decision", "fact", "relation", "session", "task"]);
  assert.equal(entityRegistry.session.storageForm, "composite-manifest-blob");
  assert.equal(entityRegistry.decision.storageForm, "lifecycle");
  assert.equal(entityRegistry.task.storageForm, "lifecycle");
  assert.equal(entityRegistry.fact.storageForm, "schema");
  assert.equal(entityRegistry.relation.storageForm, "host_frontmatter");
  assert.equal(entityRegistry.decision.dispositionMatrix.entries["hard-delete"].supported, false);
  assert.equal(entityRegistry.fact.dispositionMatrix.entries.invalidate.supported, true);
  assert.equal(entityRegistry.fact.dispositionMatrix.entries["hard-delete"].supported, false);
  assert.equal(Object.keys(entityRegistry.fact.mutabilityContract).includes("statement"), true);
});

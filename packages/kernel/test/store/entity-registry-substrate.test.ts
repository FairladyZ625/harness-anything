// harness-test-tier: integration
import { testWriteAttribution } from "../test-attribution.ts";
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
import {
  compileRegistryMutationPlan,
  createWritableEntityRegistry,
  entityRegistry,
  entityRegistryKinds,
  type EntityRegistration,
  type KernelEntityKind
} from "../../src/entity/registry.ts";
import {
  assertRegistryCompiledStoragePlan,
  assertWritableEntityRegistry
} from "../../src/entity/registry-compiler.ts";
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
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(),
      rootDir,
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

test("entity registry derives all eight canonical kinds from one source", () => {
  assert.deepEqual(entityRegistryKinds, ["task", "decision", "fact", "relation", "module", "session", "execution", "review"]);
  assert.deepEqual(Object.keys(entityRegistry).sort(), [...entityRegistryKinds].sort());
  assert.equal(entityRegistry.session.storageForm, "composite-manifest-blob");
  assert.equal(entityRegistry.decision.storageForm, "lifecycle");
  assert.equal(entityRegistry.task.storageForm, "lifecycle");
  assert.equal(entityRegistry.fact.storageForm, "schema");
  assert.equal(entityRegistry.relation.storageForm, "host_frontmatter");
  assert.equal(entityRegistry.execution.storageForm, "hosted-entity");
  assert.equal(entityRegistry.review.storageForm, "hosted-entity");
  assert.equal(entityRegistry.decision.dispositionMatrix.entries["hard-delete"].supported, false);
  assert.equal(entityRegistry.fact.dispositionMatrix.entries.invalidate.supported, true);
  assert.equal(entityRegistry.fact.dispositionMatrix.entries["hard-delete"].supported, false);
  assert.equal(Object.keys(entityRegistry.fact.mutabilityContract).includes("statement"), true);
});

test("all eight identity codecs and storage locators are total without standalone hosted files", () => {
  const fixtures = [
    ["task", { taskId: "task_T" }, "task/task_T", {}, "tasks/task_T"],
    ["decision", { decisionId: "dec_D" }, "decision/dec_D", {}, "decisions/decision-dec_D/decision.md"],
    ["fact", { taskId: "task_T", factId: "F-1" }, "fact/task_T/F-1", {}, "tasks/task_T/facts.md"],
    ["relation", { relationId: "rel_0123456789abcdef" }, "relation/rel_0123456789abcdef", { sourceRef: "fact/task_T/F-1" }, "tasks/task_T/facts.md"],
    ["module", { moduleKey: "software/coding" }, "module/software%2Fcoding", {}, "modules.json"],
    ["session", { sessionId: "session_S" }, "session/session_S", {}, "sessions/session_S.md"],
    ["execution", { taskId: "task_T", executionId: "exe_E" }, "execution/task_T/exe_E", {}, "tasks/task_T/executions/exe_E.md"],
    ["review", { taskId: "task_T", reviewId: "rev_R" }, "review/task_T/rev_R", {}, "tasks/task_T/reviews/rev_R.md"]
  ] as const;

  for (const [kind, identity, canonicalRef, storageContext, targetPath] of fixtures) {
    const registration = entityRegistry[kind];
    assert.equal(registration.identityCodec.status, "ready");
    assert.equal(registration.storageLocator.status, "ready");
    if (registration.identityCodec.status !== "ready" || registration.storageLocator.status !== "ready") continue;
    assert.equal(registration.identityCodec.codec.encode(identity), canonicalRef);
    assert.deepEqual(registration.identityCodec.codec.decode(canonicalRef), identity);
    assert.equal(registration.storageLocator.locator.locate(identity, storageContext).targets[0]?.path, targetPath);
  }
});

test("writable registration fails closed when any required facet is missing or deferred", () => {
  const canonicalRefs: Readonly<Record<KernelEntityKind, string>> = {
    task: "task/task_T",
    decision: "decision/dec_D",
    fact: "fact/task_T/F-1",
    relation: "relation/rel_0123456789abcdef",
    module: "module/software%2Fcoding",
    session: "session/session_S",
    execution: "execution/task_T/exe_E",
    review: "review/task_T/rev_R"
  };
  const complete = writableRegistration("fact");
  for (const facet of ["identityCodec", "storageLocator", "mutationContract", "semanticDiff", "projectionFacet"] as const) {
    const missing = { ...complete } as Record<string, unknown>;
    delete missing[facet];
    assert.throws(
      () => createWritableEntityRegistry([missing as unknown as EntityRegistration<string, KernelEntityKind>]),
      new RegExp(`REGISTRY_FACET_MISSING:${facet}`, "u")
    );
  }
  for (const kind of entityRegistryKinds) {
    assert.equal(entityRegistry[kind].mutationContract.status, "ready");
    assert.equal(entityRegistry[kind].projectionFacet.status, "ready", `${kind} derives the W1 union projection from the registry`);
    if (entityRegistry[kind].projectionFacet.status === "ready" && entityRegistry[kind].identityCodec.status === "ready") {
      assert.deepEqual(
        entityRegistry[kind].projectionFacet.resolveCanonicalRef(canonicalRefs[kind]),
        entityRegistry[kind].identityCodec.codec.decode(canonicalRefs[kind])
      );
    }
    assert.doesNotThrow(() => createWritableEntityRegistry([
      entityRegistry[kind] as EntityRegistration<string, KernelEntityKind>
    ]));
  }
  for (const kind of ["session", "execution", "review"] as const) {
    assert.equal(entityRegistry[kind].semanticDiff.status, "typed-only");
  }
});

test("registry compiler emits one hosted StoragePlan from the same canonical mutation set", () => {
  const writable = createWritableEntityRegistry([
    writableRegistration("fact"),
    writableRegistration("relation")
  ]);
  const compilation = compileRegistryMutationPlan(writable, {
    registryVersion: 1,
    mutations: [
      { entityKind: "fact", identity: { taskId: "task_T", factId: "F-1" }, action: "fixture-write" },
      {
        entityKind: "relation",
        identity: { relationId: "rel_0123456789abcdef" },
        action: "fixture-write",
        storageContext: { sourceRef: "fact/task_T/F-1" }
      }
    ]
  });

  assert.strictEqual(compilation.storagePlan.mutations, compilation.mutationSet.mutations);
  assert.deepEqual(compilation.mutationSet.mutations.map((mutation) => mutation.entity.canonicalRef), [
    "fact/task_T/F-1",
    "relation/rel_0123456789abcdef"
  ]);
  assert.deepEqual(compilation.storagePlan.targets, [
    { kind: "document", path: "tasks/task_T/facts.md", access: "exact" }
  ]);
  assert.deepEqual(compilation.storagePlan.consistencyScopes, ["path:tasks/task_T/facts.md"]);
});

test("registry compiler has no unknown kind or action fallback", () => {
  const writable = createWritableEntityRegistry([writableRegistration("task")]);
  assert.throws(
    () => compileRegistryMutationPlan(writable, {
      registryVersion: 1,
      mutations: [{ entityKind: "unknown", identity: { id: "x" }, action: "fixture-write" }]
    }),
    /UNKNOWN_ENTITY_KIND:unknown/u
  );
  assert.throws(
    () => compileRegistryMutationPlan(writable, {
      registryVersion: 1,
      mutations: [{ entityKind: "task", identity: { taskId: "task_T" }, action: "unknown" }]
    }),
    /UNKNOWN_SEMANTIC_ACTION:task:unknown/u
  );
});

test("v2 compiler inputs cannot bypass the writable registry gate", () => {
  const writable = createWritableEntityRegistry([writableRegistration("task")]);
  assert.doesNotThrow(() => assertWritableEntityRegistry(writable));
  assert.throws(
    () => assertWritableEntityRegistry({ registrations: writable.registrations }),
    /WRITABLE_ENTITY_REGISTRY_GATE_REQUIRED/u
  );
  const compilation = compileRegistryMutationPlan(writable, {
    registryVersion: 1,
    mutations: [{ entityKind: "task", identity: { taskId: "task_T" }, action: "fixture-write" }]
  });
  assert.doesNotThrow(() => assertRegistryCompiledStoragePlan(compilation.storagePlan));
  assert.throws(
    () => assertRegistryCompiledStoragePlan({ ...compilation.storagePlan }),
    /REGISTRY_COMPILED_STORAGE_PLAN_REQUIRED/u
  );
});

function writableRegistration(kind: KernelEntityKind): EntityRegistration<string, KernelEntityKind> {
  return {
    ...entityRegistry[kind] as EntityRegistration<string, KernelEntityKind>,
    mutationContract: { status: "ready", actions: ["fixture-write"] },
    semanticDiff: { status: "ready", compile: () => [] },
    projectionFacet: { status: "ready", project: () => undefined, resolveCanonicalRef: () => ({}) }
  };
}

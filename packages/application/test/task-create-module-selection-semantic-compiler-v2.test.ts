// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalPayloadDigestV2,
  encodeTaskDecisionModuleCommandPayloadV2,
  makeTaskDecisionModuleSemanticCompilerV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  type HostedDocumentSnapshotV2,
  type ModuleRecordV2,
  type PathCasV2,
  type RegistryEntityRefV2,
  type SemanticBaseCasV2,
  type SemanticEntityBaseV2,
  type SemanticMutationEnvelopeV2,
  type SemanticMutationSetV2,
  type TaskDecisionModuleCommandPayloadV2
} from "../src/index.ts";
import {
  compileRegistryMutationPlan,
  createWritableEntityRegistry,
  entityRegistry
} from "../../kernel/src/index.ts";

const registry = createWritableEntityRegistry([entityRegistry.task]);

test("module-scoped task create derives its read dependency from module.md and revalidates it before publication", async () => {
  const taskId = "task_MODULE";
  const module = { ...moduleRecord(), status: "paused" };
  const registrySnapshot = moduleRegistrySnapshot(module);
  const documents = new Map<string, HostedDocumentSnapshotV2>([["modules.json", registrySnapshot]]);
  const compiler = makeTaskDecisionModuleSemanticCompilerV2({
    state: authorityState(new Map(), documents)
  });

  const compiled = await compiler.compile(envelope(
    taskCreatePayload(taskId, module),
    [absent(ref("task", `task/${taskId}`))],
    [cas("modules.json", registrySnapshot)]
  ));
  const plan = compileRegistryMutationPlan(registry, compiled.mutationPlan);
  assert.deepEqual(plan.mutationSet.mutations.map((mutation) =>
    `${mutation.entity.canonicalRef}:${mutation.action.action}`), [`task/${taskId}:create`]);
  assert.deepEqual(plan.storagePlan.touchedPaths, [`tasks/${taskId}/INDEX.md`]);
  assert.ok(compiled.publicationRevalidation);
  await compiled.publicationRevalidation();

  documents.set("modules.json", {
    ...registrySnapshot,
    revision: registrySnapshot.revision + 1n,
    blobDigest: Buffer.alloc(32, 0x33)
  });
  await assert.rejects(compiled.publicationRevalidation(), /PATH_CAS_CONFLICT:snapshot-mismatch=modules\.json/u);
});

test("module-scoped task create rejects missing, unregistered, mismatched, and publication-time unregistered modules", async () => {
  const taskId = "task_MODULE_FAILURE";
  const active = moduleRecord();
  const taskRef = ref("task", `task/${taskId}`);

  await assert.rejects(
    makeTaskDecisionModuleSemanticCompilerV2({ state: authorityState() }).compile(envelope(
      taskCreatePayload(taskId, active),
      [absent(taskRef)]
    )),
    /MODULE_NOT_FOUND/u
  );

  const unregisteredSnapshot = moduleRegistrySnapshot({ ...active, status: "unregistered" });
  await assert.rejects(
    makeTaskDecisionModuleSemanticCompilerV2({
      state: authorityState(new Map(), new Map([["modules.json", unregisteredSnapshot]]))
    }).compile(envelope(
      taskCreatePayload(taskId, active),
      [absent(taskRef)],
      [cas("modules.json", unregisteredSnapshot)]
    )),
    /MODULE_NOT_FOUND/u
  );

  const activeSnapshot = moduleRegistrySnapshot(active);
  await assert.rejects(
    makeTaskDecisionModuleSemanticCompilerV2({
      state: authorityState(new Map(), new Map([["modules.json", activeSnapshot]]))
    }).compile(envelope(
      taskCreatePayload(taskId, { ...active, title: "Wrong title" }),
      [absent(taskRef)],
      [cas("modules.json", activeSnapshot)]
    )),
    /MODULE_SELECTION_MISMATCH/u
  );

  const documents = new Map<string, HostedDocumentSnapshotV2>([["modules.json", activeSnapshot]]);
  const compiled = await makeTaskDecisionModuleSemanticCompilerV2({
    state: authorityState(new Map(), documents)
  }).compile(envelope(
    taskCreatePayload(taskId, active),
    [absent(taskRef)],
    [cas("modules.json", activeSnapshot)]
  ));
  documents.set("modules.json", moduleRegistrySnapshot({ ...active, status: "unregistered" }));
  await assert.rejects(compiled.publicationRevalidation!(), /MODULE_NOT_FOUND/u);
});

function taskCreatePayload(taskId: string, module: ModuleRecordV2): TaskDecisionModuleCommandPayloadV2 {
  const indexBody = taskIndex(taskId);
  return {
    schema: "task.create/v1",
    taskId,
    packageSlug: "module-task",
    indexBody,
    writes: [
      { path: "INDEX.md", body: indexBody },
      { path: "module.md", body: moduleSelection(module) }
    ]
  };
}

function envelope(
  payloadValue: TaskDecisionModuleCommandPayloadV2,
  baseCas: ReadonlyArray<SemanticBaseCasV2>,
  declaredPathCas: ReadonlyArray<PathCasV2> = []
): SemanticMutationEnvelopeV2 {
  const payload = encodeTaskDecisionModuleCommandPayloadV2(payloadValue);
  const mutationSet: SemanticMutationSetV2 = { registryVersion: 1, mutations: [] };
  const draft: SemanticMutationEnvelopeV2 = {
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId: "workspace-module-selection",
    operationId: {
      namespace: {
        schema: "operation-namespace/v1",
        workspaceId: "workspace-module-selection",
        deviceId: "device-module-selection",
        authorityGeneration: 1n,
        namespaceId: "namespace-module-selection",
        expiresAt: 9_000n,
        issuer: "authority.test",
        keyId: "namespace-key",
        proof: Buffer.alloc(32, 3)
      },
      clientRandom128: Buffer.alloc(16, 7)
    },
    binding: {
      bindingId: "binding-module-selection",
      actorAxesBindingDigest: Buffer.alloc(32, 4),
      deviceId: "device-module-selection",
      viewId: "view-module-selection",
      sessionId: "session-module-selection",
      admissionTokenRef: { tokenId: "token-module-selection", tokenDigest: Buffer.alloc(32, 5) }
    },
    schemaTuple: {
      wire: 2, event: 2, receipt: 2, digest: 2, policy: 1,
      commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
    },
    intent: {
      kind: "typed",
      command: { registryVersion: 1, name: "task.create", version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(payload.length), bytes: payload },
      canonicalPayloadDigest: canonicalPayloadDigestV2(payload),
      baseCas,
      declaredPathCas
    },
    claimedMutationSet: mutationSet,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  };
  return { ...draft, claimedSemanticRequestDigest: semanticRequestDigestV2(draft) };
}

function authorityState(
  bases: ReadonlyMap<string, SemanticEntityBaseV2> = new Map(),
  documents: ReadonlyMap<string, HostedDocumentSnapshotV2> = new Map()
) {
  return {
    readEntityBase: async (entityRef: RegistryEntityRefV2) => bases.get(entityKey(entityRef)) ?? null,
    readHostedDocument: async (documentPath: string) => documents.get(documentPath) ?? null
  };
}

function moduleRecord(): ModuleRecordV2 {
  return {
    key: "kernel", title: "Kernel", status: "active", scopes: ["packages/kernel/**"],
    shared: [], dependsOn: [], steps: []
  };
}

function moduleRegistrySnapshot(module: ModuleRecordV2): HostedDocumentSnapshotV2 {
  return snapshot(`${JSON.stringify({ schema: "module-registry/v1", modules: [module] }, null, 2)}\n`);
}

function moduleSelection(module: ModuleRecordV2): string {
  return [
    "# Module Selection", "", `Module key: ${module.key}`, `Module title: ${module.title}`, "",
    "## Scopes", "", ...module.scopes.map((scope) => `- ${scope}`), "",
    "This file records the module selected when the task was created.", ""
  ].join("\n");
}

function taskIndex(taskId: string): string {
  return [
    "---", "schema: task-package/v2", `task_id: ${taskId}`, `title: ${taskId}`,
    "lifecycle:", "  bindingSchema: lifecycle-binding/v1", "  engine: local", "  status: planned",
    "  ref: ", `  titleSnapshot: ${taskId}`, "  url: ",
    "  bindingCreatedAt: 2026-07-14T00:00:00.000Z", `  bindingFingerprint: sha256:${"b".repeat(64)}`,
    "packageDisposition: active", "vertical: default", "preset: default",
    "provenance:", "  - {runtime: codex, sessionId: session-module-selection, boundAt: 2026-07-14T00:00:00.000Z}",
    "---", "", `# ${taskId}`, ""
  ].join("\n");
}

function snapshot(body: string): HostedDocumentSnapshotV2 {
  return { body, epoch: "epoch-module-selection", revision: 7n, blobDigest: Buffer.alloc(32, 0x22) };
}

function cas(documentPath: string, value: HostedDocumentSnapshotV2): PathCasV2 {
  return {
    path: documentPath,
    expectedEpoch: value.epoch,
    expectedRevision: value.revision,
    expectedBlobDigest: value.blobDigest
  };
}

function ref(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}

function absent(entityRef: RegistryEntityRefV2): SemanticBaseCasV2 {
  return { entityRef, expectedSemanticVersion: null, expectedStateDigest: null };
}

function entityKey(entityRef: RegistryEntityRefV2): string {
  return `${entityRef.registryVersion}\0${entityRef.entityKind}\0${entityRef.canonicalRef}`;
}

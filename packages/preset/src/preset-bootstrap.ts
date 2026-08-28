import {
  REPLAY_TASK_GRAPH,
  classifyTextualArtifactPath,
  currentTaskForWrite,
  deriveRelationId,
  formatRelationFlowRecord,
  presetSnapshotUpgradeWritePlan,
  sha256Text,
  slugifyTaskTitle,
  taskBootstrapWritePlan,
  validatePresetSnapshotUpgradeEvent,
  validateRelationRecordsForHost,
  validateTaskBootstrapEvent,
  validateTaskIdSyntax,
  type ActorIdentity,
  type EntityRelationRecord,
  type FrozenWritePlan,
  type PresetSnapshotUpgradeBundle,
  type PresetSnapshotUpgradeEventV1,
  type RelationType,
  type TaskBootstrapBlob,
  type TaskBootstrapEventV1,
  type TaskClass,
  type TaskDocumentOwner,
  type TaskMetadataV1,
  type OpaqueTextualMediaType,
  type WriteSource,
} from "../../kernel/src/index.ts";
import { serializePresetSnapshotV1, type PresetSnapshotV1 } from "./preset.contract.ts";
import { createRuntime, type PresetResolverOptions } from "./preset-resolver.ts";

export interface TaskRelationDraft {
  readonly type: RelationType;
  readonly target: string;
  readonly rationale: string;
}
export interface TaskModuleRegistration {
  readonly key: string;
  readonly title: string;
  readonly prefix: string;
  readonly scope: string;
}
export interface CompileTaskPackageInput extends PresetResolverOptions {
  readonly taskId: string;
  readonly title: string;
  readonly taskClass?: TaskClass;
  readonly presetId: string;
  readonly verticalId: string;
  readonly profileId?: string;
  readonly locale: string;
  readonly idempotencyKey?: string;
  readonly parentTaskId?: string;
  readonly workKind?: TaskMetadataV1["workKind"];
  readonly riskTier?: TaskMetadataV1["riskTier"];
  readonly urgency?: TaskMetadataV1["urgency"];
  readonly moduleKey?: string;
  readonly registerModule?: TaskModuleRegistration;
  readonly slug?: string;
  readonly surfaces?: readonly string[];
  readonly relations?: readonly TaskRelationDraft[];
  readonly fromLegacyId?: string;
}
export interface CompileTaskBootstrapInput extends CompileTaskPackageInput {
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly workspaceRevision: number;
  readonly eventId: string;
  readonly opId: string;
  readonly occurredAt: string;
}
export interface CompiledTaskDocument {
  readonly slot: string;
  readonly relativePath: string;
  readonly path: string;
  readonly body: string;
  readonly mediaType: "application/json" | "text/markdown" | "text/plain" | OpaqueTextualMediaType;
  readonly owner: TaskDocumentOwner;
  readonly requiredAnchors: readonly string[];
  readonly templateRef: string | null;
}
export interface CompiledTaskPackage {
  readonly snapshot: PresetSnapshotV1;
  readonly packagePath: string;
  readonly scaffoldDigest: `sha256:${string}`;
  readonly documents: readonly CompiledTaskDocument[];
  readonly metadata: TaskMetadataV1;
  readonly relations: readonly EntityRelationRecord[];
}
export interface CompiledTaskBootstrap extends CompiledTaskPackage {
  readonly event: TaskBootstrapEventV1;
  readonly plan: FrozenWritePlan<"TaskBootstrap">;
  readonly blobs: readonly TaskBootstrapBlob[];
}
export interface CompilePresetSnapshotUpgradeInput extends PresetResolverOptions {
  readonly task: TaskBootstrapEventV1["payload"]["task"];
  readonly taskContractBody: string;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly workspaceRevision: number;
  readonly eventId: string;
  readonly opId: string;
  readonly occurredAt: string;
}
export interface CompiledPresetSnapshotUpgrade extends PresetSnapshotUpgradeBundle {
  readonly snapshot: PresetSnapshotV1;
}
export function compileTaskPackage(input: CompileTaskPackageInput): CompiledTaskPackage {
  validateTaskIdSyntax(input.taskId);
  if (!input.title.trim()) throw bootstrapFailure("invalid_title", "Task title is required.");
  const resolved = createRuntime(input).resolveInternal({
    presetId: input.presetId,
    verticalId: input.verticalId,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    locale: input.locale,
    purpose: "task-create",
  });
  if (resolved.requiredTaskClass && input.taskClass === undefined)
    throw bootstrapFailure(
      "task_class_required",
      `Preset requires caller-supplied taskClass=${resolved.requiredTaskClass}.`,
    );
  if (resolved.requiredTaskClass && input.taskClass !== resolved.requiredTaskClass)
    throw bootstrapFailure("task_class_mismatch", `Preset requires taskClass=${resolved.requiredTaskClass}.`);
  const slug = input.slug ?? slugifyTaskTitle(input.title),
    packagePath = `tasks/${input.taskId}-${slug}`,
    metadata: TaskMetadataV1 = {
      idempotencyKey: input.idempotencyKey ?? null,
      parentTaskId: input.parentTaskId ?? null,
      workKind: input.workKind ?? null,
      riskTier: input.riskTier ?? null,
      urgency: input.urgency ?? null,
      verticalId: input.verticalId,
      presetId: input.presetId,
      profileId: input.profileId ?? resolved.snapshot.profile.id,
      moduleKey: input.moduleKey ?? input.registerModule?.key ?? null,
      slug,
      surfaces: [...(input.surfaces ?? [])],
      fromLegacyId: input.fromLegacyId ?? null,
    },
    relations = taskRelations(input),
    prose = resolved.documents.map(
      (document): CompiledTaskDocument => ({
        slot: document.slot,
        relativePath: document.path,
        path: `${packagePath}/${document.path}`,
        body: document.body.replaceAll("{{title}}", input.title),
        mediaType: document.mediaType,
        owner: document.owner,
        requiredAnchors: document.requiredAnchors,
        templateRef: document.templateRef,
      }),
    ),
    bySlot = new Map(prose.map((document) => [document.slot, document]));
  for (const slot of ["task.plan", "task.closeout", "task.artifacts.keep"])
    if (!bySlot.has(slot)) throw bootstrapFailure("invalid_scaffold", `Base scaffold slot ${slot} cannot be removed.`);
  const presetScripts = resolved.scripts.map(
    (script): CompiledTaskDocument => ({
      slot: `preset.script.${script.name}`,
      relativePath: `artifacts/scripts/${script.name}`,
      path: `${packagePath}/artifacts/scripts/${script.name}`,
      body: script.body,
      mediaType: classifyTextualArtifactPath(`artifacts/scripts/${script.name}`)?.mediaType ?? "text/plain",
      owner: "machine",
      requiredAnchors: [],
      templateRef: null,
    }),
  );
  for (const script of presetScripts)
    if (prose.some((document) => document.relativePath === script.relativePath))
      throw bootstrapFailure(
        "invalid_scaffold",
        `Preset script ${script.relativePath} collides with a scaffold document path.`,
      );
  const moduleDocument = metadata.moduleKey
      ? machine(
          "task.module",
          "module.md",
          `# Module\n\nModule key: ${metadata.moduleKey}\nModule title: ${
            input.registerModule?.title ?? metadata.moduleKey
          }\n${
            input.registerModule
              ? `Module prefix: ${input.registerModule.prefix}\nModule scope: ${input.registerModule.scope}\n`
              : ""
          }`,
        )
      : null,
    scaffoldDigest = resolved.snapshot.scaffold.resolvedSelectionDigest,
    orderedProse = [bySlot.get("task.plan")!, bySlot.get("task.closeout")!, bySlot.get("task.artifacts.keep")!],
    additions = prose
      .filter((document) => !orderedProse.includes(document))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    descriptors = [
      descriptorStub("task.index", "INDEX.md", "machine"),
      descriptorStub("task.contract", "task-contract.json", "machine"),
      descriptor(orderedProse[0]!),
      descriptor(orderedProse[1]!),
      descriptor(orderedProse[2]!),
      ...(moduleDocument ? [descriptor(moduleDocument)] : []),
      ...additions.map(descriptor),
      ...presetScripts.map(descriptor),
    ],
    index = machine("task.index", "INDEX.md", renderIndex(input, packagePath, metadata, relations, descriptors)),
    contract = machine(
      "task.contract",
      "task-contract.json",
      `${JSON.stringify(
        {
          schema: "task-contract/v1",
          contractVersion: 1,
          taskId: input.taskId,
          packagePath,
          title: input.title,
          taskClass: input.taskClass ?? "standard",
          verticalId: input.verticalId,
          presetId: input.presetId,
          profileId: metadata.profileId,
          locale: input.locale,
          metadata,
          relations,
          registerModule: input.registerModule ?? null,
          completionGates: resolved.snapshot.profile.completionGateIds,
          presetSnapshotDigest: resolved.snapshot.digest,
          scaffold: {
            baseVersion: resolved.snapshot.scaffold.baseVersion,
            overlayDigest: resolved.snapshot.scaffold.overlayDigest,
            resolvedSelectionDigest: scaffoldDigest,
          },
          documents: descriptors,
        },
        null,
        2,
      )}\n`,
    ),
    documents = [
      index,
      contract,
      orderedProse[0]!,
      orderedProse[1]!,
      orderedProse[2]!,
      ...(moduleDocument ? [moduleDocument] : []),
      ...additions,
      ...presetScripts,
    ];
  return { snapshot: resolved.snapshot, packagePath, scaffoldDigest, documents, metadata, relations };
  function machine(slot: string, relativePath: string, body: string): CompiledTaskDocument {
    return {
      slot,
      relativePath,
      path: `${packagePath}/${relativePath}`,
      body,
      mediaType: relativePath.endsWith(".json") ? "application/json" : "text/markdown",
      owner: "machine",
      requiredAnchors: [],
      templateRef: null,
    };
  }
}
export function compileTaskBootstrap(input: CompileTaskBootstrapInput): CompiledTaskBootstrap {
  const compiled = compileTaskPackage(input),
    snapshotBody = serializePresetSnapshotV1(compiled.snapshot),
    snapshotSha = sha256Text(snapshotBody),
    snapshotClaim = {
      digest: compiled.snapshot.digest,
      sha256: snapshotSha,
      size: Buffer.byteLength(snapshotBody),
      mediaType: "application/json" as const,
    },
    initialDocumentClaims = compiled.documents.map((document) => ({
      path: document.path,
      sha256: sha256Text(document.body),
      size: Buffer.byteLength(document.body),
      mediaType: document.mediaType,
      owner: document.owner,
      policyId:
        document.owner === "machine" ? ("typed-machine-writer/v1" as const) : ("markdown-body-replaceable/v1" as const),
    }));
  const event: TaskBootstrapEventV1 = {
    schema: "task-bootstrap-event/v1",
    eventId: input.eventId,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    taskId: input.taskId,
    type: "task_bootstrapped",
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: {
      task: {
        schema: "task/v1",
        taskId: input.taskId,
        title: input.title,
        taskClass: input.taskClass ?? "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        createdBy: input.actor,
        completionGateIds: compiled.snapshot.profile.completionGateIds,
        presetSnapshotDigest: compiled.snapshot.digest,
        metadata: compiled.metadata,
        relations: compiled.relations,
        packageDisposition: "active",
        supersededBy: null,
        contractVersion: 1,
      },
      presetSnapshotClaim: snapshotClaim,
      initialDocumentClaims,
    },
  };
  const issues = validateTaskBootstrapEvent(event);
  if (issues.length) throw bootstrapFailure("invalid_bootstrap", issues.join("; "));
  const bodies = [
      { ...snapshotClaim, body: snapshotBody },
      ...compiled.documents.map((document, indexValue) => ({
        ...initialDocumentClaims[indexValue]!,
        body: document.body,
      })),
    ],
    blobs = [...new Map(bodies.map((blob) => [blob.sha256, blob])).values()];
  return { ...compiled, event, plan: taskBootstrapWritePlan(event), blobs };
}
export function compilePresetSnapshotUpgrade(input: CompilePresetSnapshotUpgradeInput): CompiledPresetSnapshotUpgrade {
  let contract: Record<string, unknown>;
  try {
    contract = JSON.parse(input.taskContractBody) as Record<string, unknown>;
  } catch {
    throw bootstrapFailure("invalid_task_contract", "Task contract is not JSON.");
  }
  const documents = Array.isArray(contract.documents) ? contract.documents : [],
    title = typeof contract.title === "string" ? contract.title : "",
    presetId = typeof contract.presetId === "string" ? contract.presetId : "",
    verticalId = typeof contract.verticalId === "string" ? contract.verticalId : "",
    profileId = typeof contract.profileId === "string" ? contract.profileId : "",
    locale = typeof contract.locale === "string" ? contract.locale : "",
    previousDigest = contract.presetSnapshotDigest;
  if (
    contract.taskId !== input.task.taskId ||
    contract.taskClass !== input.task.taskClass ||
    typeof contract.packagePath !== "string" ||
    input.task.presetSnapshotDigest !== previousDigest ||
    typeof previousDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(previousDigest) ||
    !title ||
    !presetId ||
    !verticalId ||
    !profileId ||
    !locale ||
    documents.some((item) => !item || typeof item !== "object" || typeof (item as { path?: unknown }).path !== "string")
  )
    throw bootstrapFailure("invalid_task_contract", "Task contract metadata does not match the canonical task.");
  const compiled = compileTaskPackage({
    ...input,
    taskId: input.task.taskId,
    title,
    taskClass: input.task.taskClass,
    presetId,
    verticalId,
    profileId,
    locale,
    slug: input.task.metadata?.slug,
  });
  // A preset may retire a document slot (afa7f26fc retired the fact ledger document once facts became
  // entities); the retired file stays on disk as committed prose. Only a slot the package does not have yet
  // would need materialization, so only additions are rejected.
  const knownPaths = new Set(documents.map((item) => (item as { path: string }).path)),
    addedPaths = compiled.documents.map(({ relativePath }) => relativePath).filter((item) => !knownPaths.has(item));
  if (addedPaths.length)
    throw bootstrapFailure(
      "upgrade_document_set_changed",
      `Preset upgrade adds documents the task package does not have (${addedPaths.join(", ")}); ` +
        "recreate the task instead.",
    );
  if (compiled.snapshot.digest === previousDigest)
    throw bootstrapFailure("snapshot_current", "Task already uses the current preset snapshot.");
  const snapshotBody = serializePresetSnapshotV1(compiled.snapshot),
    snapshotClaim = {
      digest: compiled.snapshot.digest,
      sha256: sha256Text(snapshotBody),
      size: Buffer.byteLength(snapshotBody),
      mediaType: "application/json" as const,
    },
    contractDocument = compiled.documents.find(({ relativePath }) => relativePath === "task-contract.json")!,
    taskContractClaim = {
      path: contractDocument.path,
      sha256: sha256Text(contractDocument.body),
      size: Buffer.byteLength(contractDocument.body),
      mediaType: "application/json" as const,
      owner: "machine" as const,
      policyId: "typed-machine-writer/v1" as const,
    },
    event: PresetSnapshotUpgradeEventV1 = {
      schema: "preset-snapshot-upgrade-event/v1",
      eventId: input.eventId,
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      taskId: input.task.taskId,
      type: "preset_snapshot_upgraded",
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
      payload: {
        previousDigest: previousDigest as `sha256:${string}`,
        task: {
          ...currentTaskForWrite(input.task),
          completionGateIds: compiled.snapshot.profile.completionGateIds,
          presetSnapshotDigest: compiled.snapshot.digest,
        },
        presetSnapshotClaim: snapshotClaim,
        taskContractClaim,
      },
    },
    issues = validatePresetSnapshotUpgradeEvent(event);
  if (issues.length) throw bootstrapFailure("invalid_upgrade", issues.join("; "));
  return {
    snapshot: compiled.snapshot,
    event,
    plan: presetSnapshotUpgradeWritePlan(event),
    blobs: [
      ...new Map(
        [
          { ...snapshotClaim, body: snapshotBody },
          { ...taskContractClaim, body: contractDocument.body },
        ].map((blob) => [blob.sha256, blob]),
      ).values(),
    ],
  };
}
function descriptor(document: CompiledTaskDocument) {
  return {
    slot: document.slot,
    path: document.relativePath,
    owner: document.owner,
    materializeAs: document.relativePath,
    requiredAnchors: document.requiredAnchors,
    templateRef: document.templateRef,
    contentSha256: sha256Text(document.body),
  };
}
function descriptorStub(slot: string, path: string, owner: TaskDocumentOwner) {
  return {
    slot,
    path,
    owner,
    materializeAs: path,
    requiredAnchors: [] as readonly string[],
    templateRef: null,
    contentSha256: null as string | null,
  };
}
function renderIndex(
  input: CompileTaskPackageInput,
  packagePath: string,
  metadata: TaskMetadataV1,
  relations: readonly EntityRelationRecord[],
  documents: readonly { readonly path: string; readonly owner: TaskDocumentOwner }[],
): string {
  return `---\nschema: task-package/v2\ntask_id: ${input.taskId}\ntitle: ${JSON.stringify(input.title)}\n${
    metadata.parentTaskId ? `parent: ${metadata.parentTaskId}\n` : ""
  }lifecycle:\n  engine: kernel/task-lifecycle/v1\n  status: planned\npackageDisposition: active\n${
    metadata.workKind ? `workKind: ${metadata.workKind}\n` : ""
  }${metadata.riskTier ? `riskTier: ${metadata.riskTier}\n` : ""}${
    metadata.urgency ? `urgency: ${metadata.urgency}\n` : ""
  }vertical: ${metadata.verticalId}\npreset: ${metadata.presetId}\nprofile: ${metadata.profileId}\npackagePath: ${
    packagePath
  }\nowner: machine\nrelations:\n${relations.map(formatRelationFlowRecord).join("\n")}\n---\n# ${
    input.title
  }\n\nPreset: ${input.presetId}/${metadata.profileId}\n\n## Documents\n\n${documents
    .map((document) => `- \`${document.path}\` — ${document.owner}`)
    .join("\n")}\n\n## Next\n\nEdit \`task_plan.md\`, then run \`ha task start ${
    input.taskId
  } --execution-id <id>\`.\n`;
}
function taskRelations(input: CompileTaskPackageInput): readonly EntityRelationRecord[] {
  const records = (input.relations ?? []).map((draft): EntityRelationRecord => {
    const basis = {
      source: `task/${input.taskId}`,
      target: draft.target,
      type: draft.type,
      direction: "directed" as const,
    };
    return {
      relation_id: deriveRelationId(basis),
      ...basis,
      strength: "strong",
      origin: "declared",
      rationale: draft.rationale.trim(),
      state: "active",
    };
  });
  const issues = validateRelationRecordsForHost(`task/${input.taskId}`, records);
  if (issues.length) throw bootstrapFailure("invalid_relation", `${issues[0]!.message}. Fix --relation and retry.`);
  return records;
}
function bootstrapFailure(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

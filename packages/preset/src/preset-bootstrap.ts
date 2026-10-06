import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  REPLAY_TASK_GRAPH,
  assertTransitionDocumentReady,
  classifyTextualArtifactPath,
  currentTaskForWrite,
  deriveTaskWorktreeBinding,
  getExecutableEntityAction,
  presetSnapshotUpgradeWritePlan,
  sha256Text,
  slugifyTaskTitle,
  taskBootstrapWritePlan,
  transitionDocumentContract,
  validatePresetSnapshotUpgradeEvent,
  validateTaskBootstrapEvent,
  validateTaskIdSyntax,
  OPAQUE_TEXTUAL_POLICY_ID,
  type ActorIdentity,
  type FrozenWritePlan,
  type PresetSnapshotUpgradeBundle,
  type PresetSnapshotUpgradeEventV1,
  type TaskBootstrapBlob,
  type TaskBootstrapEventV1,
  type TaskClass,
  type TaskDocumentOwner,
  type TaskMetadataV1,
  type OpaqueTextualMediaType,
  type WriteSource,
} from "@harness-anything/kernel";
import { canonicalPresetBytes, serializePresetSnapshotV1, type PresetSnapshotV1 } from "./preset.contract.ts";
import { createRuntime, type PresetResolverOptions } from "./preset-resolver.ts";
import { resolverContentHash } from "./preset-resolver-common.ts";

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
  readonly slug?: string;
  readonly surfaces?: readonly string[];
  readonly reviewReturnBudget?: number;
  /** Authored task_plan.md body written in the same create transaction, replacing the scaffold body. */
  readonly plan?: string;
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
  readonly contentSha256: string;
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
  readonly lightweightPresetIds: readonly string[];
}
export interface CompiledTaskBootstrap extends CompiledTaskPackage {
  readonly event: TaskBootstrapEventV1;
  readonly plan: FrozenWritePlan<"TaskBootstrap">;
  readonly blobs: readonly TaskBootstrapBlob[];
}

const LIVING_EXPLAINER_TEMPLATE = (title: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | Task explainer</title>
<style>
:root{color-scheme:light}body{margin:0;padding:2rem;background:#faf7f0;color:#3d3833;font:16px/1.55 system-ui,sans-serif}main{max-width:72rem;margin:auto}h1{font-size:2rem;margin:0 0 1rem}section{border-top:1px solid #d8d0c4;padding:1rem 0}h2{font-size:1.1rem;margin:.2rem 0}.muted{color:#6d655d}
</style>
</head>
<body><main>
<h1>${title}</h1>
<p class="muted">Living summary. Update this page incrementally as the task progresses.</p>
<section id="goal"><h2>Goal</h2><p>Pending.</p></section>
<section id="changes"><h2>Changes</h2><p>Pending.</p></section>
<section id="verification"><h2>Verification</h2><p>Pending.</p></section>
<section id="remaining"><h2>Remaining risk</h2><p>Pending.</p></section>
</main></body></html>
`;
export interface CompilePresetSnapshotUpgradeInput extends PresetResolverOptions {
  readonly toPresetId?: string;
  readonly documentExists?: (relativePath: string) => boolean;
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
  if (
    input.reviewReturnBudget !== undefined &&
    (!Number.isSafeInteger(input.reviewReturnBudget) || input.reviewReturnBudget < 1)
  )
    throw bootstrapFailure("invalid_field", "reviewReturnBudget must be a positive integer.");
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
  const snapshot = input.workKind === "docs" ? withoutCodeDeliveryGates(resolved.snapshot) : resolved.snapshot,
    slug = input.slug ?? slugifyTaskTitle(input.title),
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
      moduleKey: null,
      slug,
      surfaces: [...(input.surfaces ?? [])],
      fromLegacyId: null,
    },
    planBody = typeof input.plan === "string" && input.plan.trim() ? input.plan : null,
    planScaffoldBody =
      planBody === null
        ? null
        : (resolved.documents.find(({ slot }) => slot === "task.plan")?.body.replaceAll("{{title}}", input.title) ??
          null);
  if (planBody !== null && planScaffoldBody !== null)
    assertTransitionDocumentReady("task.plan", planBody, transitionDocumentContract(planScaffoldBody));
  const prose = resolved.documents.map((document): CompiledTaskDocument => {
      const scaffoldBody = document.body.replaceAll("{{title}}", input.title),
        body = document.slot === "task.plan" && planBody !== null ? planBody : scaffoldBody;
      return {
        slot: document.slot,
        relativePath: document.path,
        path: `${packagePath}/${document.path}`,
        body,
        contentSha256: sha256Text(body),
        mediaType: document.mediaType,
        owner: document.owner,
        requiredAnchors: document.requiredAnchors,
        templateRef: document.templateRef,
      };
    }),
    bySlot = new Map(prose.map((document) => [document.slot, document]));
  const createAction = getExecutableEntityAction("task-create");
  if (!createAction) throw bootstrapFailure("invalid_scaffold", "task.create descriptor is missing.");
  const requiredSlots = [
    ...createAction.ownedArtifacts.filter(({ scaffoldRequired }) => scaffoldRequired).map(({ slot }) => slot),
    ...createAction.managedDocuments.filter(({ scaffoldRequired }) => scaffoldRequired).map(({ slot }) => slot),
  ];
  for (const slot of requiredSlots)
    if (!bySlot.has(slot)) throw bootstrapFailure("invalid_scaffold", `Base scaffold slot ${slot} cannot be removed.`);
  const presetScripts = resolved.scripts.map(
    (script): CompiledTaskDocument => ({
      slot: `preset.script.${script.name}`,
      relativePath: `artifacts/scripts/${script.name}`,
      path: `${packagePath}/artifacts/scripts/${script.name}`,
      body: script.body,
      contentSha256: sha256Text(script.body),
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
  const explainer =
    metadata.profileId === "lightweight"
      ? null
      : {
          slot: "task.explainer",
          relativePath: "artifacts/explainer.html",
          path: `${packagePath}/artifacts/explainer.html`,
          body: LIVING_EXPLAINER_TEMPLATE(input.title),
          contentSha256: sha256Text(LIVING_EXPLAINER_TEMPLATE(input.title)),
          mediaType: "text/html" as const,
          owner: "doc-sync" as const,
          requiredAnchors: [],
          templateRef: null,
        };
  const prBodyBody = prBodyScaffoldBody(input, snapshot.profile.outputShape),
    prBody =
      prBodyBody === null
        ? null
        : {
            slot: "task.pr-body",
            relativePath: "artifacts/pr-body.md",
            path: `${packagePath}/artifacts/pr-body.md`,
            body: prBodyBody,
            contentSha256: sha256Text(prBodyBody),
            mediaType: "text/markdown" as const,
            owner: "doc-sync" as const,
            requiredAnchors: [],
            templateRef: null,
          };
  const scaffoldDigest = resolved.snapshot.scaffold.resolvedSelectionDigest,
    orderedProse = [bySlot.get("task.plan")!, bySlot.get("task.closeout")!, bySlot.get("task.artifacts.keep")!],
    additions = prose
      .filter((document) => !orderedProse.includes(document))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    // With an authored plan body, the task.plan descriptor's readiness contract must still derive
    // from the preset scaffold, never from the authored body: a contract frozen from the authored
    // body would flag that body's own text as retained scaffold and make the task unstartable.
    // Template sections stay required, exactly like the hand-edit-then-doc-sync path.
    withPlanScaffold = (document: CompiledTaskDocument) => descriptor(document, planScaffoldBody),
    descriptors = [
      descriptorStub("task.index", "INDEX.md", "machine"),
      descriptorStub("task.contract", "task-contract.json", "machine"),
      withPlanScaffold(orderedProse[0]!),
      descriptor(orderedProse[1]!),
      descriptor(orderedProse[2]!),
      ...additions.map((document) => descriptor(document)),
      ...(explainer === null ? [] : [descriptor(explainer)]),
      ...(prBody === null ? [] : [descriptor(prBody)]),
      ...presetScripts.map((document) => descriptor(document)),
    ],
    index = machine("task.index", "INDEX.md", renderIndex(input, packagePath, metadata, descriptors)),
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
          ...(input.reviewReturnBudget === undefined ? {} : { reviewReturnBudget: input.reviewReturnBudget }),
          ...(snapshot.profile.closeoutOverrides === undefined
            ? {}
            : { closeoutOverrides: snapshot.profile.closeoutOverrides }),
          ...(snapshot.profile.archiveOnComplete === undefined
            ? {}
            : { archiveOnComplete: snapshot.profile.archiveOnComplete }),
          completionGates: snapshot.profile.completionGateIds,
          presetSnapshotDigest: snapshot.digest,
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
      ...additions,
      ...(explainer === null ? [] : [explainer]),
      ...(prBody === null ? [] : [prBody]),
      ...presetScripts,
    ];
  return {
    snapshot,
    packagePath,
    scaffoldDigest,
    documents,
    metadata,
    lightweightPresetIds: resolved.lightweightPresetIds,
  };
  function machine(slot: string, relativePath: string, body: string): CompiledTaskDocument {
    return {
      slot,
      relativePath,
      path: `${packagePath}/${relativePath}`,
      body,
      contentSha256: sha256Text(body),
      mediaType: relativePath.endsWith(".json") ? "application/json" : "text/markdown",
      owner: "machine",
      requiredAnchors: [],
      templateRef: null,
    };
  }
}

/**
 * The PR-body skeleton: when the repository declares `.github/pull_request_template.md`, a
 * repository-diff task materializes its current bytes so the bilingual format is filled in, never
 * guessed — the same template CI's pr-body-lint enforces. Who qualifies is not a new judgment: it
 * is the worktree binding, the same derivation `ha task show` names the workspace kind with. Tasks
 * without a binding — work roots, task-package presets like docs-task — never change repository
 * files and never open a PR of their own. A repository without the template has nothing to
 * materialize.
 */
function prBodyScaffoldBody(input: CompileTaskPackageInput, outputShape: string): string | null {
  if (
    input.repoRoot === undefined ||
    deriveTaskWorktreeBinding({
      taskId: input.taskId,
      taskClass: input.taskClass ?? "standard",
      outputShape,
    }) === null
  )
    return null;
  const templatePath = path.join(input.repoRoot, ".github", "pull_request_template.md");
  return existsSync(templatePath) ? readFileSync(templatePath, "utf8") : null;
}

function withoutCodeDeliveryGates(snapshot: PresetSnapshotV1): PresetSnapshotV1 {
  const completionGateIds = snapshot.profile.completionGateIds.filter(
    (gateId) => gateId !== "ci" && gateId !== "code-doc-reconciliation",
  );
  if (completionGateIds.length === snapshot.profile.completionGateIds.length) return snapshot;
  const { digest: _digest, ...withoutDigest } = snapshot,
    effective = { ...withoutDigest, profile: { ...snapshot.profile, completionGateIds } };
  return {
    ...effective,
    digest: `sha256:${resolverContentHash(canonicalPresetBytes(effective))}`,
  };
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
      sha256: document.contentSha256,
      size: Buffer.byteLength(document.body),
      mediaType: document.mediaType,
      owner: document.owner,
      policyId:
        document.owner === "machine"
          ? ("typed-machine-writer/v1" as const)
          : ((document.relativePath === "artifacts/explainer.html" || document.relativePath === "artifacts/pr-body.md"
              ? OPAQUE_TEXTUAL_POLICY_ID
              : ("markdown-body-replaceable/v1" as const)) as
              | "markdown-body-replaceable/v1"
              | "opaque-textual-whole-file/v1"),
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
        schema: "task/v2",
        taskId: input.taskId,
        title: input.title,
        taskClass: input.taskClass ?? "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        pinned: false,
        createdBy: input.actor,
        completionGateIds: compiled.snapshot.profile.completionGateIds,
        presetSnapshotDigest: compiled.snapshot.digest,
        metadata: compiled.metadata,
        packageDisposition: "active",
        supersededBy: null,
        contractVersion: 1,
        ...(input.reviewReturnBudget === undefined ? {} : { reviewReturnBudget: input.reviewReturnBudget }),
        ...(compiled.snapshot.profile.closeoutOverrides === undefined
          ? {}
          : { closeoutOverrides: compiled.snapshot.profile.closeoutOverrides }),
        ...(compiled.snapshot.profile.archiveOnComplete === undefined
          ? {}
          : { archiveOnComplete: compiled.snapshot.profile.archiveOnComplete }),
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
  const currentTask = currentTaskForWrite(input.task),
    {
      closeoutOverrides: _staleCloseoutOverrides,
      archiveOnComplete: _staleArchiveOnComplete,
      ...taskWithoutOverrides
    } = currentTask,
    compiled = compileTaskPackage({
      ...input,
      taskId: input.task.taskId,
      title,
      taskClass: input.task.taskClass,
      slug: input.task.metadata?.slug,
      workKind: input.task.metadata?.workKind ?? undefined,
      reviewReturnBudget: input.task.reviewReturnBudget,
      verticalId,
      profileId: input.toPresetId && input.toPresetId !== presetId ? undefined : profileId,
      locale,
      presetId: input.toPresetId ?? presetId,
    });
  // A preset may retire a document slot (afa7f26fc retired the fact ledger document once facts became
  // entities); the retired file stays on disk as committed prose. New fixed task scaffolds can be
  // materialized during upgrade; authored or preset-defined additions still require recreation.
  const knownPaths = new Set(documents.map((item) => (item as { path: string }).path)),
    addedPaths = compiled.documents
      .map(({ relativePath }) => relativePath)
      .filter((item) => !knownPaths.has(item) && !input.documentExists?.(item)),
    scaffoldAdditions = new Set(["artifacts/explainer.html", "artifacts/pr-body.md"]),
    unsupportedAddedPaths = addedPaths.filter((item) => !scaffoldAdditions.has(item));
  if (unsupportedAddedPaths.length)
    throw bootstrapFailure(
      "upgrade_document_set_changed",
      `Preset upgrade adds documents the task package does not have (${unsupportedAddedPaths.join(", ")}); ` +
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
    compiledContract = compiled.documents.find(({ relativePath }) => relativePath === "task-contract.json")!,
    contractBody = `${JSON.stringify(
      {
        ...JSON.parse(compiledContract.body),
        packagePath: contract.packagePath,
        metadata: currentTask.metadata
          ? { ...currentTask.metadata, presetId: input.toPresetId ?? presetId, profileId: compiled.metadata.profileId }
          : null,
      },
      null,
      2,
    )}\n`,
    contractDocument = {
      ...compiledContract,
      path: `${contract.packagePath}/task-contract.json`,
      body: contractBody,
      contentSha256: sha256Text(contractBody),
    },
    taskContractClaim = {
      path: contractDocument.path,
      sha256: contractDocument.contentSha256,
      size: Buffer.byteLength(contractDocument.body),
      mediaType: "application/json" as const,
      owner: "machine" as const,
      policyId: "typed-machine-writer/v1" as const,
    },
    addedDocumentClaims = compiled.documents
      .filter(({ relativePath }) => addedPaths.includes(relativePath))
      .map((document) => ({
        path: document.path,
        sha256: document.contentSha256,
        size: Buffer.byteLength(document.body),
        mediaType: document.mediaType,
        owner: document.owner,
        policyId: "opaque-textual-whole-file/v1" as const,
      })),
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
          ...taskWithoutOverrides,
          ...(input.toPresetId && input.toPresetId !== presetId ? { iteration: input.task.iteration + 1 } : {}),
          ...(input.toPresetId && currentTask.metadata
            ? {
                metadata: {
                  ...currentTask.metadata,
                  presetId: input.toPresetId,
                  profileId: compiled.metadata.profileId,
                },
              }
            : {}),
          completionGateIds: compiled.snapshot.profile.completionGateIds,
          presetSnapshotDigest: compiled.snapshot.digest,
          ...(compiled.snapshot.profile.closeoutOverrides === undefined
            ? {}
            : { closeoutOverrides: compiled.snapshot.profile.closeoutOverrides }),
          ...(compiled.snapshot.profile.archiveOnComplete === undefined
            ? {}
            : { archiveOnComplete: compiled.snapshot.profile.archiveOnComplete }),
        },
        presetSnapshotClaim: snapshotClaim,
        taskContractClaim,
        ...(addedDocumentClaims.length ? { addedDocumentClaims } : {}),
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
          ...compiled.documents
            .filter(({ relativePath }) => addedPaths.includes(relativePath))
            .map((document) => ({
              sha256: document.contentSha256,
              size: Buffer.byteLength(document.body),
              mediaType: document.mediaType,
              body: document.body,
            })),
        ].map((blob) => [blob.sha256, blob]),
      ).values(),
    ],
  };
}
function descriptor(document: CompiledTaskDocument, planScaffold: string | null = null) {
  return {
    slot: document.slot,
    path: document.relativePath,
    owner: document.owner,
    materializeAs: document.relativePath,
    requiredAnchors: document.requiredAnchors,
    templateRef: document.templateRef,
    contentSha256: document.contentSha256,
    // The readiness contract this scaffold declares, frozen at materialization so judging a
    // transition document never needs the scaffold blob or the bundled catalog. Only the
    // readiness-judged slots carry it; the map's ordered keys are the required sections.
    ...(document.slot === "task.plan" || document.slot === "task.closeout"
      ? { readiness: transitionDocumentContract(planScaffold ?? document.body).scaffoldBySection }
      : {}),
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
  }\nowner: machine\n---\n# ${
    input.title
  }\n\nPreset: ${input.presetId}/${metadata.profileId}\n\n## Documents\n\n${documents
    .map((document) => `- \`${document.path}\` — ${document.owner}`)
    .join("\n")}\n\n## Next\n\nEdit \`task_plan.md\`, then run \`ha task start ${input.taskId}\`.\n`;
}
function bootstrapFailure(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

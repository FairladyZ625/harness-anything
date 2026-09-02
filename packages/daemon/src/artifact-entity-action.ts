import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ArtifactEntityServiceError,
  makeArtifactEntityService,
  readArtifactDescriptor,
  type ArtifactEntityCurrent,
  type ArtifactSourceResolution,
} from "../../application/src/index.ts";
import {
  compileVerticalContract,
  isEntityDeclarationEvent,
  isEntityEvent,
  normalizeRelativeDocumentPath,
  type AuthorizationDecision,
  type CanonicalEventStore,
  type CompiledArtifactKindContract,
  type EntityActionContract,
  type EntityEventV1,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { defaultAssets } from "../../preset/src/preset-resolver-common.ts";
import { loadCanonicalAssets } from "../../preset/src/preset-assets.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

let cachedArtifactKinds: readonly CompiledArtifactKindContract[] | null = null;
type ArtifactImportReceipt = WriteReceipt & { readonly entityId: string };

export function compiledArtifactKinds(): readonly CompiledArtifactKindContract[] {
  if (cachedArtifactKinds === null)
    cachedArtifactKinds = loadCanonicalAssets(defaultAssets).compiledVertical.artifactKinds;
  return cachedArtifactKinds;
}

/** Test seam for custom verticals: callers compile the same source value and pass its artifactKinds. */
export function artifactKindsFromVertical(source: unknown): readonly CompiledArtifactKindContract[] {
  return compileVerticalContract(source).artifactKinds;
}

export function resolveArtifactImportAction(
  kind: unknown,
  contracts: readonly CompiledArtifactKindContract[],
): EntityActionContract | null {
  if (typeof kind !== "string") return null;
  const contract = contracts.find(({ typeIdentity }) => typeIdentity === kind);
  return contract?.entityKindContract.actionCatalog?.actions.find(({ id }) => id === "import") ?? null;
}

export async function executeArtifactEntityImport(input: {
  readonly rootDir: string;
  readonly repositoryId: string;
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  readonly authorizationDecision: AuthorizationDecision;
}): Promise<{
  readonly action: RepoTaskAction;
  readonly contract: EntityActionContract;
  readonly receipt: ArtifactImportReceipt;
}> {
  const contracts = compiledArtifactKinds(),
    contract = resolveArtifactImportAction(input.action.entityKind, contracts);
  if (!contract?.execution)
    throw Object.assign(
      new Error(`Artifact kind ${String(input.action.entityKind)} has no executable import action.`),
      { code: "unsupported_command" },
    );
  const receipt = await runArtifactEntityImport({ ...input, contracts });
  return { action: { ...input.action, entityId: receipt.entityId }, contract, receipt };
}

export async function runArtifactEntityImport(input: {
  readonly rootDir: string;
  readonly repositoryId: string;
  readonly contracts: readonly CompiledArtifactKindContract[];
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  readonly authorizationDecision: AuthorizationDecision;
}): Promise<ArtifactImportReceipt> {
  const service = makeArtifactEntityService({
      contracts: input.contracts,
      resolveSource: (locator, contract) =>
        resolveArtifactSource({
          rootDir: input.rootDir,
          repositoryId: input.repositoryId,
          locator,
          contract,
        }),
      readCurrent: (kind, entityId) => readCurrentArtifact(input.store, input.contracts, kind, entityId),
      readOperation: (opId) => readEntityOperation(input.store, opId),
      countRelationChanges: (entityRef) =>
        input.projection
          .readRelationTruth()
          .edges.filter(
            ({ sourceRef, targetRef, state }) =>
              state === "active" && (sourceRef === entityRef || targetRef === entityRef),
          ).length,
    }),
    prepared = await service.prepare(
      {
        kind: requiredArtifactText(input.action.entityKind, "entityKind"),
        locator: requiredArtifactText(input.action.locator, "locator"),
        expectedVersion: Number(input.action.expectedVersion),
        ...(typeof input.action.title === "string" ? { title: input.action.title } : {}),
        ...(typeof input.action.entityId === "string" ? { entityId: input.action.entityId } : {}),
        ...(typeof input.action.sourceIdentity === "string" ? { sourceIdentity: input.action.sourceIdentity } : {}),
        ...(input.action.dryRun === true ? { dryRun: true } : {}),
      },
      {
        actor: input.binding.actor,
        source: input.binding.source,
        occurredAt: input.now(),
        workspaceRevision: (input.store.readHead()?.revision ?? 0) + 1,
      },
    );
  if (input.action.dryRun === true) return previewReceipt(prepared.preview, input);
  if (prepared.replay) return artifactReplayReceipt(prepared.replay, prepared.preview, input.authorizationDecision);
  const appended = input.store.append(prepared.bundle);
  input.projection.apply(prepared.bundle.event, prepared.bundle.plan);
  const applied = input.projection.readOperation(prepared.bundle.event.opId),
    visible = !!applied && applied.watermark >= prepared.bundle.event.workspaceRevision,
    base = {
      opId: prepared.bundle.event.opId,
      revision: appended.revision,
      entityId: prepared.preview.entityId,
      evidence: JSON.stringify({
        schema: "artifact-entity-import-result/v1",
        preview: prepared.preview,
        dryRun: false,
        commitSha: appended.commitSha?.sha ?? null,
      }),
      visibility: "center" as const,
      proof: {
        committedRevision: appended.revision,
        appliedCut: applied?.watermark ?? 0,
        durable: true,
        canonicalVisible: visible,
        worktreeVisible: prepared.bundle.event.type === "entity_content_observed",
      },
      authorizationDecision: input.authorizationDecision,
      commitSha: appended.commitSha?.sha ?? null,
      cut: appended.cut,
    };
  return visible
    ? { outcome: "applied", ...base }
    : {
        outcome: "pending",
        ...base,
      };
}

async function resolveArtifactSource(input: {
  readonly rootDir: string;
  readonly repositoryId: string;
  readonly locator: Parameters<Parameters<typeof makeArtifactEntityService>[0]["resolveSource"]>[0];
  readonly contract: CompiledArtifactKindContract;
}): Promise<ArtifactSourceResolution> {
  const locator = input.locator;
  if (locator.kind === "repository-path") {
    const relative = normalizeRelativeDocumentPath(locator.value),
      target = path.resolve(input.rootDir, relative),
      rootPrefix = `${path.resolve(input.rootDir)}${path.sep}`,
      source = { kind: "repository-path" as const, repositoryId: input.repositoryId, path: relative };
    if (!target.startsWith(rootPrefix)) throw new Error(`Repository locator ${relative} escapes the repository root.`);
    if (!existsSync(target))
      return {
        status: "missing",
        source,
        reason: "ENOENT",
        resolver: `repository:${input.repositoryId}`,
      };
    const content = readFileSync(target);
    return {
      status: "observed",
      source,
      witness: { kind: "content", content },
      title: titleFromContent(content, relative),
      resolver: `repository:${input.repositoryId}`,
    };
  }
  if (locator.kind === "url") {
    const response = await fetch(locator.value, { redirect: "follow" }),
      source = { kind: "url" as const, url: locator.value };
    const code = response.status;
    if (code === 404 || code === 410) return { status: "missing", source, reason: `HTTP ${code}`, resolver: "http" };
    if (!response.ok) throw new Error(`URL resolver returned HTTP ${response.status}.`);
    const content = new Uint8Array(await response.arrayBuffer());
    return {
      status: "observed",
      source,
      witness: { kind: "content", content },
      title: path.basename(new URL(locator.value).pathname) || new URL(locator.value).hostname,
      resolver: "http",
    };
  }
  throw new ArtifactEntityServiceError(
    "source_resolution_failed",
    `No external-key resolver is installed for ${input.contract.typeIdentity}.`,
  );
}

function readCurrentArtifact(
  store: CanonicalEventStore,
  contracts: readonly CompiledArtifactKindContract[],
  kind: string,
  entityId: string,
): ArtifactEntityCurrent | null {
  const contract = contracts.find(({ typeIdentity }) => typeIdentity === kind);
  if (!contract) return null;
  let revision = 0,
    descriptor: ReturnType<typeof readArtifactDescriptor> | null = null;
  for (const event of store.read().events) {
    if (!isEntityEvent(event) || event.payload.entityKind !== kind || event.payload.entityId !== entityId) continue;
    revision = Math.max(revision, event.workspaceRevision);
    if (!isEntityDeclarationEvent(event) || event.type !== "entity_content_observed") continue;
    const claim = event.payload.declarationDocumentClaim,
      bytes = store.readContentBlob(claim.sha256);
    if (!bytes) throw new Error(`Artifact descriptor blob ${claim.sha256} is unavailable.`);
    descriptor = readArtifactDescriptor(contract, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  }
  return revision === 0 ? null : { descriptor, revision };
}

function readEntityOperation(store: CanonicalEventStore, opId: string): EntityEventV1 | null {
  const event = store.readEvent(opId);
  if (event === null) return null;
  if (!isEntityEvent(event) || event.schema !== "entity-event/v1")
    throw new ArtifactEntityServiceError("invalid_command", `Operation id ${opId} belongs to another event.`);
  return event;
}

function previewReceipt(
  preview: Awaited<ReturnType<ReturnType<typeof makeArtifactEntityService>["prepare"]>>["preview"],
  input: Pick<Parameters<typeof runArtifactEntityImport>[0], "store" | "authorizationDecision">,
): ArtifactImportReceipt {
  const revision = input.store.readHead()?.revision ?? 0;
  return {
    outcome: "pending",
    opId: `preview:${preview.operationId}`,
    revision,
    entityId: preview.entityId,
    evidence: JSON.stringify(preview),
    visibility: "center",
    proof: {
      committedRevision: revision,
      appliedCut: revision,
      durable: false,
      canonicalVisible: false,
      worktreeVisible: false,
    },
    authorizationDecision: input.authorizationDecision,
    effects: [],
    updatedProjection: null,
  };
}

function artifactReplayReceipt(
  event: EntityEventV1,
  preview: Awaited<ReturnType<ReturnType<typeof makeArtifactEntityService>["prepare"]>>["preview"],
  authorizationDecision: AuthorizationDecision,
): ArtifactImportReceipt {
  return {
    outcome: "no_changes",
    opId: event.opId,
    revision: event.workspaceRevision,
    entityId: preview.entityId,
    evidence: JSON.stringify({ ...preview, idempotent: true, sameResult: true }),
    visibility: "center",
    proof: {
      committedRevision: event.workspaceRevision,
      appliedCut: event.workspaceRevision,
      durable: true,
      canonicalVisible: true,
      worktreeVisible: event.type === "entity_content_observed",
    },
    authorizationDecision,
  };
}

function titleFromContent(content: Uint8Array, relative: string): string {
  const decoded = new TextDecoder("utf-8").decode(content),
    heading = /^#\s+(.+)$/mu.exec(decoded)?.[1]?.trim();
  return heading || path.basename(relative, path.extname(relative));
}

function requiredArtifactText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new ArtifactEntityServiceError("invalid_command", `${field} is required.`);
  return value.trim();
}

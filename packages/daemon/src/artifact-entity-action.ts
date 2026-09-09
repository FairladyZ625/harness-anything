import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  ArtifactEntityServiceError,
  makeArtifactEntityService,
  readArtifactDescriptor,
  type ArtifactEntityCurrent,
  type ArtifactSourceResolution,
} from "../../application/src/index.ts";
import {
  compiledRelationDirections,
  artifactEntityContractSnapshot,
  artifactMutationOperationId,
  canonicalArtifactLocator,
  compileEntityArchived,
  compileEntityUpdated,
  compileVerticalContract,
  pinnedArtifactKindContract,
  composeCanonicalRelationDirections,
  isEntityDeclarationEvent,
  isEntityEvent,
  MAX_ENTITY_CONTENT_OBJECT_BYTES,
  normalizeRelativeDocumentPath,
  type ArtifactDescriptor,
  type AuthorizationDecision,
  type CanonicalEventStore,
  type CanonicalRelationDirection,
  type CompiledArtifactKindContract,
  type CompiledVerticalContract,
  type EntityActionContract,
  type EntityContentBlob,
  type EntityEventV1,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { requireCanonicalVerticalDeclaration, type VerticalDeclarationReader } from "./vertical-declaration-action.ts";

const compiledVerticals = new Map<string, CompiledVerticalContract>(),
  compiledDirections = new Map<string, readonly CanonicalRelationDirection[]>();
type ArtifactImportReceipt = WriteReceipt & { readonly entityId: string };

export function canonicalVertical(
  projection: VerticalDeclarationReader,
  repositoryId: string,
): {
  readonly revision: number;
  readonly contract: CompiledVerticalContract;
} {
  const { revision, definition } = requireCanonicalVerticalDeclaration(projection),
    key = `${repositoryId}\0${revision}`,
    cached = compiledVerticals.get(key);
  if (cached) return { revision, contract: cached };
  const compiled = compileVerticalContract(definition);
  compiledVerticals.set(key, compiled);
  return { revision, contract: compiled };
}

export function compiledArtifactKinds(
  projection: VerticalDeclarationReader,
  repositoryId: string,
): readonly CompiledArtifactKindContract[] {
  return canonicalVertical(projection, repositoryId).contract.artifactKinds;
}

/**
 * Resolve a caller-supplied kind name to the kind's stable ref. A kind has exactly one identity for
 * its whole life, so this never has to choose between versions, and an archived kind resolves like any
 * other: archiving stops new imports, it does not hide the material already stored under that kind.
 */
export function resolveEntityReadKind(kind: string, contracts: readonly CompiledArtifactKindContract[]): string {
  const match = contracts.find(
    ({ declaration, typeIdentity }) => typeIdentity === kind || declaration.kindId === kind || declaration.id === kind,
  );
  return match?.typeIdentity ?? kind;
}

/**
 * The registry relation writes are admitted against: kernel rows plus the governed rows the canonical
 * vertical compiled, so a kind-declared triple is writable through the same authority as a code row.
 */
export function relationDirectionRegistry(
  projection: VerticalDeclarationReader,
  repositoryId: string,
): readonly CanonicalRelationDirection[] {
  const vertical = canonicalVertical(projection, repositoryId),
    key = `${repositoryId}\0${vertical.revision}`,
    cached = compiledDirections.get(key);
  if (cached) return cached;
  const directions = composeCanonicalRelationDirections(compiledRelationDirections(vertical.contract));
  compiledDirections.set(key, directions);
  return directions;
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
  const contracts = compiledArtifactKinds(input.projection, input.repositoryId),
    contract = resolveArtifactImportAction(input.action.entityKind, contracts);
  if (!contract?.execution)
    throw Object.assign(
      new Error(`Artifact kind ${String(input.action.entityKind)} has no executable import action.`),
      { code: "unsupported_command" },
    );
  const receipt = await runArtifactEntityImport({ ...input, contracts });
  return { action: { ...input.action, entityId: receipt.entityId }, contract, receipt };
}

export function executeArtifactEntityMutation(input: {
  readonly rootDir: string;
  readonly repositoryId: string;
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  readonly authorizationDecision: AuthorizationDecision;
}): {
  readonly action: RepoTaskAction;
  readonly contract: EntityActionContract;
  readonly receipt: ArtifactImportReceipt;
} {
  const contracts = compiledArtifactKinds(input.projection, input.repositoryId),
    kind = requiredArtifactText(input.action.entityKind, "entityKind"),
    entityId = requiredArtifactText(input.action.entityId, "entityId"),
    compiled = contracts.find(({ typeIdentity }) => typeIdentity === kind),
    contract = compiled?.entityKindContract.actionCatalog?.actions.find(({ id }) => id === input.action.kind.slice(7));
  if (!compiled || !contract?.execution)
    throw Object.assign(new Error(`Artifact kind ${kind} has no executable ${input.action.kind} action.`), {
      code: "unsupported_command",
    });
  const current = readCurrentArtifact(input.store, contracts, kind, entityId),
    expectedVersion = Number(input.action.expectedVersion);
  if (!current?.descriptor)
    throw Object.assign(new Error(`Entity ${kind}/${entityId} does not exist.`), { code: "entity_not_found" });
  if (!Number.isSafeInteger(expectedVersion))
    throw Object.assign(new Error(`Entity ${entityId} expected revision ${String(expectedVersion)} is invalid.`), {
      code: "revision_conflict",
    });
  const mutation = input.action.kind === "entity-update" ? "update" : "archive",
    opId = artifactMutationOperationId({ mutation, entityId, expectedVersion }),
    replayed = readEntityOperation(input.store, opId);
  // A retry presenting the same fence replays the operation it already applied instead of tripping the CAS below.
  if (replayed) return { action: input.action, contract, receipt: mutationReplayReceipt(replayed, input) };
  if (expectedVersion !== current.revision)
    throw Object.assign(
      new Error(
        `Entity ${entityId} expected revision ${String(expectedVersion)}, current revision is ${current.revision}.`,
      ),
      { code: "revision_conflict" },
    );
  const kindVersion = current.descriptor.kindVersion,
    contractSnapshot = artifactEntityContractSnapshot({
      declaration: compiled.declaration,
      typeIdentity: compiled.typeIdentity,
      kindVersion,
    }),
    workspaceRevision = (input.store.readHead()?.revision ?? 0) + 1,
    envelope = {
      workspaceRevision,
      actor: input.binding.actor,
      source: input.binding.source,
      occurredAt: input.now(),
    },
    bundle =
      input.action.kind === "entity-update"
        ? updatedBundle(input.action, current.descriptor, compiled, contractSnapshot, { ...envelope, opId })
        : compileEntityArchived({
            ...envelope,
            eventId: `event-${opId}`,
            opId,
            contractSnapshot,
            entityId,
            reason: requiredArtifactText(input.action.reason, "reason"),
          }),
    appended = input.store.append(bundle),
    _applied = input.projection.apply(bundle.event, bundle.plan),
    applied = input.projection.readOperation(bundle.event.opId),
    visible = !!applied && applied.watermark >= bundle.event.workspaceRevision,
    receipt: ArtifactImportReceipt = {
      outcome: visible ? "applied" : "pending",
      opId: bundle.event.opId,
      revision: appended.revision,
      entityId,
      evidence: JSON.stringify({ schema: "artifact-entity-mutation-result/v1", eventType: bundle.event.type }),
      visibility: "center",
      proof: {
        committedRevision: appended.revision,
        appliedCut: applied?.watermark ?? 0,
        durable: true,
        canonicalVisible: visible,
        worktreeVisible: bundle.event.type === "entity_updated",
      },
      authorizationDecision: input.authorizationDecision,
      commitSha: appended.commitSha?.sha ?? null,
      cut: appended.cut,
      ...(visible ? {} : { guidance: [{ kind: "retry-receipt", args: { opId: bundle.event.opId } }] }),
    };
  return { action: input.action, contract, receipt };
}

function updatedBundle(
  action: RepoTaskAction,
  current: NonNullable<ArtifactEntityCurrent["descriptor"]>,
  compiled: CompiledArtifactKindContract,
  contractSnapshot: ReturnType<typeof artifactEntityContractSnapshot>,
  envelope: {
    readonly opId: string;
    readonly workspaceRevision: number;
    readonly actor: RepoCellBinding["actor"];
    readonly source: RepoCellBinding["source"];
    readonly occurredAt: string;
  },
) {
  const locator =
      typeof action.locator === "string"
        ? canonicalArtifactLocator({ kind: current.locator.kind, value: action.locator })
        : current.locator,
    contentVersion = typeof action.contentVersion === "string" ? action.contentVersion.trim() : current.contentVersion;
  // The instance keeps the schema version it was accepted against; an update states values, never a
  // new interpretation of them.
  return compileEntityUpdated({
    ...envelope,
    eventId: `event-${envelope.opId}`,
    contract: pinnedArtifactKindContract(compiled, current.kindVersion) as Parameters<
      typeof compileEntityUpdated
    >[0]["contract"],
    contractSnapshot,
    descriptor: {
      ...current,
      locator,
      contentVersion,
      ...(typeof action.title === "string" ? { title: action.title.trim() } : {}),
      // Stated attributes go to the pinned schema as they arrive; it is the one place that decides
      // whether a value is admissible, so a malformed input is refused instead of quietly dropped.
      ...(action.attributes === undefined ? {} : { attributes: action.attributes as ArtifactDescriptor["attributes"] }),
    },
  });
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
        ...(input.action.attributes === undefined
          ? {}
          : { attributes: input.action.attributes as ArtifactDescriptor["attributes"] }),
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
    if (statSync(target).isDirectory()) {
      const readme = path.join(target, "README.md"),
        directory = directoryContent(target);
      return {
        status: "observed",
        source,
        witness: { kind: "content", content: directory.fingerprint },
        content: directory.objects,
        title:
          existsSync(readme) && statSync(readme).isFile()
            ? titleFromContent(readFileSync(readme), relative)
            : path.basename(relative),
        resolver: `repository:${input.repositoryId}`,
      };
    }
    const content = readSourceObject(target, path.basename(relative));
    return {
      status: "observed",
      source,
      witness: { kind: "content", content: content.body },
      content: [content],
      title: titleFromContent(content.body, relative),
      resolver: `repository:${input.repositoryId}`,
    };
  }
  if (locator.kind === "url") {
    const response = await fetch(locator.value, { redirect: "follow" }),
      source = { kind: "url" as const, url: locator.value };
    const code = response.status;
    if (code === 404 || code === 410) return { status: "missing", source, reason: `HTTP ${code}`, resolver: "http" };
    if (!response.ok) throw new Error(`URL resolver returned HTTP ${response.status}.`);
    const content = new Uint8Array(await response.arrayBuffer()),
      name = path.basename(new URL(locator.value).pathname) || new URL(locator.value).hostname;
    return {
      status: "observed",
      source,
      witness: { kind: "content", content },
      content: [sourceObject(name, content)],
      title: name,
      resolver: "http",
    };
  }
  throw new ArtifactEntityServiceError(
    "source_resolution_failed",
    `No external-key resolver is installed for ${input.contract.typeIdentity}.`,
  );
}

const SYSTEM_DIRECTORY_ENTRIES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]),
  ENTITY_CONTENT_POLICY_ID = "entity-content/v1";

function directoryContent(root: string): {
  readonly fingerprint: string;
  readonly objects: readonly EntityContentBlob[];
} {
  const objects: EntityContentBlob[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SYSTEM_DIRECTORY_ENTRIES.has(entry.name) || entry.name.startsWith("._")) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile())
        objects.push(readSourceObject(target, path.relative(root, target).split(path.sep).join("/")));
      else throw new Error(`Directory artifact entry ${target} is neither a file nor a directory.`);
    }
  }
  visit(root);
  objects.sort((left, right) =>
    Buffer.compare(Buffer.from(left.relativePath, "utf8"), Buffer.from(right.relativePath, "utf8")),
  );
  return {
    fingerprint: objects.map(({ relativePath, sha256 }) => `${sha256}  ${JSON.stringify(relativePath)}`).join("\n"),
    objects,
  };
}

function readSourceObject(target: string, relativePath: string): EntityContentBlob {
  const size = statSync(target).size;
  // Refusing before the read keeps an oversized source from being paged into the center at all; the whole
  // snapshot is rejected rather than silently landing without one of its files.
  if (size > MAX_ENTITY_CONTENT_OBJECT_BYTES)
    throw new ArtifactEntityServiceError(
      "invalid_command",
      `Source object ${relativePath} is ${size} bytes, above the ${MAX_ENTITY_CONTENT_OBJECT_BYTES}-byte per-file limit.`,
    );
  return sourceObject(relativePath, readFileSync(target));
}

function sourceObject(relativePath: string, body: Uint8Array): EntityContentBlob {
  return {
    relativePath: normalizeRelativeDocumentPath(relativePath),
    sha256: createHash("sha256").update(body).digest("hex"),
    size: body.byteLength,
    // Raw bytes are the artifact. The center records what it holds and how long it is, and leaves
    // interpretation to whoever reads it, so no kind ever needs a media-type branch here.
    mediaType: "application/octet-stream",
    policyId: ENTITY_CONTENT_POLICY_ID,
    body,
  };
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
    // Both observations and descriptor updates carry the full descriptor blob; folding only observations would make
    // every later update start from a stale descriptor and silently drop the previous update.
    if (
      !isEntityDeclarationEvent(event) ||
      (event.type !== "entity_content_observed" && event.type !== "entity_updated")
    )
      continue;
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

function mutationReplayReceipt(
  event: EntityEventV1,
  input: { readonly authorizationDecision: AuthorizationDecision },
): ArtifactImportReceipt {
  return {
    outcome: "no_changes",
    opId: event.opId,
    revision: event.workspaceRevision,
    entityId: event.payload.entityId,
    evidence: JSON.stringify({
      schema: "artifact-entity-mutation-result/v1",
      eventType: event.type,
      idempotent: true,
      sameResult: true,
    }),
    visibility: "center",
    proof: {
      committedRevision: event.workspaceRevision,
      appliedCut: event.workspaceRevision,
      durable: true,
      canonicalVisible: true,
      worktreeVisible: event.type === "entity_updated",
    },
    authorizationDecision: input.authorizationDecision,
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

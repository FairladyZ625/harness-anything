import { createHash, randomBytes } from "node:crypto";
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
  compileEntityDeleted,
  compileEntityUpdated,
  compileVerticalContract,
  pinnedArtifactKindContract,
  composeCanonicalRelationDirections,
  ARTIFACT_ENTITY_ID_BYTES,
  entityContentRoot,
  entityDirectoryFootprint,
  isEntityDeclarationEvent,
  isEntityEvent,
  MAX_ENTITY_CONTENT_OBJECT_BYTES,
  ownedContentForDeclarationEvent,
  normalizeRelativeDocumentPath,
  type ArtifactDescriptor,
  type AuthorizationDecision,
  type CanonicalEventStore,
  type CanonicalEventV1,
  type CanonicalRelationDirection,
  type CompiledArtifactKindContract,
  type CompiledVerticalContract,
  type EntityActionContract,
  type EntityContentBlob,
  type EntityEventV1,
  type EntityOwnedContentV1,
  type EntityStoreKindContract,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { requireCanonicalVerticalDeclaration, type VerticalDeclarationReader } from "./vertical-declaration-action.ts";

const compiledVerticals = new Map<string, CompiledVerticalContract>(),
  compiledDirections = new Map<string, readonly CanonicalRelationDirection[]>();
/** `entityId` is null only for a dry run of material the center has never accepted; nothing is minted then. */
type ArtifactImportReceipt = WriteReceipt & { readonly entityId: string | null };

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
  return { action: { ...input.action, entityId: receipt.entityId ?? undefined }, contract, receipt };
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
  if (!Number.isSafeInteger(expectedVersion))
    throw new ArtifactEntityServiceError(
      "revision_conflict",
      `Entity ${entityId} expected revision ${String(expectedVersion)} is invalid.`,
    );
  const mutation =
      input.action.kind === "entity-update" ? "update" : input.action.kind === "entity-delete" ? "delete" : "archive",
    opId = artifactMutationOperationId({ mutation, entityId, expectedVersion, request: input.action }),
    replayed = readEntityOperation(input.store, opId);
  // Only the same stated intent at the same fence replays; a competing payload must reach the CAS below.
  if (replayed) return { action: input.action, contract, receipt: mutationReplayReceipt(replayed, input) };
  if (!current?.descriptor)
    throw Object.assign(new Error(`Entity ${kind}/${entityId} does not exist.`), { code: "entity_not_found" });
  if (expectedVersion !== current.revision)
    throw new ArtifactEntityServiceError(
      "revision_conflict",
      `Entity ${entityId} expected revision ${String(expectedVersion)}, current revision is ${current.revision}.`,
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
    pinned = pinnedArtifactKindContract(compiled, kindVersion) as unknown as EntityStoreKindContract,
    bundle =
      input.action.kind === "entity-update"
        ? updatedBundle(
            input.action,
            current.descriptor,
            compiled,
            contractSnapshot,
            { ...envelope, opId },
            carriedContent(input.store, pinned, entityId, current.ownedContent),
            carriedDirectories(pinned, entityId, current.ownedContent),
            entityDirectoryFootprint(entityContentRoot(pinned, entityId), current.ownedContent),
          )
        : input.action.kind === "entity-delete"
          ? compileEntityDeleted({
              ...envelope,
              eventId: `event-${opId}`,
              opId,
              contract: pinned,
              entityKind: kind,
              entityId,
              // Every path the entity still binds is retired together; leaving its imported bytes on disk
              // would strand files no event owns any more.
              baseBlobSha256: declarationRetirement(pinned, entityId, current.ownedContent),
              contentRetirements: (current.ownedContent?.bindings ?? []).map(({ path, contentSha256 }) => ({
                path,
                baseBlobSha256: contentSha256,
              })),
              // The directories go with the files, and only the ones the accepted manifest says the entity held:
              // a directory the user made inside the content root was never the entity's and is not named here.
              heldDirectories: entityDirectoryFootprint(entityContentRoot(pinned, entityId), current.ownedContent),
              reason: requiredArtifactText(input.action.reason, "reason"),
            })
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
        worktreeVisible: bundle.event.type === "entity_updated" || bundle.event.type === "entity_deleted",
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
  carried: readonly EntityContentBlob[],
  carriedDirectories: readonly string[],
  heldDirectories: readonly string[],
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
    // An update states values, not a new snapshot of the source: the content the entity already owns is
    // restated unchanged, so renaming or re-pointing an entity never drops the bytes it holds.
    sourceContent: carried,
    // An empty directory is only in the manifest because nothing else can hold it; an update that failed to
    // restate it would be un-declaring a directory the caller never asked to give up.
    sourceDirectories: carriedDirectories,
    // What the entity held before, so anything that falls out of the restated manifest is retired by name.
    heldDirectories,
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
      resolveSourceBinding: (kind, sourceIdentity) => resolveSourceBinding(input.store, kind, sourceIdentity),
      randomEntityIdBytes: () => randomBytes(ARTIFACT_ENTITY_ID_BYTES),
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
  if (!prepared.bundle) throw new ArtifactEntityServiceError("invalid_command", "Import produced no write bundle.");
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
        directories: directory.emptyDirectories,
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

/**
 * A directory source is its files plus the directories that hold none. Git has no empty-tree entry, so an
 * empty directory that is not stated here disappears on the next rebuild; the fingerprint covers both, which
 * is what makes adding or emptying a directory a real content change rather than a silent one.
 */
function directoryContent(root: string): {
  readonly fingerprint: string;
  readonly objects: readonly EntityContentBlob[];
  readonly emptyDirectories: readonly string[];
} {
  const objects: EntityContentBlob[] = [],
    emptyDirectories: string[] = [];
  // Only a directory with no surviving entry at all is stated: a directory that holds one is already implied
  // by whatever it holds, and materializing the deeper path creates it on the way.
  function visit(directory: string): boolean {
    let held = false;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SYSTEM_DIRECTORY_ENTRIES.has(entry.name) || entry.name.startsWith("._")) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile())
        objects.push(readSourceObject(target, path.relative(root, target).split(path.sep).join("/")));
      else throw new Error(`Directory artifact entry ${target} is neither a file nor a directory.`);
      held = true;
    }
    if (!held && directory !== root)
      emptyDirectories.push(normalizeRelativeDocumentPath(path.relative(root, directory).split(path.sep).join("/")));
    return held;
  }
  visit(root);
  objects.sort((left, right) =>
    Buffer.compare(Buffer.from(left.relativePath, "utf8"), Buffer.from(right.relativePath, "utf8")),
  );
  emptyDirectories.sort();
  return {
    fingerprint: [
      ...objects.map(({ relativePath, sha256 }) => `${sha256}  ${JSON.stringify(relativePath)}`),
      ...emptyDirectories.map((relativePath) => `directory  ${JSON.stringify(relativePath)}`),
    ].join("\n"),
    objects,
    emptyDirectories,
  };
}

function readSourceObject(target: string, relativePath: string): EntityContentBlob {
  const size = statSync(target).size;
  // Refusing before the read keeps an oversized source from being paged into the center at all; the whole
  // snapshot is rejected rather than silently landing without one of its files.
  const limit = MAX_ENTITY_CONTENT_OBJECT_BYTES;
  if (size > limit)
    throw new ArtifactEntityServiceError(
      "invalid_command",
      `Source object ${relativePath} is ${size} bytes, above the ${limit}-byte per-file limit.`,
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

/**
 * What one entity is, and what it owns, at the canonical cut — folded from the accepted events themselves.
 * Reads share this with the write path so nothing ever grows a second answer to the same question.
 */
export function readCurrentArtifact(
  store: CanonicalEventStore,
  contracts: readonly CompiledArtifactKindContract[],
  kind: string,
  entityId: string,
): (ArtifactEntityCurrent & { readonly ownedContent: EntityOwnedContentV1 | null }) | null {
  const contract = contracts.find(({ typeIdentity }) => typeIdentity === kind);
  if (!contract) return null;
  const state = artifactEntityFold(store).entities.get(`${kind}\0${entityId}`);
  if (!state) return null;
  // The descriptor is decoded on the way out instead of being held in the fold: one blob read answers the entity
  // that was actually asked for, so an unreadable blob stays an error about that entity, and the fold never has
  // to be rebuilt because the reader is holding a different compiled contract than the one that filled it.
  const descriptor =
      state.declarationClaimSha === null
        ? null
        : readArtifactDescriptor(contract, artifactDeclarationDocument(store, state.declarationClaimSha)),
    ownedContent = state.ownedContent,
    pinned = pinnedArtifactKindContract(
      contract,
      descriptor?.kindVersion ?? contract.latestVersion,
    ) as unknown as EntityStoreKindContract;
  return {
    descriptor,
    revision: state.revision,
    ownedContent,
    ownedDirectories: entityDirectoryFootprint(entityContentRoot(pinned, entityId), ownedContent),
    ownedPaths: (ownedContent?.bindings ?? []).map(({ path: bound, contentSha256 }) => ({
      path: bound,
      sha256: contentSha256,
    })),
  };
}

function artifactDeclarationDocument(store: CanonicalEventStore, sha256: string): unknown {
  const bytes = store.readContentBlob(sha256);
  if (!bytes) throw new Error(`Artifact descriptor blob ${sha256} is unavailable.`);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** One entity as the accepted events left it, including the tombstone a delete leaves behind. */
interface ArtifactEntityFoldState {
  readonly revision: number;
  readonly declarationClaimSha: string | null;
  readonly ownedContent: EntityOwnedContentV1 | null;
}

interface ArtifactEntityFold {
  /** The ledger revision this fold has already consumed. */
  cut: number;
  /** Which ledger it was folded from, so a fold can never answer for a repository it was not built from. */
  readonly ledger: string;
  /** `entityKind\0entityId` to that entity's current shape. */
  readonly entities: Map<string, ArtifactEntityFoldState>;
  /** `entityKind\0entityId` to the source identity that entity is bound to right now. */
  readonly boundSource: Map<string, string>;
  /** `entityKind\0sourceIdentity` to how many bindings on that source have already ended. */
  readonly releases: Map<string, number>;
}

const ARTIFACT_FOLD_BATCH = 4096,
  artifactEntityFolds = new WeakMap<CanonicalEventStore, ArtifactEntityFold>();

/**
 * The entity state a read needs, folded once and then only moved forward. The accepted cut comes from the
 * ledger's own metadata row rather than from the event stream, so a read at a cut this store has already folded
 * loads no events at all, and a read one acceptance later loads that one event instead of the whole history.
 * The fold belongs to a single store, and states which ledger it was built from, so it can neither be reused
 * across repositories nor survive the ledger underneath it being replaced.
 */
function artifactEntityFold(store: CanonicalEventStore): ArtifactEntityFold {
  const metadata = store.ledgerMetadata(),
    ledger = `${metadata.repoId}\0${String(metadata.generation)}`;
  let fold = artifactEntityFolds.get(store);
  // A different ledger, or one whose revision moved backwards, is not the history this fold was built from, so it
  // is dropped rather than patched: the answer has to come from the events that are actually there now.
  if (!fold || fold.ledger !== ledger || fold.cut > metadata.revision) {
    fold = { cut: 0, ledger, entities: new Map(), boundSource: new Map(), releases: new Map() };
    artifactEntityFolds.set(store, fold);
  }
  while (fold.cut < metadata.revision) {
    const batch = store.readBatch(String(fold.cut), ARTIFACT_FOLD_BATCH);
    if (batch.events.length === 0) break;
    for (const event of batch.events) foldArtifactEntityEvent(fold, event);
    fold.cut = batch.events.at(-1)!.workspaceRevision;
  }
  return fold;
}

function foldArtifactEntityEvent(fold: ArtifactEntityFold, event: CanonicalEventV1): void {
  if (!isEntityEvent(event)) return;
  const entityKey = `${event.payload.entityKind}\0${event.payload.entityId}`,
    boundBefore = fold.boundSource.get(entityKey),
    before = fold.entities.get(entityKey),
    // Every entity event moves the entity's revision, because the fence the next command has to present is the
    // last accepted event of any type, not the last one that carried a descriptor.
    revision = Math.max(before?.revision ?? 0, event.workspaceRevision);
  if (event.type === "entity_deleted") {
    // A delete releases the source so re-importing that path mints a new instance instead of resurrecting the
    // old one, and leaves the entity behind without a descriptor rather than removing what it was deleted at.
    if (boundBefore !== undefined) releaseArtifactSource(fold, event.payload.entityKind, boundBefore);
    fold.boundSource.delete(entityKey);
    fold.entities.set(entityKey, { revision, declarationClaimSha: null, ownedContent: null });
    return;
  }
  if ("sourceIdentity" in event.payload) {
    const bound = String(event.payload.sourceIdentity);
    if (boundBefore !== undefined && boundBefore !== bound)
      releaseArtifactSource(fold, event.payload.entityKind, boundBefore);
    fold.boundSource.set(entityKey, bound);
  }
  // Both observations and descriptor updates carry the full descriptor blob; folding only observations would make
  // every later update start from a stale descriptor and silently drop the previous update.
  if (isEntityDeclarationEvent(event) && (event.type === "entity_content_observed" || event.type === "entity_updated"))
    fold.entities.set(entityKey, {
      revision,
      declarationClaimSha: event.payload.declarationDocumentClaim.sha256,
      ownedContent: ownedContentForDeclarationEvent(event),
    });
  else
    fold.entities.set(entityKey, {
      revision,
      declarationClaimSha: before?.declarationClaimSha ?? null,
      ownedContent: before?.ownedContent ?? null,
    });
}

function releaseArtifactSource(fold: ArtifactEntityFold, entityKind: string, sourceIdentity: string): void {
  const key = `${entityKind}\0${sourceIdentity}`;
  fold.releases.set(key, (fold.releases.get(key) ?? 0) + 1);
}

/**
 * Which entity a source is bound to, read from the accepted events rather than recomputed from the path, and how
 * many times that binding has already ended. A rebind moves the binding with the entity and a deleted entity
 * releases its source, so re-importing that path mints a new instance instead of resurrecting the old one; the
 * release count is what tells the import it is starting a new binding, so it does not replay the receipt of the
 * import that the release ended. Only accepted lifecycle events move it — nothing here counts globally.
 */
export function resolveSourceBinding(
  store: CanonicalEventStore,
  kind: string,
  sourceIdentity: string,
): { readonly entityId: string | null; readonly generation: number } {
  const fold = artifactEntityFold(store),
    prefix = `${kind}\0`,
    generation = fold.releases.get(`${prefix}${sourceIdentity}`) ?? 0;
  for (const [entityKey, bound] of fold.boundSource)
    if (bound === sourceIdentity && entityKey.startsWith(prefix))
      return { entityId: entityKey.slice(prefix.length), generation };
  return { entityId: null, generation };
}

/** The content objects an entity already owns, restated from the ledger so an update carries them forward. */
function carriedContent(
  store: CanonicalEventStore,
  contract: EntityStoreKindContract,
  entityId: string,
  ownedContent: EntityOwnedContentV1 | null,
): readonly EntityContentBlob[] {
  if (!ownedContent) return [];
  const root = `${entityContentRoot(contract, entityId)}/`,
    sizes = new Map(ownedContent.content.map((entry) => [entry.sha256, entry]));
  return ownedContent.bindings.flatMap(({ path: bound, contentSha256, policyId }) => {
    if (!bound.startsWith(root)) return [];
    const bytes = store.readContentBlob(contentSha256),
      object = sizes.get(contentSha256);
    if (!bytes || !object) throw new Error(`Entity content object ${contentSha256} is unavailable.`);
    return [
      {
        relativePath: bound.slice(root.length),
        sha256: contentSha256,
        size: object.byteLength,
        mediaType: object.mediaType,
        policyId,
        body: bytes,
      },
    ];
  });
}

/** The empty directories an entity already holds, restated relative to its content root so an update keeps them. */
function carriedDirectories(
  contract: EntityStoreKindContract,
  entityId: string,
  ownedContent: EntityOwnedContentV1 | null,
): readonly string[] {
  if (!ownedContent) return [];
  const root = `${entityContentRoot(contract, entityId)}/`;
  return ownedContent.directories.flatMap(({ path: held }) => (held.startsWith(root) ? [held.slice(root.length)] : []));
}

function declarationRetirement(
  contract: EntityStoreKindContract,
  entityId: string,
  ownedContent: EntityOwnedContentV1 | null,
): string {
  const root = `${entityContentRoot(contract, entityId)}/`,
    declaration = (ownedContent?.bindings ?? []).find(({ path: bound }) => !bound.startsWith(root));
  if (!declaration) throw new Error(`Entity ${entityId} has no accepted declaration document to retire.`);
  return declaration.contentSha256;
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
    code: "no_changes",
    origin: "daemon",
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
    code: "no_changes",
    origin: "daemon",
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

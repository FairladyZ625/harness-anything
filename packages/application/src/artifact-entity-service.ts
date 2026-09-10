import {
  artifactEntityContractSnapshot,
  artifactImportOperationId,
  importBindingGeneration,
  artifactObservationId,
  canonicalArtifactLocator,
  canonicalSourceIdentity,
  compileEntityContentObserved,
  compileEntityTargetMissing,
  decodeArtifactDescriptor,
  deriveArtifactContentVersion,
  isArtifactEntityId,
  mintArtifactEntityId,
  ARTIFACT_ENTITY_ID_BYTES,
  pinnedArtifactKindContract,
  type ActorIdentity,
  type ArtifactAttributeValue,
  type ArtifactContentWitness,
  type ArtifactDescriptor,
  type ArtifactLocator,
  type ArtifactSourceIdentityInput,
  type CompiledArtifactKindContract,
  type EntityContentBlob,
  type EntityContentObservedBundle,
  type EntityEventV1,
  type EntityTargetMissingBundle,
  type WriteSource,
} from "../../kernel/src/index.ts";

export interface ArtifactSourceObserved {
  readonly status: "observed";
  readonly source: ArtifactSourceIdentityInput;
  readonly witness: ArtifactContentWitness;
  readonly title: string;
  readonly resolver: string;
  /** Raw source objects the center takes ownership of, already addressed by their own bytes. */
  readonly content?: readonly EntityContentBlob[];
  /** Directories the source holds that contain no file; Git cannot carry them, the manifest can. */
  readonly directories?: readonly string[];
}

export interface ArtifactSourceMissing {
  readonly status: "missing";
  readonly source: ArtifactSourceIdentityInput;
  readonly reason: string;
  readonly resolver: string;
}

export type ArtifactSourceResolution = ArtifactSourceObserved | ArtifactSourceMissing;

export interface ArtifactEntityImportRequest {
  readonly kind: string;
  readonly locator: string;
  readonly expectedVersion: number;
  readonly title?: string;
  /** Explicit relink pins the original source identity while changing only the locator. */
  readonly entityId?: string;
  readonly sourceIdentity?: string;
  /** Pure values, admitted by the kind schema version this instance is pinned to. */
  readonly attributes?: Readonly<Record<string, ArtifactAttributeValue>>;
  readonly dryRun?: boolean;
}

export interface ArtifactEntityCurrent {
  readonly descriptor: ArtifactDescriptor | null;
  readonly revision: number;
  /** Every path the entity's latest accepted manifest binds, so a snapshot that drops one can retire it. */
  readonly ownedPaths?: readonly { readonly path: string; readonly sha256: string }[];
  /**
   * Every directory that manifest holds. A file retirement can name itself because a file was a claim; a
   * directory was not, so a snapshot that stops needing one can only retire it by having been told what the
   * entity held. Anything absent from this list was never the entity's, whatever the worktree looks like.
   */
  readonly ownedDirectories?: readonly string[];
}

export interface ArtifactEntityImportPreview {
  readonly schema: "artifact-entity-import-preview/v1";
  /** `null` on a dry run of material the center has never accepted: the instance is minted on acceptance. */
  readonly entityId: string | null;
  readonly typeIdentity: string;
  readonly kindVersion: number;
  readonly sourceIdentity: string;
  readonly locator: ArtifactLocator;
  readonly currentContentVersion: string | null;
  readonly candidateContentVersion: string | null;
  readonly relationChanges: number;
  readonly expectedVersion: number;
  readonly currentRevision: number;
  readonly artifactOwner: string | null;
  readonly eventType: EntityEventV1["type"];
  readonly operationId: string;
  readonly dryRun: boolean;
}

export interface PreparedArtifactEntityImport {
  readonly contract: CompiledArtifactKindContract;
  /** `null` only when a dry run has no identity to compile against; every accepted path carries a bundle. */
  readonly bundle: EntityContentObservedBundle | EntityTargetMissingBundle | null;
  readonly preview: ArtifactEntityImportPreview;
  readonly replay: EntityEventV1 | null;
}

export class ArtifactEntityServiceError extends Error {
  readonly code: "entity_kind_not_found" | "invalid_command" | "revision_conflict" | "source_resolution_failed";

  constructor(code: ArtifactEntityServiceError["code"], message: string) {
    super(message);
    this.name = "ArtifactEntityServiceError";
    this.code = code;
  }
}

export function makeArtifactEntityService(options: {
  readonly contracts: readonly CompiledArtifactKindContract[];
  readonly resolveSource: (
    locator: ArtifactLocator,
    contract: CompiledArtifactKindContract,
  ) => Promise<ArtifactSourceResolution>;
  readonly readCurrent: (kind: string, entityId: string) => ArtifactEntityCurrent | null;
  /**
   * Source binding is a first-class lookup, not a hash of the path: this is how a retry finds its entity, and
   * how an import that follows a released binding learns it is starting a new one rather than continuing the
   * old one.
   */
  readonly resolveSourceBinding: (
    kind: string,
    sourceIdentity: string,
  ) => { readonly entityId: string | null; readonly generation: number };
  readonly randomEntityIdBytes: () => Uint8Array;
  readonly readOperation: (opId: string) => EntityEventV1 | null;
  readonly countRelationChanges: (entityRef: string) => number;
}) {
  const prepare = async (
    request: ArtifactEntityImportRequest,
    envelope: {
      readonly actor: ActorIdentity;
      readonly source: WriteSource;
      readonly occurredAt: string;
      readonly workspaceRevision: number;
    },
  ): Promise<PreparedArtifactEntityImport> => {
    const contract = options.contracts.find(({ typeIdentity }) => typeIdentity === request.kind);
    if (!contract)
      throw new ArtifactEntityServiceError("entity_kind_not_found", `Artifact kind ${request.kind} is not compiled.`);
    if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 0)
      throw new ArtifactEntityServiceError("invalid_command", "expectedVersion must be a non-negative integer.");
    const locator = resolveLocator(request.locator, contract),
      resolution = await resolveAuthoritatively(options.resolveSource, locator, contract),
      resolvedSourceIdentity = canonicalSourceIdentity(resolution.source),
      sourceIdentity = request.sourceIdentity ?? resolvedSourceIdentity;
    if (request.sourceIdentity && !request.entityId)
      throw new ArtifactEntityServiceError(
        "invalid_command",
        "Explicit sourceIdentity is only valid for relink and requires entityId.",
      );
    if (request.entityId !== undefined && !isArtifactEntityId(contract.declaration.idPrefix, request.entityId))
      throw new ArtifactEntityServiceError(
        "invalid_command",
        `Entity identity ${request.entityId} is not a ${contract.declaration.idPrefix} identity.`,
      );
    const candidateContentVersion =
        resolution.status === "observed" ? deriveArtifactContentVersion(resolution.witness) : null,
      resolutionWitness = resolution.status === "observed" ? candidateContentVersion! : `missing:${resolution.reason}`,
      binding = options.resolveSourceBinding(contract.typeIdentity, sourceIdentity),
      // The operation names the intent, so the same request always lands on the same operation even before any
      // identity exists. Only after that lookup fails is a new instance minted. The intent is scoped to the
      // generation of the source binding, so re-importing a source whose entity was deleted is a new operation
      // instead of a replay of a receipt for an entity that is gone.
      opId = artifactImportOperationId({
        // The Kind the caller presented, so one source observed by two Kinds is two intents.
        entityKind: contract.typeIdentity,
        sourceIdentity,
        locator,
        resolution: resolutionWitness,
        bindingGeneration: binding.generation,
      });
    if (importBindingGeneration(opId) !== binding.generation)
      throw new ArtifactEntityServiceError("invalid_command", `Operation ${opId} has an invalid binding generation.`);
    const replay = options.readOperation(opId),
      // Identity is minted once and then only looked up: a caller that names the entity is re-pointing that
      // exact instance, an accepted operation already carries the identity it minted, and the source binding
      // decides whether an unnamed import continues an existing entity or starts a new one. A dry run does not
      // mint, because an identity that no event will ever carry is a prediction, not an identity.
      resolvedEntityId = request.entityId ?? binding.entityId ?? (replay ? replay.payload.entityId : null),
      entityId =
        resolvedEntityId ??
        (request.dryRun === true
          ? null
          : mintArtifactEntityId({
              idPrefix: contract.declaration.idPrefix,
              randomBytes: mintedBytes(options.randomEntityIdBytes()),
            })),
      current = entityId === null ? null : options.readCurrent(contract.typeIdentity, entityId),
      observationId =
        entityId === null ? null : artifactObservationId({ entityId, locator, resolution: resolutionWitness });
    if (
      replay &&
      (observationId === null || !isMatchingReplay(replay, contract.typeIdentity, entityId!, observationId))
    )
      throw new ArtifactEntityServiceError("invalid_command", `Operation ${opId} is not the requested observation.`);
    if (!replay && request.expectedVersion !== (current?.revision ?? 0))
      throw new ArtifactEntityServiceError(
        "revision_conflict",
        `Entity ${String(entityId)} expected revision ${request.expectedVersion}, ` +
          `current revision is ${current?.revision ?? 0}.`,
      );
    if (request.entityId !== undefined && current === null)
      throw new ArtifactEntityServiceError("invalid_command", `Entity ${String(entityId)} does not exist to re-point.`);
    // A new instance pins the kind's newest published version; an existing one keeps the version it was
    // accepted against, so publishing version 2 never silently reinterprets material already in the ledger.
    const kindVersion = current?.descriptor?.kindVersion ?? contract.latestVersion,
      pinnedContract = pinnedArtifactKindContract(contract, kindVersion),
      attributes = request.attributes ?? current?.descriptor?.attributes ?? {},
      contractSnapshot = artifactEntityContractSnapshot({
        declaration: contract.declaration,
        typeIdentity: contract.typeIdentity,
        kindVersion,
      }),
      eventInput = {
        eventId: `event-${String(observationId)}`,
        opId,
        workspaceRevision: envelope.workspaceRevision,
        actor: envelope.actor,
        source: envelope.source,
        occurredAt: envelope.occurredAt,
      },
      bundle =
        entityId === null
          ? null
          : resolution.status === "observed"
            ? compileEntityContentObserved({
                ...eventInput,
                contract: pinnedContract as Parameters<typeof compileEntityContentObserved>[0]["contract"],
                contractSnapshot,
                descriptor: {
                  schema: descriptorSchemaRef(contract),
                  typeIdentity: contract.typeIdentity,
                  kindVersion,
                  entityId: entityId!,
                  title: request.title?.trim() || resolution.title.trim(),
                  locator,
                  contentVersion: candidateContentVersion!,
                  attributes,
                  source: sourceIdentity,
                },
                resolver: resolution.resolver,
                observationId: observationId!,
                sourceContent: resolution.content,
                sourceDirectories: resolution.directories,
                // Everything the previous snapshot bound is a retirement candidate; the compiler keeps the ones
                // this snapshot still binds, so an update retires exactly the files that fell out of the source.
                retirements: (current?.ownedPaths ?? []).map(({ path, sha256 }) => ({
                  path,
                  baseBlobSha256: sha256,
                })),
                // The same rule for directories: the compiler keeps the ones this snapshot still holds and
                // retires the rest by name, so a directory nobody declared is never a candidate.
                heldDirectories: current?.ownedDirectories ?? [],
              })
            : compileEntityTargetMissing({
                ...eventInput,
                contractSnapshot,
                entityId: entityId!,
                locator,
                sourceIdentity,
                resolver: resolution.resolver,
                observationId: observationId!,
                reason: resolution.reason,
              });
    const entityRef = `${contract.typeIdentity}/${String(entityId)}`,
      preview: ArtifactEntityImportPreview = Object.freeze({
        schema: "artifact-entity-import-preview/v1",
        entityId,
        typeIdentity: contract.typeIdentity,
        kindVersion,
        sourceIdentity,
        locator,
        currentContentVersion: current?.descriptor?.contentVersion ?? null,
        candidateContentVersion,
        relationChanges: options.countRelationChanges(entityRef),
        expectedVersion: request.expectedVersion,
        currentRevision: current?.revision ?? 0,
        artifactOwner: entityId === null ? null : `entity/${entityId}/revision/${String(envelope.workspaceRevision)}`,
        eventType:
          bundle?.event.type ??
          (resolution.status === "observed" ? "entity_content_observed" : "entity_target_missing"),
        operationId: opId,
        dryRun: request.dryRun === true,
      });
    return Object.freeze({ contract, bundle, preview, replay });
  };
  return Object.freeze({ prepare });
}

function mintedBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength !== ARTIFACT_ENTITY_ID_BYTES)
    throw new ArtifactEntityServiceError(
      "invalid_command",
      `Entity identity minting needs ${ARTIFACT_ENTITY_ID_BYTES} random bytes.`,
    );
  return bytes;
}

function resolveLocator(value: string, contract: CompiledArtifactKindContract): ArtifactLocator {
  const allowed = contract.declaration.locatorKinds,
    inferred = /^https?:\/\//iu.test(value)
      ? "url"
      : allowed.includes("repository-path")
        ? "repository-path"
        : allowed.length === 1
          ? allowed[0]!
          : null;
  if (!inferred || !allowed.includes(inferred))
    throw new ArtifactEntityServiceError(
      "invalid_command",
      `Locator ${value} is ambiguous or is not allowed for ${contract.typeIdentity}.`,
    );
  try {
    return canonicalArtifactLocator({ kind: inferred, value });
  } catch (error) {
    throw new ArtifactEntityServiceError("invalid_command", error instanceof Error ? error.message : String(error));
  }
}

async function resolveAuthoritatively(
  resolver: (locator: ArtifactLocator, contract: CompiledArtifactKindContract) => Promise<ArtifactSourceResolution>,
  locator: ArtifactLocator,
  contract: CompiledArtifactKindContract,
): Promise<ArtifactSourceResolution> {
  try {
    const resolution = await resolver(locator, contract);
    if (!resolution.resolver.trim()) throw new Error("resolver identity is empty");
    if (resolution.status === "observed" && !resolution.title.trim()) throw new Error("resolved title is empty");
    if (resolution.status === "missing" && !resolution.reason.trim()) throw new Error("missing reason is empty");
    return resolution;
  } catch (error) {
    if (error instanceof ArtifactEntityServiceError) throw error;
    throw new ArtifactEntityServiceError(
      "source_resolution_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function descriptorSchemaRef(contract: CompiledArtifactKindContract): string {
  const value = contract.entityKindContract.schema.properties.schema;
  if (value.type !== "string" || typeof value.const !== "string")
    throw new ArtifactEntityServiceError("invalid_command", `${contract.typeIdentity} has no descriptor schema ref.`);
  return value.const;
}

function isMatchingReplay(event: EntityEventV1, kind: string, entityId: string, observationId: string): boolean {
  return (
    event.payload.entityKind === kind &&
    event.payload.entityId === entityId &&
    "observationId" in event.payload &&
    event.payload.observationId === observationId
  );
}

/**
 * Read a stored descriptor through the schema version it pinned, not through the kind's newest one.
 * This is what keeps an instance imported under version 1 readable after version 2 is published.
 */
export function readArtifactDescriptor(contract: CompiledArtifactKindContract, value: unknown): ArtifactDescriptor {
  const pinned =
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger((value as { kindVersion?: unknown }).kindVersion)
      ? Number((value as { readonly kindVersion: number }).kindVersion)
      : contract.latestVersion;
  return decodeArtifactDescriptor(pinnedArtifactKindContract(contract, pinned), value);
}

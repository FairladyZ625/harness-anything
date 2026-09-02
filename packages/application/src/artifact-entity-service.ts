import {
  artifactEntityContractSnapshot,
  artifactImportOperationId,
  artifactObservationId,
  canonicalArtifactLocator,
  canonicalSourceIdentity,
  compileEntityContentObserved,
  compileEntityTargetMissing,
  decodeArtifactDescriptor,
  deriveArtifactContentVersion,
  deriveArtifactEntityId,
  type ActorIdentity,
  type ArtifactContentWitness,
  type ArtifactDescriptor,
  type ArtifactLocator,
  type ArtifactSourceIdentityInput,
  type CompiledArtifactKindContract,
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
  readonly dryRun?: boolean;
}

export interface ArtifactEntityCurrent {
  readonly descriptor: ArtifactDescriptor | null;
  readonly revision: number;
}

export interface ArtifactEntityImportPreview {
  readonly schema: "artifact-entity-import-preview/v1";
  readonly entityId: string;
  readonly typeIdentity: string;
  readonly sourceIdentity: string;
  readonly locator: ArtifactLocator;
  readonly currentContentVersion: string | null;
  readonly candidateContentVersion: string | null;
  readonly relationChanges: number;
  readonly expectedVersion: number;
  readonly currentRevision: number;
  readonly artifactOwner: string;
  readonly eventType: EntityEventV1["type"];
  readonly operationId: string;
  readonly dryRun: boolean;
}

export interface PreparedArtifactEntityImport {
  readonly contract: CompiledArtifactKindContract;
  readonly bundle: EntityContentObservedBundle | EntityTargetMissingBundle;
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
    const entityId = deriveArtifactEntityId({
      idPrefix: contract.declaration.idPrefix,
      typeIdentity: contract.typeIdentity,
      sourceIdentity,
    });
    if (request.entityId && request.entityId !== entityId)
      throw new ArtifactEntityServiceError(
        "invalid_command",
        `Relink entityId ${request.entityId} does not match frozen source identity ${sourceIdentity}.`,
      );
    const current = options.readCurrent(contract.typeIdentity, entityId),
      candidateContentVersion =
        resolution.status === "observed" ? deriveArtifactContentVersion(resolution.witness) : null,
      resolutionWitness = resolution.status === "observed" ? candidateContentVersion! : `missing:${resolution.reason}`,
      observationId = artifactObservationId({ entityId, locator, resolution: resolutionWitness }),
      opId = artifactImportOperationId({ entityId, locator, resolution: resolutionWitness }),
      replay = options.readOperation(opId);
    if (replay && !isMatchingReplay(replay, contract.typeIdentity, entityId, observationId))
      throw new ArtifactEntityServiceError("invalid_command", `Operation ${opId} is not the requested observation.`);
    if (!replay && request.expectedVersion !== (current?.revision ?? 0))
      throw new ArtifactEntityServiceError(
        "revision_conflict",
        `Entity ${entityId} expected revision ${request.expectedVersion}, ` +
          `current revision is ${current?.revision ?? 0}.`,
      );
    if (current?.descriptor && current.descriptor.source !== sourceIdentity)
      throw new ArtifactEntityServiceError(
        "invalid_command",
        `Entity ${entityId} is pinned to source identity ${current.descriptor.source}.`,
      );
    const contractSnapshot = artifactEntityContractSnapshot(contract),
      eventInput = {
        eventId: `event-${observationId}`,
        opId,
        workspaceRevision: envelope.workspaceRevision,
        actor: envelope.actor,
        source: envelope.source,
        occurredAt: envelope.occurredAt,
      },
      bundle =
        resolution.status === "observed"
          ? compileEntityContentObserved({
              ...eventInput,
              contract: contract.entityKindContract as Parameters<typeof compileEntityContentObserved>[0]["contract"],
              contractSnapshot,
              descriptor: {
                schema: descriptorSchemaRef(contract),
                typeIdentity: contract.typeIdentity,
                entityId,
                title: request.title?.trim() || resolution.title.trim(),
                locator,
                contentVersion: candidateContentVersion!,
                source: sourceIdentity,
              },
              resolver: resolution.resolver,
              observationId,
            })
          : compileEntityTargetMissing({
              ...eventInput,
              contractSnapshot,
              entityId,
              locator,
              sourceIdentity,
              resolver: resolution.resolver,
              observationId,
              reason: resolution.reason,
            });
    const entityRef = `${contract.typeIdentity}/${entityId}`,
      preview: ArtifactEntityImportPreview = Object.freeze({
        schema: "artifact-entity-import-preview/v1",
        entityId,
        typeIdentity: contract.typeIdentity,
        sourceIdentity,
        locator,
        currentContentVersion: current?.descriptor?.contentVersion ?? null,
        candidateContentVersion,
        relationChanges: options.countRelationChanges(entityRef),
        expectedVersion: request.expectedVersion,
        currentRevision: current?.revision ?? 0,
        artifactOwner: `entity/${entityId}/revision/${String(envelope.workspaceRevision)}`,
        eventType: bundle.event.type,
        operationId: opId,
        dryRun: request.dryRun === true,
      });
    return Object.freeze({ contract, bundle, preview, replay });
  };
  return Object.freeze({ prepare });
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

export function readArtifactDescriptor(contract: CompiledArtifactKindContract, value: unknown): ArtifactDescriptor {
  return decodeArtifactDescriptor(contract.entityKindContract, value);
}

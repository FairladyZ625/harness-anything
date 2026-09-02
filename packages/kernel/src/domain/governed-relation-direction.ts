import { entityTypeContracts } from "./base-entity.ts";
import type { CanonicalRelationDirection } from "./relation-direction.ts";
import type { ArtifactEntityKindDefinition, ArtifactRelationDefinition } from "../schemas/vertical-definition.ts";

export interface GovernedRelationDecision {
  readonly decisionId: string;
  readonly state: string;
  readonly contentPin: `sha256:${string}`;
  readonly claimIds: readonly string[];
}

export interface GovernedRelationCompilationAuthority {
  readonly decisions: readonly GovernedRelationDecision[];
}

export interface GovernedArtifactRelationRequest {
  readonly artifactTypeIdentity: string;
  readonly declaration: ArtifactRelationDefinition;
}

/**
 * The accepted decision receipt shipped with the kernel policy it authorizes.
 * Callers compiling later governance decisions supply a fresh authority snapshot.
 */
export const canonicalGovernedRelationAuthority: GovernedRelationCompilationAuthority = Object.freeze({
  decisions: Object.freeze([
    Object.freeze({
      decisionId: "dec_29CCC98CD0241D0C9806AC1CF1",
      state: "in_effect",
      contentPin: "sha256:f8ccb58e91a8da7c67fe57d1e02e78bdb1bf1972abc721d4a542d27f5919ffdb",
      claimIds: Object.freeze(["CH1"]),
    }),
  ]),
});

export function compileGovernedRelationDirections(input: {
  readonly verticalId: string;
  readonly artifacts: readonly {
    readonly declaration: ArtifactEntityKindDefinition;
    readonly typeIdentity: string;
    readonly relationRequests: readonly GovernedArtifactRelationRequest[];
  }[];
  readonly authority?: GovernedRelationCompilationAuthority;
}): readonly CanonicalRelationDirection[] {
  const authority = input.authority ?? canonicalGovernedRelationAuthority,
    artifactsByKind = new Map<string, string>(),
    artifactTypeIdentities = new Set<string>();
  for (const artifact of input.artifacts) {
    artifactsByKind.set(artifact.declaration.id, artifact.typeIdentity);
    artifactsByKind.set(artifact.typeIdentity, artifact.typeIdentity);
    artifactTypeIdentities.add(artifact.typeIdentity);
  }
  const builtinKinds = new Set<string>(entityTypeContracts.map(({ kind }) => kind)),
    rows = new Map<string, CanonicalRelationDirection>(),
    relatesOrientations = new Map<string, CanonicalRelationDirection>();
  for (const request of input.artifacts.flatMap(({ relationRequests }) => relationRequests)) {
    const declaration = request.declaration,
      sourceKind = resolveKind(declaration.sourceKind, artifactsByKind, builtinKinds),
      targetKind = resolveKind(declaration.targetKind, artifactsByKind, builtinKinds);
    if (!sourceKind)
      invalidGovernedRelation(
        `Relation source kind ${declaration.sourceKind} is not registered for vertical ${input.verticalId}.`,
      );
    if (!targetKind)
      invalidGovernedRelation(
        `Relation target kind ${declaration.targetKind} is not registered for vertical ${input.verticalId}.`,
      );
    if (!artifactTypeIdentities.has(sourceKind) && !artifactTypeIdentities.has(targetKind)) {
      invalidGovernedRelation(
        `Relation ${sourceKind} --${declaration.type}--> ${targetKind} must include an artifact kind ` +
          `declared by vertical ${input.verticalId}.`,
      );
    }
    validateGovernedSemantics(declaration, sourceKind, targetKind);
    validateDecisionPin(declaration, authority);
    const row: CanonicalRelationDirection = Object.freeze({
        type: declaration.type,
        sourceKind,
        targetKind,
        reads: declaration.reads,
        registration: "ratified",
        strength: declaration.strength,
        governance: Object.freeze({
          decisionClaimRef: declaration.decisionClaimRef,
          decisionContentPin: declaration.decisionContentPin as `sha256:${string}`,
          ...(declaration.rationale ? { rationale: declaration.rationale } : {}),
        }),
      }),
      key = `${sourceKind}|${declaration.type}|${targetKind}`,
      previous = rows.get(key);
    if (previous) {
      if (!sameGovernance(previous, row)) {
        invalidGovernedRelation(
          `Duplicate relation triple ${key} has conflicting reads, strength, or decision governance.`,
        );
      }
      continue;
    }
    if (declaration.type === "relates" && sourceKind !== targetKind) {
      const orientationKey = [sourceKind, targetKind].sort().join("|relates|"),
        oriented = relatesOrientations.get(orientationKey);
      if (oriented && (oriented.sourceKind !== sourceKind || oriented.targetKind !== targetKind)) {
        invalidGovernedRelation(
          `Relation direction is duplicated in reverse: ${sourceKind} --relates--> ${targetKind} conflicts with ` +
            `${oriented.sourceKind} --relates--> ${oriented.targetKind}.`,
        );
      }
      relatesOrientations.set(orientationKey, row);
    }
    rows.set(key, row);
  }
  return Object.freeze([...rows.values()]);
}

function resolveKind(
  kind: string,
  artifactsByKind: ReadonlyMap<string, string>,
  builtinKinds: ReadonlySet<string>,
): string | null {
  return artifactsByKind.get(kind) ?? (builtinKinds.has(kind) ? kind : null);
}

function validateGovernedSemantics(
  declaration: ArtifactRelationDefinition,
  sourceKind: string,
  targetKind: string,
): void {
  if (declaration.type === "relates") {
    if (declaration.strength !== "weak")
      invalidGovernedRelation("User-configured relates rows must have strength weak.");
    return;
  }
  if (declaration.type !== "supersedes") {
    invalidGovernedRelation(`Relation type ${declaration.type} is not open to governed vertical configuration.`);
  }
  if (sourceKind !== targetKind)
    invalidGovernedRelation("User-configured supersedes rows must have the same source and target kind.");
  if (declaration.strength === "strong" && !declaration.rationale?.trim()) {
    invalidGovernedRelation("Strong user-configured supersedes rows require a non-blank rationale.");
  }
}

function validateDecisionPin(
  declaration: ArtifactRelationDefinition,
  authority: GovernedRelationCompilationAuthority,
): void {
  const match = /^decision\/(?<decisionId>dec_[A-Za-z0-9_-]+)\/(?<claimId>(?:CH|C)[1-9][0-9]*)$/u.exec(
      declaration.decisionClaimRef,
    ),
    decisionId = match?.groups?.decisionId,
    claimId = match?.groups?.claimId;
  if (!decisionId || !claimId)
    invalidGovernedRelation(`Decision claim ref ${declaration.decisionClaimRef} is not canonical.`);
  const decision = authority.decisions.find((candidate) => candidate.decisionId === decisionId);
  if (!decision || !decision.claimIds.includes(claimId)) {
    invalidGovernedRelation(
      `Decision claim ref ${declaration.decisionClaimRef} does not exist in the compilation authority.`,
    );
  }
  if (decision.state !== "in_effect") {
    invalidGovernedRelation(
      `Decision ${decisionId} is ${decision.state}; governed relation approval must be in_effect.`,
    );
  }
  if (decision.contentPin !== declaration.decisionContentPin) {
    invalidGovernedRelation(`Decision content pin mismatch for ${declaration.decisionClaimRef}.`);
  }
}

function sameGovernance(left: CanonicalRelationDirection, right: CanonicalRelationDirection): boolean {
  return (
    left.reads === right.reads &&
    left.strength === right.strength &&
    JSON.stringify(left.governance ?? null) === JSON.stringify(right.governance ?? null)
  );
}

function invalidGovernedRelation(message: string): never {
  throw new Error(message);
}

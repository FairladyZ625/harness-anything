import { factLiveness } from "./fact-liveness.ts";
import { parseEntityRef } from "./entity-ref.ts";

export const FACT_RETIREMENT_UNDECLARED = "fact_retirement_undeclared" as const;

export interface FactStillHoldsAttestation {
  readonly factRef: string;
  readonly rationale: string;
}

export interface FactRetirementDecision {
  readonly decisionId: string;
  readonly claims: readonly {
    readonly id: string;
    readonly loadBearing: boolean;
  }[];
}

export interface FactRetirementRelation {
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: string;
  readonly state: string;
}

export interface UpstreamEvidencingFact {
  readonly factRef: string;
  readonly viaClaim: string;
  readonly viaDecision: string;
}

export interface FactRetirementAssessment {
  readonly ready: boolean;
  readonly code: typeof FACT_RETIREMENT_UNDECLARED;
  readonly undischarged: readonly UpstreamEvidencingFact[];
}

export interface FactRetirementReadinessInput {
  readonly taskId: string;
  readonly decisions: readonly FactRetirementDecision[];
  readonly relations: readonly FactRetirementRelation[];
  readonly stillHoldsAttestations: readonly FactStillHoldsAttestation[];
}

/**
 * dec_A232BE26CBFD366274CA42E42A CH1: completion must explicitly dispose of
 * every standing Fact that evidences a load-bearing claim on an upstream
 * Decision. The relation walk deliberately follows the canonical storage
 * directions: decision --derives--> task and decision/claim
 * --evidenced-by--> fact.
 */
export function assessFactRetirement(input: FactRetirementReadinessInput): FactRetirementAssessment {
  const upstream = upstreamEvidencingFacts(input.taskId, input.decisions, input.relations),
    taskRef = `task/${input.taskId}`,
    producedFacts = new Set(
      input.relations
        .filter((edge) => edge.state === "active" && edge.relationType === "produces" && edge.sourceRef === taskRef)
        .map((edge) => edge.targetRef),
    ),
    taskSupersededFacts = new Set(
      input.relations
        .filter(
          (edge) =>
            edge.state === "active" && edge.relationType === "supersedes-fact" && producedFacts.has(edge.sourceRef),
        )
        .map((edge) => edge.targetRef),
    ),
    attestedFacts = new Set(input.stillHoldsAttestations.map((attestation) => attestation.factRef)),
    undischarged = upstream.filter(
      ({ factRef }) =>
        factLiveness({ ref: factRef }, input.relations) === "standing" &&
        !taskSupersededFacts.has(factRef) &&
        !attestedFacts.has(factRef),
    );
  return Object.freeze({
    ready: undischarged.length === 0,
    code: FACT_RETIREMENT_UNDECLARED,
    undischarged: Object.freeze(undischarged),
  });
}

export function upstreamEvidencingFacts(
  taskId: string,
  decisions: readonly FactRetirementDecision[],
  relations: readonly FactRetirementRelation[],
): readonly UpstreamEvidencingFact[] {
  const taskRef = `task/${taskId}`,
    upstreamDecisionIds = new Set(
      relations
        .filter((edge) => edge.state === "active" && edge.relationType === "derives" && edge.targetRef === taskRef)
        .flatMap((edge) => {
          const source = parseEntityRef(edge.sourceRef);
          return source?.kind === "decision" && !source.externalHarness ? [source.id] : [];
        }),
    ),
    evidencedByClaim = new Map<string, string[]>();
  for (const edge of relations) {
    if (edge.state !== "active" || edge.relationType !== "evidenced-by") continue;
    const target = parseEntityRef(edge.targetRef);
    if (target?.kind !== "fact" || target.externalHarness) continue;
    evidencedByClaim.set(edge.sourceRef, [...(evidencedByClaim.get(edge.sourceRef) ?? []), edge.targetRef]);
  }
  const rows = decisions.flatMap((decision) => {
    if (!upstreamDecisionIds.has(decision.decisionId)) return [];
    const viaDecision = `decision/${decision.decisionId}`;
    return decision.claims.flatMap((claim) => {
      if (!claim.loadBearing) return [];
      const viaClaim = `${viaDecision}/${claim.id}`;
      return (evidencedByClaim.get(viaClaim) ?? []).map((factRef) => ({ factRef, viaClaim, viaDecision }));
    });
  });
  return Object.freeze(
    rows.sort(
      (left, right) =>
        left.factRef.localeCompare(right.factRef) ||
        left.viaClaim.localeCompare(right.viaClaim) ||
        left.viaDecision.localeCompare(right.viaDecision),
    ),
  );
}

export function validFactStillHoldsAttestation(value: unknown): value is FactStillHoldsAttestation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Readonly<Record<string, unknown>>,
    ref = typeof row.factRef === "string" ? parseEntityRef(row.factRef) : null;
  return (
    Object.keys(row).sort().join("\0") === "factRef\0rationale" &&
    ref?.kind === "fact" &&
    !ref.externalHarness &&
    ref.anchor === undefined &&
    typeof row.rationale === "string" &&
    row.rationale.trim().length > 0 &&
    [...row.rationale].length <= 199
  );
}

import type { CanonicalCborValue } from "./canonical-cbor.ts";
import { entityRegistry, entityRegistryKinds } from "../../../kernel/src/index.ts";
import {
  cutoverContractCborDigest,
  type AuthorityCutoverEntityKind,
  type AuthorityCutoverEntityRegistryQualification,
  type AuthorityCutoverRegistryFacet,
  type AuthorityCutoverRegistryQualificationRow
} from "./cutover-contract.ts";

const requiredKinds = entityRegistryKinds satisfies ReadonlyArray<AuthorityCutoverEntityKind>;
const requiredFacets = [
  "identityCodec", "storageLocator", "mutationContract", "semanticDiff", "projectionFacet"
] as const satisfies ReadonlyArray<AuthorityCutoverRegistryFacet>;
const consentActions = consentMutationActionsForCutover();

export interface AuthorityCutoverRegistryRegistrationInput {
  readonly kind: string;
  readonly identityCodecStatus: string;
  readonly storageLocatorStatus: string;
  readonly mutationContractStatus: string;
  readonly semanticDiffStatus: string;
  readonly projectionFacetStatus: string;
  readonly mutationActions: ReadonlyArray<string>;
}

export function createAuthorityCutoverEntityRegistryQualification(
  registrations: ReadonlyArray<AuthorityCutoverRegistryRegistrationInput>
): AuthorityCutoverEntityRegistryQualification {
  const byKind = new Map(registrations.map((registration) => [registration.kind, registration]));
  if (byKind.size !== requiredKinds.length || registrations.length !== requiredKinds.length
    || registrations.some((registration) => !requiredKinds.includes(registration.kind as AuthorityCutoverEntityKind))) {
    throw new Error("AUTHORITY_CUTOVER_REGISTRY_KIND_SET_INVALID");
  }
  const rows = requiredKinds.map((kind) => qualificationRow(kind, byKind.get(kind)));
  const body = qualificationBody(rows);
  return {
    ...body,
    qualificationDigest: cutoverContractCborDigest(
      "ha/authority-cutover-entity-registry-qualification/v1\0",
      body as unknown as CanonicalCborValue
    )
  };
}

export function validateAuthorityCutoverEntityRegistryQualification(
  qualification: AuthorityCutoverEntityRegistryQualification
): AuthorityCutoverEntityRegistryQualification {
  const rebuilt = createAuthorityCutoverEntityRegistryQualification(qualification.rows.map((row) => ({
    kind: row.kind,
    identityCodecStatus: row.facets.identityCodec,
    storageLocatorStatus: row.facets.storageLocator,
    mutationContractStatus: row.facets.mutationContract,
    semanticDiffStatus: row.facets.semanticDiff,
    projectionFacetStatus: row.facets.projectionFacet,
    mutationActions: row.mutationActions
  })));
  if (qualification.schema !== rebuilt.schema
    || qualification.registryVersion !== rebuilt.registryVersion
    || qualification.matrixCellCount !== rebuilt.matrixCellCount
    || !sameCutoverQualificationStrings(qualification.requiredKinds, rebuilt.requiredKinds)
    || !sameCutoverQualificationStrings(qualification.requiredFacets, rebuilt.requiredFacets)
    || qualification.qualificationDigest !== rebuilt.qualificationDigest) {
    throw new Error("AUTHORITY_CUTOVER_REGISTRY_QUALIFICATION_INVALID");
  }
  return structuredClone(rebuilt);
}

function qualificationRow(
  kind: AuthorityCutoverEntityKind,
  registration: AuthorityCutoverRegistryRegistrationInput | undefined
): AuthorityCutoverRegistryQualificationRow {
  if (!registration
    || registration.identityCodecStatus !== "ready"
    || registration.storageLocatorStatus !== "ready"
    || registration.mutationContractStatus !== "ready"
    || (registration.semanticDiffStatus !== "ready" && registration.semanticDiffStatus !== "typed-only")
    || registration.projectionFacetStatus !== "ready") {
    throw new Error(`AUTHORITY_CUTOVER_REGISTRY_FACET_NOT_QUALIFIED:${kind}`);
  }
  const mutationActions = [...registration.mutationActions];
  if (mutationActions.length === 0 || new Set(mutationActions).size !== mutationActions.length) {
    throw new Error(`AUTHORITY_CUTOVER_REGISTRY_ACTIONS_INVALID:${kind}`);
  }
  if (kind === "consent" && !sameCutoverQualificationStrings(mutationActions, consentActions)) {
    throw new Error("AUTHORITY_CUTOVER_CONSENT_ACTIONS_INCOMPLETE");
  }
  return {
    kind,
    facets: {
      identityCodec: "ready",
      storageLocator: "ready",
      mutationContract: "ready",
      semanticDiff: registration.semanticDiffStatus,
      projectionFacet: "ready"
    },
    mutationActions
  };
}

function qualificationBody(rows: ReadonlyArray<AuthorityCutoverRegistryQualificationRow>): Omit<AuthorityCutoverEntityRegistryQualification, "qualificationDigest"> {
  return {
    schema: "authority-cutover-entity-registry-qualification/v1",
    registryVersion: 1,
    requiredKinds: requiredKinds,
    requiredFacets: requiredFacets,
    rows,
    matrixCellCount: requiredKinds.length * requiredFacets.length
  };
}

function sameCutoverQualificationStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function consentMutationActionsForCutover(): ReadonlyArray<string> {
  const contract = entityRegistry.consent.mutationContract;
  if (contract.status !== "ready") throw new Error("AUTHORITY_CUTOVER_CONSENT_MUTATION_CONTRACT_NOT_READY");
  return contract.actions;
}

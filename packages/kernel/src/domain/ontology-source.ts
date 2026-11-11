/** Exact source identities emitted by the ontology closure gate, never line numbers. */
export interface OntologySourceBinding {
  readonly candidateId: string;
  readonly route: string;
}

export interface OntologyActionSources {
  readonly owner: string;
  readonly sources: readonly OntologySourceBinding[];
  readonly exemptions?: readonly OntologySourceExemption[];
}

/** Reviewed technical candidates remain visible and expire, without growing the debt baseline. */
export interface OntologySourceExemption {
  readonly id: string;
  readonly category: "action" | "judgment" | "policy";
  readonly candidateId: string;
  readonly reason: string;
  readonly reviewer: string;
  readonly expiresOn: string;
}

export interface OntologyJudgmentDeclaration {
  readonly id: string;
  readonly symbol: string;
  readonly inputs: readonly string[];
  readonly output: string;
  readonly failureCodes: readonly string[];
  readonly explain: string;
  readonly consumers: readonly string[];
  readonly sources: readonly OntologySourceBinding[];
}

export interface OntologyPolicyDeclaration {
  readonly id: string;
  readonly ownerRef: string;
  readonly unit: string;
  readonly bounds: string;
  readonly defaultValue: unknown;
  readonly version: number;
  readonly scope: string;
  readonly reason: string;
  readonly fixtures: readonly string[];
  readonly sources: readonly OntologySourceBinding[];
}

/** Exact source identities emitted by the ontology closure gate, never line numbers. */
export interface OntologySourceBinding {
  readonly candidateId: string;
  readonly route: string;
  readonly role?: "effect" | "support" | "script" | "technical-port";
  /** Exact compiler-resolved declaration (file#qualified member) of a shared technical port. */
  readonly port?: string;
}

export interface OntologyActionSources {
  /** Own-process technical effects do not project remote permission scopes or command kinds. */
  readonly technical?: true;
  readonly scriptManifest?: string;
  readonly authority?: "local-process" | "package-script";
  readonly entries?: Readonly<
    Record<
      string,
      { readonly file: string; readonly builder?: string; readonly script?: string; readonly bin?: string }
    >
  >;
  /** Non-protocol source rows use the owning action's execution and concurrency contract. */
  readonly execution?: { readonly ingress: string; readonly read: boolean } | null;
  readonly concurrency?: import("./entity-kind-registry.ts").EntityActionContract["concurrency"];
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
  readonly declaration?: "function" | "const";
  readonly inputs: readonly string[];
  readonly output: string;
  readonly failureCodes: readonly string[];
  readonly explain: string;
  readonly consumers: readonly string[];
  readonly sources: readonly OntologySourceBinding[];
  /** Forbidden equivalent judgments at read/transport edges, enforced by single-definition. */
  readonly consumerRules?: readonly {
    readonly pathPattern: string;
    readonly pattern: string;
    readonly flags?: string;
    readonly reason: string;
  }[];
}

/** A syntactic predicate owned by an existing codec, protocol or renderer, not a business verdict.
 * Exact source identities keep these boundaries closed when their implementation changes.
 */
export interface OntologySourceContract {
  readonly id: string;
  readonly symbol: string;
  readonly explain: string;
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

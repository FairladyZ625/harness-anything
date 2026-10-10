export const gateAppliesTo = ["submission", "code", "artifacts"] as const;
export type GateAppliesTo = (typeof gateAppliesTo)[number];

/** A vertical owns these values. Installing a declaration does not grant witness authority. */
export type WitnessSourceDefinition = {
  readonly predicateType: string;
  readonly resultSchema: Readonly<Record<string, unknown>>;
} & (
  | { readonly kind: "github-actions" }
  | { readonly kind: "command"; readonly entrypoint: string }
  | {
      readonly kind: "external";
      readonly runnerRole: string;
      readonly outputBindings?: Readonly<Record<string, "run-artifact">>;
    }
  | { readonly kind: "manual" }
);

export interface CompletionGateDeclaration {
  readonly source: string;
  readonly appliesTo: GateAppliesTo;
  readonly subjects?: "all-artifacts" | readonly string[];
  readonly bindings?: Readonly<Record<string, { readonly artifact: string; readonly pointer: string }>>;
  readonly mandatorySignoff?: boolean;
  readonly allowOverride?: boolean;
  readonly independentNode?: boolean;
}

export interface VerticalCompletionDeclaration {
  readonly sources: Readonly<Record<string, WitnessSourceDefinition>>;
  readonly gates: Readonly<Record<string, CompletionGateDeclaration>>;
  readonly closeoutDefaults: Readonly<Partial<Record<"review" | "consent" | "factDisposition" | "codeDoc", boolean>>>;
}

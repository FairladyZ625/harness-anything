import type { OntologyPolicyDeclaration, OntologyJudgmentDeclaration } from "./ontology-source.ts";

/** Offer override remediation for a judged failed/missing non-manual gate when its frozen contract permits it. */
export function canOverrideGate(
  status: string | undefined,
  allowOverride: boolean | undefined,
  manual: boolean,
): status is "failed" | "missing" {
  if ((status === "failed" || status === "missing") && allowOverride === true && !manual) return true;
  return false;
}

export const completionGateOverridePolicy = {
  id: "completion-gate-override-remediation",
  ownerRef: "task",
  unit: "gate remediation availability",
  bounds: "Only failed/missing non-manual gates with an explicit override declaration offer an override action.",
  defaultValue: null,
  version: 1,
  scope: "Completion remediation commands and desktop gate attestation actions",
  reason: "Both consumers use the same eligibility rule; witness admission keeps its existing cut/evidence checks.",
  fixtures: [
    "packages/gui/test/attestation-pool-model.vitest.ts",
    "packages/kernel/test/domain/task-completion-next.test.ts",
    "packages/daemon/test/witness-adapters.test.ts",
  ],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/completion-gate-policy.ts#canOverrideGate:aac87d6ac35ce8e3265628cf83f15b61",
      route: "gate override remediation",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;
export const completionGateOverrideJudgment = {
  id: "canOverrideGate",
  symbol: "packages/kernel/src/domain/completion-gate-policy.ts#canOverrideGate",
  inputs: ["judged gate status", "override declaration", "manual source flag"],
  output: "status is failed or missing",
  failureCodes: [],
  explain: "Offer override remediation only for a declared non-manual failed/missing gate.",
  consumers: [
    "packages/kernel/src/domain/completion-readiness.ts",
    "packages/gui/src/renderer/model/attestation-pool.ts",
  ],
  sources: [
    {
      candidateId:
        "judgment:packages/kernel:packages/kernel/src/domain/completion-gate-policy.ts#canOverrideGate:2f88f4d76fb4a6e9c33c680b936ad69a",
      route: "gate override remediation",
    },
  ],
} as const satisfies OntologyJudgmentDeclaration;

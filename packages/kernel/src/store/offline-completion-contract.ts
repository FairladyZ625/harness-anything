import { CODE_DOC_GATE_ID, type FrozenGateRequirement } from "../domain/completion-contract.ts";

/** Offline conversion of the documented rules that accepted pre-contract submissions. */
export function historicalCompletionRequirements(
  declared: readonly string[],
  workflows: readonly string[],
): readonly FrozenGateRequirement[] {
  return declared.flatMap((gateId): readonly FrozenGateRequirement[] => {
    if (gateId === CODE_DOC_GATE_ID)
      return [
        { gateId, appliesTo: "code", witness: { adapterId: CODE_DOC_GATE_ID, kind: "internal", adapterOptions: {} } },
      ];
    if (gateId === "ci" && workflows.length)
      return [
        {
          gateId,
          appliesTo: "code",
          witness: {
            adapterId: "github-actions",
            kind: "github-actions",
            predicateType: "harness/ci/v1",
            resultSchema: { type: "object", additionalProperties: false },
            adapterOptions: { workflows, branch: "main", event: "push", coverage: "descendant", selection: "newest" },
          },
        },
      ];
    return [];
  });
}

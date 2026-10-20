import { CODE_DOC_GATE_ID, type FrozenGateRequirement } from "../domain/completion-contract.ts";

/** Offline conversion of the documented rules that accepted pre-contract submissions. */
export function historicalCompletionRequirements(declared: readonly string[]): readonly FrozenGateRequirement[] {
  return declared.flatMap((gateId): readonly FrozenGateRequirement[] => {
    if (gateId === CODE_DOC_GATE_ID)
      return [
        { gateId, appliesTo: "code", witness: { adapterId: CODE_DOC_GATE_ID, kind: "internal", adapterOptions: {} } },
      ];
    // The legacy `ci` completion gate is retired. Historical submissions may still name it,
    // but conversion must not recreate the hosted witness chain from mutable repository settings.
    if (gateId === "ci") return [];
    return [];
  });
}

import type { DecisionProjectionRow } from "../src/api/renderer-dto.ts";
import type { DecisionRow } from "../src/renderer/model/types.ts";

/**
 * The capability / claimsOpen fields the kernel projects onto every full decision row
 * (decision-board-projection.ts). Fixtures restate the mapping per state because tests
 * may not deep-import kernel source — same discipline as task-projection-fields.ts.
 */
const CAPABILITY_IDS = ["accept", "reject", "defer", "supersede", "retire"] as const;
const SOURCE_STATE: Readonly<Record<(typeof CAPABILITY_IDS)[number], DecisionRow["state"]>> = {
  accept: "proposed",
  reject: "proposed",
  defer: "proposed",
  supersede: "in_effect",
  retire: "in_effect",
};
const CLAIMS_OPEN_STATES: ReadonlySet<DecisionRow["state"]> = new Set(["proposed", "in_effect"]);

export function decisionProjectionFields(
  state: DecisionRow["state"],
): Pick<DecisionRow, "capabilities" | "claimsOpen"> {
  return {
    capabilities: CAPABILITY_IDS.map((id) => ({
      id,
      available: SOURCE_STATE[id] === state,
      reason: SOURCE_STATE[id] === state ? null : ("invalid_transition" as const),
    })),
    claimsOpen: CLAIMS_OPEN_STATES.has(state),
  };
}

export type WireDecisionProjectionFields = Pick<DecisionProjectionRow, "capabilities" | "claimsOpen">;

import { decisionTransitionDefinitions, type DecisionState } from "./decision-event.ts";

/** The Decision actions whose lifecycle precondition can be answered from one projected row. */
export const decisionCapabilityIds = Object.freeze(decisionTransitionDefinitions.map(({ action }) => action));
export type DecisionCapabilityId = (typeof decisionCapabilityIds)[number];

export const decisionCapabilityReasons = ["invalid_transition"] as const;
export type DecisionCapabilityReason = (typeof decisionCapabilityReasons)[number];

export interface DecisionCapability {
  readonly id: DecisionCapabilityId;
  readonly available: boolean;
  readonly reason: DecisionCapabilityReason | null;
}

export function decisionCapabilities(state: DecisionState): readonly DecisionCapability[] {
  return Object.freeze(
    decisionTransitionDefinitions.map(({ action: id, sourceState }) => {
      const available = state === sourceState;
      return Object.freeze({ id, available, reason: available ? null : "invalid_transition" });
    }),
  );
}

export function decisionClaimsOpen(state: DecisionState): boolean {
  return state === "proposed" || state === "in_effect";
}

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

/** Follow-up terminal: every state except `proposed`, the only one still awaiting judgment.
 * `deferred` is included on purpose — it has no outgoing transition at all, so a follow-up cue
 * waiting for the source's next write would wait forever, exactly like a task past done/cancelled.
 * `in_effect` counts as settled for the same purpose: the judgment is out even though supersede
 * and retire remain possible. */
const terminalDecisionStates = [
  "in_effect",
  "rejected",
  "deferred",
  "superseded",
  "outcome_retired",
] as const satisfies ReadonlyArray<DecisionState>;

export function isTerminalDecisionState(state: DecisionState): boolean {
  return (terminalDecisionStates as ReadonlyArray<DecisionState>).includes(state);
}

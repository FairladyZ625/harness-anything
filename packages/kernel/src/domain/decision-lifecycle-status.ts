export const decisionStates = [
  "proposed",
  "active",
  "rejected",
  "deferred",
  "retired"
] as const;

export type DecisionState = typeof decisionStates[number];
export type DecisionStateTransitionRejectionReason = "terminal_state" | "unsupported_transition";
export type DecisionStateTransitionExplanation =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DecisionStateTransitionRejectionReason };

const terminalDecisionStates = [
  "rejected",
  "deferred",
  "retired"
] as const satisfies ReadonlyArray<DecisionState>;

const allowedDecisionStateTransitions = {
  proposed: ["active", "rejected", "deferred"],
  active: ["retired"],
  rejected: [],
  deferred: [],
  retired: []
} as const satisfies Record<DecisionState, ReadonlyArray<DecisionState>>;

export function isDecisionState(value: string): value is DecisionState {
  return (decisionStates as ReadonlyArray<string>).includes(value);
}

export function explainDecisionStateTransition(
  from: DecisionState,
  to: DecisionState
): DecisionStateTransitionExplanation {
  if (from === to) return { allowed: true };
  if ((terminalDecisionStates as ReadonlyArray<DecisionState>).includes(from)) {
    return { allowed: false, reason: "terminal_state" };
  }
  return (allowedDecisionStateTransitions[from] as ReadonlyArray<DecisionState>).includes(to)
    ? { allowed: true }
    : { allowed: false, reason: "unsupported_transition" };
}

export const domainStatuses = ["planned", "active", "submitted", "blocked", "in_review", "done", "cancelled"] as const;

export type DomainStatus = (typeof domainStatuses)[number];
export type CanonicalStatus = DomainStatus;
export type StatusCoarseClass = "open" | "terminal";
export type StatusTransitionRejectionReason = "terminal_status" | "unsupported_transition";
export type StatusTransitionExplanation =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: StatusTransitionRejectionReason };

export const openDomainStatuses = [
  "planned",
  "active",
  "submitted",
  "blocked",
  "in_review",
] as const satisfies ReadonlyArray<DomainStatus>;

export const terminalDomainStatuses = ["done", "cancelled"] as const satisfies ReadonlyArray<DomainStatus>;

export const reviewArtifactStatuses = ["in_review", "done"] as const satisfies ReadonlyArray<DomainStatus>;

export function isDomainStatus(value: string): value is DomainStatus {
  return (domainStatuses as ReadonlyArray<string>).includes(value);
}

export function isTerminalStatus(status: DomainStatus): boolean {
  return (terminalDomainStatuses as ReadonlyArray<DomainStatus>).includes(status);
}

export function needsReviewArtifacts(status: DomainStatus): boolean {
  return (reviewArtifactStatuses as ReadonlyArray<DomainStatus>).includes(status);
}

export function statusCoarseClass(status: DomainStatus): StatusCoarseClass {
  return isTerminalStatus(status) ? "terminal" : "open";
}

/** The sole exit from cancelled: a compensating rollback (reinstate_task) to the
 * status the owner adjudicates as the recorded pre-cancel position. done keeps no exit —
 * its integrity is vouched for by the completion chain, so reversal is a different semantic. */
export const reinstateTaskTargets = ["planned", "active", "in_review"] as const satisfies ReadonlyArray<DomainStatus>;

/** The adjudication corridor (owner ruling 2026-09-19): submit lands the cut in `submitted`
 * awaiting the owning CEO's triage; only the owner's adjudication moves it to `in_review`
 * (forward to the reviewer gate) or back to `active` (rework). `done` is reachable only from
 * `in_review` through consented completion — the direct `active → done` shortcut is gone. */
const allowedStatusTransitions = {
  planned: ["active", "blocked", "cancelled"],
  active: ["planned", "submitted", "blocked", "cancelled"],
  submitted: ["active", "in_review", "cancelled"],
  blocked: ["active", "cancelled"],
  in_review: ["active", "blocked", "done", "cancelled"],
  done: [],
  cancelled: reinstateTaskTargets,
} as const satisfies Record<DomainStatus, ReadonlyArray<DomainStatus>>;

export function explainStatusTransition(from: DomainStatus, to: DomainStatus): StatusTransitionExplanation {
  if (from === to) return { allowed: true };
  return (allowedStatusTransitions[from] as ReadonlyArray<DomainStatus>).includes(to)
    ? { allowed: true }
    : { allowed: false, reason: isTerminalStatus(from) ? "terminal_status" : "unsupported_transition" };
}

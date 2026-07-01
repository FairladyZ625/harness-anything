export const domainStatuses = [
  "planned",
  "active",
  "blocked",
  "in_review",
  "done",
  "cancelled"
] as const;

export type DomainStatus = typeof domainStatuses[number];
export type CanonicalStatus = DomainStatus;
export type StatusCoarseClass = "open" | "terminal";
export type StatusTransitionRejectionReason = "terminal_status" | "unsupported_transition";
export type StatusTransitionExplanation =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: StatusTransitionRejectionReason };

export const openDomainStatuses = [
  "planned",
  "active",
  "blocked",
  "in_review"
] as const satisfies ReadonlyArray<DomainStatus>;

export const terminalDomainStatuses = [
  "done",
  "cancelled"
] as const satisfies ReadonlyArray<DomainStatus>;

export const reviewArtifactStatuses = [
  "in_review",
  "done"
] as const satisfies ReadonlyArray<DomainStatus>;

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

const allowedStatusTransitions = {
  planned: ["active", "blocked", "cancelled"],
  active: ["blocked", "in_review", "done", "cancelled"],
  blocked: ["active", "cancelled"],
  in_review: ["active", "blocked", "done", "cancelled"],
  done: [],
  cancelled: []
} as const satisfies Record<DomainStatus, ReadonlyArray<DomainStatus>>;

export function explainStatusTransition(from: DomainStatus, to: DomainStatus): StatusTransitionExplanation {
  if (from === to) return { allowed: true };
  if (isTerminalStatus(from)) return { allowed: false, reason: "terminal_status" };
  return (allowedStatusTransitions[from] as ReadonlyArray<DomainStatus>).includes(to)
    ? { allowed: true }
    : { allowed: false, reason: "unsupported_transition" };
}

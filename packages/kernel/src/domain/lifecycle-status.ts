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

import { isNonEmptyString } from "./contract-validation.ts";
import type { LedgerCutIdentity } from "./receipt-domain-registry.ts";

export const receiptAcceptanceStatuses = Object.freeze(["accepted_durable", "rejected", "unknown"] as const);
export const receiptFacetStates = Object.freeze(["pending", "verified", "not_configured"] as const);
export const receiptWaitStates = Object.freeze(["satisfied", "timed_out"] as const);

export interface ReceiptConsumerCut extends LedgerCutIdentity {
  readonly generation: 1;
}
export interface ReceiptAcceptance {
  readonly storage: "sqlite";
  readonly durability: "local_fsync";
  readonly recordedAt: string;
  readonly revisionFrom: number;
  readonly revisionTo: number;
  readonly memberOpIds: readonly string[];
  readonly cut: ReceiptConsumerCut;
}
export interface ReceiptFacet {
  readonly state: (typeof receiptFacetStates)[number];
  readonly cut: ReceiptConsumerCut | null;
  readonly reason?: string;
}
export interface ReceiptGitFacet extends ReceiptFacet {
  readonly commitSha: string | null;
}
export type ReceiptWaitPredicate =
  | "accepted_durable"
  | "projection_visible"
  | "git_verified"
  | "worktree_visible"
  | "replica_verified";
export interface ReceiptAcceptanceFields {
  readonly status: (typeof receiptAcceptanceStatuses)[number];
  readonly acceptance: ReceiptAcceptance | null;
  readonly projection: ReceiptFacet;
  readonly git: ReceiptGitFacet;
  readonly worktree: ReceiptFacet;
  readonly replica: ReceiptFacet;
  readonly wait?: {
    readonly state: (typeof receiptWaitStates)[number];
    readonly unsatisfied: readonly ReceiptWaitPredicate[];
  };
}

export const receiptWaitPredicates = Object.freeze([
  "accepted_durable",
  "projection_visible",
  "git_verified",
  "worktree_visible",
  "replica_verified",
] as const);

/** Progress facets are certified by their owning readers at an accepted ledger cut. */
export function unsatisfiedReceiptPredicates(
  receipt: ReceiptAcceptanceFields,
  predicates: readonly ReceiptWaitPredicate[],
): readonly ReceiptWaitPredicate[] {
  const target = receipt.acceptance?.cut;
  const covers = (facet: ReceiptFacet): boolean =>
    !!target &&
    facet.state === "verified" &&
    !!facet.cut &&
    facet.cut.repoId === target.repoId &&
    facet.cut.generation === target.generation &&
    facet.cut.revision >= target.revision &&
    (facet.cut.revision !== target.revision || facet.cut.headDigest === target.headDigest);
  return predicates.filter((predicate) => {
    if (predicate === "accepted_durable") return receipt.status !== "accepted_durable";
    const facet =
      predicate === "projection_visible"
        ? receipt.projection
        : predicate === "git_verified"
          ? receipt.git
          : predicate === "worktree_visible"
            ? receipt.worktree
            : receipt.replica;
    return !covers(facet);
  });
}

export function validateReceiptAcceptance(value: Readonly<Record<string, unknown>>): readonly string[] {
  const errors: string[] = [];
  if (!["accepted_durable", "rejected", "unknown"].includes(String(value.status)))
    errors.push("receipt status is invalid");
  if (value.status === "accepted_durable") {
    const a = value.acceptance;
    if (
      !record(a) ||
      !exact(a, ["storage", "durability", "recordedAt", "revisionFrom", "revisionTo", "memberOpIds", "cut"]) ||
      a.storage !== "sqlite" ||
      a.durability !== "local_fsync" ||
      !isNonEmptyString(a.recordedAt) ||
      !Number.isFinite(Date.parse(a.recordedAt)) ||
      !revision(a.revisionFrom) ||
      a.revisionFrom < 1 ||
      !revision(a.revisionTo) ||
      a.revisionTo < a.revisionFrom ||
      !consumerCut(a.cut) ||
      a.cut.revision !== a.revisionTo ||
      !Array.isArray(a.memberOpIds) ||
      a.memberOpIds.length !== a.revisionTo - a.revisionFrom + 1 ||
      !a.memberOpIds.every(isNonEmptyString) ||
      new Set(a.memberOpIds).size !== a.memberOpIds.length ||
      typeof value.opId !== "string" ||
      !a.memberOpIds.includes(value.opId)
    )
      errors.push("accepted_durable requires a committed acceptance interval");
  } else if (value.acceptance !== null) errors.push("unaccepted receipt requires acceptance:null");
  for (const name of ["projection", "git", "worktree", "replica"] as const) {
    const facet = value[name],
      fields = ["state", "cut", ...(name === "git" ? ["commitSha"] : [])];
    if (
      !record(facet) ||
      !exact(facet, [...fields, ...("reason" in facet ? ["reason"] : [])]) ||
      !["pending", "verified", ...(name === "replica" ? ["not_configured"] : [])].includes(String(facet.state)) ||
      (facet.state === "verified" ? !consumerCut(facet.cut) : facet.cut !== null) ||
      ("reason" in facet && !isNonEmptyString(facet.reason)) ||
      (name === "git" &&
        (facet.state === "verified"
          ? typeof facet.commitSha !== "string" || !/^[0-9a-f]{40}$/u.test(facet.commitSha)
          : facet.commitSha !== null))
    )
      errors.push(`${name} must report an independent verified cut or pending state`);
  }
  if (value.outcome === "applied" && value.status !== "accepted_durable")
    errors.push("applied requires accepted_durable");
  if (
    "wait" in value &&
    (!record(value.wait) ||
      !exact(value.wait, ["state", "unsatisfied"]) ||
      !["satisfied", "timed_out"].includes(String(value.wait.state)) ||
      !Array.isArray(value.wait.unsatisfied) ||
      !value.wait.unsatisfied.every((item) => (receiptWaitPredicates as readonly unknown[]).includes(item)) ||
      (value.wait.state === "satisfied") !== (value.wait.unsatisfied.length === 0))
  )
    errors.push("receipt wait result is invalid");
  return errors;
}
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((key) => key in value);
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function consumerCut(value: unknown): value is ReceiptConsumerCut {
  return (
    record(value) &&
    exact(value, ["repoId", "generation", "revision", "headDigest"]) &&
    isNonEmptyString(value.repoId) &&
    value.generation === 1 &&
    revision(value.revision) &&
    typeof value.headDigest === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(value.headDigest)
  );
}

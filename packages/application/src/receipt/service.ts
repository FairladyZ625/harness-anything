import {
  isCompleteAuthorityCommittedReceiptV2,
  type AuthorityOperationReceipt
} from "../authority/index.ts";
import {
  CompoundReceiptTransitionError,
  compoundReceiptSchema,
  type CompoundOperationReceipt,
  type CompoundReceiptService,
  type CompoundReceiptStore,
  type CurrentLeaseState,
  type ImmutableReceiptAcknowledgement,
  type OriginResolution,
  type ReceiptIdentity
} from "./types.ts";

export interface CompoundReceiptServiceOptions {
  readonly store: CompoundReceiptStore;
  readonly now?: () => string;
}

export function createCompoundReceiptService(options: CompoundReceiptServiceOptions): CompoundReceiptService {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    initialize: async (identity) => options.store.create(initialReceipt(identity, now())),
    recordAuthority: (identity, authority) => mutate(identity, (current) => authorityTransition(current, authority)),
    recordOrigin: (identity, origin) => mutate(identity, (current) => originTransition(current, origin)),
    prepareResult: (identity) => mutate(identity, prepareResultTransition),
    commitAcknowledgement: (identity, acknowledgement) => mutate(identity, (current) => acknowledgeTransition(current, acknowledgement)),
    detach: (identity, reason) => mutate(identity, (current) => terminalDeliveryTransition(current, "DETACHED", reason)),
    markProtocolDamaged: (identity, reason) => mutate(identity, (current) => terminalDeliveryTransition(current, "PROTOCOL_DAMAGED", reason)),
    setCurrentLease: (identity, state) => mutate(identity, (current) => leaseTransition(current, state))
  };

  async function mutate(
    identity: ReceiptIdentity,
    transition: (current: CompoundOperationReceipt) => CompoundOperationReceipt
  ): Promise<CompoundOperationReceipt> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await requiredReceipt(options.store, identity);
      const candidate = transition(current);
      if (candidate === current) return current;
      const next = { ...candidate, sequence: current.sequence + 1, updatedAt: now() };
      if (await options.store.compareAndSet(identity, current.sequence, next)) return next;
    }
    throw new CompoundReceiptTransitionError(`concurrent receipt update did not converge for waiter ${identity.waiterId}`);
  }
}

function initialReceipt(identity: ReceiptIdentity, updatedAt: string): CompoundOperationReceipt {
  assertIdentity(identity);
  return {
    schema: compoundReceiptSchema,
    ...identity,
    phase: "PENDING",
    delivery: "PENDING",
    currentLease: "NOT_REQUESTED",
    sequence: 0,
    updatedAt
  };
}

function authorityTransition(current: CompoundOperationReceipt, authority: AuthorityOperationReceipt): CompoundOperationReceipt {
  assertAuthorityIdentity(current, authority);
  if (current.authority) {
    if (JSON.stringify(current.authority) === JSON.stringify(authority)) return current;
    throw invalid(current, "authority outcome is immutable");
  }
  if (current.phase !== "PENDING") throw invalid(current, "authority can only be recorded from PENDING");
  return {
    ...current,
    authority,
    phase: authority.tag === "COMMITTED" ? "COMMITTED" : "PENDING"
  };
}

function originTransition(current: CompoundOperationReceipt, origin: OriginResolution): CompoundOperationReceipt {
  assertOriginIdentity(current, origin);
  if (current.authority?.tag !== "COMMITTED" || current.phase === "PENDING") {
    throw invalid(current, "origin requires a durable COMMITTED authority receipt");
  }
  if (origin.tag === "APPLIED_EXACT_AT_CUT" && origin.version !== current.authority.revision) {
    throw invalid(current, "exact-cut version must match the committed authority revision");
  }
  if (current.origin) {
    if (JSON.stringify(current.origin) === JSON.stringify(origin)) return current;
    throw invalid(current, "origin outcome is immutable");
  }
  return {
    ...current,
    origin,
    phase: origin.tag === "APPLIED_EXACT_AT_CUT" ? "APPLIED_EXACT_AT_CUT" : "COMMITTED"
  };
}

function prepareResultTransition(current: CompoundOperationReceipt): CompoundOperationReceipt {
  if (current.delivery === "RESULT_PREPARED" || current.delivery === "PROTOCOL_DAMAGED") return current;
  if (current.delivery !== "PENDING" || current.phase !== "APPLIED_EXACT_AT_CUT") {
    throw invalid(current, "RESULT_PREPARED requires APPLIED_EXACT_AT_CUT and a live delivery");
  }
  if (current.authority?.tag !== "COMMITTED" || !isCompleteAuthorityCommittedReceiptV2(current.authority)) {
    return { ...current, delivery: "PROTOCOL_DAMAGED" };
  }
  return { ...current, delivery: "RESULT_PREPARED" };
}

function acknowledgeTransition(
  current: CompoundOperationReceipt,
  acknowledgement: ImmutableReceiptAcknowledgement
): CompoundOperationReceipt {
  validateAcknowledgement(current, acknowledgement);
  if (current.delivery === "ACK_COMMITTED") {
    if (JSON.stringify(current.acknowledgement) === JSON.stringify(acknowledgement)) return current;
    throw invalid(current, "ACK_COMMITTED evidence is immutable");
  }
  if (current.delivery !== "RESULT_PREPARED" || current.phase !== "APPLIED_EXACT_AT_CUT") {
    throw invalid(current, "ACK_COMMITTED requires a durable RESULT_PREPARED exact-cut receipt");
  }
  return {
    ...current,
    delivery: "ACK_COMMITTED",
    phase: "ACK_COMMITTED",
    terminalLSN: acknowledgement.terminalLSN,
    acknowledgement
  };
}

function validateAcknowledgement(
  current: CompoundOperationReceipt,
  acknowledgement: ImmutableReceiptAcknowledgement
): void {
  const authority = current.authority;
  const origin = current.origin;
  if (authority?.tag !== "COMMITTED" || origin?.tag !== "APPLIED_EXACT_AT_CUT") {
    throw invalid(current, "acknowledgement requires committed authority and exact origin evidence");
  }
  if (!isCompleteAuthorityCommittedReceiptV2(authority)) {
    throw invalid(current, "acknowledgement requires the complete committed authority integrity tuple");
  }
  if (acknowledgement.workspaceId !== current.workspaceId
    || acknowledgement.viewId !== current.viewId
    || acknowledgement.opId !== current.opId
    || acknowledgement.waiterId !== current.waiterId
    || acknowledgement.revision !== authority.revision
    || acknowledgement.commitSha !== authority.commitSha
    || acknowledgement.canonicalEventDigest !== authority.integrityTuple.canonicalEventDigest
    || acknowledgement.cutId !== origin.cutId
    || acknowledgement.cutKind !== origin.cutKind
    || acknowledgement.cutJournalLSN !== origin.cutJournalLSN
    || acknowledgement.affectedDigest !== origin.verifiedAffectedDigest
    || acknowledgement.writerExclusionId !== origin.writerExclusionId) {
    throw invalid(current, "acknowledgement integrity tuple does not match authority/origin evidence");
  }
  for (const value of [acknowledgement.epoch, acknowledgement.revision, acknowledgement.cutJournalLSN, acknowledgement.terminalLSN]) {
    if (!Number.isSafeInteger(value) || value < 0) throw invalid(current, "acknowledgement LSN/version fields must be non-negative safe integers");
  }
  if (!acknowledgement.canonicalEventDigest || !acknowledgement.affectedDigest) {
    throw invalid(current, "acknowledgement digests are required");
  }
}

function terminalDeliveryTransition(
  current: CompoundOperationReceipt,
  delivery: "DETACHED" | "PROTOCOL_DAMAGED",
  reason: string
): CompoundOperationReceipt {
  if (!reason.trim()) throw invalid(current, `${delivery} requires a reason`);
  if (current.delivery === delivery) return current;
  if (current.delivery === "ACK_COMMITTED" || current.delivery === "DETACHED" || current.delivery === "PROTOCOL_DAMAGED") {
    throw invalid(current, `terminal delivery ${current.delivery} cannot become ${delivery}`);
  }
  return { ...current, delivery };
}

function leaseTransition(current: CompoundOperationReceipt, state: CurrentLeaseState): CompoundOperationReceipt {
  if (current.currentLease === state) return current;
  if (current.currentLease === "REVOKED" && state === "SATISFIED") {
    throw invalid(current, "a revoked current lease cannot be resurrected");
  }
  return { ...current, currentLease: state };
}

async function requiredReceipt(store: CompoundReceiptStore, identity: ReceiptIdentity): Promise<CompoundOperationReceipt> {
  const receipt = await store.get(identity);
  if (!receipt) throw new CompoundReceiptTransitionError(`receipt not initialized for waiter ${identity.waiterId}`);
  return receipt;
}

function assertIdentity(identity: ReceiptIdentity): void {
  for (const [field, value] of Object.entries(identity)) {
    if (typeof value !== "string" || value.length === 0) throw new CompoundReceiptTransitionError(`${field} is required`);
  }
}

function assertAuthorityIdentity(current: CompoundOperationReceipt, authority: AuthorityOperationReceipt): void {
  if (authority.workspaceId !== current.workspaceId || authority.opId !== current.opId) {
    throw invalid(current, "authority identity does not match waiter receipt");
  }
}

function assertOriginIdentity(current: CompoundOperationReceipt, origin: OriginResolution): void {
  if (origin.viewId !== current.viewId || origin.opId !== current.opId) {
    throw invalid(current, "origin identity does not match waiter receipt");
  }
}

function invalid(current: CompoundOperationReceipt, message: string): CompoundReceiptTransitionError {
  return new CompoundReceiptTransitionError(`${message} (waiter=${current.waiterId}, phase=${current.phase}, delivery=${current.delivery})`);
}

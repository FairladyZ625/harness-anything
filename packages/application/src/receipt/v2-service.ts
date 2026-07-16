import { randomBytes, randomUUID } from "node:crypto";
import { isCompleteAuthorityCommittedReceiptV2, type AuthorityOperationReceipt } from "../authority/index.ts";
import { CompoundReceiptTransitionError, type CurrentLeaseState } from "./types.ts";
import { preparedReceiptDigestV2, resultTokenDigestV2, resultTokenMatchesV2 } from "./v2-integrity.ts";
import { assertHistoricalExcludedSetWitnessV1 } from "./witness-v1.ts";
import {
  CompoundReceiptProtocolError,
  compoundReceiptV2Schema,
  compoundTerminalJournalSchema,
  type CompoundOperationReceiptV2,
  type CompoundReceiptServiceV2,
  type CompoundReceiptStoreV2,
  type DeliveryAcknowledgementInputV2,
  type ImmutableReceiptAcknowledgementV2,
  type OriginResolutionV2,
  type ReceiptIdentityV2,
  type WaiterScope
} from "./v2-types.ts";

export interface CompoundReceiptServiceV2Options {
  readonly store: CompoundReceiptStoreV2;
  readonly now?: () => string;
  readonly createWaiterId?: () => string;
  readonly createResultToken?: () => string;
}

export function createCompoundReceiptServiceV2(options: CompoundReceiptServiceV2Options): CompoundReceiptServiceV2 {
  const now = options.now ?? (() => new Date().toISOString());
  const createWaiterId = options.createWaiterId ?? (() => randomUUID());
  const createResultToken = options.createResultToken ?? (() => randomBytes(32).toString("base64url"));

  return {
    openWaiter: async (scope) => {
      assertScope(scope);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const resultToken = createResultToken();
        const tokenBytes = Buffer.from(resultToken, "base64url");
        if (tokenBytes.byteLength < 32 || tokenBytes.toString("base64url") !== resultToken) {
          throw new CompoundReceiptTransitionError("result token must contain at least 256 bits of entropy");
        }
        const identity = {
          workspaceId: scope.workspaceId,
          viewId: scope.viewId,
          opId: scope.opId,
          waiterId: requiredCompoundText(createWaiterId(), "waiterId")
        };
        const candidate = initialReceiptV2(identity, resultTokenDigestV2(resultToken), now());
        const receipt = await options.store.create(candidate);
        if (receipt.resultTokenDigest === candidate.resultTokenDigest) return { identity, resultToken, receipt };
      }
      throw new CompoundReceiptTransitionError("could not allocate a unique compound waiter");
    },
    getWaiter: async (capability) => {
      const receipt = await options.store.get(capability);
      return receipt && resultTokenMatchesV2(capability.resultToken, receipt.resultTokenDigest) ? receipt : undefined;
    },
    recordAuthority: (identity, authority) => mutateReceiptV2(identity, (current) => authorityTransitionV2(current, authority)),
    recordOrigin: (identity, origin) => mutateReceiptV2(identity, (current) => originTransitionV2(current, origin)),
    prepareResult: (identity) => mutateReceiptV2(identity, prepareResultTransitionV2),
    commitAcknowledgement,
    detach: (identity, reason) => commitDetach(identity, reason),
    markProtocolDamaged: (identity, reason) => mutateReceiptV2(identity, (current) => protocolDamageTransitionV2(current, "PROTOCOL_DAMAGED", reason)),
    setCurrentLease: (identity, state) => mutateReceiptV2(identity, (current) => leaseTransitionV2(current, state))
  };

  async function mutateReceiptV2(
    identity: ReceiptIdentityV2,
    transition: (current: CompoundOperationReceiptV2) => CompoundOperationReceiptV2
  ): Promise<CompoundOperationReceiptV2> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await requiredReceiptV2(options.store, identity);
      const candidate = transition(current);
      if (candidate === current) return current;
      const next = { ...candidate, sequence: current.sequence + 1, updatedAt: now() };
      if (await options.store.compareAndSet(identity, current.sequence, next)) return next;
    }
    throw invalidIdentity(identity, "concurrent receipt update did not converge");
  }

  async function commitAcknowledgement(input: DeliveryAcknowledgementInputV2): Promise<CompoundOperationReceiptV2> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await requiredReceiptV2(options.store, input);
      if (!resultTokenMatchesV2(input.resultToken, current.resultTokenDigest)) throw protocol("result token mismatch", current);
      if (current.delivery === "ACK_COMMITTED") {
        const ack = current.acknowledgement;
        if (ack?.preparedSequence === input.preparedSequence
          && ack.preparedReceiptDigest === input.preparedReceiptDigest) return current;
        throw protocol("ACK does not match the durable prepared result", current);
      }
      if (current.delivery !== "RESULT_PREPARED" || current.phase !== "APPLIED_EXACT_AT_CUT") {
        throw protocol(`ACK cannot advance terminal delivery ${current.delivery}`, current);
      }
      const expectedDigest = preparedReceiptDigestV2(current);
      if (input.preparedSequence !== current.sequence || input.preparedReceiptDigest !== expectedDigest) {
        throw protocol("ACK prepared sequence or digest mismatch", current);
      }
      const acknowledgement = acknowledgementWithoutTerminal(current, input);
      const committed = await options.store.commitTerminal(
        input,
        current.sequence,
        {
          schema: compoundTerminalJournalSchema,
          workspaceId: current.workspaceId,
          viewId: current.viewId,
          opId: current.opId,
          waiterId: current.waiterId,
          kind: "ACK_COMMITTED",
          pinReleaseEligible: true,
          recordedAt: now(),
          preparedSequence: input.preparedSequence,
          preparedReceiptDigest: input.preparedReceiptDigest
        },
        (terminalLSN) => ({
          ...current,
          phase: "ACK_COMMITTED",
          delivery: "ACK_COMMITTED",
          pinReleaseEligible: true,
          terminalLSN,
          acknowledgement: { ...acknowledgement, terminalLSN },
          sequence: current.sequence + 1,
          updatedAt: now()
        })
      );
      if (committed) return committed;
    }
    throw invalidIdentity(input, "concurrent ACK update did not converge");
  }

  async function commitDetach(identity: ReceiptIdentityV2, reason: string): Promise<CompoundOperationReceiptV2> {
    if (!reason.trim()) throw invalidIdentity(identity, "DETACHED requires a reason");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await requiredReceiptV2(options.store, identity);
      if (current.delivery === "DETACHED") return current;
      if (current.delivery === "ACK_COMMITTED" || current.delivery === "PROTOCOL_DAMAGED") {
        throw invalidReceiptV2(current, `terminal delivery ${current.delivery} cannot become DETACHED`);
      }
      const committed = await options.store.commitTerminal(
        identity,
        current.sequence,
        {
          schema: compoundTerminalJournalSchema,
          workspaceId: current.workspaceId,
          viewId: current.viewId,
          opId: current.opId,
          waiterId: current.waiterId,
          kind: "DETACHED",
          pinReleaseEligible: true,
          recordedAt: now(),
          reason
        },
        (terminalLSN) => ({
          ...current,
          delivery: "DETACHED",
          pinReleaseEligible: true,
          terminalLSN,
          sequence: current.sequence + 1,
          updatedAt: now()
        })
      );
      if (committed) return committed;
    }
    throw invalidIdentity(identity, "concurrent detach update did not converge");
  }
}

function initialReceiptV2(identity: ReceiptIdentityV2, resultTokenDigest: string, updatedAt: string): CompoundOperationReceiptV2 {
  return {
    schema: compoundReceiptV2Schema,
    ...identity,
    resultTokenDigest,
    phase: "PENDING",
    delivery: "PENDING",
    pinReleaseEligible: false,
    currentLease: "NOT_REQUESTED",
    sequence: 0,
    updatedAt
  };
}

function authorityTransitionV2(current: CompoundOperationReceiptV2, authority: AuthorityOperationReceipt): CompoundOperationReceiptV2 {
  if (authority.workspaceId !== current.workspaceId || authority.opId !== current.opId) throw invalidReceiptV2(current, "authority identity mismatch");
  if (current.authority) {
    if (JSON.stringify(current.authority) === JSON.stringify(authority)) return current;
    throw invalidReceiptV2(current, "authority outcome is immutable");
  }
  if (current.phase !== "PENDING") throw invalidReceiptV2(current, "authority can only be recorded from PENDING");
  return { ...current, authority, phase: authority.tag === "COMMITTED" ? "COMMITTED" : "PENDING" };
}

function originTransitionV2(current: CompoundOperationReceiptV2, origin: OriginResolutionV2): CompoundOperationReceiptV2 {
  if (origin.viewId !== current.viewId || origin.opId !== current.opId) throw invalidReceiptV2(current, "origin identity mismatch");
  if (current.authority?.tag !== "COMMITTED" || current.phase === "PENDING") {
    throw invalidReceiptV2(current, "origin requires a durable COMMITTED authority receipt");
  }
  if (origin.tag === "APPLIED_EXACT_AT_CUT") {
    assertExactOrigin(origin);
    if (origin.version !== current.authority.revision) throw invalidReceiptV2(current, "exact-cut revision mismatch");
  }
  if (current.origin) {
    if (JSON.stringify(current.origin) === JSON.stringify(origin)) return current;
    throw invalidReceiptV2(current, "origin outcome is immutable");
  }
  return {
    ...current,
    origin,
    ...(origin.tag === "APPLIED_EXACT_AT_CUT" ? {
      originPin: { state: "PINNED" as const, cutId: origin.cutId, witnessDigest: origin.witnessDigest }
    } : {}),
    phase: origin.tag === "APPLIED_EXACT_AT_CUT" ? "APPLIED_EXACT_AT_CUT" : "COMMITTED"
  };
}

function prepareResultTransitionV2(current: CompoundOperationReceiptV2): CompoundOperationReceiptV2 {
  if (current.delivery === "RESULT_PREPARED" || current.delivery === "PROTOCOL_DAMAGED") return current;
  if (current.delivery !== "PENDING" || current.phase !== "APPLIED_EXACT_AT_CUT") {
    throw invalidReceiptV2(current, "RESULT_PREPARED requires APPLIED_EXACT_AT_CUT and live delivery");
  }
  try {
    if (current.authority?.tag !== "COMMITTED" || !isCompleteAuthorityCommittedReceiptV2(current.authority)
      || current.origin?.tag !== "APPLIED_EXACT_AT_CUT"
      || current.originPin?.state !== "PINNED"
      || current.originPin.cutId !== current.origin.cutId
      || current.originPin.witnessDigest !== current.origin.witnessDigest) {
      return { ...current, delivery: "PROTOCOL_DAMAGED" };
    }
    assertExactOrigin(current.origin);
    return { ...current, delivery: "RESULT_PREPARED" };
  } catch {
    return { ...current, delivery: "PROTOCOL_DAMAGED" };
  }
}

function acknowledgementWithoutTerminal(
  current: CompoundOperationReceiptV2,
  input: DeliveryAcknowledgementInputV2
): Omit<ImmutableReceiptAcknowledgementV2, "terminalLSN"> {
  const authority = current.authority;
  const origin = current.origin;
  if (authority?.tag !== "COMMITTED" || !isCompleteAuthorityCommittedReceiptV2(authority)
    || origin?.tag !== "APPLIED_EXACT_AT_CUT") throw protocol("complete authority and exact origin required", current);
  const tuple = authority.integrityTuple;
  return {
    viewId: current.viewId,
    workspaceId: current.workspaceId,
    opId: current.opId,
    epochToken: origin.witness.epochToken,
    revision: authority.revision,
    commitSha: authority.commitSha,
    canonicalEventDigest: tuple.canonicalEventDigest,
    changeSetDigest: tuple.changeSetDigest,
    semanticMutationSetDigest: tuple.semanticMutationSetDigest,
    actorAxesBindingDigest: tuple.actorAxesBindingDigest,
    affectedDigest: origin.verifiedAffectedDigest,
    cutId: origin.cutId,
    cutKind: origin.cutKind,
    cutJournalLSN: origin.cutJournalLSN,
    witnessDigest: origin.witnessDigest,
    ...(origin.writerExclusionId === undefined ? {} : { writerExclusionId: origin.writerExclusionId }),
    waiterId: current.waiterId,
    preparedSequence: input.preparedSequence,
    preparedReceiptDigest: input.preparedReceiptDigest
  };
}

function assertExactOrigin(origin: Extract<OriginResolutionV2, { readonly tag: "APPLIED_EXACT_AT_CUT" }>): void {
  assertHistoricalExcludedSetWitnessV1(origin.witness);
  if (origin.cutKind !== "WRITE_EXCLUDED" || origin.witnessDigest !== origin.witness.canonicalWitnessDigest
    || origin.cutId !== origin.witness.cutId || origin.version !== origin.witness.revision
    || origin.cutJournalLSN !== origin.witness.cutJournalLSN
    || origin.verifiedAffectedDigest !== origin.witness.affectedDigest
    || origin.writerExclusionId !== origin.witness.writerExclusionId) {
    throw new Error("COMPOUND_EXACT_ORIGIN_WITNESS_MISMATCH");
  }
}

function protocolDamageTransitionV2(
  current: CompoundOperationReceiptV2,
  delivery: "PROTOCOL_DAMAGED",
  reason: string
): CompoundOperationReceiptV2 {
  if (!reason.trim()) throw invalidReceiptV2(current, `${delivery} requires a reason`);
  if (current.delivery === delivery) return current;
  if (current.delivery === "ACK_COMMITTED" || current.delivery === "DETACHED") {
    throw invalidReceiptV2(current, `terminal delivery ${current.delivery} cannot become ${delivery}`);
  }
  return { ...current, delivery };
}

function leaseTransitionV2(current: CompoundOperationReceiptV2, state: CurrentLeaseState): CompoundOperationReceiptV2 {
  if (current.currentLease === state) return current;
  if (current.currentLease === "REVOKED" && state === "SATISFIED") throw invalidReceiptV2(current, "a revoked current lease cannot be resurrected");
  return { ...current, currentLease: state };
}

async function requiredReceiptV2(store: CompoundReceiptStoreV2, identity: ReceiptIdentityV2): Promise<CompoundOperationReceiptV2> {
  const receipt = await store.get(identity);
  if (!receipt) throw invalidIdentity(identity, "receipt not initialized");
  return receipt;
}

function assertScope(scope: WaiterScope): void {
  requiredCompoundText(scope.workspaceId, "workspaceId");
  requiredCompoundText(scope.viewId, "viewId");
  requiredCompoundText(scope.opId, "opId");
}

function requiredCompoundText(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new CompoundReceiptTransitionError(`${field} is required`);
  return value;
}

function protocol(message: string, receipt: CompoundOperationReceiptV2): CompoundReceiptProtocolError {
  return new CompoundReceiptProtocolError(`${message} (waiter=${receipt.waiterId}, delivery=${receipt.delivery})`);
}

function invalidReceiptV2(current: CompoundOperationReceiptV2, message: string): CompoundReceiptTransitionError {
  return new CompoundReceiptTransitionError(`${message} (waiter=${current.waiterId}, phase=${current.phase}, delivery=${current.delivery})`);
}

function invalidIdentity(identity: ReceiptIdentityV2, message: string): CompoundReceiptTransitionError {
  return new CompoundReceiptTransitionError(`${message} (waiter=${identity.waiterId})`);
}

import {
  createCompoundReceiptWireBrokerV1,
  type AuthorityCommittedReceipt,
  type AuthorityOperationReceipt,
  type CompoundOperationReceiptV2,
  type CompoundReceiptServiceV2,
  type CompoundReceiptWireBrokerV1,
  type ReceiptIdentityV2
} from "@harness-anything/application";
import { materializationWitnessToAppliedExactAtCutV2 } from "./compound-receipt-witness.ts";
import { ReplicaBroker } from "./replica-broker.ts";
import type { BrokerBarrierResult, BrokerDurableState } from "./types.ts";

export interface BrokerCompoundReceiptCoordinatorV2 {
  readonly wire: CompoundReceiptWireBrokerV1;
  readonly recordAuthorityAndResolve: (
    identity: ReceiptIdentityV2,
    authority: AuthorityOperationReceipt
  ) => Promise<CompoundOperationReceiptV2>;
  readonly detach: (identity: ReceiptIdentityV2, reason: string) => Promise<CompoundOperationReceiptV2>;
}

export function createBrokerCompoundReceiptCoordinatorV2(options: {
  readonly broker: ReplicaBroker;
  readonly receipts: CompoundReceiptServiceV2;
}): BrokerCompoundReceiptCoordinatorV2 {
  return {
    wire: createCompoundReceiptWireBrokerV1(options.receipts),
    recordAuthorityAndResolve,
    detach: (identity, reason) => options.receipts.detach(identity, reason)
  };

  async function recordAuthorityAndResolve(
    identity: ReceiptIdentityV2,
    authority: AuthorityOperationReceipt
  ): Promise<CompoundOperationReceiptV2> {
    let current = await options.receipts.recordAuthority(identity, authority);
    if (authority.tag !== "COMMITTED") return current;

    const brokerState = await options.broker.synchronize();
    if (brokerState.workspaceId !== authority.workspaceId) {
      return options.receipts.markProtocolDamaged(identity, "broker workspace does not match authority receipt");
    }
    if (brokerState.resolvedCursor > authority.revision) {
      return options.receipts.recordOrigin(identity, {
        tag: "SUPERSEDED",
        viewId: identity.viewId,
        opId: identity.opId,
        committedVersion: authority.revision,
        visibleVersion: brokerState.resolvedCursor
      });
    }
    if (brokerState.mode !== "READY" || brokerState.resolvedCursor < authority.revision) return current;
    if (brokerState.resolvedCommit !== authority.commitSha) {
      return options.receipts.markProtocolDamaged(identity, "broker revision does not match authority commit");
    }

    const affectedPaths = exactAffectedPaths(brokerState, authority);
    const barrier = await options.broker.barrier({ paths: affectedPaths, targetRevision: authority.revision });
    current = await recordBarrierResult(identity, authority, barrier, current);
    return current.origin?.tag === "APPLIED_EXACT_AT_CUT"
      ? options.receipts.prepareResult(identity)
      : current;
  }

  async function recordBarrierResult(
    identity: ReceiptIdentityV2,
    authority: AuthorityCommittedReceipt,
    barrier: BrokerBarrierResult,
    currentReceipt: CompoundOperationReceiptV2
  ): Promise<CompoundOperationReceiptV2> {
    if (barrier.tag === "SATISFIED_EXACT_AT_CUT") {
      if (barrier.witness.revision > authority.revision) {
        return options.receipts.recordOrigin(identity, {
          tag: "SUPERSEDED",
          viewId: identity.viewId,
          opId: identity.opId,
          committedVersion: authority.revision,
          visibleVersion: barrier.witness.revision
        });
      }
      if (barrier.witness.revision < authority.revision) {
        return options.receipts.markProtocolDamaged(identity, "broker witness revision does not match authority receipt");
      }
      return options.receipts.recordOrigin(identity, materializationWitnessToAppliedExactAtCutV2({
        witness: barrier.witness,
        viewId: identity.viewId,
        opId: identity.opId
      }));
    }
    if (barrier.tag === "LOCAL_CONFLICT") {
      const conflictIds = barrier.paths.map((pathName) => options.broker.pathState(pathName)?.conflictId);
      if (conflictIds.some((conflictId) => conflictId === undefined)) {
        return options.receipts.markProtocolDamaged(identity, "broker conflict lacks a durable conflict identifier");
      }
      return options.receipts.recordOrigin(identity, {
        tag: "LOCAL_CONFLICT",
        viewId: identity.viewId,
        opId: identity.opId,
        conflictIds: conflictIds as string[]
      });
    }
    if (barrier.tag === "APPLY_BLOCKED") {
      const reasons = barrier.paths.map((pathName) => options.broker.pathState(pathName)?.applyBlockedReason);
      if (reasons.some((reason) => reason === undefined)) {
        return options.receipts.markProtocolDamaged(identity, "broker apply block lacks a durable reason");
      }
      return options.receipts.recordOrigin(identity, {
        tag: "APPLY_BLOCKED",
        viewId: identity.viewId,
        opId: identity.opId,
        reasons: reasons as string[]
      });
    }
    if (barrier.tag === "NONQUIESCENT") {
      return options.receipts.recordOrigin(identity, {
        tag: "NONQUIESCENT",
        viewId: identity.viewId,
        opId: identity.opId,
        writerSetReason: "broker could not establish the required writer exclusion"
      });
    }
    return currentReceipt;
  }
}

function exactAffectedPaths(
  state: BrokerDurableState,
  authority: AuthorityCommittedReceipt
): ReadonlyArray<string> {
  return Object.entries(state.paths)
    .filter(([, pathState]) => pathState.canonicalHidden.revision === authority.revision
      && (pathState.canonicalHidden.lastChangeOpIds
        ?? (pathState.canonicalHidden.lastChangeOpId === null
          ? []
          : [pathState.canonicalHidden.lastChangeOpId]))
        .includes(authority.opId)
      && pathState.canonicalHidden.commitSha === authority.commitSha)
    .map(([pathName]) => pathName)
    .sort();
}

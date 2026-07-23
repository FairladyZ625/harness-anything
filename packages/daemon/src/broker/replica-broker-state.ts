import type { ReplicaChangeRecord } from "@harness-anything/application";
import { replicaChangeOperationIdsForPath } from "../authority/replica-change-operation-paths.ts";
import type { ConflictReason } from "./conflict-store.ts";
import { sameFingerprint, tombstoneFingerprint } from "./fingerprint.ts";
import type {
  BrokerPathState,
  BrokerResyncTarget,
  BrokerVersion,
  ManagedFingerprint
} from "./types.ts";

export const maxRemoteResyncTransitionsPerSynchronization = 3;

export function sameResyncTarget(
  left: BrokerResyncTarget | undefined,
  right: BrokerResyncTarget
): boolean {
  return left?.epoch === right.epoch
    && left.revision === right.revision
    && left.commitSha === right.commitSha
    && JSON.stringify(left.cutChange) === JSON.stringify(right.cutChange);
}

export function versionFor(
  change: ReplicaChangeRecord | null,
  pathName: string,
  fingerprint: ManagedFingerprint,
  epoch: string,
  revision: number,
  commitSha: string
): BrokerVersion {
  const operationIds = change ? replicaChangeOperationIdsForPath(change, pathName) : [];
  return {
    epoch,
    revision,
    lastChangeOpIds: operationIds,
    lastChangeOpId: operationIds[0] ?? null,
    commitSha,
    fingerprint
  };
}

export function localTombstone(epoch: string): BrokerVersion {
  return {
    epoch,
    revision: 0,
    lastChangeOpIds: [],
    lastChangeOpId: null,
    commitSha: null,
    fingerprint: tombstoneFingerprint()
  };
}

export function sameVersion(left: BrokerVersion, right: BrokerVersion): boolean {
  return left.epoch === right.epoch
    && left.revision === right.revision
    && JSON.stringify(versionOperationIds(left)) === JSON.stringify(versionOperationIds(right))
    && left.commitSha === right.commitSha
    && sameFingerprint(left.fingerprint, right.fingerprint);
}

export function versionOperationIds(version: BrokerVersion): ReadonlyArray<string> {
  return version.lastChangeOpIds
    ?? (version.lastChangeOpId === null ? [] : [version.lastChangeOpId]);
}

export function mapConflictReason(reason: string): ConflictReason {
  return reason === "RECOVERY_GENERATION_AMBIGUOUS"
    ? "RECOVERY_GENERATION_AMBIGUOUS"
    : "PRECHECK_FINGERPRINT_MISMATCH";
}

export function isSubmittableDraft(pathState: BrokerPathState): boolean {
  return hasPathStatus(pathState, "DIRTY") || hasPathStatus(pathState, "LOCAL_ONLY");
}

export function hasPathStatus(
  pathState: BrokerPathState,
  expected: BrokerPathState["status"]
): boolean {
  return pathState.status === expected;
}

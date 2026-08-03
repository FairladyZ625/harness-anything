import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface DaemonRepositoryServiceStatus {
  readonly state:
    | "served-by-connected-daemon"
    | "served-by-other-daemon"
    | "served-by-unknown-daemon"
    | "not-served"
    | "lock-record-unavailable";
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly daemon: {
    readonly pid: number | null;
    readonly hostname: string | null;
    readonly userRoot: string | null;
    readonly endpoint: string | null;
    readonly connected: boolean;
  } | null;
  readonly reason: string;
}

export function readDaemonRepositoryLock(lockPath: string): Record<string, unknown> {
  if (!existsSync(lockPath)) return { started: false, lockPath, lockRecordState: "absent" };
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    if (!validLockRecord(lock)) {
      return { started: false, lockPath, lockRecordState: "publishing-or-invalid" };
    }
    return {
      started: lock.ownerKind === "daemon",
      lockPath,
      lockRecordState: "complete",
      pid: lock.pid,
      hostname: lock.hostname,
      heartbeatAt: lock.heartbeatAt,
      ownerKind: lock.ownerKind,
      ownerToken: lock.ownerToken,
      repoId: lock.repoId,
      canonicalRoot: lock.canonicalRoot,
      userRoot: lock.userRoot,
      endpoint: lock.endpoint
    };
  } catch {
    return { started: false, lockPath, lockRecordState: "publishing-or-invalid" };
  }
}

export function projectDaemonRepositoryService(input: {
  readonly requestedRepoId: string;
  readonly canonicalRoot: string;
  readonly connectedUserRoot: string;
  readonly connectedEndpoint: string;
  readonly reachableStatus?: Record<string, unknown>;
  readonly lockStatus: Record<string, unknown>;
}): DaemonRepositoryServiceStatus {
  const lockIsDaemon = input.lockStatus.ownerKind === "daemon";
  const lockRecordState = stringField(input.lockStatus, "lockRecordState");
  const lockRepoId = stringField(input.lockStatus, "repoId");
  const lockRoot = stringField(input.lockStatus, "canonicalRoot");
  const lockUserRoot = stringField(input.lockStatus, "userRoot");
  const lockEndpoint = stringField(input.lockStatus, "endpoint");
  const connectedRepo = reachableRepo(input.reachableStatus, input.canonicalRoot, input.requestedRepoId);
  const connectedService = recordField(input.reachableStatus, "service");
  const reachable = input.reachableStatus !== undefined;
  const provenanceNamesOther = lockIsDaemon && (
    lockEndpoint !== undefined && !sameResolvedPath(lockEndpoint, input.connectedEndpoint)
      || lockUserRoot !== undefined && !sameResolvedPath(lockUserRoot, input.connectedUserRoot)
  );
  const provenanceMatchesConnected = lockIsDaemon && reachable && !provenanceNamesOther && (
    connectedRepo !== undefined
      || lockEndpoint !== undefined && sameResolvedPath(lockEndpoint, input.connectedEndpoint)
      || lockUserRoot !== undefined && sameResolvedPath(lockUserRoot, input.connectedUserRoot)
  );
  const repoId = lockRepoId ?? (connectedRepo ? stringField(connectedRepo, "repoId") : undefined) ?? input.requestedRepoId;

  if (lockRecordState === "publishing-or-invalid") {
    return {
      state: "lock-record-unavailable",
      repoId,
      canonicalRoot: input.canonicalRoot,
      daemon: null,
      reason: "The repository lock record is currently publishing or invalid, so daemon ownership cannot yet be proven."
    };
  }
  if (lockIsDaemon) {
    const state = provenanceNamesOther
      ? "served-by-other-daemon"
      : provenanceMatchesConnected
        ? "served-by-connected-daemon"
        : "served-by-unknown-daemon";
    return {
      state,
      repoId,
      canonicalRoot: lockRoot ?? input.canonicalRoot,
      daemon: {
        pid: numberField(input.lockStatus, "pid") ?? numberField(connectedService, "pid") ?? null,
        hostname: stringField(input.lockStatus, "hostname") ?? null,
        userRoot: lockUserRoot ?? stringField(connectedService, "userRoot") ?? null,
        endpoint: lockEndpoint ?? stringField(connectedService, "endpoint") ?? null,
        connected: provenanceMatchesConnected
      },
      reason: state === "served-by-connected-daemon"
        ? "This repository is attached to the reachable daemon."
        : state === "served-by-other-daemon"
          ? "This repository lock is owned by a daemon outside the selected userRoot/endpoint."
          : "A daemon owns this repository, but the legacy lock record does not identify its userRoot or endpoint."
    };
  }
  if (connectedRepo && stringField(connectedRepo, "state") === "attached") {
    return {
      state: "served-by-connected-daemon",
      repoId,
      canonicalRoot: input.canonicalRoot,
      daemon: {
        pid: numberField(connectedService, "pid") ?? null,
        hostname: null,
        userRoot: stringField(connectedService, "userRoot") ?? input.connectedUserRoot,
        endpoint: stringField(connectedService, "endpoint") ?? input.connectedEndpoint,
        connected: true
      },
      reason: "The reachable daemon reports this repository as attached; its lock record is not daemon-shaped."
    };
  }
  return {
    state: "not-served",
    repoId,
    canonicalRoot: input.canonicalRoot,
    daemon: null,
    reason: reachable
      ? "A daemon is reachable at the selected endpoint, but it does not serve this repository."
      : "No daemon lock or reachable daemon proves service for this repository."
  };
}

function reachableRepo(
  status: Record<string, unknown> | undefined,
  canonicalRoot: string,
  repoId: string
): Record<string, unknown> | undefined {
  if (!status || !Array.isArray(status.repos)) return undefined;
  return status.repos
    .filter(isRepositoryStatusRecord)
    .find((repo) => stringField(repo, "repoId") === repoId
      || sameResolvedPath(stringField(repo, "canonicalRoot"), canonicalRoot));
}

function sameResolvedPath(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  return canonicalExistingPath(left) === canonicalExistingPath(right);
}

function canonicalExistingPath(value: string): string {
  const resolved = path.resolve(value);
  return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
}

function validLockRecord(lock: Record<string, unknown>): boolean {
  return typeof lock.pid === "number"
    && typeof lock.hostname === "string"
    && typeof lock.acquiredAt === "string"
    && typeof lock.heartbeatAt === "string"
    && typeof lock.ownerToken === "string";
}

function recordField(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const field = value?.[key];
  return isRepositoryStatusRecord(field) ? field : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" && Number.isSafeInteger(field) ? field : undefined;
}

function isRepositoryStatusRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

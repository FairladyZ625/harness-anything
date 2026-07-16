import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync
} from "node:fs";
import path from "node:path";
import type {
  AuthorityOperationRegistry,
  AuthorityStoredOperationRecord,
  ReplicaChangeLog,
  ReplicaChangeRecord
} from "../../../application/src/index.ts";
import { stableStringify } from "../../../kernel/src/index.ts";

const serviceStateSchema = "authority-service-state/v1" as const;

interface DurableStateEnvelope {
  readonly schema: typeof serviceStateSchema;
  readonly table: "operation" | "replica-change" | "binding" | "namespace";
  readonly key: string;
  readonly value: unknown;
}

export interface DurableAuthorityStateTable {
  readonly get: <Value>(key: string) => Value | undefined;
  readonly put: (key: string, value: unknown) => void;
  readonly entries: <Value>() => ReadonlyArray<readonly [string, Value]>;
}

export interface DurableAuthorityServiceState {
  readonly stateDirectory: string;
  readonly operationRegistry: AuthorityOperationRegistry;
  readonly replicaChangeLog: ReplicaChangeLog;
  readonly bindingState: DurableAuthorityStateTable;
  readonly namespaceState: DurableAuthorityStateTable;
  readonly close: () => Promise<void>;
}

/**
 * Opens restart-recoverable daemon service state. All logs are replayed before
 * this function returns, so lifecycle serve cannot race recovery.
 */
export function openDurableAuthorityServiceState(input: {
  readonly serviceStateRoot: string;
  readonly repoId: string;
}): DurableAuthorityServiceState {
  const repoId = requiredKey(input.repoId, "repoId");
  const stateDirectory = path.join(
    path.resolve(input.serviceStateRoot),
    "authority",
    Buffer.from(repoId, "utf8").toString("base64url")
  );
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const operationLog = openLog(stateDirectory, "operations.jsonl", "operation");
  const replicaLog = openLog(stateDirectory, "replica-changes.jsonl", "replica-change");
  const bindingLog = openLog(stateDirectory, "bindings.jsonl", "binding");
  const namespaceLog = openLog(stateDirectory, "namespaces.jsonl", "namespace");
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) throw new Error("AUTHORITY_SERVICE_STATE_CLOSED");
  };

  const operationRegistry: AuthorityOperationRegistry = {
    get: async (workspaceId, opId) => {
      ensureOpen();
      return operationLog.values.get(compoundKey(workspaceId, opId)) as AuthorityStoredOperationRecord | undefined;
    },
    put: async (record) => {
      ensureOpen();
      validateStoredOperation(record);
      operationLog.append(compoundKey(record.workspaceId, record.opId), record);
    }
  };

  const replicaChangeLog: ReplicaChangeLog = {
    append: async (record) => {
      ensureOpen();
      validateReplicaChange(record);
      const operationKey = compoundKey(record.workspaceId, record.opId);
      const known = [...replicaLog.values.values()].find((candidate) => {
        const row = candidate as ReplicaChangeRecord;
        return compoundKey(row.workspaceId, row.opId) === operationKey;
      }) as ReplicaChangeRecord | undefined;
      if (known) {
        if (stableStringify(known) !== stableStringify(record)) {
          throw new Error(`AUTHORITY_REPLICA_CHANGE_CONFLICT:${record.workspaceId}:${record.opId}`);
        }
        return;
      }
      const latest = latestReplica(replicaLog.values, record.workspaceId);
      const expectedRevision = (latest?.revision ?? 0) + 1;
      if (record.revision !== expectedRevision || (latest && record.previousCommit !== latest.commitSha)) {
        throw new Error(`AUTHORITY_REPLICA_CHANGE_GAP:${record.workspaceId}:${record.revision}`);
      }
      replicaLog.append(compoundKey(record.workspaceId, String(record.revision)), record);
    },
    latest: async (workspaceId) => {
      ensureOpen();
      return latestReplica(replicaLog.values, workspaceId);
    },
    getByOperation: async (workspaceId, opId) => {
      ensureOpen();
      return [...replicaLog.values.values()].find((candidate) => {
        const row = candidate as ReplicaChangeRecord;
        return row.workspaceId === workspaceId && row.opId === opId;
      }) as ReplicaChangeRecord | undefined;
    },
    changesAfter: async (workspaceId, revision) => {
      ensureOpen();
      return [...replicaLog.values.values()]
        .filter((candidate): candidate is ReplicaChangeRecord => {
          const row = candidate as ReplicaChangeRecord;
          return row.workspaceId === workspaceId && row.revision > revision;
        })
        .sort((left, right) => left.revision - right.revision);
    }
  };

  return {
    stateDirectory,
    operationRegistry,
    replicaChangeLog,
    bindingState: stateTable(bindingLog, ensureOpen),
    namespaceState: stateTable(namespaceLog, ensureOpen),
    close: async () => {
      closed = true;
    }
  };
}

function openLog(
  stateDirectory: string,
  fileName: string,
  table: DurableStateEnvelope["table"]
): {
  readonly values: Map<string, unknown>;
  readonly append: (key: string, value: unknown) => void;
} {
  const logPath = path.join(stateDirectory, fileName);
  const values = new Map<string, unknown>();
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line) continue;
      let envelope: DurableStateEnvelope;
      try {
        envelope = JSON.parse(line) as DurableStateEnvelope;
      } catch {
        throw new Error(`AUTHORITY_SERVICE_STATE_INVALID_JSON:${fileName}:${index + 1}`);
      }
      if (envelope.schema !== serviceStateSchema || envelope.table !== table || !envelope.key) {
        throw new Error(`AUTHORITY_SERVICE_STATE_INVALID_ROW:${fileName}:${index + 1}`);
      }
      values.set(envelope.key, envelope.value);
    }
  }
  return {
    values,
    append: (key, value) => {
      const envelope: DurableStateEnvelope = { schema: serviceStateSchema, table, key, value };
      const fd = openSync(logPath, "a", 0o600);
      try {
        writeSync(fd, `${stableStringify(envelope)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      syncDirectory(stateDirectory);
      values.set(key, value);
    }
  };
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function stateTable(
  log: ReturnType<typeof openLog>,
  ensureOpen: () => void
): DurableAuthorityStateTable {
  return {
    get: <Value>(key: string) => {
      ensureOpen();
      return log.values.get(requiredKey(key, "state key")) as Value | undefined;
    },
    put: (key, value) => {
      ensureOpen();
      log.append(requiredKey(key, "state key"), value);
    },
    entries: <Value>() => {
      ensureOpen();
      return [...log.values.entries()] as ReadonlyArray<readonly [string, Value]>;
    }
  };
}

function latestReplica(values: ReadonlyMap<string, unknown>, workspaceId: string): ReplicaChangeRecord | undefined {
  return [...values.values()]
    .filter((candidate): candidate is ReplicaChangeRecord => (candidate as ReplicaChangeRecord).workspaceId === workspaceId)
    .sort((left, right) => right.revision - left.revision)[0];
}

function validateStoredOperation(record: AuthorityStoredOperationRecord): void {
  requiredKey(record.workspaceId, "workspaceId");
  requiredKey(record.opId, "opId");
  requiredKey(record.semanticDigest, "semanticDigest");
}

function validateReplicaChange(record: ReplicaChangeRecord): void {
  if (record.schema !== "replica-change/v1") throw new Error("AUTHORITY_REPLICA_CHANGE_SCHEMA_INVALID");
  requiredKey(record.workspaceId, "workspaceId");
  requiredKey(record.opId, "opId");
  if (!Number.isInteger(record.revision) || record.revision <= 0) throw new Error("AUTHORITY_REPLICA_CHANGE_REVISION_INVALID");
}

function compoundKey(left: string, right: string): string {
  return `${requiredKey(left, "key part")}\0${requiredKey(right, "key part")}`;
}

function requiredKey(value: string, name: string): string {
  if (!value || value.trim() !== value || value.includes("\0")) throw new Error(`AUTHORITY_SERVICE_STATE_KEY_INVALID:${name}`);
  return value;
}

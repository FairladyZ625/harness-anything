// @slice-activation PLT-Boundary W2 exports daemon-owned production authority durable state to CLI composition consumers.
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
import { authorityFixedOperationBindingMatchesV1 } from "@harness-anything/application";
import type {
  AuthorityOperationRegistry,
  AuthorityStoredOperationRecord,
  ReplicaChangeLog,
  ReplicaChangeRecord
} from "@harness-anything/application";
import { stableStringify } from "@harness-anything/kernel";

const serviceStateSchema = "authority-service-state/v1" as const;
const operationTransitionSchema = "authority-operation-transition-batch/v1" as const;
const replayProgressRowInterval = 2_048;

interface DurableStateEnvelope {
  readonly schema: typeof serviceStateSchema;
  readonly table: "operation" | "replica-change" | "binding" | "namespace" | "cutover" | "replication";
  readonly key: string;
  readonly value: unknown;
}

interface DurableOperationTransitionEnvelope {
  readonly schema: typeof operationTransitionSchema;
  readonly table: "operation";
  readonly transitions: ReadonlyArray<{
    readonly key: string;
    readonly semanticDigest: string;
    readonly state: AuthorityStoredOperationRecord["state"];
    readonly receipt?: AuthorityStoredOperationRecord["receipt"];
    readonly commitSha?: string;
  }>;
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
  readonly cutoverState: DurableAuthorityStateTable;
  readonly replicationState: DurableAuthorityStateTable;
  readonly close: () => Promise<void>;
}

export interface DurableAuthorityServiceStateReplayProgress {
  readonly fileName: string;
  readonly table: DurableStateEnvelope["table"];
  readonly replayedRows: number;
}

/**
 * Opens restart-recoverable daemon service state. All logs are replayed before
 * this function returns, so lifecycle serve cannot race recovery.
 */
export function openDurableAuthorityServiceState(input: {
  readonly serviceStateRoot: string;
  readonly repoId: string;
  readonly onReplayProgress?: (
    progress: DurableAuthorityServiceStateReplayProgress
  ) => void;
}): DurableAuthorityServiceState {
  const repoId = requiredKey(input.repoId, "repoId");
  const stateDirectory = path.join(
    path.resolve(input.serviceStateRoot),
    "authority",
    Buffer.from(repoId, "utf8").toString("base64url")
  );
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const operationLog = openLog(
    stateDirectory,
    "operations.jsonl",
    "operation",
    input.onReplayProgress
  );
  const replicaLog = openLog(
    stateDirectory,
    "replica-changes.jsonl",
    "replica-change",
    input.onReplayProgress
  );
  for (const [key, value] of replicaLog.values) {
    const normalized = normalizePersistedReplicaChange(value);
    validateReplicaChange(normalized);
    replicaLog.values.set(key, normalized);
  }
  const bindingLog = openLog(
    stateDirectory,
    "bindings.jsonl",
    "binding",
    input.onReplayProgress
  );
  const namespaceLog = openLog(
    stateDirectory,
    "namespaces.jsonl",
    "namespace",
    input.onReplayProgress
  );
  const cutoverLog = openLog(
    stateDirectory,
    "cutover.jsonl",
    "cutover",
    input.onReplayProgress
  );
  const replicationLog = openLog(
    stateDirectory,
    "replication.jsonl",
    "replication",
    input.onReplayProgress
  );
  const replicaListeners = new Map<string, Set<(record: ReplicaChangeRecord) => void>>();
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
    },
    putMany: async (records) => {
      ensureOpen();
      records.forEach(validateStoredOperation);
      operationLog.appendTransitions(records.map((record) => ({
        key: compoundKey(record.workspaceId, record.opId),
        semanticDigest: record.semanticDigest,
        state: record.state,
        ...(record.receipt ? { receipt: record.receipt } : {}),
        ...(record.commitSha ? { commitSha: record.commitSha } : {})
      })));
    },
    list: async (workspaceId) => {
      ensureOpen();
      return [...operationLog.values.values()]
        .filter((candidate): candidate is AuthorityStoredOperationRecord =>
          (candidate as AuthorityStoredOperationRecord).workspaceId === workspaceId)
        .sort((left, right) => left.opId.localeCompare(right.opId));
    }
  };

  const replicaChangeLog: ReplicaChangeLog = {
    append: async (record) => {
      ensureOpen();
      const normalized = normalizeReplicaChange(record);
      validateReplicaChange(normalized);
      const known = [...replicaLog.values.values()].find((candidate) => {
        const row = candidate as ReplicaChangeRecord;
        return row.workspaceId === normalized.workspaceId
          && row.operations.some((operation) => normalized.operations.some((incoming) => incoming.opId === operation.opId));
      }) as ReplicaChangeRecord | undefined;
      if (known) {
        if (stableStringify(known) !== stableStringify(normalized)) {
          throw new Error(`AUTHORITY_REPLICA_CHANGE_CONFLICT:${record.workspaceId}:${record.opId}`);
        }
        return;
      }
      const latest = latestReplica(replicaLog.values, record.workspaceId);
      const expectedRevision = (latest?.revision ?? 0) + 1;
      if (record.revision !== expectedRevision) {
        throw new Error(`AUTHORITY_REPLICA_CHANGE_GAP:${record.workspaceId}:${record.revision}`);
      }
      replicaLog.append(compoundKey(record.workspaceId, String(record.revision)), normalized);
      for (const listener of replicaListeners.get(record.workspaceId) ?? []) listener(structuredClone(normalized));
    },
    latest: async (workspaceId) => {
      ensureOpen();
      return latestReplica(replicaLog.values, workspaceId);
    },
    getByOperation: async (workspaceId, opId) => {
      ensureOpen();
      return [...replicaLog.values.values()].find((candidate) => {
        const row = candidate as ReplicaChangeRecord;
        return row.workspaceId === workspaceId && row.operations.some((operation) => operation.opId === opId);
      }) as ReplicaChangeRecord | undefined;
    },
    getByCommit: async (workspaceId, commitSha) => {
      ensureOpen();
      return [...replicaLog.values.values()].find((candidate) => {
        const row = candidate as ReplicaChangeRecord;
        return row.workspaceId === workspaceId && row.commitSha === commitSha;
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
    },
    subscribe: (workspaceId, listener) => {
      ensureOpen();
      const listeners = replicaListeners.get(workspaceId) ?? new Set();
      listeners.add(listener);
      replicaListeners.set(workspaceId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) replicaListeners.delete(workspaceId);
      };
    }
  };

  return {
    stateDirectory,
    operationRegistry,
    replicaChangeLog,
    bindingState: stateTable(bindingLog, ensureOpen),
    namespaceState: stateTable(namespaceLog, ensureOpen),
    cutoverState: stateTable(cutoverLog, ensureOpen),
    replicationState: stateTable(replicationLog, ensureOpen),
    close: async () => {
      closed = true;
    }
  };
}

function openLog(
  stateDirectory: string,
  fileName: string,
  table: DurableStateEnvelope["table"],
  onReplayProgress?: (
    progress: DurableAuthorityServiceStateReplayProgress
  ) => void
): {
  readonly values: Map<string, unknown>;
  readonly append: (key: string, value: unknown) => void;
  readonly appendTransitions: (transitions: DurableOperationTransitionEnvelope["transitions"]) => void;
} {
  const logPath = path.join(stateDirectory, fileName);
  const values = new Map<string, unknown>();
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, "utf8").split("\n");
    let replayedRows = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line) continue;
      let envelope: DurableStateEnvelope | DurableOperationTransitionEnvelope;
      try {
        envelope = JSON.parse(line) as DurableStateEnvelope | DurableOperationTransitionEnvelope;
      } catch {
        throw new Error(`AUTHORITY_SERVICE_STATE_INVALID_JSON:${fileName}:${index + 1}`);
      }
      if (envelope.schema === operationTransitionSchema) {
        if (table !== "operation" || envelope.table !== "operation" || envelope.transitions.length === 0) {
          throw new Error(`AUTHORITY_SERVICE_STATE_INVALID_ROW:${fileName}:${index + 1}`);
        }
        applyOperationTransitions(values, envelope.transitions, fileName, index + 1);
        replayedRows += 1;
        reportReplayProgress(onReplayProgress, fileName, table, replayedRows);
        continue;
      }
      if (envelope.schema !== serviceStateSchema || envelope.table !== table || !envelope.key) {
        throw new Error(`AUTHORITY_SERVICE_STATE_INVALID_ROW:${fileName}:${index + 1}`);
      }
      values.set(envelope.key, envelope.value);
      replayedRows += 1;
      reportReplayProgress(onReplayProgress, fileName, table, replayedRows);
    }
  }
  return {
    values,
    append: (key, value) => {
      const envelope: DurableStateEnvelope = { schema: serviceStateSchema, table, key, value };
      appendDurableLine(logPath, stateDirectory, envelope);
      values.set(key, value);
    },
    appendTransitions: (transitions) => {
      if (table !== "operation" || transitions.length === 0) return;
      appendDurableLine(logPath, stateDirectory, {
        schema: operationTransitionSchema,
        table: "operation",
        transitions
      });
      applyOperationTransitions(values, transitions, fileName);
    }
  };
}

function reportReplayProgress(
  onReplayProgress: ((progress: DurableAuthorityServiceStateReplayProgress) => void) | undefined,
  fileName: string,
  table: DurableStateEnvelope["table"],
  replayedRows: number
): void {
  if (!onReplayProgress || replayedRows % replayProgressRowInterval !== 0) return;
  onReplayProgress({ fileName, table, replayedRows });
}

function applyOperationTransitions(
  values: Map<string, unknown>,
  transitions: DurableOperationTransitionEnvelope["transitions"],
  fileName: string,
  line?: number
): void {
  for (const transition of transitions) {
    const known = values.get(transition.key) as AuthorityStoredOperationRecord | undefined;
    if (!known || known.semanticDigest !== transition.semanticDigest) {
      throw new Error(`AUTHORITY_SERVICE_STATE_TRANSITION_BASE_MISSING:${fileName}:${line ?? "append"}:${transition.key}`);
    }
    values.set(transition.key, {
      ...known,
      state: transition.state,
      ...(transition.receipt ? { receipt: transition.receipt } : {}),
      ...(transition.commitSha ? { commitSha: transition.commitSha } : {})
    } satisfies AuthorityStoredOperationRecord);
  }
}

function appendDurableLine(
  logPath: string,
  stateDirectory: string,
  envelope: DurableStateEnvelope | DurableOperationTransitionEnvelope
): void {
  const fd = openSync(logPath, "a", 0o600);
  try {
    writeSync(fd, `${stableStringify(envelope)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncAuthorityServiceStateDirectory(stateDirectory);
}

function syncAuthorityServiceStateDirectory(directory: string): void {
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

function normalizeReplicaChange(record: Parameters<ReplicaChangeLog["append"]>[0]): ReplicaChangeRecord {
  const operations = record.operations ?? [{
    opId: record.opId,
    semanticDigest: record.semanticDigest,
    ...(record.authorityIntegrity ? { authorityIntegrity: record.authorityIntegrity } : {})
  }];
  return {
    ...record,
    schema: "replica-change/v2",
    operations,
    manifest: record.manifest ?? {
      digest: `sha256:${record.semanticDigest}`,
      entryCount: record.paths?.filter((entry) => !entry.tombstone).length ?? 0
    },
    paths: record.paths ?? []
  };
}

function normalizePersistedReplicaChange(value: unknown): ReplicaChangeRecord {
  if (!value || typeof value !== "object") throw new Error("AUTHORITY_REPLICA_CHANGE_ROW_INVALID");
  const record = value as Parameters<ReplicaChangeLog["append"]>[0];
  if (record.schema !== "replica-change/v1" && record.schema !== "replica-change/v2") {
    throw new Error("AUTHORITY_REPLICA_CHANGE_SCHEMA_INVALID");
  }
  return normalizeReplicaChange(record);
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
  if (record.recoveryPublicationPolicy !== undefined
    && record.recoveryPublicationPolicy !== "EXACT_FIXED_OPERATION"
    && record.recoveryPublicationPolicy !== "REVALIDATION_REQUIRED") {
    throw new Error("AUTHORITY_STORED_OPERATION_RECOVERY_POLICY_INVALID");
  }
  if (record.canonicalOperation) {
    requiredKey(record.canonicalOperation.opId, "canonical operation opId");
    requiredKey(record.canonicalOperation.entityId, "canonical operation entityId");
    requiredKey(record.canonicalOperation.kind, "canonical operation kind");
    if (record.canonicalOperation.opId !== record.opId
      || !record.authorityIntegrity
      || record.authorityIntegrity.semanticRequestDigest !== record.semanticDigest
      || stableStringify(record.canonicalOperation.authorityIntegrity)
        !== stableStringify(record.authorityIntegrity)) {
      throw new Error("AUTHORITY_STORED_OPERATION_FIXED_MATERIAL_MISMATCH");
    }
    if (record.fixedOperationBinding && (!record.canonicalRequestEnvelope
      || !authorityFixedOperationBindingMatchesV1(record.fixedOperationBinding, {
        repoId: record.fixedOperationBinding.repoId,
        workspaceId: record.workspaceId,
        writerGeneration: record.fixedOperationBinding.writerGeneration,
        authorityGeneration: record.fixedOperationBinding.authorityGeneration,
        opId: record.opId,
        semanticDigest: record.semanticDigest,
        canonicalRequestEnvelope: record.canonicalRequestEnvelope,
        operation: record.canonicalOperation
      }))) {
      throw new Error("AUTHORITY_STORED_OPERATION_FIXED_BINDING_MISMATCH");
    }
  }
}

function validateReplicaChange(record: ReplicaChangeRecord): void {
  if (record.schema !== "replica-change/v2") throw new Error("AUTHORITY_REPLICA_CHANGE_SCHEMA_INVALID");
  requiredKey(record.workspaceId, "workspaceId");
  requiredKey(record.opId, "opId");
  if (!Number.isInteger(record.revision) || record.revision <= 0) throw new Error("AUTHORITY_REPLICA_CHANGE_REVISION_INVALID");
  if (record.operations.length === 0
    || record.operations[0]?.opId !== record.opId
    || record.operations[0]?.semanticDigest !== record.semanticDigest
    || new Set(record.operations.map((operation) => operation.opId)).size !== record.operations.length) {
    throw new Error("AUTHORITY_REPLICA_CHANGE_OPERATION_GROUP_INVALID");
  }
  for (const operation of record.operations) {
    requiredKey(operation.opId, "operation opId");
    requiredKey(operation.semanticDigest, "operation semanticDigest");
  }
}

function compoundKey(left: string, right: string): string {
  return `${requiredKey(left, "key part")}\0${requiredKey(right, "key part")}`;
}

function requiredKey(value: string, name: string): string {
  if (!value || value.trim() !== value || value.includes("\0")) throw new Error(`AUTHORITY_SERVICE_STATE_KEY_INVALID:${name}`);
  return value;
}

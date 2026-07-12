import type { EntityId, TaskId } from "../domain/index.ts";
import type { HarnessLayoutOverrides } from "../layout/index.ts";
import type { VersionControlSystem } from "../ports/version-control-system.ts";
import type { WriteOp } from "../ports/write-coordinator.ts";
import type { ActorAxes, AgentRef, OperationalActor, WriteAttribution } from "../schemas/actor-attribution.ts";
export type { OperationalActor } from "../schemas/actor-attribution.ts";
import type {
  JournalRecordV1Document,
  JournalRecordV2Document
} from "../schemas/write-journal.ts";

export interface JournaledWriteCoordinatorOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly journalPath?: string;
  readonly watermarkPath?: string;
  readonly attribution: WriteAttribution;
  readonly operationalActor?: OperationalActor;
  readonly lockTtlMs?: number;
  readonly lockConflictRetry?: LockConflictRetryOptions;
  readonly heldGlobalLock?: OwnedLock;
  readonly sessionId?: string;
  readonly autoMaterialize?: boolean;
  readonly commitAuthor?: GitCommitAuthor;
  readonly versionControlSystem?: VersionControlSystem;
}

export type JournalRecoveryOptions = Omit<JournaledWriteCoordinatorOptions, "attribution">;
export type OperationalJournaledWriteCoordinatorOptions = JournalRecoveryOptions & {
  readonly operationalActor: OperationalActor;
};

export interface LockConflictRetryOptions {
  readonly maxWaitMs: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}

export interface JournalActor {
  readonly kind: "agent" | "human" | "system";
  readonly id: string;
}

export interface GitCommitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface PayloadRef {
  readonly path: string;
  readonly sha256: string;
}

export type JournalRecordKind = WriteOp["kind"];

export type JournalRecordV1 = JournalRecordV1Document;
export type JournalRecordV2 = JournalRecordV2Document;

export interface LegacyJournalAttribution {
  readonly status: "unresolved";
  readonly source: "legacy";
  readonly principal: null;
  readonly executor: AgentRef | null;
  readonly actor: JournalActor;
}

export type NormalizedJournalRecordV1 = JournalRecordV1 & {
  readonly legacyAttribution: LegacyJournalAttribution;
};

export type ReadableJournalRecord = NormalizedJournalRecordV1 | JournalRecordV2;

// Phase 1 leaves the writer on v1. Call sites that construct new WAL entries
// continue to use this alias until the Phase 3 writer cutover.
export type JournalRecord = JournalRecordV1;

export interface LockTakeoverRecord {
  readonly schema: "lock-takeover/v1";
  readonly actor: OperationalActor;
  readonly at: string;
  readonly lockPath: string;
  readonly oldPid: number;
  readonly reason: string;
}

export interface DeleteAuditRecord {
  readonly schema: "delete-audit/v1";
  readonly opId: string;
  readonly taskId: TaskId;
  readonly kind: "package_delete_hard_applied";
  readonly actor: JournalActor | ActorAxes;
  readonly at: string;
  readonly reason: string;
}

// Durable mark that an op already mutated its target files. Replay skips the file
// writes for marked ops but still commits and watermarks them, so a failure after
// apply is self-healing instead of poisoning every later write (ADR-0016 D1/D2).
export interface ApplyMarkerRecord {
  readonly schema: "apply-marker/v1";
  readonly opId: string;
  readonly entityId: EntityId;
  readonly at: string;
}

export interface WriteWatermark {
  readonly schema: "write-watermark/v1";
  readonly lastCommittedOpIds: ReadonlyArray<string>;
  readonly lastCommitSha: string;
  readonly projectionHash: string;
  readonly updatedAt: string;
}

export interface LockRecord {
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly ownerToken: string;
  readonly ownerKind?: "daemon";
}

export interface OwnedLock {
  readonly path: string;
  readonly ownerToken: string;
  readonly ownerKind?: "daemon";
}

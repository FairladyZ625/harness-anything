import type { EntityId } from "../domain/index.ts";
import type { HarnessLayoutOverrides } from "../layout/index.ts";
import type { VersionControlSystem } from "../ports/version-control-system.ts";
import type { WriteOp } from "../ports/write-coordinator.ts";

export interface JournaledWriteCoordinatorOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly journalPath?: string;
  readonly watermarkPath?: string;
  readonly actor?: JournalActor;
  readonly lockTtlMs?: number;
  readonly lockConflictRetry?: LockConflictRetryOptions;
  readonly heldGlobalLock?: OwnedLock;
  readonly sessionId?: string;
  readonly autoMaterialize?: boolean;
  readonly commitAuthor?: GitCommitAuthor;
  readonly versionControlSystem?: VersionControlSystem;
}

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

export interface JournalRecord {
  readonly schema: "write-journal/v1";
  readonly opId: string;
  readonly entityId: EntityId;
  readonly kind: JournalRecordKind;
  readonly actor: JournalActor;
  readonly at: string;
  readonly payloadRef?: PayloadRef;
  readonly payload?: Record<string, unknown>;
}

export interface LockTakeoverRecord {
  readonly schema: "lock-takeover/v1";
  readonly actor: JournalActor;
  readonly at: string;
  readonly lockPath: string;
  readonly oldPid: number;
  readonly reason: string;
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

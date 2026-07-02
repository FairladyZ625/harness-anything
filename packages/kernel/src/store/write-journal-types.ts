import type { TaskId } from "../domain/index.ts";
import type { HarnessLayoutOverrides } from "../layout/index.ts";
import type { WriteOp } from "../ports/write-coordinator.ts";

export interface JournaledWriteCoordinatorOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly journalPath?: string;
  readonly watermarkPath?: string;
  readonly actor?: JournalActor;
  readonly lockTtlMs?: number;
}

export interface JournalActor {
  readonly kind: "agent" | "human" | "system";
  readonly id: string;
}

export interface PayloadRef {
  readonly path: string;
  readonly sha256: string;
}

export type JournalRecordKind = WriteOp["kind"];

export interface JournalRecord {
  readonly schema: "write-journal/v1";
  readonly opId: string;
  readonly taskId: TaskId;
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

export interface DeleteAuditRecord {
  readonly schema: "delete-audit/v1";
  readonly opId: string;
  readonly taskId: TaskId;
  readonly kind: "package_delete_hard_applied";
  readonly actor: JournalActor;
  readonly at: string;
  readonly reason: string;
}

// Durable mark that a non-idempotent op (delta progress_append) already mutated
// the target file. Replay skips the file write for marked ops but still commits
// and watermarks them, so a crash between apply and watermark cannot append the
// same delta twice (ADR-0016 D2).
export interface ApplyMarkerRecord {
  readonly schema: "apply-marker/v1";
  readonly opId: string;
  readonly taskId: TaskId;
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
}

export interface OwnedLock {
  readonly path: string;
  readonly ownerToken: string;
}

export interface WriterEpochLease {
  readonly repoId: string;
  readonly holderId: string;
  readonly epoch: number;
  readonly version: number;
  readonly issuedAt: string;
}
export interface WriterEpochFenceDescriptor {
  readonly schema: "harness-writer-epoch-fence/v1";
  readonly stateRoot: string;
  readonly repoId: string;
  readonly epoch: number;
  readonly holderId: string;
}
export interface PersistentWriterEpoch {
  readonly acquire: (repoId: string, observedLedgerEpoch?: number) => WriterEpochLease;
  readonly current: (repoId: string) => WriterEpochLease | null;
  readonly highWatermark: (repoId: string) => number;
  readonly retireCurrent: (repoId: string) => void;
  readonly assert: (repoId: string, epoch: number, holderId?: string) => void;
  readonly withAppendFence: <T>(repoId: string, epoch: number, holderId: string, operation: () => T) => T;
  readonly close: () => void;
}
export class WriterEpochError extends Error {
  readonly code:
    | "writer_epoch_stale"
    | "writer_epoch_invalid"
    | "writer_epoch_migration_required"
    | "writer_epoch_legacy_unreadable"
    | "writer_epoch_legacy_unsupported"
    | "writer_epoch_daemon_running";
  constructor(code: WriterEpochError["code"], message: string) {
    super(message);
    this.name = "WriterEpochError";
    this.code = code;
  }
}

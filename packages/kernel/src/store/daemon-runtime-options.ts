export interface DaemonMaterializerBatchOptions {
  readonly dryRun?: boolean;
  readonly sessionId?: string;
}

export interface DaemonDrainOptions {
  readonly drainTimeoutMs?: number;
}

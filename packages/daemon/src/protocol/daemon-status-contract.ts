import { materializationStateWords } from "./daemon-protocol-vocabulary.ts";

export interface DaemonRepoAttachProgress {
  readonly phase: "opening" | "recovering" | "catching-up";
  readonly applied: number | null;
  readonly total: number | null;
  readonly watermark: number | null;
}

export interface DaemonStatusResult {
  readonly ok: true;
  readonly daemonId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly entry: "source" | "dist";
  readonly build: {
    readonly version: string;
    readonly commit: string | null;
    readonly loadedBuildId: string | null;
    readonly diskBuildId: string | null;
    readonly drifted: boolean;
  };
  readonly connections: readonly {
    readonly id: string;
    readonly kind: "local" | "remote-endpoint" | "fleet-center";
    readonly displayName: string;
    readonly state: "enabled" | "disabled";
    readonly endpoint?: string;
  }[];
  readonly repos: readonly {
    readonly repoId: string;
    readonly rootDir: string;
    readonly mode: "local" | "remote-proxy" | "remote-center" | "remote-edge" | null;
    readonly state: "warming" | "attached" | "unavailable" | "closed";
    readonly generation: number | null;
    readonly queueDepth: number | null;
    readonly projectionWatermark?: number;
    readonly ledgerRevision?: number;
    readonly lastError: string | null;
    readonly causeClass: "data-shape" | "infrastructure" | "projection" | null;
    readonly recoveryMs: number | null;
    readonly materialization: {
      readonly state: (typeof materializationStateWords)[number];
      readonly lastCheckpointRevision: number;
      readonly lastCheckpointAt: string | null;
      readonly pendingWalEvents: number;
      readonly retryElapsedMs?: number;
      readonly reason?: "git_diverged" | "deterministic_failure" | "retry_budget_exhausted";
      readonly lastError?: string;
    } | null;
    readonly attach?: DaemonRepoAttachProgress;
  }[];
  readonly summary: string;
}

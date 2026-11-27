import type { EdgeUpgradeOutcome } from "@harness-anything/kernel/browser";

export const EDGE_UPGRADE_STATUS_CHANNEL = "harness:edge-upgrade-status";
export const EDGE_UPGRADE_RUN_CHANNEL = "harness:edge-upgrade-run";
export const EDGE_UPGRADE_RELAUNCH_CHANNEL = "harness:edge-upgrade-relaunch";
export const EDGE_UPGRADE_PROGRESS_EVENT = "harness:edge-upgrade-progress-event";

export type EdgeUpgradeChannelMode = "source" | "packaged";

export type EdgeUpgradeGuiStage =
  | "preflight"
  | "installing"
  | "handing_off"
  | "syncing"
  | "rolling_back"
  | "completed"
  | "rolled_back"
  | "failed";

export interface EdgeUpgradeGuiProgress {
  readonly stage: EdgeUpgradeGuiStage;
  readonly message: string;
  readonly fromCommit?: string | null;
  readonly targetCommit?: string | null;
}

export interface EdgeUpgradeGuiRepoSyncResult {
  readonly repoId: string;
  readonly revision: number | null;
  readonly lagRevisions: number | null;
  readonly mirrorOutcome: string | null;
}

export interface EdgeUpgradeGuiReceipt {
  readonly schema: "edge-upgrade-receipt/v1";
  readonly ok: boolean;
  readonly command: "edge-upgrade";
  readonly outcome: EdgeUpgradeOutcome;
  readonly code?: string;
  readonly installRoot: string | null;
  readonly repoId: string | null;
  readonly fromCommit: string | null;
  readonly toCommit: string | null;
  readonly targetCommit: string | null;
  readonly daemonPid: number | null;
  readonly daemonBuildId: string | null;
  readonly daemonRestarted: boolean;
  readonly syncedRepos: readonly EdgeUpgradeGuiRepoSyncResult[];
  readonly syncSkippedReason?: string;
  readonly rolledBack: boolean;
  readonly rollbackSyncOk?: boolean;
  readonly rollbackError?: string;
  readonly guiRestartRequired: boolean;
  readonly error?: { readonly code: string; readonly hint: string };
  readonly nextAction?: string;
}

export interface EdgeUpgradeGuiStatus {
  readonly mode: EdgeUpgradeChannelMode;
  readonly ok: boolean;
  readonly installRoot: string | null;
  readonly repoId: string | null;
  readonly localCommit: string | null;
  readonly daemonCommit: string | null;
  readonly centerCommit: string | null;
  readonly updateAvailable: boolean;
  readonly canRollback: boolean;
  readonly previousCommit: string | null;
  readonly inProgress: boolean;
  readonly reason?: string;
}

export interface EdgeUpgradeGuiRunInput {
  readonly repoId?: string;
  readonly toRef?: string;
  readonly offline?: boolean;
  readonly rollback?: boolean;
}

export interface EdgeUpgradeGuiApi {
  readonly status: (repoId?: string) => Promise<EdgeUpgradeGuiStatus>;
  readonly run: (input?: EdgeUpgradeGuiRunInput) => Promise<EdgeUpgradeGuiReceipt>;
  readonly relaunch: () => Promise<void>;
  readonly onProgress: (listener: (progress: EdgeUpgradeGuiProgress) => void) => () => void;
}

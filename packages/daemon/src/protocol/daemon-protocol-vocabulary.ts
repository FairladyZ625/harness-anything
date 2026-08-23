import type { DaemonRepoMode } from "../../../kernel/src/index.ts";

export const taskStatusWords = ["planned", "active", "blocked", "in_review", "done", "cancelled"] as const;

export const executionV1StateWords = ["active", "submitted", "changes_requested", "accepted"] as const;

export const executionStateWords = ["active", "submitted", "changes_requested", "accepted", "abandoned"] as const;

export const leasePhaseWords = ["reserving", "held", "orphaned", "released"] as const;

export const relationStateWords = ["active", "edge_retired", "deleted"] as const;

export const packageDispositionWords = ["active", "archived", "tombstoned"] as const;

export const reviewVerdictWords = ["approved", "changes_requested", "dismissed"] as const;

export const decisionStateWords = [
  "proposed",
  "in_effect",
  "rejected",
  "deferred",
  "superseded",
  "outcome_retired",
] as const;

export const receiptOutcomeWords = ["applied", "pending", "indeterminate", "op_rejected"] as const;

export const daemonRepoModeWords = Object.freeze([
  "local",
  "remote-center",
  "remote-edge",
] as const satisfies readonly DaemonRepoMode[]);

export const daemonRepoModeWordsAreExact: [DaemonRepoMode] extends [(typeof daemonRepoModeWords)[number]]
  ? true
  : never = true;

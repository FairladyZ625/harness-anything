import type { WriteCoordinator } from "../../../kernel/src/index.ts";
import {
  createDaemonRuntime,
  createMultiRepoDaemonRuntime,
  makeJournaledWriteCoordinator,
  runLedgerMaterializer
} from "../../../kernel/src/store/index.ts";
import type { AdapterProviderMetadata, LocalWriteCoordinatorOptions } from "./types.ts";

export { collectGitDiffEvidence } from "./git-diff-evidence.ts";
export type { GitDiffEvidenceFile, GitDiffEvidenceOptions, GitDiffEvidenceReport } from "./git-diff-evidence.ts";
export { createDaemonRuntime, createMultiRepoDaemonRuntime, runLedgerMaterializer };
export type { AdapterProviderMetadata, LocalWriteCoordinatorOptions } from "./types.ts";

export const localAdapterProviderMetadata = {
  id: "local",
  capabilities: [
    "task.read",
    "decision.write",
    "fact.write",
    "runtime-event.write",
    "daemon.runtime",
    "materializer.run"
  ],
  readonly: true,
  writable: true,
  defaultProvider: true
} as const satisfies AdapterProviderMetadata;

export function makeLocalWriteCoordinator(options: LocalWriteCoordinatorOptions): WriteCoordinator {
  if (!options.actor) throw new Error("Local write coordinator requires explicit actor attribution.");
  return makeJournaledWriteCoordinator({
    ...options,
    lockConflictRetry: { maxWaitMs: 5_000, initialDelayMs: 25, maxDelayMs: 250 }
  });
}

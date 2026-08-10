import type {
  DaemonCommandHostServices,
  DaemonHostCommand,
  DaemonHostCommandResult
} from "@harness-anything/application";
import type { AuthorityRepoComponent } from "../authority/authority-lifecycle.ts";
import type { AuthenticatedActor } from "../identity/types.ts";
import type { BackgroundRuntimeEventFailure } from "./background-command-runtime-event.ts";
import type { DurableRepoWriteOutcomeStoreV1 } from "./durable-repo-write-outcome-store.ts";
import type { ReceiptSettlementStore } from "./receipt-settlement-store.ts";
import type { RepoWriteAuthorityRecoveryGateOptions } from "./repo-write-authority-recovery-gate.ts";
import type { RepoWriteCommandDto } from "./repo-write-protocol.ts";
import type { RepoWriteDocSyncExecution } from "./repo-write-doc-sync-operation.ts";
import type { HarnessDaemonRuntime } from "./repo-runtime.ts";

export interface ProductionRepoWriteOperationHostOptions<
  Command extends DaemonHostCommand,
  Result extends DaemonHostCommandResult
> {
  readonly repoId: string;
  readonly workspaceId: string;
  readonly generation: number;
  readonly runtime: HarnessDaemonRuntime;
  readonly authorityComponent: AuthorityRepoComponent;
  readonly hostServices: DaemonCommandHostServices<Command, Result, AuthenticatedActor>;
  readonly outcomeStore: DurableRepoWriteOutcomeStoreV1;
  readonly settlementStore: ReceiptSettlementStore;
  readonly resolveHistoricalPublication?: RepoWriteAuthorityRecoveryGateOptions["resolveHistoricalPublication"];
  readonly recoverHistoricalCommittedReceipt?: RepoWriteAuthorityRecoveryGateOptions["recoverHistoricalCommittedReceipt"];
  readonly executeDocSyncSubmit?: (input: {
    readonly command: RepoWriteCommandDto;
    readonly decoded: ReturnType<typeof import("./repo-write-progress-command.ts").decodeRepoWriteCommand>;
  }) => Promise<RepoWriteDocSyncExecution | undefined>;
  readonly conflictMarkerPreflight?: () => import("@harness-anything/kernel").ProjectionWarning | undefined;
  readonly onBackgroundRuntimeEventFailure?: (
    failure: BackgroundRuntimeEventFailure
  ) => void | Promise<void>;
  readonly recoverSettlements?: () => Promise<void>;
  readonly now?: () => Date;
  readonly newOuterOpId?: () => string;
}

export type ResolvedProductionRepoWriteOperationHostOptions<
  Command extends DaemonHostCommand,
  Result extends DaemonHostCommandResult
> = Omit<ProductionRepoWriteOperationHostOptions<Command, Result>, "now" | "newOuterOpId"> & {
  readonly now: () => Date;
  readonly newOuterOpId: () => string;
};

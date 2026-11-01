// Internal test access for daemon conversion, receipt and admission scenarios.
export { OPAQUE_TEXTUAL_POLICY_ID } from "@harness-anything/kernel/internal/domain/artifact-text-classification.ts";
export {
  assertNoPendingHistoricalRewrites,
  planLegacyGenerationConversion,
} from "../../src/store/event-shape-migration.ts";
export {
  createImmutableLegacyGenerationSnapshotFromStoppedRepository,
  preflightCanonicalGeneration,
  preflightConvertedGenerationActivation,
} from "../../src/store/legacy-generation-conversion.ts";
export { migrateEventsToSqlite, sqliteContentObjectPath } from "../../src/store/sqlite-event-store.ts";
export { eventObjectRelativePath } from "@harness-anything/kernel/internal/layout/ledger-object-layout.ts";
export { validateWriteReceipt } from "@harness-anything/kernel/internal/domain/receipt-domain-registry.ts";
export { contentClaims } from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
export { daemonRegistryPaths } from "@harness-anything/kernel/daemon-registry";

export { createLedgerBackup, drillLedgerBackup } from "../../src/store/ledger-backup.ts";
export {
  generationTwoActivationPath,
  openSqliteEventStore,
  resolveActiveGeneration,
  sqliteLedgerPath,
} from "../../src/store/sqlite-event-store.ts";
export { sha256Bytes } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
export type { DocEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync-types.ts";

export type { AgentRuntimeEventV1 } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";

export { makeSqliteTaskEventStore } from "../../src/store/sqlite-task-event-store.ts";

export { planCompletionGeneration } from "../../src/store/completion-generation-plan.ts";
export { canonicalLedgerCut } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
export { makeOfflineCompletionChain } from "../../src/store/offline-completion-chain.ts";

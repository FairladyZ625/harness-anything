// Internal test access for daemon conversion, receipt and admission scenarios.
export { OPAQUE_TEXTUAL_POLICY_ID } from "../../src/domain/artifact-text-classification.ts";
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
export { eventObjectRelativePath } from "../../src/layout/ledger-object-layout.ts";
export { validateWriteReceipt } from "../../src/domain/receipt-domain-registry.ts";
export { contentClaims } from "../../src/store/task-event-store-claims-layout.ts";
export { daemonRegistryPaths } from "../../src/daemon/registry.ts";

export { createLedgerBackup, drillLedgerBackup } from "../../src/store/ledger-backup.ts";
export {
  generationTwoActivationPath,
  openSqliteEventStore,
  resolveActiveGeneration,
  sqliteLedgerPath,
} from "../../src/store/sqlite-event-store.ts";
export { sha256Bytes } from "../../src/integrity/stable-hash.ts";
export type { DocEventV1 } from "../../src/domain/doc-sync-types.ts";

export type { AgentRuntimeEventV1 } from "../../src/domain/agent-runtime.ts";

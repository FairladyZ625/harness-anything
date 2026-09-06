// Internal test access for daemon conversion, receipt and admission scenarios.
export { OPAQUE_TEXTUAL_POLICY_ID } from "../../src/domain/artifact-text-classification.ts";
export {
  assertNoPendingHistoricalRewrites,
  planLegacyGenerationConversion,
} from "../../src/store/event-shape-migration.ts";
export {
  createImmutableLegacyGenerationSnapshotFromStoppedRepository,
  preflightConvertedGenerationActivation,
} from "../../src/store/legacy-generation-conversion.ts";
export { migrateEventsToSqlite, sqliteContentObjectPath } from "../../src/store/sqlite-event-store.ts";
export { eventObjectRelativePath } from "../../src/layout/ledger-object-layout.ts";
export { validateWriteReceipt } from "../../src/domain/receipt-domain-registry.ts";
export { daemonRegistryPaths } from "../../src/daemon/registry.ts";

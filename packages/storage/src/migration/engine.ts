import { existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { writeFileDurably } from "../durable-file.ts";
import {
  assertMigrationValue,
  assertSqliteMigrationScope,
  storageMigrationVersions,
  validateStorageManifest,
} from "./manifest.ts";
import {
  StorageMigrationError,
  migrationWritable,
  type MigrationEndpoint,
  type StorageMigrationRecord,
  type StorageMigrationManifest,
} from "./types.ts";

export interface StorageMigrationInput {
  readonly repoId: string;
  readonly runId: string;
  readonly source: MigrationEndpoint;
  readonly target: MigrationEndpoint;
  readonly exportDirectory: string;
  readonly mode?: "migrate" | "resume" | "abort" | "preflight";
  /** Test-only fault injection happens after a durable boundary, never on a timer. */
  readonly checkpoint?: (boundary: string) => void;
}
/** All backends use this protocol. Only a durable target marker transfers authority (CH10/16). */
export async function migrateStorage(input: StorageMigrationInput) {
  const { source, target, runId } = input,
    mode = input.mode ?? "migrate";
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(runId) || source.id === target.id)
    throw new StorageMigrationError("storage_migration_invalid", "use a stable run id and distinct endpoints");
  const checkpoint = (boundary: string) => input.checkpoint?.(boundary),
    manifestPath = path.join(input.exportDirectory, "manifest.json");
  // Read the target first. Failure to read either side propagates; configuration never votes.
  const activated = await target.marker(runId);
  let targetState = await target.state(),
    sourceState = await source.state();
  for (const state of [sourceState, targetState]) {
    if (state?.runId === runId && (state.source !== source.id || state.target !== target.id))
      throw new StorageMigrationError("storage_migration_conflict", "run identity belongs to other endpoints");
    if (state && state.runId !== runId && !["target_activated", "source_resumed", "abandoned"].includes(state.phase))
      throw new StorageMigrationError("storage_migration_conflict", "endpoint has another unfinished migration");
  }
  if (activated) {
    if (mode === "abort")
      throw new StorageMigrationError(
        "storage_migration_already_activated",
        "target marker exists; reverse export is required",
      );
    if (
      !sourceState ||
      sourceState.runId !== runId ||
      sourceState.role !== "source" ||
      targetState?.runId !== runId ||
      targetState.role !== "target" ||
      !["source_sealed", "activation_failed", "target_activated"].includes(sourceState.phase) ||
      targetState?.phase !== "target_activated"
    )
      throw new StorageMigrationError("storage_migration_conflict", "activation marker disagrees with endpoint state");
    if (sourceState.phase !== "target_activated")
      await source.change(sourceState, { ...sourceState, phase: "target_activated" });
    return {
      schema: "storage-migration-receipt/v1",
      runId,
      phase: "target_activated",
      manifestPath,
      replicaRecovery: "full_snapshot_required",
    };
  }
  if (mode === "abort") {
    if (!sourceState || sourceState.runId !== runId || sourceState.role !== "source")
      throw new StorageMigrationError("storage_migration_conflict", "no frozen source for this run");
    if (targetState?.runId === runId && targetState.phase !== "abandoned") {
      await target.change(targetState, { ...targetState, phase: "abandoned" });
      checkpoint("target_abandoned");
    }
    // Re-read marker after abandoning: the CAS above excludes a concurrent activator.
    if (await target.marker(runId))
      throw new StorageMigrationError("storage_migration_conflict", "target activated during abort");
    const resumed = {
      ...sourceState,
      epoch: Math.max(await source.epoch(), sourceState.epoch) + 1,
      phase: "source_resumed" as const,
    };
    await source.change(sourceState, resumed);
    checkpoint("source_resumed");
    return { schema: "storage-migration-receipt/v1", runId, phase: "source_resumed", manifestPath };
  }
  if (sourceState?.runId === runId && sourceState.phase === "source_resumed")
    throw new StorageMigrationError("storage_migration_abandoned", "aborted run cannot be reused");
  if (targetState?.runId === runId && targetState.phase === "abandoned")
    throw new StorageMigrationError(
      "storage_migration_abandoned",
      "target was abandoned; abort the source or use a new target",
    );
  if (sourceState?.runId !== runId && !migrationWritable(sourceState))
    throw new StorageMigrationError("storage_migration_source_retired", "source is not the current writable authority");
  let tuples = await source.export(runId);
  if (target.backend === "sqlite") assertSqliteMigrationScope(tuples);
  const manifest: StorageMigrationManifest = {
    schema: "storage-migration/v1",
    versions: storageMigrationVersions,
    repoId: input.repoId,
    runId,
    source: source.id,
    target: target.id,
    tuples,
  };
  validateStorageManifest(manifest);
  if (targetState?.runId !== runId) {
    if (
      (await target.export(runId)).some(
        (tuple) => tuple.events.length > 0 || tuple.outcomes.length > 0 || tuple.blobs.length > 0,
      )
    )
      throw new StorageMigrationError(
        "storage_migration_target_not_empty",
        "use an empty target, retaining the previous authority",
      );
  }
  if (mode === "preflight")
    return {
      schema: "storage-migration-receipt/v1",
      runId,
      phase: "preflight",
      tuples: tuples.length,
      cuts: tuples.map((tuple) => tuple.cut),
    };
  if (sourceState?.runId !== runId) {
    const epoch = Math.max(await source.epoch(), await target.epoch()) + 1,
      frozen: StorageMigrationRecord = {
        runId,
        source: source.id,
        target: target.id,
        role: "source",
        phase: "freezing",
        epoch,
        cut: tuples[0]!.cut,
        tupleCuts: tuples.map((tuple) => ({
          tenantId: tuple.scope.tenantId,
          projectId: tuple.scope.projectId,
          cut: tuple.cut,
        })),
      };
    await source.change(sourceState, frozen);
    sourceState = frozen;
    checkpoint("source_frozen");
  }
  tuples = await source.export(runId);
  const frozenManifest = { ...manifest, tuples };
  validateStorageManifest(frozenManifest);
  /* @gate-identity state-store/migration.source.storage.src.migration.engine.filesystem-store */ mkdirSync(
    input.exportDirectory,
    { recursive: true },
  );
  if (existsSync(manifestPath))
    assertMigrationValue(
      JSON.parse(readFileSync(manifestPath, "utf8")),
      frozenManifest,
      "retained source snapshot differs",
    );
  else writeFileDurably(manifestPath, `${JSON.stringify(frozenManifest)}\n`, 0o600);
  checkpoint("manifest_published");
  if (targetState?.runId !== runId) {
    const prepared: StorageMigrationRecord = { ...sourceState!, role: "target", phase: "prepared" };
    await target.change(targetState, prepared);
    targetState = prepared;
    checkpoint("target_prepared");
  }
  await target.import(frozenManifest);
  checkpoint("target_imported");
  const imported = await target.export(runId);
  assertMigrationValue(imported, tuples, "event/blob/outcome bytes, cut or complete projection reconciliation differs");
  checkpoint("audit_passed");
  if (sourceState!.phase === "freezing") {
    const sealed = { ...sourceState!, phase: "source_sealed" as const };
    await source.change(sourceState, sealed);
    sourceState = sealed;
    checkpoint("source_sealed");
  }
  try {
    const active = { ...targetState!, phase: "target_activated" as const };
    await target.change(targetState, active, true);
    targetState = active;
  } catch (error) {
    if (!(await target.marker(runId))) {
      const failed = { ...sourceState!, phase: "activation_failed" as const };
      await source.change(sourceState, failed);
      await target.change(targetState, { ...targetState!, phase: "activation_failed" });
      checkpoint("activation_failed");
    }
    throw error;
  }
  checkpoint("target_marker");
  await source.change(sourceState, { ...sourceState!, phase: "target_activated" });
  checkpoint("source_completed");
  return {
    schema: "storage-migration-receipt/v1",
    runId,
    phase: "target_activated",
    manifestPath,
    cuts: tuples.map((tuple) => tuple.cut),
    replicaRecovery: "full_snapshot_required",
  };
}

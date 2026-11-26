import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { canonicalLedgerCut } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "@harness-anything/kernel/internal/layout/index.ts";
import {
  localLedgerBackupFileSystem,
  localRuntimeStateFileSystem,
} from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import { readGenerationThreeActivationAtPath } from "./store/generation-three-selection.ts";
import { sqliteDatabasePath } from "./sqlite-database-path.ts";
import { openPersistentWriterEpoch } from "./writer-epoch.ts";
import type { RbacBackupStatus } from "@harness-anything/kernel/internal/domain/status-vocabulary.ts";
import { validatePromotableReplica } from "@harness-anything/kernel/internal/domain/replica-promotion.ts";
import {
  CenterMigratingError,
  CenterMovedError,
  clearCenterMigrating,
  enterCenterMigrating,
  writeCenterRelocated,
  writeWriterEpochRetirementSeal,
  type CenterRelocatedTombstoneV1,
} from "./center-relocation-state.ts";
import {
  createLedgerBackup,
  sha256File,
  stageLedgerBackup,
  type LedgerBackupRegistrationV1,
  type LedgerBackupStage,
} from "./store/ledger-backup.ts";
import { openSqliteEventStore, resolveActiveGeneration, sqliteLedgerPath } from "./store/sqlite-event-store.ts";
import { removeFileDurably, syncDirectory, syncFile, writeFileDurably } from "./durable-file.ts";
import type { ReplicationPosition } from "./store/replication-log.ts";

export interface RelocationBundleFileV1 {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface RelocationBundleManifestV1 {
  readonly schema: "relocation-bundle/v1";
  readonly repoId: string;
  readonly finalRevision: number;
  readonly tipHash: string;
  readonly writerEpoch: number;
  readonly createdAt: string;
  readonly files: readonly RelocationBundleFileV1[];
}

export type CenterRelocationManifestV1 = RelocationBundleManifestV1;

export interface StageCenterRelocationInput {
  readonly rootInput: HarnessLayoutInput;
  readonly bundleDir: string;
}

export interface ExportCenterRelocationRbacContext {
  readonly bundleDir: string;
  readonly payloadRbacDir: string;
  readonly repoId: string;
  readonly writerEpoch: number;
}

export interface ImportCenterRelocationRbacContext {
  readonly bundleDir: string;
  readonly payloadRbacDir: string;
  readonly manifest: RelocationBundleManifestV1;
}

export interface ExportCenterRelocationInput extends StageCenterRelocationInput {
  readonly repoId: string;
  readonly writerEpoch: number;
  readonly userRoot?: string;
  readonly stateRoot?: string;
  readonly replicationSlotsPath?: string;
  readonly registration?: Omit<LedgerBackupRegistrationV1, "repoId" | "writerEpoch">;
  readonly now?: Date;
  readonly stage?: LedgerBackupStage;
  readonly freezeAndDrain?: () => void | Promise<void>;
  readonly exportRbacBundle?: (context: ExportCenterRelocationRbacContext) => void | Promise<void>;
}

export interface ImportCenterRelocationInput {
  readonly bundleDir: string;
  readonly destinationRoot: string;
  readonly stateRoot: string;
  readonly expectedRepoId?: string;
  readonly expectedFinalRevision?: number;
  readonly expectedTipHash?: string;
  readonly replicationSlotsPath?: string;
  readonly writerHolderId?: string;
  readonly now?: () => string;
  readonly importRbacBundle?: (context: ImportCenterRelocationRbacContext) => void | Promise<void>;
}

export interface PromoteFromEdgeInput {
  readonly rootInput: HarnessLayoutInput;
  readonly repoId: string;
  readonly replicaDatabasePath: string;
  readonly replicaGeneration: number;
  readonly replicaPosition: ReplicationPosition;
  readonly stateRoot: string;
  readonly holderId?: string;
  readonly observedWriterEpoch?: number;
  readonly forceNewEpoch: boolean;
  readonly confirmPossibleTailLoss: boolean;
  readonly rbacBackupStatus?: RbacBackupStatus;
  readonly now?: () => string;
}

export interface PromoteFromEdgeResult {
  readonly schema: "center-emergency-promoted/v1";
  readonly repoId: string;
  readonly oldEpoch: number;
  readonly newEpoch: number;
  readonly finalRevision: number;
  readonly tipHash: string;
  readonly replicationHistory: string;
  readonly replicationSequence: number;
  readonly rbacBackupStatus: RbacBackupStatus;
  readonly displacedGenerationPath: string | null;
  readonly auditPath: string;
  readonly promotedAt: string;
}

export class EdgeReplicaIntegrityError extends Error {
  readonly code = "edge_replica_integrity_failed";

  constructor(issues: readonly string[]) {
    super(`edge replica integrity failed: ${issues.join(", ")}`);
    this.name = "EdgeReplicaIntegrityError";
  }
}

export function promoteFromEdgeAuditPath(stateRoot: string, repoId: string): string {
  return path.join(path.resolve(stateRoot), "governance", "center-emergency-promoted", `${repoId}.json`);
}

/**
 * Promote a published edge replica through the storage writer boundary. This is a manual operation
 * and has no scheduler or reconnect caller.
 */
export async function promoteFromEdge(input: PromoteFromEdgeInput): Promise<PromoteFromEdgeResult> {
  if (!input.forceNewEpoch || !input.confirmPossibleTailLoss)
    throw new Error("promote-from-edge requires --force-new-epoch and --confirm-possible-tail-loss");
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(input.repoId)) throw new Error("repoId is invalid for a center promotion");
  const now = input.now ?? (() => new Date().toISOString()),
    holderId = input.holderId ?? `emergency-center-${process.pid}`,
    replicaDatabasePath = path.resolve(input.replicaDatabasePath),
    targetDatabasePath = sqliteLedgerPath(input.rootInput, 3),
    targetGenerationDir = path.dirname(targetDatabasePath),
    source = openSqliteEventStore({
      repoId: input.repoId,
      databasePath: replicaDatabasePath,
      generation: input.replicaGeneration,
      readOnly: true,
    });
  let authority: ReturnType<typeof openPersistentWriterEpoch> | undefined;
  let stagingDirectory: string | undefined,
    published = false,
    displacedGenerationPath: string | null = null;
  let newEpoch: number;
  try {
    if (input.replicaGeneration !== 3)
      throw new Error(`edge replica generation ${input.replicaGeneration} is unsupported; generation 3 is required`);
    if (localLedgerBackupFileSystem.exists(promoteFromEdgeAuditPath(input.stateRoot, input.repoId)))
      throw new Error(`an emergency promotion record already exists for ${input.repoId}`);
    const observed = readReplicaPromotionCut(source, input.repoId, input.replicaPosition),
      activation = readGenerationThreeActivationAtPath(replicaDatabasePath, input.repoId);
    if (activation === null) throw new Error("edge replica has no valid generation 3 activation certificate");
    if (input.observedWriterEpoch !== undefined && observed.oldEpoch !== input.observedWriterEpoch)
      throw new Error("edge replica writer epoch differs from fleet-edge.json");

    const targetStoreDir = path.dirname(targetGenerationDir),
      cacheRoot = resolveHarnessLayout(input.rootInput).cacheRoot;
    localLedgerBackupFileSystem.mkdir(targetStoreDir, { recursive: true });
    stagingDirectory = path.join(targetStoreDir, `.promote-from-edge-${randomUUID()}`);
    localLedgerBackupFileSystem.mkdir(stagingDirectory, { recursive: true });
    const stagedDatabasePath = path.join(stagingDirectory, "ledger.sqlite"),
      sourceDatabase = new DatabaseSync(sqliteDatabasePath(replicaDatabasePath), { readOnly: true });
    try {
      sourceDatabase.exec(`VACUUM INTO ${sqlString(sqliteDatabasePath(stagedDatabasePath))}`);
    } finally {
      sourceDatabase.close();
    }
    const sourceObjects = path.join(path.dirname(replicaDatabasePath), "objects"),
      stagedObjects = path.join(stagingDirectory, "objects");
    if (localLedgerBackupFileSystem.exists(sourceObjects))
      localLedgerBackupFileSystem.copy(sourceObjects, stagedObjects, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    localLedgerBackupFileSystem.copy(`${replicaDatabasePath}.activation.json`, `${stagedDatabasePath}.activation.json`);
    syncPromotionTree(stagingDirectory);

    const ledger = openSqliteEventStore({
      repoId: input.repoId,
      databasePath: stagedDatabasePath,
      generation: 3,
    });
    let rotated: ReplicationPosition, tipHash: string, finalRevision: number;
    try {
      const staged = readReplicaPromotionCut(ledger, input.repoId, input.replicaPosition);
      if (staged.tipHash !== observed.tipHash || staged.revision !== observed.revision)
        throw new Error("copied edge replica differs from its verified source cut");
      authority = openPersistentWriterEpoch({
        stateRoot: input.stateRoot,
        holderId,
        now,
        initialEpochFloor: observed.oldEpoch,
      });
      const lease = authority.acquire(input.repoId, observed.oldEpoch);
      newEpoch = lease.epoch;
      ledger.claimWriter({ repoId: input.repoId, holder: holderId, epoch: newEpoch });
      rotated = ledger.rotateReplicationHistory();
      finalRevision = ledger.revision();
      tipHash = canonicalLedgerCut(input.repoId, ledger.eventIdentityAtRevision(finalRevision)).headDigest;
    } finally {
      ledger.close();
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      const cachedProjection = path.join(cacheRoot, `task.sqlite${suffix}`);
      if (localLedgerBackupFileSystem.exists(cachedProjection)) removeFileDurably(cachedProjection);
    }
    try {
      if (localLedgerBackupFileSystem.exists(targetGenerationDir)) {
        const retiredRoot = path.join(path.dirname(targetStoreDir), "retired", "center-promote-from-edge");
        localLedgerBackupFileSystem.mkdir(retiredRoot, { recursive: true });
        displacedGenerationPath = path.join(retiredRoot, `generation-3-${randomUUID()}`);
        localRuntimeStateFileSystem.rename(targetGenerationDir, displacedGenerationPath);
        syncDirectory(targetStoreDir);
        syncDirectory(retiredRoot);
      }
      localRuntimeStateFileSystem.rename(stagingDirectory, targetGenerationDir);
      published = true;
      syncDirectory(targetStoreDir);
    } catch (publishError) {
      try {
        if (published && localLedgerBackupFileSystem.exists(targetGenerationDir)) {
          localRuntimeStateFileSystem.rename(targetGenerationDir, stagingDirectory);
          published = false;
        }
        if (
          displacedGenerationPath !== null &&
          localLedgerBackupFileSystem.exists(displacedGenerationPath) &&
          !localLedgerBackupFileSystem.exists(targetGenerationDir)
        ) {
          localRuntimeStateFileSystem.rename(displacedGenerationPath, targetGenerationDir);
          syncDirectory(targetStoreDir);
          displacedGenerationPath = null;
        }
      } catch (restoreError) {
        throw new AggregateError(
          [publishError, restoreError],
          "generation publish failed and the prior ledger could not be restored",
        );
      }
      throw publishError;
    }

    const promotedLedger = openSqliteEventStore({ rootInput: input.rootInput, repoId: input.repoId, readOnly: true });
    try {
      const promoted = promotedLedger.replicationPosition();
      if (promoted.history !== rotated.history || promoted.sequence !== 0 || promoted.revision !== finalRevision)
        throw new Error("promoted edge ledger differs from its rotated replication cut");
    } finally {
      promotedLedger.close();
    }
    const promotedAt = now(),
      auditPath = promoteFromEdgeAuditPath(input.stateRoot, input.repoId),
      result: PromoteFromEdgeResult = {
        schema: "center-emergency-promoted/v1",
        repoId: input.repoId,
        oldEpoch: observed.oldEpoch,
        newEpoch,
        finalRevision,
        tipHash,
        replicationHistory: rotated.history,
        replicationSequence: rotated.sequence,
        rbacBackupStatus: input.rbacBackupStatus ?? "unknown",
        displacedGenerationPath,
        auditPath,
        promotedAt,
      };
    writeFileDurably(
      auditPath,
      `${JSON.stringify(
        {
          ...result,
          event: "center_emergency_promoted",
          possibleTailLossConfirmed: true,
          forceNewEpoch: true,
        },
        null,
        2,
      )}\n`,
      0o600,
    );
    return result;
  } finally {
    authority?.close();
    source.close();
    if (stagingDirectory && !published && localLedgerBackupFileSystem.exists(stagingDirectory))
      localLedgerBackupFileSystem.remove(stagingDirectory);
  }
}

function readReplicaPromotionCut(
  ledger: ReturnType<typeof openSqliteEventStore>,
  repoId: string,
  expectedPosition: ReplicationPosition,
): { readonly revision: number; readonly oldEpoch: number; readonly tipHash: string } {
  const metadata = ledger.metadata(),
    position = ledger.replicationPosition(),
    revision = ledger.revision();

  let afterRevision = 0,
    done = false,
    eventDigestsValid = true,
    eventSequenceComplete = true;
  while (!done) {
    const page = ledger.eventRowPage(afterRevision, 256);
    for (const row of page.rows) {
      if (row.revision !== afterRevision + 1) eventSequenceComplete = false;
      if (row.digest !== `sha256:${sha256Text(row.eventJson)}`) eventDigestsValid = false;
      afterRevision = row.revision;
    }
    if (!page.done && page.rows.length === 0) {
      eventSequenceComplete = false;
      done = true;
      continue;
    }
    done = page.done;
  }
  let contentDigestsValid = true;
  for (const digest of ledger.contentObjectDigests()) {
    if (!/^[0-9a-f]{64}$/u.test(digest)) {
      contentDigestsValid = false;
      continue;
    }
    const objectPath = path.join(
      path.dirname(ledger.databasePath),
      "objects",
      "sha256",
      digest.slice(0, 2),
      digest.slice(2),
    );
    if (!localLedgerBackupFileSystem.lstat(objectPath, { throwIfNoEntry: false })?.isFile()) {
      contentDigestsValid = false;
      continue;
    }
    if (sha256File(objectPath) !== `sha256:${digest}`) contentDigestsValid = false;
  }
  const integrityIssues = validatePromotableReplica({
    expectedRepoId: repoId,
    actualRepoId: metadata.repoId,
    expectedGeneration: 3,
    actualGeneration: metadata.generation,
    expectedHistory: expectedPosition.history,
    actualHistory: position.history,
    expectedSequence: expectedPosition.sequence,
    actualSequence: position.sequence,
    expectedPositionRevision: expectedPosition.revision,
    actualPositionRevision: position.revision,
    metadataRevision: metadata.revision,
    ledgerRevision: revision,
    lastEventRevision: afterRevision,
    eventSequenceComplete,
    eventDigestsValid,
    contentDigestsValid,
  });
  if (integrityIssues.length > 0) throw new EdgeReplicaIntegrityError(integrityIssues);
  return {
    revision,
    oldEpoch: ledger.writerFence()?.epoch ?? 0,
    tipHash: canonicalLedgerCut(repoId, ledger.eventIdentityAtRevision(revision)).headDigest,
  };
}

function syncPromotionTree(directory: string): void {
  for (const file of inventory(directory)) syncFile(file);
  const syncDirectories = (current: string): void => {
    for (const name of localLedgerBackupFileSystem.readDirectory(current)) {
      const entry = path.join(current, name);
      if (localLedgerBackupFileSystem.stat(entry).isDirectory()) syncDirectories(entry);
    }
    syncDirectory(current);
  };
  syncDirectories(directory);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const REPLICATION_SLOTS_BUNDLE_PATH = "replication-slots.sqlite";
const RBAC_BUNDLE_PREFIX = "rbac/";

function bundleSidecarEntry(entryPath: string): boolean {
  return entryPath === REPLICATION_SLOTS_BUNDLE_PATH || entryPath.startsWith(RBAC_BUNDLE_PREFIX);
}

export function stageCenterRelocation(input: StageCenterRelocationInput): LedgerBackupStage {
  return stageLedgerBackup({ rootInput: input.rootInput, backupDir: input.bundleDir });
}

export async function exportCenterRelocation(
  input: ExportCenterRelocationInput,
): Promise<{ readonly manifest: RelocationBundleManifestV1; readonly stage: LedgerBackupStage }> {
  if (!Number.isSafeInteger(input.writerEpoch) || input.writerEpoch < 1)
    throw new Error("writerEpoch must be a positive safe integer.");
  // Phase 1 (outside CENTER_MIGRATING freeze): bulk-copy live objects and working tree.
  const stage = input.stage ?? stageCenterRelocation(input),
    resolvedBundleDir = path.resolve(input.bundleDir),
    payloadRoot = path.join(resolvedBundleDir, "payload");
  if (input.userRoot) enterCenterMigrating(input.userRoot, input.repoId, input.writerEpoch, input.now);
  try {
    // Phase 2 (inside CENTER_MIGRATING freeze): drain RepoCell + Git outbox, then capture delta + VACUUM INTO.
    await input.freezeAndDrain?.();
    createLedgerBackup({
      rootInput: input.rootInput,
      backupDir: resolvedBundleDir,
      stage,
      now: input.now,
      registration: input.registration
        ? { ...input.registration, repoId: input.repoId, writerEpoch: input.writerEpoch }
        : undefined,
    });
    const slotsSource =
      input.replicationSlotsPath ??
      (input.stateRoot
        ? path.join(path.resolve(input.stateRoot), REPLICATION_SLOTS_BUNDLE_PATH)
        : input.userRoot
          ? path.join(path.resolve(input.userRoot), "fleet", REPLICATION_SLOTS_BUNDLE_PATH)
          : undefined);
    if (slotsSource && localLedgerBackupFileSystem.exists(slotsSource)) {
      const target = path.join(payloadRoot, REPLICATION_SLOTS_BUNDLE_PATH);
      localLedgerBackupFileSystem.mkdir(path.dirname(target), { recursive: true });
      localLedgerBackupFileSystem.copy(slotsSource, target);
    }
    if (input.exportRbacBundle) {
      await input.exportRbacBundle({
        bundleDir: resolvedBundleDir,
        payloadRbacDir: path.join(payloadRoot, "rbac"),
        repoId: input.repoId,
        writerEpoch: input.writerEpoch,
      });
    }
    const observed = readBundleHead(payloadRoot, input.repoId),
      files = inventory(payloadRoot).map((file) => ({
        path: portable(path.relative(payloadRoot, file)),
        size: localLedgerBackupFileSystem.stat(file).size,
        sha256: sha256File(file),
      })),
      manifest: RelocationBundleManifestV1 = {
        schema: "relocation-bundle/v1",
        repoId: input.repoId,
        finalRevision: observed.finalRevision,
        tipHash: observed.tipHash,
        writerEpoch: input.writerEpoch,
        createdAt: (input.now ?? new Date()).toISOString(),
        files,
      };
    // `createLedgerBackup` writes a source-rooted manifest. Replace it with the relocation contract,
    // whose only paths are relative to the bundle root and therefore portable across operating systems.
    writeFileDurably(path.join(resolvedBundleDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    return { manifest, stage };
  } finally {
    if (input.userRoot) clearCenterMigrating(input.userRoot, input.repoId);
  }
}

export function readRelocationManifest(bundleDir: string): RelocationBundleManifestV1 {
  const value = JSON.parse(
    localLedgerBackupFileSystem.read(path.join(bundleDir, "manifest.json"), "utf8"),
  ) as Partial<RelocationBundleManifestV1>;
  const finalRevision = value.finalRevision,
    writerEpoch = value.writerEpoch;
  if (
    value.schema !== "relocation-bundle/v1" ||
    typeof value.repoId !== "string" ||
    !Number.isSafeInteger(finalRevision) ||
    Number(finalRevision) < 0 ||
    typeof value.tipHash !== "string" ||
    !Number.isSafeInteger(writerEpoch) ||
    Number(writerEpoch) < 1 ||
    !Array.isArray(value.files)
  )
    throw new Error("relocation bundle manifest is invalid");
  for (const file of value.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.path !== "string" ||
      path.isAbsolute(file.path) ||
      file.path.includes("\\") ||
      file.path.split("/").includes("..") ||
      !Number.isSafeInteger(file.size) ||
      typeof file.sha256 !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(file.sha256)
    )
      throw new Error("relocation bundle contains an invalid file entry");
  }
  return value as RelocationBundleManifestV1;
}

export function verifyRelocationBundle(bundleDir: string): RelocationBundleManifestV1 {
  const root = path.resolve(bundleDir),
    manifest = readRelocationManifest(root),
    payloadRoot = path.join(root, "payload"),
    actual = inventory(payloadRoot).map((file) => portable(path.relative(payloadRoot, file)));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files.map(({ path: file }) => file)))
    throw new Error("relocation bundle file inventory differs from manifest");
  for (const entry of manifest.files) {
    const file = path.join(payloadRoot, entry.path),
      stat = localLedgerBackupFileSystem.stat(file);
    if (stat.size !== entry.size || sha256File(file) !== entry.sha256)
      throw new Error(`relocation bundle digest differs: ${entry.path}`);
  }
  return manifest;
}

export async function importCenterRelocation(input: ImportCenterRelocationInput): Promise<{
  readonly manifest: RelocationBundleManifestV1;
  readonly newEpoch: number;
  readonly restoredRoot: string;
}> {
  const resolvedBundleDir = path.resolve(input.bundleDir),
    manifest = verifyRelocationBundle(resolvedBundleDir);
  if (input.expectedRepoId !== undefined && input.expectedRepoId !== manifest.repoId)
    throw new Error("relocation bundle repoId differs from the requested repository");
  if (input.expectedFinalRevision !== undefined && input.expectedFinalRevision !== manifest.finalRevision)
    throw new Error("relocation bundle finalRevision differs from the expected cut");
  if (input.expectedTipHash !== undefined && input.expectedTipHash !== manifest.tipHash)
    throw new Error("relocation bundle tipHash differs from the expected cut");
  if (localLedgerBackupFileSystem.exists(input.destinationRoot))
    throw new Error("relocation destination already exists");

  const slotsEntry = manifest.files.find((entry) => entry.path === REPLICATION_SLOTS_BUNDLE_PATH);
  if (input.replicationSlotsPath !== undefined) {
    if (!slotsEntry) throw new Error("relocation bundle is missing replication-slots.sqlite");
    if (localLedgerBackupFileSystem.exists(input.replicationSlotsPath))
      throw new Error("replication slots destination already exists");
  }

  const restoredRoot = path.resolve(input.destinationRoot),
    workspaceEntries = manifest.files.filter((entry) => !bundleSidecarEntry(entry.path));
  let copiedSlotsPath: string | null = null;
  localLedgerBackupFileSystem.mkdir(restoredRoot, { recursive: true });
  try {
    for (const entry of workspaceEntries) {
      const source = path.join(resolvedBundleDir, "payload", entry.path),
        target = path.join(restoredRoot, entry.path);
      localLedgerBackupFileSystem.mkdir(path.dirname(target), { recursive: true });
      localLedgerBackupFileSystem.copy(source, target);
    }
    verifyEntriesAtRoot(restoredRoot, workspaceEntries);
    const restoredHead = readBundleHead(restoredRoot, manifest.repoId);
    if (restoredHead.finalRevision !== manifest.finalRevision || restoredHead.tipHash !== manifest.tipHash)
      throw new Error("restored relocation ledger cut differs from manifest");

    const defaultSlotsDestination = path.join(path.resolve(input.stateRoot), REPLICATION_SLOTS_BUNDLE_PATH),
      slotsDestination =
        input.replicationSlotsPath !== undefined
          ? path.resolve(input.replicationSlotsPath)
          : slotsEntry && !localLedgerBackupFileSystem.exists(defaultSlotsDestination)
            ? defaultSlotsDestination
            : null;
    if (slotsEntry && slotsDestination !== null) {
      const source = path.join(resolvedBundleDir, "payload", REPLICATION_SLOTS_BUNDLE_PATH);
      localLedgerBackupFileSystem.mkdir(path.dirname(slotsDestination), { recursive: true });
      localLedgerBackupFileSystem.copy(source, slotsDestination);
      copiedSlotsPath = slotsDestination;
      const stat = localLedgerBackupFileSystem.stat(slotsDestination);
      if (stat.size !== slotsEntry.size || sha256File(slotsDestination) !== slotsEntry.sha256)
        throw new Error(`restored relocation digest differs: ${REPLICATION_SLOTS_BUNDLE_PATH}`);
    }

    if (input.importRbacBundle) {
      await input.importRbacBundle({
        bundleDir: resolvedBundleDir,
        payloadRbacDir: path.join(resolvedBundleDir, "payload", "rbac"),
        manifest,
      });
    }

    const authority = openPersistentWriterEpoch({
      stateRoot: input.stateRoot,
      holderId: input.writerHolderId,
      now: input.now,
      // Importing an old center's cut must advance the durable floor before acquiring the new lease.
      initialEpochFloor: manifest.writerEpoch,
    });
    try {
      const acquired = authority.acquire(manifest.repoId, manifest.writerEpoch);
      return { manifest, newEpoch: acquired.epoch, restoredRoot };
    } finally {
      authority.close();
    }
  } catch (error) {
    localLedgerBackupFileSystem.remove(restoredRoot);
    if (copiedSlotsPath !== null) removeFileDurably(copiedSlotsPath);
    throw error;
  }
}

export function retireCenter(input: {
  readonly userRoot: string;
  readonly repoId: string;
  readonly oldEpoch: number;
  readonly finalRevision: number;
  readonly tipHash: string;
  readonly newExternalUrl: string;
  readonly newLoginUrl: string;
  readonly spkiSha256: string;
  readonly now?: Date;
}): CenterRelocatedTombstoneV1 {
  const tombstone: CenterRelocatedTombstoneV1 = {
    schema: "center-relocated/v1",
    repoId: input.repoId,
    finalRevision: input.finalRevision,
    tipHash: input.tipHash,
    oldEpoch: input.oldEpoch,
    newEpoch: input.oldEpoch + 1,
    newExternalUrl: input.newExternalUrl,
    newLoginUrl: input.newLoginUrl,
    spkiSha256: input.spkiSha256,
    relocatedAt: (input.now ?? new Date()).toISOString(),
  };
  writeCenterRelocated(input.userRoot, tombstone);
  writeWriterEpochRetirementSeal(input.userRoot, {
    schema: "writer-epoch-retirement-seal/v1",
    repoId: tombstone.repoId,
    retiredEpoch: tombstone.oldEpoch,
    newEpoch: tombstone.newEpoch,
    retiredAt: tombstone.relocatedAt,
  });
  return tombstone;
}

function selectBundleLedgerPath(payloadRoot: string, repoId: string): string {
  const generationsDir = path.join(resolveHarnessLayout(payloadRoot).localRoot, "store", "generations");
  if (localLedgerBackupFileSystem.exists(generationsDir)) {
    // Upgraded repositories retain historical generation SQLite files alongside generation 3;
    // always resolve the active generation pointer instead of picking lexicographically first.
    const activeGeneration = resolveActiveGeneration({ rootInput: payloadRoot, repoId }),
      ledgerFile = sqliteLedgerPath(payloadRoot, activeGeneration);
    if (!localLedgerBackupFileSystem.exists(ledgerFile))
      throw new Error(`relocation bundle active generation ${String(activeGeneration)} is missing ledger.sqlite`);
    return ledgerFile;
  }
  const candidates = inventory(payloadRoot).filter((file) => path.basename(file) === "ledger.sqlite");
  if (candidates.length === 0) throw new Error("relocation bundle does not contain ledger.sqlite");
  if (candidates.length > 1)
    throw new Error("relocation bundle has multiple ledger.sqlite files without an active generation layout");
  return candidates[0]!;
}

function readBundleHead(payloadRoot: string, repoId: string): { finalRevision: number; tipHash: string } {
  const ledgerFile = selectBundleLedgerPath(payloadRoot, repoId),
    database = new DatabaseSync(sqliteDatabasePath(ledgerFile), { readOnly: true });
  try {
    const metadata = database.prepare("SELECT repo_id, revision FROM ledger_meta WHERE singleton=1").get() as
        | { repo_id?: unknown; revision?: unknown }
        | undefined,
      head = database.prepare("SELECT revision, op_id, digest FROM event ORDER BY revision DESC LIMIT 1").get() as
        | { revision?: unknown; op_id?: unknown; digest?: unknown }
        | undefined;
    if (!metadata || metadata.repo_id !== repoId) throw new Error("relocation ledger repoId differs from manifest");
    const finalRevision = Number(metadata.revision ?? 0),
      tipHash =
        finalRevision === 0
          ? canonicalLedgerCut(repoId, null).headDigest
          : canonicalLedgerCut(repoId, {
              revision: Number(head?.revision),
              opId: String(head?.op_id),
              eventDigest: String(head?.digest) as `sha256:${string}`,
            }).headDigest;
    return { finalRevision, tipHash };
  } finally {
    database.close();
  }
}

function verifyEntriesAtRoot(root: string, entries: readonly RelocationBundleFileV1[]): void {
  for (const entry of entries) {
    const file = path.join(root, entry.path),
      stat = localLedgerBackupFileSystem.stat(file);
    if (stat.size !== entry.size || sha256File(file) !== entry.sha256)
      throw new Error(`restored relocation digest differs: ${entry.path}`);
  }
}

function inventory(root: string): readonly string[] {
  const files: string[] = [],
    walk = (directory: string): void => {
      for (const name of localLedgerBackupFileSystem.readDirectory(directory)) {
        const file = path.join(directory, name),
          stat = localLedgerBackupFileSystem.stat(file);
        if (stat.isDirectory()) walk(file);
        else files.push(file);
      }
    };
  walk(root);
  return files.sort((left, right) =>
    portable(path.relative(root, left)).localeCompare(portable(path.relative(root, right))),
  );
}

function portable(value: string): string {
  return value.split(path.sep).join("/");
}

export {
  centerMigratingPath,
  centerMovedDetails,
  centerMovedError,
  centerRelocatedPath,
  centerRelocatedRepoPath,
  clearCenterMigrating,
  enterCenterMigrating,
  readCenterMigrating,
  readCenterRelocated,
  readWriterEpochRetirementSeal,
  throwIfCenterMigrating,
  throwIfCenterRelocated,
  throwIfWriterEpochRetired,
  writeCenterRelocated,
  writerEpochRetirementSealPath,
  writeWriterEpochRetirementSeal,
} from "./center-relocation-state.ts";
export { CenterMigratingError, CenterMovedError };

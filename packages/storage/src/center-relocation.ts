import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { canonicalLedgerCut } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import type { HarnessLayoutInput } from "@harness-anything/kernel/internal/layout/index.ts";
import {
  localLedgerBackupFileSystem,
  localRuntimeStateFileSystem,
} from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import { openPersistentWriterEpoch } from "./writer-epoch.ts";
import {
  readCenterRelocated,
  writeCenterRelocated,
  writeWriterEpochRetirementSeal,
  CenterMovedError,
  type CenterRelocatedTombstoneV1,
} from "./center-relocation-state.ts";
import {
  createLedgerBackup,
  stageLedgerBackup,
  type LedgerBackupRegistrationV1,
  type LedgerBackupStage,
} from "./store/ledger-backup.ts";
import { writeFileDurably } from "./durable-file.ts";

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

export interface ExportCenterRelocationInput extends StageCenterRelocationInput {
  readonly repoId: string;
  readonly writerEpoch: number;
  readonly stateRoot?: string;
  readonly replicationSlotsPath?: string;
  readonly registration?: Omit<LedgerBackupRegistrationV1, "repoId" | "writerEpoch">;
  readonly now?: Date;
  readonly stage?: LedgerBackupStage;
  readonly freezeAndDrain?: () => void | Promise<void>;
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
}

export function stageCenterRelocation(input: StageCenterRelocationInput): LedgerBackupStage {
  return stageLedgerBackup({ rootInput: input.rootInput, backupDir: input.bundleDir });
}

export async function exportCenterRelocation(
  input: ExportCenterRelocationInput,
): Promise<{ readonly manifest: RelocationBundleManifestV1; readonly stage: LedgerBackupStage }> {
  if (!Number.isSafeInteger(input.writerEpoch) || input.writerEpoch < 1)
    throw new Error("writerEpoch must be a positive safe integer.");
  const stage = input.stage ?? stageCenterRelocation(input);
  await input.freezeAndDrain?.();
  // The freeze callback is intentionally run before the second capture. Callers that own a
  // writer queue can therefore freeze and drain between the stage and the short final copy.
  createLedgerBackup({
    rootInput: input.rootInput,
    backupDir: input.bundleDir,
    stage,
    now: input.now,
    registration: input.registration
      ? { ...input.registration, repoId: input.repoId, writerEpoch: input.writerEpoch }
      : undefined,
  });
  if (input.replicationSlotsPath && localLedgerBackupFileSystem.exists(input.replicationSlotsPath)) {
    const target = path.join(input.bundleDir, "payload", "replication-slots.sqlite");
    localLedgerBackupFileSystem.mkdir(path.dirname(target), { recursive: true });
    localLedgerBackupFileSystem.copy(input.replicationSlotsPath, target);
  }
  const payloadRoot = path.join(input.bundleDir, "payload"),
    observed = readBundleHead(payloadRoot, input.repoId),
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
  writeFileDurably(path.join(input.bundleDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return { manifest, stage };
}

export function readRelocationManifest(bundleDir: string): RelocationBundleManifestV1 {
  const value = JSON.parse(localLedgerBackupFileSystem.read(path.join(bundleDir, "manifest.json"), "utf8")) as Partial<
    RelocationBundleManifestV1
  >;
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

export function importCenterRelocation(input: ImportCenterRelocationInput): {
  readonly manifest: RelocationBundleManifestV1;
  readonly newEpoch: number;
  readonly restoredRoot: string;
} {
  const manifest = verifyRelocationBundle(input.bundleDir);
  if (input.expectedRepoId !== undefined && input.expectedRepoId !== manifest.repoId)
    throw new Error("relocation bundle repoId differs from the requested repository");
  if (input.expectedFinalRevision !== undefined && input.expectedFinalRevision !== manifest.finalRevision)
    throw new Error("relocation bundle finalRevision differs from the expected cut");
  if (input.expectedTipHash !== undefined && input.expectedTipHash !== manifest.tipHash)
    throw new Error("relocation bundle tipHash differs from the expected cut");
  if (localLedgerBackupFileSystem.exists(input.destinationRoot)) throw new Error("relocation destination already exists");
  const restoredRoot = path.resolve(input.destinationRoot);
  localLedgerBackupFileSystem.mkdir(restoredRoot, { recursive: true });
  try {
    for (const entry of manifest.files) {
      const source = path.join(input.bundleDir, "payload", entry.path),
        target = path.join(restoredRoot, entry.path);
      localLedgerBackupFileSystem.mkdir(path.dirname(target), { recursive: true });
      localLedgerBackupFileSystem.copy(source, target);
    }
    verifyRelocationBundleAtRoot(restoredRoot, manifest);
    const restoredHead = readBundleHead(restoredRoot, manifest.repoId);
    if (restoredHead.finalRevision !== manifest.finalRevision || restoredHead.tipHash !== manifest.tipHash)
      throw new Error("restored relocation ledger cut differs from manifest");
    if (input.replicationSlotsPath) {
      const source = path.join(restoredRoot, "replication-slots.sqlite");
      if (!localLedgerBackupFileSystem.exists(source)) throw new Error("relocation bundle is missing replication-slots.sqlite");
      if (localLedgerBackupFileSystem.exists(input.replicationSlotsPath)) throw new Error("replication slots destination already exists");
      localLedgerBackupFileSystem.mkdir(path.dirname(input.replicationSlotsPath), { recursive: true });
      localLedgerBackupFileSystem.copy(source, input.replicationSlotsPath);
    }
    const authority = openPersistentWriterEpoch({
      stateRoot: input.stateRoot,
      holderId: input.writerHolderId,
      now: input.now,
      // Importing an old center's cut must advance the durable floor before acquiring the new lease.
      initialEpochFloor: manifest.writerEpoch,
    });
    try {
      const lease = authority.acquire(manifest.repoId, manifest.writerEpoch);
      return { manifest, newEpoch: lease.epoch, restoredRoot };
    } finally {
      authority.close();
    }
  } catch (error) {
    localLedgerBackupFileSystem.remove(restoredRoot);
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

function readBundleHead(payloadRoot: string, repoId: string): { finalRevision: number; tipHash: string } {
  const candidates = inventory(payloadRoot).filter((file) => path.basename(file) === "ledger.sqlite");
  if (candidates.length === 0) throw new Error("relocation bundle does not contain ledger.sqlite");
  const database = new DatabaseSync(candidates[0]!, { readOnly: true });
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

function verifyRelocationBundleAtRoot(root: string, manifest: RelocationBundleManifestV1): void {
  for (const entry of manifest.files) {
    const file = path.join(root, entry.path),
      stat = localLedgerBackupFileSystem.stat(file);
    if (stat.size !== entry.size || sha256File(file) !== entry.sha256)
      throw new Error(`restored relocation digest differs: ${entry.path}`);
  }
}

function inventory(root: string): readonly string[] {
  const files: string[] = [], walk = (directory: string): void => {
    for (const name of localLedgerBackupFileSystem.readDirectory(directory)) {
      const file = path.join(directory, name), stat = localLedgerBackupFileSystem.stat(file);
      if (stat.isDirectory()) walk(file);
      else files.push(file);
    }
  };
  walk(root);
  return files.sort((left, right) => portable(path.relative(root, left)).localeCompare(portable(path.relative(root, right))));
}

function sha256File(file: string): string {
  return localRuntimeStateFileSystem.withReadDescriptor(file, (descriptor) => {
    const hash = createHash("sha256"),
      buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytesRead = localLedgerBackupFileSystem.readChunk(descriptor, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return `sha256:${hash.digest("hex")}`;
  });
}

function portable(value: string): string {
  return value.split(path.sep).join("/");
}

export {
  centerRelocatedPath,
  readCenterRelocated,
  writeCenterRelocated,
  writerEpochRetirementSealPath,
  writeWriterEpochRetirementSeal,
} from "./center-relocation-state.ts";
export { CenterMovedError };

import path from "node:path";
import {
  localLedgerBackupFileSystem,
  localRuntimeStateFileSystem,
} from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import { removeFileDurably, writeFileDurably } from "./durable-file.ts";
import { WriterEpochError } from "./writer-epoch-contract.ts";

export interface CenterMovedDetails {
  readonly newExternalUrl: string;
  readonly newLoginUrl: string;
  readonly newEpoch: number;
  readonly spkiSha256: string;
}

export interface CenterRelocatedTombstoneV1 extends CenterMovedDetails {
  readonly schema: "center-relocated/v1";
  readonly repoId: string;
  readonly finalRevision: number;
  readonly tipHash: string;
  readonly oldEpoch: number;
  readonly relocatedAt: string;
}

export interface WriterEpochRetirementSealV1 {
  readonly schema: "writer-epoch-retirement-seal/v1";
  readonly repoId: string;
  readonly retiredEpoch: number;
  readonly newEpoch: number;
  readonly retiredAt: string;
}

export interface CenterMigratingStateV1 {
  readonly schema: "center-migrating/v1";
  readonly repoId: string;
  readonly writerEpoch: number;
  readonly startedAt: string;
}

export function centerMovedDetails(details: CenterMovedDetails): CenterMovedDetails {
  return {
    newExternalUrl: details.newExternalUrl,
    newLoginUrl: details.newLoginUrl,
    newEpoch: details.newEpoch,
    spkiSha256: details.spkiSha256,
  };
}

export class CenterMovedError extends Error {
  readonly code = "CENTER_MOVED" as const;
  readonly details: CenterMovedDetails;
  readonly centerMoved: CenterMovedDetails;

  constructor(details: CenterMovedDetails) {
    const projected = centerMovedDetails(details);
    super("The center has moved; repoint this edge to the new center before retrying.");
    this.name = "CenterMovedError";
    this.details = projected;
    this.centerMoved = projected;
  }
}

export class CenterMigratingError extends Error {
  readonly code = "CENTER_MIGRATING" as const;

  constructor(repoId: string) {
    super(
      `Center repository ${repoId} is freezing and draining writes for controlled relocation; retry after cutover.`,
    );
    this.name = "CenterMigratingError";
  }
}

export function centerRelocatedPath(userRoot: string): string {
  return path.join(path.resolve(userRoot), "fleet", "center-relocated.json");
}

export function centerRelocatedRepoPath(userRoot: string, repoId: string): string {
  return path.join(path.resolve(userRoot), "fleet", "center-relocated", `${repoId}.json`);
}

function parseTombstoneFile(file: string): CenterRelocatedTombstoneV1 {
  const value = JSON.parse(localRuntimeStateFileSystem.readText(file)) as Partial<CenterRelocatedTombstoneV1>;
  const oldEpoch = value.oldEpoch,
    newEpoch = value.newEpoch;
  if (
    value.schema !== "center-relocated/v1" ||
    typeof value.repoId !== "string" ||
    value.repoId.length === 0 ||
    !Number.isSafeInteger(value.finalRevision) ||
    !Number.isSafeInteger(oldEpoch) ||
    !Number.isSafeInteger(newEpoch) ||
    newEpoch !== Number(oldEpoch) + 1 ||
    typeof value.tipHash !== "string" ||
    typeof value.newExternalUrl !== "string" ||
    typeof value.newLoginUrl !== "string" ||
    typeof value.spkiSha256 !== "string" ||
    typeof value.relocatedAt !== "string"
  )
    throw new Error(`Center relocation tombstone at ${file} is invalid.`);
  return value as CenterRelocatedTombstoneV1;
}

export function readCenterRelocated(userRoot: string, repoId?: string): CenterRelocatedTombstoneV1 | null {
  if (repoId !== undefined) {
    const repoFile = centerRelocatedRepoPath(userRoot, repoId);
    if (localRuntimeStateFileSystem.exists(repoFile)) {
      const parsed = parseTombstoneFile(repoFile);
      if (parsed.repoId !== repoId)
        throw new Error(`Center relocation tombstone at ${repoFile} names ${parsed.repoId}, expected ${repoId}.`);
      return parsed;
    }
    const sharedFile = centerRelocatedPath(userRoot);
    if (!localRuntimeStateFileSystem.exists(sharedFile)) return null;
    const parsed = parseTombstoneFile(sharedFile);
    return parsed.repoId === repoId ? parsed : null;
  }
  const sharedFile = centerRelocatedPath(userRoot);
  if (localRuntimeStateFileSystem.exists(sharedFile)) return parseTombstoneFile(sharedFile);
  const repoDir = path.join(path.resolve(userRoot), "fleet", "center-relocated");
  if (!localRuntimeStateFileSystem.exists(repoDir)) return null;
  const entries = localLedgerBackupFileSystem
    .readDirectory(repoDir)
    .filter((name: string) => name.endsWith(".json"))
    .sort();
  return entries.length === 1 ? parseTombstoneFile(path.join(repoDir, entries[0]!)) : null;
}

export function writeCenterRelocated(userRoot: string, tombstone: CenterRelocatedTombstoneV1): string {
  const existingForRepo = readCenterRelocated(userRoot, tombstone.repoId);
  if (existingForRepo !== null && JSON.stringify(existingForRepo) !== JSON.stringify(tombstone))
    throw new Error("Center relocation is irreversible and the existing tombstone differs.");
  const body = `${JSON.stringify(tombstone, null, 2)}\n`,
    repoFile = centerRelocatedRepoPath(userRoot, tombstone.repoId),
    sharedFile = centerRelocatedPath(userRoot);
  writeFileDurably(repoFile, body, 0o600);
  if (!localRuntimeStateFileSystem.exists(sharedFile) || parseTombstoneFile(sharedFile).repoId === tombstone.repoId)
    writeFileDurably(sharedFile, body, 0o600);
  return repoFile;
}

export function writerEpochRetirementSealPath(userRoot: string, repoId: string): string {
  return path.join(path.resolve(userRoot), "fleet", "writer-epochs", `${repoId}.retired.json`);
}

export function writeWriterEpochRetirementSeal(userRoot: string, seal: WriterEpochRetirementSealV1): string {
  const file = writerEpochRetirementSealPath(userRoot, seal.repoId);
  writeFileDurably(file, `${JSON.stringify(seal, null, 2)}\n`, 0o600);
  return file;
}

export function readWriterEpochRetirementSeal(
  stateRootOrUserRoot: string,
  repoId: string,
): WriterEpochRetirementSealV1 | null {
  const resolved = path.resolve(stateRootOrUserRoot),
    direct = path.join(resolved, "writer-epochs", `${repoId}.retired.json`),
    underFleet = writerEpochRetirementSealPath(resolved, repoId),
    file = localRuntimeStateFileSystem.exists(direct)
      ? direct
      : localRuntimeStateFileSystem.exists(underFleet)
        ? underFleet
        : null;
  if (file === null) return null;
  const value = JSON.parse(localRuntimeStateFileSystem.readText(file)) as Partial<WriterEpochRetirementSealV1>;
  if (
    value.schema !== "writer-epoch-retirement-seal/v1" ||
    value.repoId !== repoId ||
    !Number.isSafeInteger(value.retiredEpoch) ||
    !Number.isSafeInteger(value.newEpoch) ||
    value.newEpoch !== Number(value.retiredEpoch) + 1 ||
    typeof value.retiredAt !== "string"
  )
    throw new Error(`Writer-epoch retirement seal at ${file} is invalid.`);
  return value as WriterEpochRetirementSealV1;
}

export function centerMovedError(userRoot: string, repoId: string): CenterMovedError | null {
  const tombstone = readCenterRelocated(userRoot, repoId);
  return tombstone === null ? null : new CenterMovedError(tombstone);
}

export function throwIfCenterRelocated(userRoot: string, repoId: string): void {
  const moved = centerMovedError(userRoot, repoId);
  if (moved !== null) throw moved;
}

export function throwIfWriterEpochRetired(stateRoot: string, repoId: string): void {
  const resolvedStateRoot = path.resolve(stateRoot),
    moved = centerMovedError(path.dirname(resolvedStateRoot), repoId);
  if (moved !== null) throw moved;
  const seal = readWriterEpochRetirementSeal(resolvedStateRoot, repoId);
  if (seal !== null)
    throw new WriterEpochError(
      "CENTER_MOVED",
      `Writer epoch ${String(seal.retiredEpoch)} for ${repoId} is permanently retired at epoch ${String(seal.newEpoch)}.`,
    );
}

export function centerMigratingPath(userRoot: string, repoId: string): string {
  return path.join(path.resolve(userRoot), "fleet", "center-migrating", `${repoId}.json`);
}

export function enterCenterMigrating(userRoot: string, repoId: string, writerEpoch: number, now?: Date): string {
  const file = centerMigratingPath(userRoot, repoId),
    payload: CenterMigratingStateV1 = {
      schema: "center-migrating/v1",
      repoId,
      writerEpoch,
      startedAt: (now ?? new Date()).toISOString(),
    };
  writeFileDurably(file, `${JSON.stringify(payload, null, 2)}\n`, 0o600);
  return file;
}

export function clearCenterMigrating(userRoot: string, repoId: string): void {
  const file = centerMigratingPath(userRoot, repoId);
  if (localRuntimeStateFileSystem.exists(file)) removeFileDurably(file);
}

export function readCenterMigrating(userRoot: string, repoId: string): CenterMigratingStateV1 | null {
  const file = centerMigratingPath(userRoot, repoId);
  if (!localRuntimeStateFileSystem.exists(file)) return null;
  const value = JSON.parse(localRuntimeStateFileSystem.readText(file)) as Partial<CenterMigratingStateV1>;
  if (
    value.schema !== "center-migrating/v1" ||
    value.repoId !== repoId ||
    !Number.isSafeInteger(value.writerEpoch) ||
    typeof value.startedAt !== "string"
  )
    return null;
  return value as CenterMigratingStateV1;
}

export function throwIfCenterMigrating(userRoot: string, repoId: string): void {
  if (readCenterMigrating(userRoot, repoId) !== null) throw new CenterMigratingError(repoId);
}

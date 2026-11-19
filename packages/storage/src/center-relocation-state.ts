import path from "node:path";
import { localRuntimeStateFileSystem } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import { writeFileDurably } from "./durable-file.ts";

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

export function centerRelocatedPath(userRoot: string): string {
  return path.join(path.resolve(userRoot), "fleet", "center-relocated.json");
}

export function readCenterRelocated(userRoot: string, repoId?: string): CenterRelocatedTombstoneV1 | null {
  const file = centerRelocatedPath(userRoot);
  if (!localRuntimeStateFileSystem.exists(file)) return null;
  const value = JSON.parse(localRuntimeStateFileSystem.readText(file)) as Partial<CenterRelocatedTombstoneV1>;
  const oldEpoch = value.oldEpoch,
    newEpoch = value.newEpoch;
  if (
    value.schema !== "center-relocated/v1" ||
    typeof value.repoId !== "string" ||
    (repoId !== undefined && value.repoId !== repoId) ||
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

export function writeCenterRelocated(userRoot: string, tombstone: CenterRelocatedTombstoneV1): string {
  const file = centerRelocatedPath(userRoot),
    existing = readCenterRelocated(userRoot);
  if (existing !== null && JSON.stringify(existing) !== JSON.stringify(tombstone))
    throw new Error("Center relocation is irreversible and the existing tombstone differs.");
  writeFileDurably(file, `${JSON.stringify(tombstone, null, 2)}\n`, 0o600);
  return file;
}

export function writerEpochRetirementSealPath(userRoot: string, repoId: string): string {
  return path.join(path.resolve(userRoot), "fleet", "writer-epochs", `${repoId}.retired.json`);
}

export function writeWriterEpochRetirementSeal(userRoot: string, seal: WriterEpochRetirementSealV1): string {
  const file = writerEpochRetirementSealPath(userRoot, seal.repoId);
  writeFileDurably(file, `${JSON.stringify(seal, null, 2)}\n`, 0o600);
  return file;
}

export function centerMovedError(userRoot: string, repoId: string): CenterMovedError | null {
  const tombstone = readCenterRelocated(userRoot, repoId);
  return tombstone === null ? null : new CenterMovedError(tombstone);
}

export function throwIfCenterRelocated(userRoot: string, repoId: string): void {
  const moved = centerMovedError(userRoot, repoId);
  if (moved !== null) throw moved;
}

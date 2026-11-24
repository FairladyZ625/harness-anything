import path from "node:path";
import {
  localLedgerBackupFileSystem,
  localRuntimeStateFileSystem,
} from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import type { CenterSwitchoverFenceState } from "@harness-anything/kernel/internal/domain/center-switchover.ts";
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

/**
 * Reversible switchover fence persisted BEFORE target activation (dec_AAEC26DBB6F23BDF80876ABB2C CH3).
 * Distinct from permanent CenterRelocatedTombstoneV1 (`center-relocated.json`): while active, a restarted old center
 * cannot acquire <= cededEpoch and returns CENTER_MOVED; it can be lifted only by audited oldEpoch+2 rollback
 * or a later switchback promotion at newEpoch > cededEpoch.
 */
export interface CenterSwitchoverFenceV1 extends CenterMovedDetails {
  readonly schema: "center-switchover-fence/v1";
  readonly switchoverId: string;
  readonly repoId: string;
  readonly state: CenterSwitchoverFenceState;
  readonly oldEpoch: number;
  readonly cededEpoch: number;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly finalRevision: number;
  readonly tipHash: string;
  readonly fencedAt: string;
  readonly demotedAt?: string;
  /** Immutable target TLS authority metadata captured at Phase 1 (F3). */
  readonly targetCaPath?: string;
  readonly targetServername?: string;
  /** Immutable local-path authority captured only when Phase 1 ran in explicit local-path CLI mode (F3). */
  readonly targetRoot?: string;
  readonly targetUserRoot?: string;
  readonly targetStateRoot?: string;
}

export interface SwitchoverInvalidatedAttemptsV1 {
  readonly schema: "center-switchover-invalidated/v1";
  readonly repoId: string;
  readonly attempts: readonly {
    readonly switchoverId: string;
    readonly invalidatedAt: string;
  }[];
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

export function centerSwitchoverFencePath(userRoot: string, repoId: string): string {
  return path.join(path.resolve(userRoot), "fleet", "center-switchover-fence", `${repoId}.json`);
}

function parseSwitchoverFenceFile(file: string, expectedRepoId: string): CenterSwitchoverFenceV1 {
  const value = JSON.parse(localRuntimeStateFileSystem.readText(file)) as Partial<CenterSwitchoverFenceV1>;
  if (
    value.schema !== "center-switchover-fence/v1" ||
    typeof value.switchoverId !== "string" ||
    value.switchoverId.length === 0 ||
    value.repoId !== expectedRepoId ||
    (value.state !== "fenced_ceded" && value.state !== "demoted_edge") ||
    !Number.isSafeInteger(value.oldEpoch) ||
    !Number.isSafeInteger(value.cededEpoch) ||
    !Number.isSafeInteger(value.newEpoch) ||
    value.newEpoch !== value.cededEpoch ||
    Number(value.cededEpoch) < Number(value.oldEpoch) + 1 ||
    !Number.isSafeInteger(value.finalRevision) ||
    typeof value.sourceNodeId !== "string" ||
    typeof value.targetNodeId !== "string" ||
    typeof value.tipHash !== "string" ||
    typeof value.newExternalUrl !== "string" ||
    typeof value.newLoginUrl !== "string" ||
    typeof value.spkiSha256 !== "string" ||
    typeof value.fencedAt !== "string" ||
    (value.targetCaPath !== undefined &&
      (typeof value.targetCaPath !== "string" || !path.isAbsolute(value.targetCaPath))) ||
    (value.targetServername !== undefined && typeof value.targetServername !== "string") ||
    (value.targetRoot !== undefined && (typeof value.targetRoot !== "string" || !path.isAbsolute(value.targetRoot))) ||
    (value.targetUserRoot !== undefined &&
      (typeof value.targetUserRoot !== "string" || !path.isAbsolute(value.targetUserRoot))) ||
    (value.targetStateRoot !== undefined &&
      (typeof value.targetStateRoot !== "string" || !path.isAbsolute(value.targetStateRoot)))
  )
    throw new Error(`Center switchover fence at ${file} is invalid.`);
  return value as CenterSwitchoverFenceV1;
}

export function readCenterSwitchoverFence(userRoot: string, repoId: string): CenterSwitchoverFenceV1 | null {
  const file = centerSwitchoverFencePath(userRoot, repoId);
  if (!localRuntimeStateFileSystem.exists(file)) return null;
  return parseSwitchoverFenceFile(file, repoId);
}

export function writeCenterSwitchoverFence(userRoot: string, fence: CenterSwitchoverFenceV1): string {
  if (
    !Number.isSafeInteger(fence.oldEpoch) ||
    fence.oldEpoch < 1 ||
    !Number.isSafeInteger(fence.cededEpoch) ||
    fence.cededEpoch < fence.oldEpoch + 1
  )
    throw new Error(
      `Center switchover fence cededEpoch (${String(fence.cededEpoch)}) must be >= oldEpoch + 1 (${String(fence.oldEpoch + 1)}).`,
    );
  if (fence.newEpoch !== fence.cededEpoch) throw new Error("Center switchover fence newEpoch must equal cededEpoch.");
  const file = centerSwitchoverFencePath(userRoot, fence.repoId);
  writeFileDurably(file, `${JSON.stringify(fence, null, 2)}\n`, 0o600);
  return file;
}

export function markCenterSwitchoverFenceDemoted(
  userRoot: string,
  repoId: string,
  switchoverId: string,
  demotedAt = new Date().toISOString(),
): CenterSwitchoverFenceV1 {
  const existing = readCenterSwitchoverFence(userRoot, repoId);
  if (existing === null) throw new Error(`Cannot mark switchover fence demoted: no fence exists for ${repoId}.`);
  if (existing.switchoverId !== switchoverId)
    throw new Error(
      `Switchover fence for ${repoId} belongs to ${existing.switchoverId}, cannot demote for ${switchoverId}.`,
    );
  const updated: CenterSwitchoverFenceV1 = { ...existing, state: "demoted_edge", demotedAt };
  writeCenterSwitchoverFence(userRoot, updated);
  return updated;
}

export function clearCenterSwitchoverFence(userRoot: string, repoId: string): void {
  const file = centerSwitchoverFencePath(userRoot, repoId);
  if (localRuntimeStateFileSystem.exists(file)) removeFileDurably(file);
}

export function switchoverInvalidatedAttemptsPath(stateRoot: string, repoId: string): string {
  return path.join(path.resolve(stateRoot), "switchover-invalidated", `${repoId}.json`);
}

function readSwitchoverInvalidatedAttempts(stateRoot: string, repoId: string): SwitchoverInvalidatedAttemptsV1 {
  const file = switchoverInvalidatedAttemptsPath(stateRoot, repoId);
  if (!localRuntimeStateFileSystem.exists(file))
    return { schema: "center-switchover-invalidated/v1", repoId, attempts: [] };
  const parsed = JSON.parse(localRuntimeStateFileSystem.readText(file)) as Partial<SwitchoverInvalidatedAttemptsV1>,
    entries = parsed.attempts;
  if (parsed.schema !== "center-switchover-invalidated/v1" || parsed.repoId !== repoId || !Array.isArray(entries))
    throw new Error(`Invalidated switchover attempt ledger at ${file} is invalid.`);
  return parsed as SwitchoverInvalidatedAttemptsV1;
}

export function recordInvalidatedSwitchoverAttempt(
  stateRoot: string,
  repoId: string,
  switchoverId: string,
  invalidatedAt = new Date().toISOString(),
): SwitchoverInvalidatedAttemptsV1 {
  const current = readSwitchoverInvalidatedAttempts(stateRoot, repoId);
  if (current.attempts.some((entry) => entry.switchoverId === switchoverId)) return current;
  const next: SwitchoverInvalidatedAttemptsV1 = {
    schema: "center-switchover-invalidated/v1",
    repoId,
    attempts: [...current.attempts, { switchoverId, invalidatedAt }],
  };
  writeFileDurably(switchoverInvalidatedAttemptsPath(stateRoot, repoId), `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return next;
}

export function isSwitchoverAttemptInvalidated(stateRoot: string, repoId: string, switchoverId: string): boolean {
  return readSwitchoverInvalidatedAttempts(stateRoot, repoId).attempts.some(
    (entry) => entry.switchoverId === switchoverId,
  );
}

export function centerMovedError(
  userRoot: string,
  repoId: string,
  options?: { readonly repoMode?: string },
): CenterMovedError | null {
  const tombstone = readCenterRelocated(userRoot, repoId);
  if (tombstone !== null) return new CenterMovedError(tombstone);
  const fence = readCenterSwitchoverFence(userRoot, repoId);
  if (fence === null) return null;
  // Once Phase 1 fsyncs `fenced_ceded`, the old center is blocked across restarts regardless of caller mode.
  // After Phase 3 transitions the fence to `demoted_edge`, local remote-edge mode reads/forwards normally while
  // center-role paths (local mode, writer epochs, center-listener) still enforce CENTER_MOVED.
  if (fence.state === "fenced_ceded" || options?.repoMode !== "remote-edge") return new CenterMovedError(fence);
  return null;
}

export function throwIfCenterRelocated(
  userRoot: string,
  repoId: string,
  options?: { readonly repoMode?: string },
): void {
  const moved = centerMovedError(userRoot, repoId, options);
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

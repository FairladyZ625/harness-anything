import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { AuthorityFenceWitness } from "@harness-anything/application";

export const singleAuthorityBoundedRpoProfile = "SINGLE_AUTHORITY_BOUNDED_RPO" as const;

export type DurabilityAuditStage =
  | "CANONICAL_OBJECTS_FSYNCED"
  | "CANONICAL_REF_FSYNCED"
  | "OPERATION_INDEX_FSYNCED"
  | "ORIGIN_RESULT_DURABLE"
  | "BACKUP_HOOK_RECORDED";

const durabilityAuditStages = new Set<DurabilityAuditStage>([
  "CANONICAL_OBJECTS_FSYNCED",
  "CANONICAL_REF_FSYNCED",
  "OPERATION_INDEX_FSYNCED",
  "ORIGIN_RESULT_DURABLE",
  "BACKUP_HOOK_RECORDED"
]);

export interface SingleAuthorityDurabilityAuditRecord {
  readonly schema: "single-authority-durability-audit/v1";
  readonly profile: typeof singleAuthorityBoundedRpoProfile;
  readonly commitSha: string;
  readonly completedStages: ReadonlyArray<DurabilityAuditStage>;
  readonly backupWatermark: string;
  readonly backupBoundSatisfied: boolean;
}

export interface SingleAuthorityBackupResult {
  readonly watermark: string;
  readonly boundSatisfied: boolean;
}

export interface SingleAuthorityBackupHook {
  readonly capture: (input: {
    readonly profile: typeof singleAuthorityBoundedRpoProfile;
    readonly commitSha: string;
  }) => Promise<SingleAuthorityBackupResult>;
}

export interface SingleAuthorityBoundedRpoCommitOptions {
  readonly fenceWitness: AuthorityFenceWitness;
  readonly ledger: SingleAuthorityDurabilityLedger;
  readonly backupHook: SingleAuthorityBackupHook;
  readonly prepareCanonicalObjects: () => Promise<{ readonly commitSha: string }>;
  readonly fsyncCanonicalObjects: (commitSha: string) => Promise<void>;
  readonly publishCanonicalRef: (commitSha: string) => Promise<void>;
  readonly fsyncCanonicalRef: (commitSha: string) => Promise<void>;
  readonly fsyncOperationIndex: (commitSha: string) => Promise<void>;
  readonly persistOriginResult: (commitSha: string) => Promise<void>;
}

export interface SingleAuthorityCommittedBoundary {
  readonly tag: "COMMITTED";
  readonly profile: typeof singleAuthorityBoundedRpoProfile;
  readonly commitSha: string;
  readonly backupWatermark: string;
}

export class DurabilityBoundUnsatisfiedError extends Error {
  readonly code = "DURABILITY_BOUND_UNSATISFIED";
  readonly commitSha: string;
  readonly backupWatermark: string;

  constructor(commitSha: string, backupWatermark: string) {
    super(`COMMITTED withheld for ${commitSha}: configured backup bound is not satisfied`);
    this.name = "DurabilityBoundUnsatisfiedError";
    this.commitSha = commitSha;
    this.backupWatermark = backupWatermark;
  }
}

export class SingleAuthorityDurabilityLedger {
  readonly path: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(ledgerPath: string) {
    this.path = ledgerPath;
  }

  append(record: SingleAuthorityDurabilityAuditRecord): Promise<void> {
    const pending = this.tail.then(() => appendDurabilityRecord(this.path, record));
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}

export async function runSingleAuthorityBoundedRpoCommit(
  options: SingleAuthorityBoundedRpoCommitOptions
): Promise<SingleAuthorityCommittedBoundary> {
  await options.fenceWitness.assertHeld();
  const prepared = await options.prepareCanonicalObjects();
  await options.fenceWitness.assertHeld();
  await options.fsyncCanonicalObjects(prepared.commitSha);
  await options.fenceWitness.assertHeld();
  await options.publishCanonicalRef(prepared.commitSha);
  await options.fsyncCanonicalRef(prepared.commitSha);
  await options.fsyncOperationIndex(prepared.commitSha);
  await options.persistOriginResult(prepared.commitSha);
  const backup = await options.backupHook.capture({
    profile: singleAuthorityBoundedRpoProfile,
    commitSha: prepared.commitSha
  });
  await options.ledger.append({
    schema: "single-authority-durability-audit/v1",
    profile: singleAuthorityBoundedRpoProfile,
    commitSha: prepared.commitSha,
    completedStages: [
      "CANONICAL_OBJECTS_FSYNCED",
      "CANONICAL_REF_FSYNCED",
      "OPERATION_INDEX_FSYNCED",
      "ORIGIN_RESULT_DURABLE",
      "BACKUP_HOOK_RECORDED"
    ],
    backupWatermark: backup.watermark,
    backupBoundSatisfied: backup.boundSatisfied
  });
  if (!backup.boundSatisfied) {
    throw new DurabilityBoundUnsatisfiedError(prepared.commitSha, backup.watermark);
  }
  return {
    tag: "COMMITTED",
    profile: singleAuthorityBoundedRpoProfile,
    commitSha: prepared.commitSha,
    backupWatermark: backup.watermark
  };
}

export async function readSingleAuthorityDurabilityLedger(
  ledgerPath: string
): Promise<ReadonlyArray<SingleAuthorityDurabilityAuditRecord>> {
  let body: Buffer;
  try {
    body = await readFile(ledgerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return scanSingleAuthorityDurabilityLedger(body).records;
}

async function appendDurabilityRecord(
  ledgerPath: string,
  record: SingleAuthorityDurabilityAuditRecord
): Promise<void> {
  if (!isSingleAuthorityDurabilityAuditRecord(record)) {
    throw new Error("invalid single-authority durability audit record");
  }
  const directory = path.dirname(ledgerPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(ledgerPath, "a+", 0o600);
  try {
    const scan = scanSingleAuthorityDurabilityLedger(await handle.readFile());
    if (scan.repairRequired) {
      await handle.truncate(scan.validByteLength);
      await handle.sync();
      await fsyncSingleAuthorityDurabilityDirectory(directory);
    }
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncSingleAuthorityDurabilityDirectory(directory);
}

interface SingleAuthorityDurabilityLedgerScan {
  readonly records: ReadonlyArray<SingleAuthorityDurabilityAuditRecord>;
  readonly validByteLength: number;
  readonly repairRequired: boolean;
}

function scanSingleAuthorityDurabilityLedger(body: Buffer): SingleAuthorityDurabilityLedgerScan {
  const lines: Array<{ readonly start: number; readonly end: number; readonly terminated: boolean }> = [];
  let start = 0;
  for (let offset = 0; offset < body.byteLength; offset += 1) {
    if (body[offset] !== 0x0a) continue;
    lines.push({ start, end: offset, terminated: true });
    start = offset + 1;
  }
  if (start < body.byteLength) lines.push({ start, end: body.byteLength, terminated: false });
  const lastNonEmpty = lines.findLastIndex(({ start: lineStart, end }) => end > lineStart);
  const records: SingleAuthorityDurabilityAuditRecord[] = [];
  let validByteLength = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.end === line.start) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.subarray(line.start, line.end).toString("utf8"));
    } catch (error) {
      if (index === lastNonEmpty) return { records, validByteLength, repairRequired: true };
      throw new Error(`invalid single-authority durability ledger record at byte ${line.start}`, { cause: error });
    }
    if (!isSingleAuthorityDurabilityAuditRecord(parsed)) {
      if (index === lastNonEmpty) return { records, validByteLength, repairRequired: true };
      throw new Error(`invalid single-authority durability ledger schema at byte ${line.start}`);
    }
    if (!line.terminated) return { records, validByteLength, repairRequired: true };
    records.push(parsed);
    validByteLength = line.end + 1;
  }
  return { records, validByteLength: body.byteLength, repairRequired: false };
}

function isSingleAuthorityDurabilityAuditRecord(value: unknown): value is SingleAuthorityDurabilityAuditRecord {
  if (!isDurabilityLedgerJsonRecord(value)) return false;
  const keys = Object.keys(value);
  const recordKeys = new Set([
    "schema",
    "profile",
    "commitSha",
    "completedStages",
    "backupWatermark",
    "backupBoundSatisfied"
  ]);
  if (keys.length !== recordKeys.size || !keys.every((key) => recordKeys.has(key))) return false;
  return value.schema === "single-authority-durability-audit/v1"
    && value.profile === singleAuthorityBoundedRpoProfile
    && typeof value.commitSha === "string" && value.commitSha.length > 0
    && Array.isArray(value.completedStages)
    && value.completedStages.every((stage) => typeof stage === "string"
      && durabilityAuditStages.has(stage as DurabilityAuditStage))
    && new Set(value.completedStages).size === value.completedStages.length
    && typeof value.backupWatermark === "string" && value.backupWatermark.length > 0
    && typeof value.backupBoundSatisfied === "boolean";
}

function isDurabilityLedgerJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fsyncSingleAuthorityDurabilityDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

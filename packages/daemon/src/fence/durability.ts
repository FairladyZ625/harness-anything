import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { AuthorityFenceWitness } from "../../../application/src/index.ts";

export const singleAuthorityBoundedRpoProfile = "SINGLE_AUTHORITY_BOUNDED_RPO" as const;

export type DurabilityAuditStage =
  | "CANONICAL_OBJECTS_FSYNCED"
  | "CANONICAL_REF_FSYNCED"
  | "OPERATION_INDEX_FSYNCED"
  | "ORIGIN_RESULT_DURABLE"
  | "BACKUP_HOOK_RECORDED";

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
  let body: string;
  try {
    body = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const completeBody = body.endsWith("\n") ? body : body.slice(0, body.lastIndexOf("\n") + 1);
  return completeBody
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as SingleAuthorityDurabilityAuditRecord);
}

async function appendDurabilityRecord(
  ledgerPath: string,
  record: SingleAuthorityDurabilityAuditRecord
): Promise<void> {
  const directory = path.dirname(ledgerPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(ledgerPath, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform === "win32") return;
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

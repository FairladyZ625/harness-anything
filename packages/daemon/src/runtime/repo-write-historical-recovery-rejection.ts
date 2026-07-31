import { closeSync } from "node:fs";
import path from "node:path";
import { stableStringify } from "@harness-anything/kernel";
import {
  repoWriteOutcomeDurablePathExists,
  repoWriteOutcomeFsyncOpened,
  repoWriteOutcomePublishOnce,
  repoWriteOutcomeReadPrivateText,
  type RepoWriteOutcomeDurabilityTestHooks
} from "./repo-write-outcome-durable-file.ts";
import {
  RepoWriteOutcomeConflictError,
  RepoWriteOutcomeCorruptionError,
  RepoWriteOutcomeValidationError
} from "./repo-write-outcome-errors.ts";
import type {
  RepoWriteOutcomeAxesV1,
  RepoWriteOutcomeV1,
  RepoWriteProceedingOutcomeV1
} from "./repo-write-outcome-schema.ts";

const schema = "repo-write-historical-recovery-rejection/v1" as const;

export interface RepoWriteHistoricalRecoveryRejectionV1 {
  readonly schema: typeof schema;
  readonly disposition: "permanently-rejected";
  readonly repoId: string;
  readonly workspaceId: string;
  readonly proceedingGeneration: number;
  readonly rejectedByGeneration: number;
  readonly outerOpId: string;
  readonly requestDigest: string;
  readonly innerOpId: string;
  readonly authoritySemanticDigest: string;
  readonly code: string;
}

export interface RepoWriteHistoricalRecoveryRejectInputV1 extends RepoWriteOutcomeAxesV1 {
  readonly outerOpId: string;
  readonly requestDigest: string;
  readonly code: string;
}

interface HistoricalRecoveryRejectionStoreInput {
  readonly directory: string;
  readonly file: string;
  readonly axes: RepoWriteOutcomeAxesV1;
  readonly current: RepoWriteOutcomeV1 | undefined;
  readonly hooks?: RepoWriteOutcomeDurabilityTestHooks;
  readonly allowNewerRejectingGeneration?: boolean;
}

export function repoWriteHistoricalRecoveryRejectionRead(
  input: HistoricalRecoveryRejectionStoreInput
): RepoWriteHistoricalRecoveryRejectionV1 | undefined {
  if (!repoWriteOutcomeDurablePathExists(input.file)) return undefined;
  if (!input.current || input.current.phase !== "PROCEEDING") {
    throw new RepoWriteOutcomeCorruptionError(
      "historical recovery rejection has no unsettled PROCEEDING"
    );
  }
  return readCanonical(
    input.file,
    input.current,
    input.axes,
    input.hooks,
    input.allowNewerRejectingGeneration === true
  );
}

export function repoWriteHistoricalRecoveryReject(
  input: HistoricalRecoveryRejectionStoreInput & {
    readonly requestDigest: string;
    readonly code: string;
  }
): RepoWriteHistoricalRecoveryRejectionV1 {
  const current = input.current;
  if (!current || current.phase !== "PROCEEDING") {
    throw new RepoWriteOutcomeConflictError(
      "historical recovery rejection requires unsettled PROCEEDING"
    );
  }
  if (current.generation >= input.axes.generation) {
    throw new RepoWriteOutcomeConflictError(
      "historical recovery rejection requires an older writer generation"
    );
  }
  if (current.requestDigest !== input.requestDigest) {
    throw new RepoWriteOutcomeConflictError(
      "outer opId is already bound to a different request digest"
    );
  }
  const candidate = createRejection(current, input.axes.generation, input.code);
  const raceTolerantInput = {
    ...input,
    allowNewerRejectingGeneration: true
  };
  const existing = repoWriteHistoricalRecoveryRejectionRead(raceTolerantInput);
  if (existing) return idempotent(existing, candidate);
  const published = repoWriteOutcomePublishOnce(
    input.directory,
    input.file,
    canonicalText(candidate),
    input.hooks
  );
  const durable = repoWriteHistoricalRecoveryRejectionRead(raceTolerantInput);
  if (!durable) {
    throw new RepoWriteOutcomeCorruptionError(
      "historical recovery rejection publication disappeared"
    );
  }
  return published ? durable : idempotent(durable, candidate);
}

function createRejection(
  proceeding: RepoWriteProceedingOutcomeV1,
  rejectedByGeneration: number,
  code: string
): RepoWriteHistoricalRecoveryRejectionV1 {
  if (!/^[A-Z][A-Z0-9_]{0,255}$/u.test(code)) {
    throw new RepoWriteOutcomeValidationError(
      "historical recovery rejection code must be a bounded uppercase identifier"
    );
  }
  return {
    schema,
    disposition: "permanently-rejected",
    repoId: proceeding.repoId,
    workspaceId: proceeding.workspaceId,
    proceedingGeneration: proceeding.generation,
    rejectedByGeneration,
    outerOpId: proceeding.outerOpId,
    requestDigest: proceeding.requestDigest,
    innerOpId: proceeding.innerOpId,
    authoritySemanticDigest: proceeding.authoritySemanticDigest,
    code
  };
}

function readCanonical(
  file: string,
  proceeding: RepoWriteProceedingOutcomeV1,
  axes: RepoWriteOutcomeAxesV1,
  hooks?: RepoWriteOutcomeDurabilityTestHooks,
  allowNewerRejectingGeneration = false
): RepoWriteHistoricalRecoveryRejectionV1 {
  try {
    const { descriptor, text } = repoWriteOutcomeReadPrivateText(file);
    try {
      const record = parseRecord(text);
      if (!Number.isSafeInteger(record.rejectedByGeneration)
        || (record.rejectedByGeneration as number) <= proceeding.generation
        || (!allowNewerRejectingGeneration
          && (record.rejectedByGeneration as number) > axes.generation)) {
        throw new RepoWriteOutcomeValidationError(
          "historical recovery rejection has invalid generation fencing"
        );
      }
      const decoded = createRejection(
        proceeding,
        record.rejectedByGeneration as number,
        typeof record.code === "string" ? record.code : ""
      );
      if (!matches(record, decoded) || text !== canonicalText(decoded)) {
        throw new RepoWriteOutcomeValidationError(
          "historical recovery rejection does not bind its PROCEEDING"
        );
      }
      repoWriteOutcomeFsyncOpened(descriptor, file, hooks, "observe-existing");
      return decoded;
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (error instanceof RepoWriteOutcomeCorruptionError) throw error;
    throw new RepoWriteOutcomeCorruptionError(
      `cannot read durable historical recovery rejection: ${path.basename(file)}`,
      { cause: error }
    );
  }
}

function parseRecord(text: string): Record<string, unknown> {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RepoWriteOutcomeValidationError("historical recovery rejection must be an object");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "schema", "disposition", "repoId", "workspaceId", "proceedingGeneration",
    "rejectedByGeneration", "outerOpId", "requestDigest", "innerOpId",
    "authoritySemanticDigest", "code"
  ];
  if (Object.keys(record).length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.hasOwn(record, key))) {
    throw new RepoWriteOutcomeValidationError("historical recovery rejection has invalid fields");
  }
  return record;
}

function matches(
  record: Record<string, unknown>,
  expected: RepoWriteHistoricalRecoveryRejectionV1
): boolean {
  return Object.entries(expected).every(([key, value]) => record[key] === value);
}

function canonicalText(rejection: RepoWriteHistoricalRecoveryRejectionV1): string {
  return `${stableStringify(rejection)}\n`;
}

function idempotent(
  current: RepoWriteHistoricalRecoveryRejectionV1,
  candidate: RepoWriteHistoricalRecoveryRejectionV1
): RepoWriteHistoricalRecoveryRejectionV1 {
  const currentRecord = current as unknown as Record<string, unknown>;
  const candidateRecord = candidate as unknown as Record<string, unknown>;
  if (Object.entries(candidateRecord).some(([key, value]) =>
    key !== "rejectedByGeneration" && currentRecord[key] !== value)) {
    throw new RepoWriteOutcomeConflictError("historical recovery rejection is immutable");
  }
  return current;
}

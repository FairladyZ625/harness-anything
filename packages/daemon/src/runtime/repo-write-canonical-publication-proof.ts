import { RepoWriteOutcomeValidationError } from "./repo-write-outcome-errors.ts";
import {
  repoWriteJsonBudget,
  repoWriteJsonObjectAt
} from "./repo-write-json-budget.ts";

export const repoWriteCanonicalPublicationEvidenceSchema =
  "repo-write-canonical-publication-evidence/v1" as const;
export const repoWriteCanonicalAncestryAnchorSchema =
  "repo-write-canonical-ancestry-anchor/v1" as const;

const digestPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export interface RepoWriteCanonicalPublicationEvidenceV1 {
  readonly schema: typeof repoWriteCanonicalPublicationEvidenceSchema;
  readonly tag: "CANONICAL_PUBLICATION";
  readonly workspaceId: string;
  readonly opId: string;
  readonly semanticDigest: string;
  readonly revision: number;
  readonly commitSha: string;
  readonly previousCommit: string | null;
  readonly canonicalAncestry: {
    readonly schema: typeof repoWriteCanonicalAncestryAnchorSchema;
    readonly acceptedCommitSha: string;
    readonly canonicalCommitSha: string;
  };
}

export function createRepoWriteCanonicalPublicationEvidenceV1(input: {
  readonly workspaceId: string;
  readonly opId: string;
  readonly semanticDigest: string;
  readonly revision: number;
  readonly commitSha: string;
  readonly previousCommit: string | null;
  readonly acceptedCommitSha: string;
}): RepoWriteCanonicalPublicationEvidenceV1 {
  return decodeRepoWriteCanonicalPublicationEvidenceV1({
    schema: repoWriteCanonicalPublicationEvidenceSchema,
    tag: "CANONICAL_PUBLICATION",
    workspaceId: input.workspaceId,
    opId: input.opId,
    semanticDigest: input.semanticDigest,
    revision: input.revision,
    commitSha: input.commitSha,
    previousCommit: input.previousCommit,
    canonicalAncestry: {
      schema: repoWriteCanonicalAncestryAnchorSchema,
      acceptedCommitSha: input.acceptedCommitSha,
      canonicalCommitSha: input.commitSha
    }
  });
}

export function decodeRepoWriteCanonicalPublicationEvidenceV1(
  value: unknown,
  path = "$.evidence"
): RepoWriteCanonicalPublicationEvidenceV1 {
  repoWriteJsonObjectAt(value, path, repoWriteJsonBudget(), 0);
  const record = recordAt(value, path);
  canonicalPublicationExactKeys(record, [
    "schema", "tag", "workspaceId", "opId", "semanticDigest", "revision",
    "commitSha", "previousCommit", "canonicalAncestry"
  ], path);
  if (record.schema !== repoWriteCanonicalPublicationEvidenceSchema) {
    invalid(`${path}.schema`, repoWriteCanonicalPublicationEvidenceSchema);
  }
  if (record.tag !== "CANONICAL_PUBLICATION") {
    invalid(`${path}.tag`, "CANONICAL_PUBLICATION");
  }
  const commitSha = commitAt(record.commitSha, `${path}.commitSha`);
  const previousCommit = record.previousCommit === null
    ? null
    : commitAt(record.previousCommit, `${path}.previousCommit`);
  const ancestry = recordAt(record.canonicalAncestry, `${path}.canonicalAncestry`);
  canonicalPublicationExactKeys(ancestry, [
    "schema", "acceptedCommitSha", "canonicalCommitSha"
  ], `${path}.canonicalAncestry`);
  if (ancestry.schema !== repoWriteCanonicalAncestryAnchorSchema) {
    invalid(`${path}.canonicalAncestry.schema`, repoWriteCanonicalAncestryAnchorSchema);
  }
  const acceptedCommitSha = commitAt(
    ancestry.acceptedCommitSha,
    `${path}.canonicalAncestry.acceptedCommitSha`
  );
  const canonicalCommitSha = commitAt(
    ancestry.canonicalCommitSha,
    `${path}.canonicalAncestry.canonicalCommitSha`
  );
  if (canonicalCommitSha !== commitSha) {
    invalid(`${path}.canonicalAncestry.canonicalCommitSha`, "exact equality with commitSha");
  }
  return {
    schema: repoWriteCanonicalPublicationEvidenceSchema,
    tag: "CANONICAL_PUBLICATION",
    workspaceId: identifierAt(record.workspaceId, `${path}.workspaceId`),
    opId: identifierAt(record.opId, `${path}.opId`),
    semanticDigest: digestAt(record.semanticDigest, `${path}.semanticDigest`),
    revision: uintAt(record.revision, `${path}.revision`),
    commitSha,
    previousCommit,
    canonicalAncestry: {
      schema: repoWriteCanonicalAncestryAnchorSchema,
      acceptedCommitSha,
      canonicalCommitSha
    }
  };
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, "plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, "plain object");
  return value as Record<string, unknown>;
}

function canonicalPublicationExactKeys(
  record: Record<string, unknown>,
  required: ReadonlyArray<string>,
  path: string
): void {
  const allowed = new Set(required);
  if (required.some((key) => !Object.hasOwn(record, key))
    || Object.keys(record).some((key) => !allowed.has(key))) {
    invalid(path, "exact canonical publication evidence fields");
  }
}

function identifierAt(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()
    || Buffer.byteLength(value, "utf8") > 4_096
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(path, "non-empty bounded identifier");
  }
  return value;
}

function digestAt(value: unknown, path: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    invalid(path, "lowercase SHA-256 digest");
  }
  return value;
}

function commitAt(value: unknown, path: string): string {
  if (typeof value !== "string" || !commitPattern.test(value)) {
    invalid(path, "lowercase Git object id");
  }
  return value;
}

function uintAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(path, "non-negative safe integer");
  }
  return value;
}

function invalid(path: string, expected: string): never {
  throw new RepoWriteOutcomeValidationError(
    `Invalid ${repoWriteCanonicalPublicationEvidenceSchema} at ${path}: expected ${expected}.`
  );
}

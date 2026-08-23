import { consumeKnownError } from "../error-consumption.ts";
import { stableStringify } from "../integrity/stable-hash.ts";
import {
  assertNoPortablePathCollisions,
  normalizeRelativeDocumentPath,
  type PortableDocumentPath,
} from "../layout/portable-path.ts";
import {
  DocSyncContractError,
} from "./doc-sync-types.ts";
import type {
  ContentClaim,
  CurrentDocEventV1,
  DocByteLength,
  DocClaimRef,
  DocWriteIntent,
  LedgerCommitSha,
} from "./doc-sync-types.ts";
import type { LedgerCutIdentity } from "./receipt-domain-registry.ts";
import {
  hasOnlyFields,
  isNonEmptyString,
  isRecord,
} from "./write-chain.contract.ts";

import { serializeCanonicalEvent } from "./doc-sync-canonical-events.ts";
import {
  commitSha,
  ledgerCutIdentity,
  nullableBlobSha,
  safeDocSyncPath,
  validDocSyncClaim,
  validateCurrentDocEvent,
} from "./doc-sync-validation.ts";

export function validateDocWriteIntent(value: unknown): readonly string[] {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, ["schema", "executionId", "baseLedgerSha", "changes"])
  )
    return ["doc intent fields are incomplete or unknown"];
  const errors: string[] = [];
  if (
    value.schema !== "doc-write-intent/v1" ||
    (value.executionId !== null && !isNonEmptyString(value.executionId)) ||
    !ledgerCutIdentity(value.baseLedgerSha) ||
    !Array.isArray(value.changes) ||
    value.changes.length === 0
  )
    errors.push("doc intent identity, base, or changes are invalid");
  const paths = new Set<string>();
  for (const change of Array.isArray(value.changes) ? value.changes : []) {
    if (
      !isRecord(change) ||
      !hasOnlyFields(change, [
        "path",
        "baseBlobSha256",
        "policyId",
        "candidate",
      ]) ||
      !safeDocSyncPath(change.path) ||
      !nullableBlobSha(change.baseBlobSha256) ||
      !isNonEmptyString(change.policyId) ||
      !validDocSyncClaim(change.candidate)
    )
      errors.push("doc change path, base, policy, or claim is invalid");
    else if (paths.has(change.path))
      errors.push(`duplicate doc path ${change.path}`);
    else paths.add(change.path);
  }
  try {
    assertNoPortablePathCollisions(
      Array.isArray(value.changes)
        ? value.changes.flatMap((change) =>
            isRecord(change) && typeof change.path === "string"
              ? [change.path]
              : [],
          )
        : [],
    );
  } catch (error) {
    consumeKnownError(error);
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

export function ledgerCommitSha(repoId: string, sha: string): LedgerCommitSha {
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(repoId) || !commitSha(sha))
    throw new DocSyncContractError(
      "ledger commit requires a canonical repoId and Git SHA",
    );
  return Object.freeze({ repoId, sha }) as LedgerCommitSha;
}

export function docClaimRef(value: string): DocClaimRef {
  const normalized = normalizeRelativeDocumentPath(value);
  if (normalized !== value || !normalized.startsWith("doc-sync-claims/"))
    throw new DocSyncContractError(
      "claim ref must be a canonical doc-sync-claims path",
    );
  return normalized as unknown as DocClaimRef;
}

export function docByteLength(value: number): DocByteLength {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new DocSyncContractError(
      "claim size must be a non-negative byte length",
    );
  return value as DocByteLength;
}

export function documentPath(value: string): PortableDocumentPath {
  const normalized = normalizeRelativeDocumentPath(value);
  if (normalized !== value)
    throw new DocSyncContractError(
      "document path must already be canonical NFC",
    );
  return normalized;
}

export function parseDocWriteIntent(
  value: unknown,
  repoId: string,
): DocWriteIntent {
  const errors = validateDocWriteIntent(value);
  if (errors.length) throw new DocSyncContractError(errors.join("; "));
  const raw = value as {
    readonly schema: "doc-write-intent/v1";
    readonly executionId: string | null;
    readonly baseLedgerSha: LedgerCutIdentity;
    readonly changes: readonly {
      readonly path: string;
      readonly baseBlobSha256: string | null;
      readonly policyId: string;
      readonly candidate: {
        readonly ref: string;
        readonly sha256: string;
        readonly size: number;
        readonly mediaType: ContentClaim["mediaType"];
      } | null;
    }[];
  };
  if (raw.baseLedgerSha.repoId !== repoId)
    throw new DocSyncContractError(
      "doc intent cut belongs to another repository",
    );
  return {
    ...raw,
    changes: raw.changes.map((change) => ({
      ...change,
      path: documentPath(change.path),
      candidate:
        change.candidate === null
          ? null
          : {
              ...change.candidate,
              ref: docClaimRef(change.candidate.ref),
              size: docByteLength(change.candidate.size),
            },
    })),
  };
}

export function serializeDocWriteIntent(intent: DocWriteIntent): string {
  const errors = validateDocWriteIntent(intent);
  if (errors.length) throw new DocSyncContractError(errors.join("; "));
  return `${stableStringify(intent)}\n`;
}

export function serializeDocEvent(event: unknown): string {
  const errors = validateCurrentDocEvent(event);
  if (errors.length) throw new DocSyncContractError(errors.join("; "));
  return serializeCanonicalEvent(event as CurrentDocEventV1);
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyTextualArtifactPath,
  OPAQUE_TEXTUAL_MEDIA_TYPE,
  OPAQUE_TEXTUAL_POLICY_ID,
} from "../../src/domain/artifact-text-classification.ts";
import docSyncContract, {
  DOC_POLICY_ID,
  decideDocWrite,
  docRegionPolicyRegistry,
  docSyncWritePlan,
  documentPath,
  parseCanonicalEvent,
  parseDocWriteIntent,
  resolveDocRoute,
  serializeCanonicalEvent,
  serializeDocEvent,
  serializeDocWriteIntent,
  validateCurrentDocEvent,
  validateDocEvent,
  validateDocWriteIntent,
  verifyDocEventChange,
  type ContentClaim,
  type DocWriteChange,
  type DocumentState,
} from "../../src/domain/doc-sync.contract.ts";
import { MIGRATION_DOCUMENT_POLICY_ID } from "../../src/domain/migration-import-event.ts";
import { resolveLiveTaskBoundRuntimeBinding } from "../../src/domain/task-bound-runtime-authority.ts";
import {
  validateWriteReceipt,
  validateWriteSource,
} from "../../src/domain/write-chain.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { validateCanonicalWriteBundle } from "../../src/store/task-event-store.ts";

export const actor = {
  principal: { personId: "person-owner" },
  executor: { kind: "agent", id: "codex" },
} as const;
export const baseLedgerSha = {
    repoId: "docs",
    revision: 2,
    headDigest: `sha256:${"a".repeat(64)}`,
  } as const,
  currentLedgerSha = baseLedgerSha;
export const legacyDocEventBytes = readFileSync(
  new URL(
    "../../fixtures/events/doc-event-v1-legacy-ledger-identity.json",
    import.meta.url,
  ),
  "utf8",
);
export const lease = {
  schema: "lease/v1",
  taskId: "task-owner",
  executionId: "execution-1",
  actor,
  source: "local",
  phase: "held",
  expiresAt: "2026-08-12T12:00:00.000Z",
  ttlMs: 1_800_000,
  version: 3,
} as const;
export const claim = (body: string) => ({
  ref: "doc-sync-claims/candidate",
  sha256: sha256Text(body),
  size: Buffer.byteLength(body),
  mediaType: "text/markdown" as const,
});
export const opaqueClaim = (
  body: string,
  mediaType: ContentClaim["mediaType"] = OPAQUE_TEXTUAL_MEDIA_TYPE,
) => ({
  ref: "doc-sync-claims/candidate",
  sha256: sha256Text(body),
  size: Buffer.byteLength(body),
  mediaType,
});
export const state = (body: string): DocumentState => ({
  path: "context/notes.md",
  blobSha256: sha256Text(body),
  body,
  size: Buffer.byteLength(body),
  mediaType: "text/markdown",
  policyId: DOC_POLICY_ID,
  workspaceRevision: 2,
});
export function decide(
  change: DocWriteChange,
  document: DocumentState | null,
  bytes: Uint8Array | null = change.candidate
    ? Buffer.from(
        change.candidate.sha256 === sha256Text("# Notes\nA\nB\n")
          ? "# Notes\nA\nB\n"
          : "# Notes\nA\n",
      )
    : null,
  overrides: Record<string, unknown> = {},
) {
  return decideDocWrite({
    intent: {
      schema: "doc-write-intent/v1",
      executionId: "execution-1",
      baseLedgerSha,
      changes: [change],
    },
    opId: "doc-op",
    eventId: "doc-event",
    workspaceRevision: 3,
    actor,
    source: "local",
    occurredAt: "2026-08-12T11:00:00.000Z",
    currentLedgerSha,
    lease,
    documents: [document],
    claims: [bytes],
    ...overrides,
  });
}

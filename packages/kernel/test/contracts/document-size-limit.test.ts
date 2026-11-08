// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  MIGRATION_DOCUMENT_POLICY_ID,
  migrationImportWritePlan,
  sha256Bytes,
  type MigrationImportEventV1,
} from "../../src/index.ts";
import { LEDGER_DOCUMENT_MAX_BYTES } from "../../src/domain/artifact-text-classification.ts";
import { validateCanonicalWriteBundle } from "../../src/ports/canonical-event-store.ts";

// dec_E355A3715D7C65666E385C8339 CH2. A migration import is the smallest canonical write that
// reaches the one document-volume judgment without a doc-sync scanner in front of it, so a bundle
// that would otherwise be accepted proves the write port itself is the boundary.
const actor = { principal: { personId: "person-owner" }, executor: null } as const;

function documentBundle(body: Uint8Array): {
  readonly event: MigrationImportEventV1;
  readonly plan: ReturnType<typeof migrationImportWritePlan>;
  readonly blobs: readonly { sha256: string; size: number; mediaType: string; body: Uint8Array }[];
} {
  const sha256 = sha256Bytes(body),
    event: MigrationImportEventV1 = {
      schema: "migration-import-event/v1",
      eventId: "event-document-size",
      workspaceRevision: 1,
      opId: "op-document-size",
      type: "entity_migrated",
      actor,
      source: "migration-import/v1",
      occurredAt: "2026-08-12T11:00:00.000Z",
      payload: {
        migratedFrom: "context/oversized.md",
        generation: "v0",
        entity: {
          kind: "repo-document",
          nodeKind: "file",
          documentClaim: {
            path: "context/oversized.md",
            sha256,
            size: body.byteLength,
            mediaType: "text/markdown",
            policyId: MIGRATION_DOCUMENT_POLICY_ID,
          },
          referencedContentClaims: [],
        },
      },
    };
  return {
    event,
    plan: migrationImportWritePlan(event),
    blobs: [{ sha256, size: body.byteLength, mediaType: "text/markdown", body }],
  };
}

test("one byte above the 20,000,000-byte document limit is refused by the canonical write port", () => {
  const oversized = documentBundle(Buffer.alloc(LEDGER_DOCUMENT_MAX_BYTES + 1, 0x78));
  assert.throws(
    () => validateCanonicalWriteBundle(oversized),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, "document_too_large");
      assert.match(
        (error as Error).message,
        new RegExp(
          `context/oversized\\.md is ${LEDGER_DOCUMENT_MAX_BYTES + 1} bytes, above the ${LEDGER_DOCUMENT_MAX_BYTES}-byte single-document limit`,
          "u",
        ),
      );
      assert.match((error as Error).message, /external artifact storage and record it here by reference/u);
      return true;
    },
  );
});

test("exactly 20,000,000 bytes is accepted and replayed as the document claim", () => {
  const body = Buffer.alloc(LEDGER_DOCUMENT_MAX_BYTES, 0x78),
    bundle = documentBundle(body);
  assert.equal(bundle.event.payload.entity.kind, "repo-document");
  assert.doesNotThrow(() => validateCanonicalWriteBundle(bundle));
});

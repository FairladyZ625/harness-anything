// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTIFACT_ENTITY_ID_BYTES,
  artifactEntityContractSnapshot,
  artifactImportOperationId,
  artifactObservationId,
  canonicalSourceIdentity,
  compileEntityContentObserved,
  compileEntityUpsert,
  deriveArtifactContentVersion,
  MIGRATION_DOCUMENT_POLICY_ID,
  migrationImportWritePlan,
  mintArtifactEntityId,
  RAW_ARTIFACT_POLICY_ID,
  sha256Bytes,
  type ArtifactDescriptor,
  type MigrationImportEventV1,
} from "../../src/index.ts";
import { artifactEntityContractFromSnapshot } from "../../src/domain/artifact-entity.ts";
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

test("exactly 20,000,000 bytes is accepted by the canonical write port", () => {
  const body = Buffer.alloc(LEDGER_DOCUMENT_MAX_BYTES, 0x78),
    bundle = documentBundle(body);
  assert.equal(bundle.event.payload.entity.kind, "repo-document");
  assert.doesNotThrow(() => validateCanonicalWriteBundle(bundle));
});

// The first cut exempted the whole entity-event schema, which let an oversized declaration through.
// Entity declarations are canonical documents; only content objects keep their own byte contract.
function agentDeclaration(instructions: string) {
  return {
    schema: "agent-declaration/v1",
    id: "oversized-agent",
    name: "Oversized Agent",
    instructions,
    runtimes: [{ type: "codex" }],
  };
}

function agentUpsert(instructions: string) {
  return compileEntityUpsert({
    entityKind: "agent",
    entity: agentDeclaration(instructions),
    eventId: "event-entity-declaration-size",
    opId: "op-entity-declaration-size",
    workspaceRevision: 1,
    actor,
    source: "local",
    occurredAt: "2026-08-12T11:00:00.000Z",
  });
}

function oversizedAgentDeclarationBundle() {
  const empty = agentUpsert("x"),
    // The declaration body is JSON.stringify(entity, null, 2) plus a newline, so each extra
    // instruction byte grows the claim by exactly one.
    padding = LEDGER_DOCUMENT_MAX_BYTES + 1 - empty.event.payload.declarationDocumentClaim.size + 1,
    bundle = agentUpsert("x".repeat(padding));
  assert.equal(bundle.event.payload.declarationDocumentClaim.size, LEDGER_DOCUMENT_MAX_BYTES + 1);
  return bundle;
}

const artifactSnapshot = artifactEntityContractSnapshot({
    declaration: {
      descriptorSchemaRef: "schema://artifact-descriptor",
      idPrefix: "ADR",
      locatorKinds: ["repository-path"],
      store: { pathTemplate: "entities/adrs/{id}.json" },
    },
    typeIdentity: "entity-kind/architecture-decision-record",
    kindVersion: 1,
  }),
  oversizedContentBody = Buffer.alloc(LEDGER_DOCUMENT_MAX_BYTES + 1, 0x78);

function oversizedEntityContentBundle() {
  const contract = artifactEntityContractFromSnapshot(artifactSnapshot),
    entityId = mintArtifactEntityId({
      idPrefix: "ADR",
      randomBytes: new Uint8Array(ARTIFACT_ENTITY_ID_BYTES).fill(7),
    }),
    locator = { kind: "repository-path" as const, value: "docs/oversized.bin" },
    sourceIdentity = canonicalSourceIdentity({
      kind: "repository-path",
      repositoryId: "canonical",
      path: "docs/oversized.bin",
    }),
    contentVersion = deriveArtifactContentVersion({ kind: "content", content: "oversized" }),
    descriptor: ArtifactDescriptor = {
      schema: "schema://artifact-descriptor",
      typeIdentity: "entity-kind/architecture-decision-record",
      kindVersion: 1,
      entityId,
      title: "Oversized artifact",
      locator,
      contentVersion,
      attributes: {},
      source: sourceIdentity,
    },
    observationId = artifactObservationId({ entityId, locator, resolution: contentVersion });
  return compileEntityContentObserved({
    contract,
    contractSnapshot: artifactSnapshot,
    descriptor,
    resolver: "repository:canonical",
    observationId,
    eventId: `event-${observationId}`,
    opId: artifactImportOperationId({
      entityKind: descriptor.typeIdentity,
      sourceIdentity,
      locator,
      resolution: contentVersion,
    }),
    workspaceRevision: 2,
    actor,
    source: "local",
    occurredAt: "2026-08-12T11:01:00.000Z",
    sourceContent: [
      {
        relativePath: "oversized.bin",
        sha256: sha256Bytes(oversizedContentBody),
        size: oversizedContentBody.byteLength,
        mediaType: "application/octet-stream",
        policyId: RAW_ARTIFACT_POLICY_ID,
        body: oversizedContentBody,
      },
    ],
  });
}

test("a 20,000,001-byte entity declaration document is refused by the canonical write port", () => {
  const bundle = oversizedAgentDeclarationBundle();
  assert.throws(
    () => validateCanonicalWriteBundle(bundle),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, "document_too_large");
      assert.match((error as Error).message, /agents\/oversized-agent\.json is 20000001 bytes/u);
      assert.match((error as Error).message, /external artifact storage and record it here by reference/u);
      return true;
    },
  );
});

test("a 20,000,001-byte entity content object is not counted as a document", () => {
  const bundle = oversizedEntityContentBundle(),
    binding = bundle.event.payload.ownedContent.bindings.find(({ path }) => path.endsWith("/oversized.bin"));
  assert.equal(binding?.policyId, RAW_ARTIFACT_POLICY_ID);
  assert.equal(
    bundle.event.payload.ownedContent.content.find(({ sha256 }) => sha256 === binding?.contentSha256)?.byteLength,
    LEDGER_DOCUMENT_MAX_BYTES + 1,
  );
  assert.doesNotThrow(() => validateCanonicalWriteBundle(bundle));
});

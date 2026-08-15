// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { MIGRATION_DOCUMENT_POLICY_ID, migrationImportWritePlan, sha256Text, validateMigrationImportEvent, type MigrationImportEventV1 } from "../../src/index.ts";

const body = "# Repository document\n", referencedBody = "Referenced body\n", documentClaim = { path: "field-notes/2024/xyz.md", sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: "text/markdown", policyId: MIGRATION_DOCUMENT_POLICY_ID } as const, referencedContentClaims = [{ sha256: sha256Text(referencedBody), size: Buffer.byteLength(referencedBody), mediaType: "text/plain" }] as const;

test("repo-document accepts only its exact fields and non-specialized document paths", () => {
  const event = repoDocumentEvent(documentClaim.path);
  assert.deepEqual(validateMigrationImportEvent(event), []);
  assert.deepEqual(validateMigrationImportEvent(repoDocumentEvent("decisions/README.md")), []); assert.deepEqual(validateMigrationImportEvent(repoDocumentEvent("tasks/README.md")), []);
  assert.deepEqual(validateMigrationImportEvent({ ...event, payload: { ...event.payload, entity: { ...event.payload.entity, guessedOwner: "task/nope" } } }), ["migration repo document entity is invalid"]);
  assert.deepEqual(validateMigrationImportEvent(repoDocumentEvent("people.yaml")), []);
  for (const target of ["tasks/task_x/note.md", "decisions/decision-dec_X/note.md", "presets/custom/README.md", "objects/sha256/blob", "events/old.json", "harness.yaml"]) {
    assert.deepEqual(validateMigrationImportEvent(repoDocumentEvent(target)), ["migration repo document entity is invalid"], target);
  }
  const symbolicLink = repoDocumentEvent("tasks/task_x/note.md", "symbolic-link"); assert.deepEqual(validateMigrationImportEvent(symbolicLink), []); assert.deepEqual(validateMigrationImportEvent({ ...symbolicLink, payload: { ...symbolicLink.payload, entity: { ...symbolicLink.payload.entity, nodeKind: "shortcut" as never } } }), ["migration repo document entity is invalid"]);
});

test("repo-document write plan publishes the document and every referenced CAS claim", () => {
  const plan = migrationImportWritePlan(repoDocumentEvent(documentClaim.path));
  assert.equal(plan.targets.some((target) => target.kind === "authored_file" && target.path === documentClaim.path && target.sha256 === documentClaim.sha256), true);
  assert.equal(plan.targets.some((target) => target.kind === "content_blob" && target.sha256 === documentClaim.sha256), true);
  assert.equal(plan.targets.some((target) => target.kind === "content_blob" && target.sha256 === referencedContentClaims[0].sha256 && target.size === referencedContentClaims[0].size), true);
});

function repoDocumentEvent(target: string, nodeKind: "file" | "symbolic-link" = "file"): MigrationImportEventV1 { const opId = `migration-${sha256Text(target).slice(0, 26)}`; return { schema: "migration-import-event/v1", eventId: `event-${sha256Text(opId)}`, workspaceRevision: 1, opId, type: "entity_migrated", actor: { principal: { personId: "person_migration" }, executor: null }, source: "migration-import/v1", occurredAt: "2026-08-15T00:00:00.000Z", payload: { migratedFrom: target, generation: "v0", entity: { kind: "repo-document", nodeKind, documentClaim: { ...documentClaim, path: target }, referencedContentClaims } } }; }

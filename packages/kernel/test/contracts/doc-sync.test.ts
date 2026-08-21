// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyTextualArtifactPath, OPAQUE_TEXTUAL_MEDIA_TYPE, OPAQUE_TEXTUAL_POLICY_ID } from "../../src/domain/artifact-text-classification.ts";
import docSyncContract, { DOC_POLICY_ID, decideDocWrite, docRegionPolicyRegistry, docSyncWritePlan, documentPath, parseCanonicalEvent, parseDocWriteIntent, resolveDocRoute, serializeCanonicalEvent, serializeDocEvent, serializeDocWriteIntent, validateCurrentDocEvent, validateDocEvent, validateDocWriteIntent, verifyDocEventChange, type ContentClaim, type DocWriteChange, type DocumentState } from "../../src/domain/doc-sync.contract.ts";
import { MIGRATION_DOCUMENT_POLICY_ID } from "../../src/domain/migration-import-event.ts";
import { validateWriteReceipt, validateWriteSource } from "../../src/domain/write-chain.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { validateCanonicalWriteBundle } from "../../src/store/task-event-store.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;
const baseLedgerSha = { repoId: "docs", revision: 2, headDigest: `sha256:${"a".repeat(64)}` } as const, currentLedgerSha = baseLedgerSha;
const legacyDocEventBytes = readFileSync(new URL("../../fixtures/events/doc-event-v1-legacy-ledger-identity.json", import.meta.url), "utf8");
const lease = { schema: "lease/v1", taskId: "task-owner", executionId: "execution-1", actor, source: "local", phase: "held", expiresAt: "2026-08-12T12:00:00.000Z", ttlMs: 1_800_000, version: 3 } as const;
const claim = (body: string) => ({ ref: "doc-sync-claims/candidate", sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: "text/markdown" as const });
const opaqueClaim = (body: string, mediaType: ContentClaim["mediaType"] = OPAQUE_TEXTUAL_MEDIA_TYPE) => ({ ref: "doc-sync-claims/candidate", sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType });
const state = (body: string): DocumentState => ({ path: "context/notes.md", blobSha256: sha256Text(body), body, size: Buffer.byteLength(body), mediaType: "text/markdown", policyId: DOC_POLICY_ID, workspaceRevision: 2 });
function decide(change: DocWriteChange, document: DocumentState | null, bytes: Uint8Array | null = change.candidate ? Buffer.from(change.candidate.sha256 === sha256Text("# Notes\nA\nB\n") ? "# Notes\nA\nB\n" : "# Notes\nA\n") : null, overrides: Record<string, unknown> = {}) {
  return decideDocWrite({ intent: { schema: "doc-write-intent/v1", executionId: "execution-1", baseLedgerSha, changes: [change] }, opId: "doc-op", eventId: "doc-event", workspaceRevision: 3, actor, source: "local", occurredAt: "2026-08-12T11:00:00.000Z", currentLedgerSha, lease, documents: [document], claims: [bytes], ...overrides });
}

test("derived doc-sync contract closes intent and event schemas", () => {
  assert.deepEqual(docSyncContract.schemas.map((schema) => schema.id), ["doc-write-intent/v1", "doc-event/v1"]);
  assert.equal(docSyncContract.schemas.every((schema) => schema.negativeFixtures.length > 0), true);
  const parsed = parseDocWriteIntent({ schema: "doc-write-intent/v1", executionId: "execution-1", baseLedgerSha, changes: [{ path: "context/notes.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: claim("body\n") }] }, "docs");
  assert.deepEqual(JSON.parse(serializeDocWriteIntent(parsed)).baseLedgerSha, baseLedgerSha);
  assert.deepEqual(validateWriteSource({ kind: "watch_session", sessionId: "watch-one", path: "context/notes.md", fingerprint: "a".repeat(64) }), []); assert.match(validateWriteSource({ kind: "watch_session", sessionId: "watch-one", path: "context/notes.md", fingerprint: "bad" }).join("\n"), /watch session/u);
});

test("canonical reader accepts the historical doc-event ledger identity bytes", () => {
  const parsed = parseCanonicalEvent(legacyDocEventBytes);
  assert.equal(parsed.schema, "doc-event/v1");
  assert.equal(parsed.workspaceRevision, 21402);
  assert.deepEqual(parsed.payload.baseLedgerSha, { repoId: "harness-anything", sha: "de2fe7239e570c7c9ed6fe8417a32f008bbf7ccc" });
  assert.equal(serializeCanonicalEvent(parsed), legacyDocEventBytes);
  assert.deepEqual(validateWriteReceipt({ outcome: "applied", opId: parsed.opId, revision: parsed.workspaceRevision, evidence: `event-object:${parsed.opId}`, visibility: "center", proof: { committedRevision: parsed.workspaceRevision, appliedCut: parsed.workspaceRevision, durable: true, canonicalVisible: true, worktreeVisible: null }, detail: { kind: "doc_sync", code: "applied", baseLedgerSha: parsed.payload.baseLedgerSha, currentLedgerSha, paths: [], holder: null, differences: [], unresolvedTouches: [], deletions: [], nextAction: "no action required" } }), []);
});

test("canonical writer rejects the historical doc-event ledger identity", () => {
  const body = "# Notes\nReplacement sentence.\n", result = decide({ path: "context/notes.md", baseBlobSha256: sha256Text("# Notes\nOriginal sentence.\n"), policyId: DOC_POLICY_ID, candidate: claim(body) }, state("# Notes\nOriginal sentence.\n"), Buffer.from(body));
  assert.equal(result.accepted, true); if (!result.accepted) return;
  const legacy = { ...result.event, payload: { ...result.event.payload, baseLedgerSha: { repoId: "docs", sha: "0".repeat(40) } } };
  assert.deepEqual(validateDocEvent(legacy), []);
  assert.match(validateCurrentDocEvent(legacy).join("\n"), /invalid/u);
  assert.throws(() => serializeDocEvent(legacy), /invalid/u);
  assert.throws(() => validateCanonicalWriteBundle({ event: legacy, plan: docSyncWritePlan(legacy), blobs: result.blobs }), /current cut/u);
});

test("doc ingress rejects non-portable paths and same-batch Unicode collisions", () => {
  const change = { path: "context/CON.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: claim("body\n") };
  assert.match(validateDocWriteIntent({ schema: "doc-write-intent/v1", executionId: "execution-1", baseLedgerSha, changes: [change] }).join("\n"), /portable|reserved/iu);
  const collision = { schema: "doc-write-intent/v1", executionId: "execution-1", baseLedgerSha, changes: [
    { ...change, path: "context/café.md" }, { ...change, path: "context/cafe\u0301.md" }
  ] };
  assert.match(validateDocWriteIntent(collision).join("\n"), /collision/iu);
  assert.match(validateDocWriteIntent({ ...collision, changes: [{ ...change, path: "context/ok.md", candidate: { ...change.candidate!, size: Number.MAX_SAFE_INTEGER + 1 } }] }).join("\n"), /claim/iu);
  assert.match(validateDocWriteIntent({ ...collision, changes: [{ ...change, path: "context/ok.md", candidate: { ...change.candidate!, ref: "doc-sync-claims/CON" } }] }).join("\n"), /claim/iu);
});

test("default prose route is open while typed internal routes are denied", () => {
  assert.deepEqual(resolveDocRoute(documentPath("context/new-area/notes.md")), { allowed: true, requiredRoute: "doc-sync" });
  assert.deepEqual(resolveDocRoute(documentPath("events/op.json")), { allowed: false, requiredRoute: "canonical-event" });
  assert.deepEqual(resolveDocRoute(documentPath("people.yaml")), { allowed: false, requiredRoute: "people-registry" });
  assert.throws(() => documentPath("../outside.md"));
});

test("textual artifacts are opaque by location while preserving their media type", () => {
  for (const [target, mediaType] of [["artifacts/summary.md", "text/markdown"], ["artifacts/notes.txt", "text/plain"], ["artifacts/report.html", "text/html"], ["artifacts/report.htm", "text/html"], ["artifacts/scripts/build.mjs", "text/javascript"], ["artifacts/scripts/build.js", "text/javascript"], ["artifacts/data.json", "application/json"], ["artifacts/styles/main.css", "text/css"], ["artifacts/data.yaml", "application/yaml"], ["artifacts/data.yml", "application/yaml"], ["artifacts/data.csv", "text/csv"], ["artifacts/unknown.foo", OPAQUE_TEXTUAL_MEDIA_TYPE], ["artifacts/NOTICE", OPAQUE_TEXTUAL_MEDIA_TYPE], ["artifacts/.metadata", OPAQUE_TEXTUAL_MEDIA_TYPE]] as const) assert.deepEqual(classifyTextualArtifactPath(target), { kind: "opaque-textual", mediaType, policyId: OPAQUE_TEXTUAL_POLICY_ID }, target);
  assert.deepEqual(classifyTextualArtifactPath("context/report.md"), { kind: "canonical-prose", mediaType: "text/markdown", policyId: DOC_POLICY_ID });
  assert.deepEqual(classifyTextualArtifactPath("context/notes.txt"), { kind: "canonical-prose", mediaType: "text/plain", policyId: DOC_POLICY_ID });
  assert.equal(classifyTextualArtifactPath("context/report.html"), null);
});

test("doc content claims accept only the supported opaque textual media types", () => {
  const base = { schema: "doc-write-intent/v1", executionId: "execution-1", baseLedgerSha, changes: [{ path: "tasks/task-owner/artifacts/report.json", baseBlobSha256: null, policyId: OPAQUE_TEXTUAL_POLICY_ID, candidate: opaqueClaim("{}\n", "application/json") }] };
  for (const mediaType of ["application/json", "text/markdown", "text/plain"] as const) assert.deepEqual(validateDocWriteIntent({ ...base, changes: [{ ...base.changes[0]!, candidate: { ...base.changes[0]!.candidate, mediaType } }] }), [], mediaType);
  assert.match(validateDocWriteIntent({ ...base, changes: [{ ...base.changes[0]!, candidate: { ...base.changes[0]!.candidate, mediaType: "application/octet-stream" } }] }).join("\n"), /claim/iu);
});

test("prose policy accepts body replacement while freezing region proofs and content target", () => {
  const base = "# Notes\nOriginal sentence.\n", candidate = "# Notes\nReplacement sentence.\n", result = decide({ path: "context/notes.md", baseBlobSha256: sha256Text(base), policyId: DOC_POLICY_ID, candidate: claim(candidate) }, state(base), Buffer.from(candidate));
  assert.equal(result.accepted, true); if (!result.accepted) return;
  assert.equal(result.plan.targets.some((target) => target.kind === "content_blob" && target.sha256 === sha256Text(candidate)), true);
  assert.equal(result.plan.targets.filter((target) => target.kind === "content_blob").length, 1);
});

test("body-replaceable policy accepts shorter prose and emits a valid canonical event", () => {
  assert.equal(DOC_POLICY_ID, "markdown-body-replaceable/v1");
  assert.equal(docRegionPolicyRegistry[0]?.writable, "body-replaceable");
  const base = "# Notes\nA much longer original sentence.\n", candidate = "# Notes\nShort.\n", result = decide({ path: "context/notes.md", baseBlobSha256: sha256Text(base), policyId: DOC_POLICY_ID, candidate: claim(candidate) }, state(base), Buffer.from(candidate));
  assert.equal(result.accepted, true); if (!result.accepted) return;
  assert.doesNotThrow(() => serializeDocEvent(result.event));
});

test("opaque textual policy is a whole-file CAS with no markdown parsing or region proofs", () => {
  const base = "---\nnot: frontmatter\n# Same\n# Same\nThis entire legacy payload is deliberately removed.\n", candidate = "<script/>\n", document: DocumentState = { ...state(base), path: documentPath("tasks/task-owner/artifacts/scripts/report.mjs"), mediaType: "text/javascript", policyId: OPAQUE_TEXTUAL_POLICY_ID };
  const result = decide({ path: document.path, baseBlobSha256: sha256Text(base), policyId: OPAQUE_TEXTUAL_POLICY_ID, candidate: opaqueClaim(candidate, "text/javascript") }, document, Buffer.from(candidate));
  assert.equal(result.accepted, true, JSON.stringify(result)); if (!result.accepted) return;
  const change = result.event.payload.changes[0]!;
  assert.deepEqual(change.regionProofs, []);
  assert.deepEqual(validateDocEvent(JSON.parse(JSON.stringify(result.event))), []);
  assert.equal(verifyDocEventChange(change, base, candidate), true);
  assert.deepEqual(validateDocEvent({ ...result.event, payload: { ...result.event.payload, changes: [{ ...change, regionProofs: [{ regionId: "prose/*", policyId: DOC_POLICY_ID, codecId: "markdown-regions/v1", baseSha256: sha256Text(base), candidateSha256: sha256Text(candidate), insertBytes: 0 }] }] } }), ["doc event change is invalid"]);
  assert.deepEqual(validateDocEvent({ ...result.event, payload: { ...result.event.payload, changes: [{ ...change, policyId: DOC_POLICY_ID, regionProofs: [{ regionId: "prose/*", policyId: DOC_POLICY_ID, codecId: "markdown-regions/v1", baseSha256: sha256Text(base), candidateSha256: sha256Text(candidate), insertBytes: 0 }] }] } }), ["doc event change is invalid"]);
});

test("an opaque artifact write reclassifies an existing prose record without a policy upgrade", () => {
  const base = "---\ntitle: Legacy report\n---\n\n# Same\n\n# Same\n", candidate = "---\ntitle: Rewritten report\n---\n\n# Same\n\n# Same\n\nAll bytes are opaque.\n", path = documentPath("tasks/task-owner/artifacts/report.md"), document: DocumentState = { ...state(base), path, policyId: DOC_POLICY_ID };
  const result = decide({ path, baseBlobSha256: sha256Text(base), policyId: OPAQUE_TEXTUAL_POLICY_ID, candidate: opaqueClaim(candidate, "text/markdown") }, document, Buffer.from(candidate));
  assert.equal(result.accepted, true, JSON.stringify(result)); if (!result.accepted) return;
  const change = result.event.payload.changes[0]!;
  assert.equal(change.policyId, OPAQUE_TEXTUAL_POLICY_ID);
  assert.equal(change.candidate.mediaType, "text/markdown");
  assert.deepEqual(change.regionProofs, []);
  assert.equal("policyUpgrade" in change, false);
});

test("mixed body-replaceable rejection produces a valid typed receipt", () => {
  const shorterBase = "# Notes\nA much longer original sentence.\n", shorter = "# Notes\nShort.\n";
  const protectedBase = "---\nowner: owner\n---\n# Protected\nBody\n", protectedEdit = "---\nowner: other\n---\n# Protected\nBody\n";
  const changes = [
    { path: "context/notes.md", baseBlobSha256: sha256Text(shorterBase), policyId: DOC_POLICY_ID, candidate: claim(shorter) },
    { path: "context/protected.md", baseBlobSha256: sha256Text(protectedBase), policyId: DOC_POLICY_ID, candidate: claim(protectedEdit) }
  ] as const;
  const documents = [
    { ...state(shorterBase), path: documentPath("context/notes.md") },
    { ...state(protectedBase), path: documentPath("context/protected.md") }
  ];
  const result = decideDocWrite({ intent: { schema: "doc-write-intent/v1", executionId: "execution-1", baseLedgerSha, changes }, opId: "doc-op", eventId: "doc-event", workspaceRevision: 3,
    actor, source: "local", occurredAt: "2026-08-12T11:00:00.000Z", currentLedgerSha, lease, documents, claims: [Buffer.from(shorter), Buffer.from(protectedEdit)] });
  assert.equal(result.accepted, false); if (result.accepted) return; assert.equal(result.code, "unresolved_touch"); assert.equal("plan" in result, false);
  for (const difference of result.detail.differences) for (const count of [difference.insertBytes, difference.deleteBytes, difference.replaceBytes]) assert.equal(Number.isSafeInteger(count) && count >= 0, true, JSON.stringify(difference));
  const receipt = { outcome: "op_rejected", opId: "doc-op", code: result.code, origin: "doc-sync-contract", evidence: `contract-rejection:${result.code}`, nextAction: result.detail.nextAction, detail: result.detail };
  assert.deepEqual(validateWriteReceipt(receipt), []);
});

test("Decision documents admit body-only sync and route new or frontmatter edits to typed commands", () => {
  const path = documentPath("decisions/decision-dec_IMPORTED_E12_ALPHA/decision.md"), base = "---\ndecision_id: dec_IMPORTED_E12_ALPHA\nstate: proposed\n---\n# Decision\n\nCanonical prose.\n", bodyOnly = base.replace("Canonical prose.", "Updated prose."), frontmatter = base.replace("state: proposed", "state: active"), mixed = frontmatter.replace("Canonical prose.", "Updated prose."), document = { ...state(base), path };
  const run = (candidate: string, current: DocumentState | null) => decide({ path, baseBlobSha256: current?.blobSha256 ?? null, policyId: DOC_POLICY_ID, candidate: claim(candidate) }, current, Buffer.from(candidate));
  const accepted = run(bodyOnly, document); assert.equal(accepted.accepted, true);
  for (const [name, result] of [["new", run("# Unregistered\n", null)], ["frontmatter", run(frontmatter, document)], ["mixed", run(mixed, document)]] as const) { assert.equal(result.accepted, false, name); if (!result.accepted) { assert.equal(result.code, "unresolved_touch"); assert.equal(result.detail.unresolvedTouches[0]?.requiredRoute, "ha decision --help"); } }
});

test("stale ledger and stale blob reject the entire batch with current holder and typed conflict detail", () => {
  const body = "# Notes\nA\n", change = { path: "context/notes.md", baseBlobSha256: sha256Text(body), policyId: DOC_POLICY_ID, candidate: claim(`${body}B\n`) } as const;
  const staleLedger = decide(change, state(body), Buffer.from(`${body}B\n`), { currentLedgerSha: { ...baseLedgerSha, headDigest: `sha256:${"b".repeat(64)}` } }); assert.equal(staleLedger.accepted, false); if (staleLedger.accepted) return;
  assert.equal(staleLedger.code, "base_ledger_changed"); assert.equal(staleLedger.detail.holder?.personId, "person-owner"); assert.equal(staleLedger.detail.paths[0]?.currentBlobSha256, sha256Text(body));
  assert.deepEqual(validateWriteReceipt({ outcome: "op_rejected", opId: "doc-op", code: staleLedger.code, origin: "doc-sync-contract", evidence: `contract-rejection:${staleLedger.code}`, nextAction: staleLedger.detail.nextAction, detail: staleLedger.detail }), []);
  const staleBlob = decide({ ...change, baseBlobSha256: "c".repeat(64) }, state(body), Buffer.from(`${body}B\n`)); assert.equal(staleBlob.accepted, false); if (!staleBlob.accepted) { assert.equal(staleBlob.code, "base_blob_changed"); assert.equal(staleBlob.detail.holder?.version, 3); }
});

test("claim mismatch, deletion, heading rename, machine touch, and ambiguous headings fail closed", () => {
  const base = "# Notes\nA\n", additive = `${base}B\n`, change = { path: "context/notes.md", baseBlobSha256: sha256Text(base), policyId: DOC_POLICY_ID, candidate: claim(additive) } as const;
  const mismatch = decide(change, state(base), Buffer.from("wrong")); assert.equal(mismatch.accepted, false); if (!mismatch.accepted) assert.equal(mismatch.code, "content_claim_mismatch");
  const deletion = decide({ ...change, candidate: null }, state(base), null); assert.equal(deletion.accepted, false); if (!deletion.accepted) { assert.equal(deletion.code, "deletion_forbidden"); assert.equal(deletion.detail.deletions[0]?.source, "intent"); }
  for (const candidate of ["# Renamed\nA\n", "---\nowner: other\n---\n# Notes\nA\n", "# Same\nA\n# Same\nB\n"]) {
    const current = candidate.startsWith("---") ? "---\nowner: owner\n---\n# Notes\nA\n" : base, rejected = decide({ path: "context/notes.md", baseBlobSha256: sha256Text(current), policyId: DOC_POLICY_ID, candidate: claim(candidate) }, state(current), Buffer.from(candidate));
    assert.equal(rejected.accepted, false, candidate); if (!rejected.accepted) { assert.equal(rejected.code, "unresolved_touch"); assert.equal(rejected.detail.unresolvedTouches.length > 0, true); }
  }
});

test("direct CRLF claims name the line-ending repair when the contract rejects them", () => {
  const crlf = "# Notes" + String.fromCharCode(13) + "\nA" + String.fromCharCode(13) + "\n", result = decide({ path: "context/notes.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: claim(crlf) }, null, Buffer.from(crlf));
  assert.equal(result.accepted, false); if (!result.accepted) { assert.equal(result.code, "unresolved_touch"); assert.equal(result.detail.unresolvedTouches[0]?.reason, "claim is not canonical LF text"); assert.match(result.detail.nextAction, /LF line endings.*resubmit/u); }
});

test("prose regression controls still reject deletion, duplicate headings, and base-region reordering", () => {
  const base = "# One\nA\n# Two\nB\n", prose = { path: "context/notes.md", baseBlobSha256: sha256Text(base), policyId: DOC_POLICY_ID, candidate: claim(base) } as const;
  const deletion = decide({ ...prose, candidate: null }, state(base), null); assert.equal(deletion.accepted, false); if (!deletion.accepted) assert.equal(deletion.code, "deletion_forbidden");
  const duplicate = "# Same\nA\n# Same\nB\n", duplicateResult = decide({ ...prose, candidate: claim(duplicate) }, state(base), Buffer.from(duplicate)); assert.equal(duplicateResult.accepted, false); if (!duplicateResult.accepted) assert.equal(duplicateResult.detail.unresolvedTouches[0]?.reason, "duplicate heading anchor");
  const reordered = "# Two\nB\n# One\nA\n", reorderedResult = decide({ ...prose, candidate: claim(reordered) }, state(base), Buffer.from(reordered)); assert.equal(reorderedResult.accepted, false); if (!reorderedResult.accepted) assert.match(reorderedResult.detail.unresolvedTouches[0]?.reason ?? "", /base region is missing or reordered/u);
});

test("the first authored write on a migrated document upgrades its policy one-way with from/to recorded", () => {
  const base = "# Notes\nA\n", next = `${base}B\n`, migrated = (body: string): DocumentState => ({ ...state(body), policyId: MIGRATION_DOCUMENT_POLICY_ID });
  const run = (policyId: string, current: DocumentState | null, candidate: string) => decide({ path: "context/notes.md", baseBlobSha256: current?.blobSha256 ?? null, policyId, candidate: claim(candidate) }, current, Buffer.from(candidate));
  const upgraded = run(DOC_POLICY_ID, migrated(base), next);
  assert.equal(upgraded.accepted, true, JSON.stringify(upgraded)); if (!upgraded.accepted) return;
  const change = upgraded.event.payload.changes[0]!;
  assert.equal(change.policyId, DOC_POLICY_ID);
  assert.deepEqual(change.policyUpgrade, { from: MIGRATION_DOCUMENT_POLICY_ID, to: DOC_POLICY_ID });
  assert.doesNotThrow(() => serializeDocEvent(upgraded.event));
  assert.deepEqual(validateDocEvent(JSON.parse(JSON.stringify(upgraded.event))), []);
  assert.deepEqual(validateDocEvent({ ...upgraded.event, payload: { ...upgraded.event.payload, changes: [{ ...change, policyUpgrade: { from: DOC_POLICY_ID, to: MIGRATION_DOCUMENT_POLICY_ID } }] } }), ["doc event change is invalid"]);
  for (const [name, rejected] of [["migrated-shell write", run(MIGRATION_DOCUMENT_POLICY_ID, migrated(base), next)], ["downgrade after upgrade", run(MIGRATION_DOCUMENT_POLICY_ID, state(next), `${next}C\n`)]] as const) {
    assert.equal(rejected.accepted, false, name); if (!rejected.accepted) assert.equal(rejected.code, "semantic_policy_changed", name);
  }
  const native = run(DOC_POLICY_ID, { ...state(next), workspaceRevision: 3 }, `${next}C\n`);
  assert.equal(native.accepted, true, JSON.stringify(native)); if (native.accepted) assert.equal("policyUpgrade" in native.event.payload.changes[0]!, false);
});

test("an upgraded write still runs the full region differ and heading preservation", () => {
  const base = "# One\nA\n# Two\nB\n", reordered = "# Two\nB\n# One\nA\n", result = decide({ path: "context/notes.md", baseBlobSha256: sha256Text(base), policyId: DOC_POLICY_ID, candidate: claim(reordered) }, { ...state(base), policyId: MIGRATION_DOCUMENT_POLICY_ID }, Buffer.from(reordered));
  assert.equal(result.accepted, false, JSON.stringify(result)); if (!result.accepted) { assert.equal(result.code, "unresolved_touch"); assert.equal(result.detail.unresolvedTouches.some(({ reason }) => reason.includes("missing or reordered")), true); }
});

test("receipt detail registry rejects unregistered or open-ended detail shapes", () => {
  const body = "# Notes\nA\n", rejected = decide({ path: "context/notes.md", baseBlobSha256: sha256Text(body), policyId: DOC_POLICY_ID, candidate: null }, state(body), null); if (rejected.accepted) assert.fail("expected rejection");
  const receipt = { outcome: "op_rejected", opId: "doc-op", code: rejected.code, origin: "doc-sync-contract", evidence: `contract-rejection:${rejected.code}`, nextAction: rejected.detail.nextAction, detail: rejected.detail };
  assert.deepEqual(validateWriteReceipt(receipt), []); assert.match(validateWriteReceipt({ ...receipt, detail: { ...rejected.detail, legacy: true } }).join("\n"), /registered receipt domain/u);
});

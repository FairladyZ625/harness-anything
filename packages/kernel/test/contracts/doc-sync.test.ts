// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import docSyncContract, { DOC_POLICY_ID, decideDocWrite, docRegionPolicyRegistry, documentPath, ledgerCommitSha, parseDocWriteIntent, resolveDocRoute, serializeDocEvent, serializeDocWriteIntent, validateDocWriteIntent, type DocWriteChange, type DocumentState } from "../../src/domain/doc-sync.contract.ts";
import { validateWriteReceipt, validateWriteSource } from "../../src/domain/write-chain.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;
const baseLedgerSha = ledgerCommitSha("docs", "a".repeat(40)), currentLedgerSha = baseLedgerSha;
const lease = { schema: "lease/v1", taskId: "task-owner", executionId: "execution-1", actor, source: "local", phase: "active", expiresAt: "2026-08-12T12:00:00.000Z", ttlMs: 1_800_000, version: 3 } as const;
const claim = (body: string) => ({ ref: "doc-sync-claims/candidate", sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: "text/markdown" as const });
const state = (body: string): DocumentState => ({ path: "context/notes.md", blobSha256: sha256Text(body), body, size: Buffer.byteLength(body), mediaType: "text/markdown", policyId: DOC_POLICY_ID, workspaceRevision: 2 });
function decide(change: DocWriteChange, document: DocumentState | null, bytes: Uint8Array | null = change.candidate ? Buffer.from(change.candidate.sha256 === sha256Text("# Notes\nA\nB\n") ? "# Notes\nA\nB\n" : "# Notes\nA\n") : null, overrides: Record<string, unknown> = {}) {
  return decideDocWrite({ intent: { schema: "doc-write-intent/v1", executionId: "execution-1", baseLedgerSha, changes: [change] }, opId: "doc-op", eventId: "doc-event", workspaceRevision: 3, actor, source: "local", occurredAt: "2026-08-12T11:00:00.000Z", currentLedgerSha, lease, documents: [document], claims: [bytes], ...overrides });
}

test("derived doc-sync contract closes intent and event schemas", () => {
  assert.deepEqual(docSyncContract.schemas.map((schema) => schema.id), ["doc-write-intent/v1", "doc-event/v1"]);
  assert.equal(docSyncContract.schemas.every((schema) => schema.negativeFixtures.length > 0), true);
  const parsed = parseDocWriteIntent({ schema: "doc-write-intent/v1", executionId: "execution-1", baseLedgerSha: baseLedgerSha.sha, changes: [{ path: "context/notes.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: claim("body\n") }] }, "docs");
  assert.equal(JSON.parse(serializeDocWriteIntent(parsed)).baseLedgerSha, baseLedgerSha.sha);
  assert.deepEqual(validateWriteSource({ kind: "watch_session", sessionId: "watch-one", path: "context/notes.md", fingerprint: "a".repeat(64) }), []); assert.match(validateWriteSource({ kind: "watch_session", sessionId: "watch-one", path: "context/notes.md", fingerprint: "bad" }).join("\n"), /watch session/u);
});

test("doc ingress rejects non-portable paths and same-batch Unicode collisions", () => {
  const change = { path: "context/CON.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: claim("body\n") };
  assert.match(validateDocWriteIntent({ schema: "doc-write-intent/v1", executionId: "execution-1", baseLedgerSha: baseLedgerSha.sha, changes: [change] }).join("\n"), /portable|reserved/iu);
  const collision = { schema: "doc-write-intent/v1", executionId: "execution-1", baseLedgerSha: baseLedgerSha.sha, changes: [
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
  const receipt = { outcome: "rejected", opId: "doc-op", code: result.code, origin: "doc-sync-contract", evidence: `contract-rejection:${result.code}`, nextAction: result.detail.nextAction, detail: result.detail };
  assert.deepEqual(validateWriteReceipt(receipt), []);
});

test("stale ledger and stale blob reject the entire batch with current holder and typed conflict detail", () => {
  const body = "# Notes\nA\n", change = { path: "context/notes.md", baseBlobSha256: sha256Text(body), policyId: DOC_POLICY_ID, candidate: claim(`${body}B\n`) } as const;
  const staleLedger = decide(change, state(body), Buffer.from(`${body}B\n`), { currentLedgerSha: ledgerCommitSha("docs", "b".repeat(40)) }); assert.equal(staleLedger.accepted, false); if (staleLedger.accepted) return;
  assert.equal(staleLedger.code, "base_ledger_changed"); assert.equal(staleLedger.detail.holder?.personId, "person-owner"); assert.equal(staleLedger.detail.paths[0]?.currentBlobSha256, sha256Text(body));
  assert.deepEqual(validateWriteReceipt({ outcome: "rejected", opId: "doc-op", code: staleLedger.code, origin: "doc-sync-contract", evidence: `contract-rejection:${staleLedger.code}`, nextAction: staleLedger.detail.nextAction, detail: staleLedger.detail }), []);
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

test("receipt detail registry rejects unregistered or open-ended detail shapes", () => {
  const body = "# Notes\nA\n", rejected = decide({ path: "context/notes.md", baseBlobSha256: sha256Text(body), policyId: DOC_POLICY_ID, candidate: null }, state(body), null); if (rejected.accepted) assert.fail("expected rejection");
  const receipt = { outcome: "rejected", opId: "doc-op", code: rejected.code, origin: "doc-sync-contract", evidence: `contract-rejection:${rejected.code}`, nextAction: rejected.detail.nextAction, detail: rejected.detail };
  assert.deepEqual(validateWriteReceipt(receipt), []); assert.match(validateWriteReceipt({ ...receipt, detail: { ...rejected.detail, legacy: true } }).join("\n"), /registered receipt domain/u);
});

// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  auditGenesisChainHash,
  buildDeliveryCertificate,
  createAuditChainAccumulator,
  createAuditSliceVerifier,
  verifyAuditSliceContent,
  verifyDeliveryCertificate,
} from "../../src/integrity/audit-hash-chain.ts";
import { digestText, sha256Text, type AuditHashAlgorithm } from "../../src/integrity/stable-hash.ts";
import { lifecycleFixture } from "../store/task-lifecycle-fixture.ts";

test("SM3 matches GM/T 0004-2012 standard test vector for 'abc' and SHA-256 matches FIPS 180-4", () => {
  assert.equal(digestText("sm3", "abc"), "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0");
  assert.equal(sha256Text("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

for (const algorithm of ["sha256", "sm3"] as readonly AuditHashAlgorithm[]) {
  test(`audit hash chain export, cross-slice prevRootHash linking, and delivery-certificate verify (${algorithm})`, () => {
    const fixture = lifecycleFixture({
      taskId: "task_done_001",
      executionId: "exec_done_001",
      reviewId: "rev_done_001",
    });
    const firstEvents = fixture.events.slice(0, 3);
    const secondEvents = fixture.events.slice(3);

    const acc1 = createAuditChainAccumulator({
      repoId: "repo-audit-test",
      algorithm,
      window: { fromRevision: 1, toRevision: 3, utcDate: null, after: null, before: null },
    });
    const lines1 = firstEvents.map((event) => acc1.addEvent(event).line).join("");
    const manifest1 = acc1.finalize();

    assert.equal(manifest1.schema, "audit-export-manifest/v1");
    assert.equal(manifest1.algorithm, algorithm);
    assert.equal(manifest1.prevRootHash, auditGenesisChainHash(algorithm));
    assert.equal(manifest1.eventCount, 3);
    assert.equal(manifest1.firstRevision, 1);
    assert.equal(manifest1.lastRevision, 3);
    assert.equal(manifest1.personAttribution.traceableRatio, 1);
    assert.deepEqual(manifest1.personAttribution.distinctPersonIds, ["person-owner"]);

    const verify1 = verifyAuditSliceContent({
      manifest: manifest1,
      entriesContent: lines1,
      expectedAlgorithm: algorithm,
    });
    assert.equal(verify1.ok, true);

    const acc2 = createAuditChainAccumulator({
      repoId: "repo-audit-test",
      algorithm,
      prevRootHash: manifest1.rootHash,
      window: { fromRevision: 4, toRevision: 6, utcDate: null, after: null, before: null },
    });
    const lines2 = secondEvents.map((event) => acc2.addEvent(event).line).join("");
    const manifest2 = acc2.finalize();
    assert.equal(manifest2.prevRootHash, manifest1.rootHash);

    const verifier2 = createAuditSliceVerifier({
      manifest: manifest2,
      expectedAlgorithm: algorithm,
      expectedPrevRootHash: manifest1.rootHash,
    });
    assert.equal(verifier2.ok, true);
    if (!verifier2.ok) return;
    const rawLines2 = lines2.trimEnd().split("\n");
    for (let index = 0; index < rawLines2.length; index += 1) {
      assert.equal(verifier2.verifier.verifyLine(rawLines2[index]!, index + 1), null);
    }
    const verify2 = verifier2.verifier.finalize();
    assert.equal(verify2.ok, true);

    const completionEvent = fixture.events.find((event) => event.type === "task_completed");
    assert.ok(completionEvent && completionEvent.type === "task_completed");
    const execution = fixture.snapshot.executions[0]!;
    assert.equal(execution.schema, "execution/v1");
    const consent = fixture.snapshot.consents?.[0] ?? null;
    assert.ok(consent !== null);

    const cert = buildDeliveryCertificate({
      algorithm,
      repoId: "repo-audit-test",
      task: fixture.snapshot.task!,
      execution,
      reviews: fixture.snapshot.reviews,
      reviewConsent: consent,
      completionEvent,
    });
    assert.equal(cert.schema, "delivery-certificate/v1");
    assert.equal(cert.algorithm, algorithm);
    assert.equal(cert.taskId, "task_done_001");
    assert.equal(cert.executionId, "exec_done_001");
    assert.equal(cert.reviews.length, 1);
    assert.equal(cert.reviewConsent?.consentId, consent.consentId);

    const certVerified = verifyDeliveryCertificate(cert, {
      expectedAlgorithm: algorithm,
      verifiedEvents: verifier2.verifier.observedEvents,
    });
    assert.equal(certVerified.ok, true);
    if (certVerified.ok) {
      assert.equal(certVerified.completionOpId, completionEvent.opId);
      assert.equal(certVerified.completionRevision, completionEvent.workspaceRevision);
    }
  });
}

test("negative controls: every tamper mode fails with a deterministic error code", () => {
  const fixture = lifecycleFixture({
    taskId: "task_tamper_001",
    executionId: "exec_tamper_001",
    reviewId: "rev_tamper_001",
  });
  const acc = createAuditChainAccumulator({
    repoId: "repo-tamper",
    algorithm: "sm3",
    window: { fromRevision: 1, toRevision: 6, utcDate: null, after: null, before: null },
  });
  const lines = fixture.events.map((event) => acc.addEvent(event).line);
  const manifest = acc.finalize();

  // 1. Tamper single field inside canonical event
  const editedEntry = JSON.parse(lines[1]!);
  editedEntry.event.payload.task.title = "Tampered Title";
  const tamperedFieldLines = [...lines];
  tamperedFieldLines[1] = `${JSON.stringify(editedEntry)}\n`;
  const r1 = verifyAuditSliceContent({ manifest, entriesContent: tamperedFieldLines.join("") });
  assert.equal(r1.ok, false);
  if (!r1.ok) {
    assert.equal(r1.code, "audit_entry_digest_mismatch");
    assert.equal(r1.line, 2);
  }

  // 2. Delete a middle line
  const deletedMiddle = [...lines.slice(0, 2), ...lines.slice(3)].join("");
  const r2 = verifyAuditSliceContent({ manifest, entriesContent: deletedMiddle });
  assert.equal(r2.ok, false);
  if (!r2.ok) {
    assert.equal(r2.code, "audit_chain_prev_hash_mismatch");
    assert.equal(r2.line, 3);
  }

  // 3. Swap two lines
  const swapped = [lines[0], lines[2], lines[1], ...lines.slice(3)].join("");
  const r3 = verifyAuditSliceContent({ manifest, entriesContent: swapped });
  assert.equal(r3.ok, false);
  if (!r3.ok) {
    assert.equal(r3.code, "audit_chain_prev_hash_mismatch");
    assert.equal(r3.line, 2);
  }

  // 4. Tamper manifest rootHash
  const badRootManifest = { ...manifest, rootHash: `sm3:${"f".repeat(64)}` };
  const r4 = verifyAuditSliceContent({ manifest: badRootManifest, entriesContent: lines.join("") });
  assert.equal(r4.ok, false);
  if (!r4.ok) assert.equal(r4.code, "audit_manifest_root_hash_mismatch");

  // 5. Broken cross-slice prevRootHash
  const r5 = verifyAuditSliceContent({
    manifest,
    entriesContent: lines.join(""),
    expectedPrevRootHash: `sm3:${"1".repeat(64)}`,
  });
  assert.equal(r5.ok, false);
  if (!r5.ok) assert.equal(r5.code, "audit_manifest_chain_link_mismatch");

  // 6. Delivery certificate tamper controls
  const completionEvent = fixture.events.find((event) => event.type === "task_completed");
  assert.ok(completionEvent && completionEvent.type === "task_completed");
  const execution = fixture.snapshot.executions[0]!;
  assert.equal(execution.schema, "execution/v1");
  const cert = buildDeliveryCertificate({
    algorithm: "sm3",
    repoId: "repo-tamper",
    task: fixture.snapshot.task!,
    execution,
    reviews: fixture.snapshot.reviews,
    reviewConsent: fixture.snapshot.consents?.[0] ?? null,
    completionEvent,
  });

  // 6a. Tamper submissionDigest
  const badSubDigest = { ...cert, submissionDigest: `sha256:${"a".repeat(64)}` };
  const rc1 = verifyDeliveryCertificate(badSubDigest);
  assert.equal(rc1.ok, false);
  if (!rc1.ok) assert.equal(rc1.code, "audit_certificate_submission_digest_mismatch");

  // 6b. Tamper reviewConsent
  const badConsent = {
    ...cert,
    reviewConsent: { ...cert.reviewConsent!, reviewDigest: `sha256:${"b".repeat(64)}` },
  };
  const rc2 = verifyDeliveryCertificate(badConsent);
  assert.equal(rc2.ok, false);
  if (!rc2.ok) assert.equal(rc2.code, "audit_certificate_consent_mismatch");

  // 6c. Tamper certificateHash
  const badCertHash = { ...cert, certificateHash: `sm3:${"c".repeat(64)}` };
  const rc3 = verifyDeliveryCertificate(badCertHash);
  assert.equal(rc3.ok, false);
  if (!rc3.ok) assert.equal(rc3.code, "audit_certificate_hash_mismatch");

  // 6d. Non-done task refused by buildDeliveryCertificate
  assert.throws(
    () =>
      buildDeliveryCertificate({
        algorithm: "sha256",
        repoId: "repo-tamper",
        task: { ...fixture.snapshot.task!, status: "in_review" },
        execution,
        reviews: fixture.snapshot.reviews,
        reviewConsent: fixture.snapshot.consents?.[0] ?? null,
        completionEvent,
      }),
    /requires a done task/u,
  );
});

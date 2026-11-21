// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  AuditChainGapError,
  auditGenesisChainHash,
  buildDeliveryCertificate,
  createAuditCertificateChainCollector,
  createAuditChainAccumulator,
  createAuditSliceVerifier,
  verifyAuditSliceContent,
  verifyAuditSliceSequence,
  verifyDeliveryCertificate,
} from "../../src/integrity/audit-hash-chain.ts";
import { digestText, sha256Text, type AuditHashAlgorithm } from "../../src/integrity/stable-hash.ts";
import type { TaskCompletedEvent } from "../../src/domain/task-lifecycle-event.ts";
import { createMigrationImportEvent, type MigrationImportEventV1 } from "../../src/domain/migration-import-event.ts";
import { normalizePersistedEventValue } from "../../src/domain/doc-sync-canonical-events.ts";
import { reviewDigest } from "../../src/domain/review.ts";
import { lifecycleFixture } from "../store/task-lifecycle-fixture.ts";

test("SM3 matches GM/T 0004-2012 standard test vector for 'abc' and SHA-256 matches FIPS 180-4", () => {
  assert.equal(digestText("sm3", "abc"), "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0");
  assert.equal(sha256Text("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

for (const algorithm of ["sha256", "sm3"] as readonly AuditHashAlgorithm[]) {
  test(`audit hash chain export, cross-slice linking, anchor pinning, and delivery-certificate verify (${algorithm})`, () => {
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
    assert.equal(manifest1.attributionStatus, "complete");
    assert.equal(manifest1.personAttribution.complete, true);
    assert.equal(manifest1.personAttribution.traceableRatio, 1);
    assert.ok(manifest1.personAttribution.attributionChainDigest.startsWith(`${algorithm}:`));

    const completionEvent = fixture.events.find((event) => event.type === "task_completed");
    assert.ok(completionEvent && completionEvent.type === "task_completed");
    const execution = fixture.snapshot.executions[0]!;
    assert.equal(execution.schema, "execution/v1");
    const consent = fixture.snapshot.consents?.[0] ?? null;
    assert.ok(consent !== null);

    const collector = createAuditCertificateChainCollector({
      taskId: "task_done_001",
      completionOpId: completionEvent.opId,
      executionId: execution.executionId,
    });

    const verify1 = verifyAuditSliceContent({
      manifest: manifest1,
      entriesContent: lines1,
      expectedAlgorithm: algorithm,
      expectedRootHash: manifest1.rootHash,
      certificateCollector: collector,
    });
    assert.equal(verify1.ok, true);
    if (verify1.ok) {
      assert.equal(verify1.anchorPinned, true);
      assert.equal(verify1.verificationStatus, "verified");
    }

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
      expectedRootHash: manifest2.rootHash,
      certificateCollector: collector,
    });
    assert.equal(verifier2.ok, true);
    if (!verifier2.ok) return;
    verifier2.verifier.feedRawBytes(Buffer.from(lines2, "utf8"));
    const rawLines2 = lines2.slice(0, -1).split("\n");
    for (let index = 0; index < rawLines2.length; index += 1) {
      assert.equal(verifier2.verifier.verifyLine(rawLines2[index]!, index + 1), null);
    }
    const verify2 = verifier2.verifier.finalize();
    assert.equal(verify2.ok, true);
    if (verify1.ok && verify2.ok) {
      assert.equal(verifyAuditSliceSequence(verify1, verify2), null);
    }

    // Also test cross-algorithm certificate (sha256 cert against sm3 slice and vice versa!)
    const certAlgorithm: AuditHashAlgorithm = algorithm === "sm3" ? "sha256" : "sm3";
    const cert = buildDeliveryCertificate({
      algorithm: certAlgorithm,
      repoId: "repo-audit-test",
      task: fixture.snapshot.task!,
      execution,
      reviews: fixture.snapshot.reviews,
      reviewConsent: consent,
      completionEvent,
    });
    assert.equal(cert.schema, "delivery-certificate/v1");
    assert.equal(cert.algorithm, certAlgorithm);
    assert.equal(cert.completionKind, "native");
    assert.equal(cert.taskId, "task_done_001");
    assert.equal(cert.executionId, "exec_done_001");
    assert.equal(cert.reviews.length, 1);
    assert.equal(cert.reviewConsent?.consentId, consent.consentId);

    const certVerified = verifyDeliveryCertificate(cert, {
      expectedAlgorithm: certAlgorithm,
      expectedCertificateHash: cert.certificateHash,
      chainEvidence: collector.evidence(),
    });
    assert.equal(certVerified.ok, true, JSON.stringify(certVerified));
    if (certVerified.ok) {
      assert.equal(certVerified.anchorPinned, true);
      assert.equal(certVerified.completionOpId, completionEvent.opId);
      assert.equal(certVerified.completionRevision, completionEvent.workspaceRevision);
      assert.equal(certVerified.chainEvidence?.completionVerified, true);
      assert.equal(certVerified.chainEvidence?.reviewsVerifiedCount, 1);
      assert.equal(certVerified.chainEvidence?.consentVerified, true);
    }
  });
}

test("G4-01 & G4-02: pinned anchors reject self-consistent forged replacements and chain semantic mismatches", () => {
  const fixture = lifecycleFixture({
    taskId: "task_anchor_001",
    executionId: "exec_anchor_001",
    reviewId: "rev_anchor_001",
  });
  const accOrig = createAuditChainAccumulator({
    repoId: "repo-anchor",
    algorithm: "sm3",
    window: { fromRevision: 1, toRevision: 6, utcDate: null, after: null, before: null },
  });
  const origLines = fixture.events.map((event) => accOrig.addEvent(event).line).join("");
  const origManifest = accOrig.finalize();

  // Construct a 100% internally self-consistent forged replacement slice with different task title
  const forgedEvents = fixture.events.map((event, idx) =>
    idx === 0 && event.type === "task_created"
      ? { ...event, payload: { ...event.payload, task: { ...event.payload.task, title: "Forged Self-Consistent" } } }
      : event,
  );
  const accForged = createAuditChainAccumulator({
    repoId: "repo-anchor",
    algorithm: "sm3",
    window: { fromRevision: 1, toRevision: 6, utcDate: null, after: null, before: null },
  });
  const forgedLines = forgedEvents.map((event) => accForged.addEvent(event).line).join("");
  const forgedManifest = accForged.finalize();

  // Without expectedRootHash it looks self-consistent; WITH expectedRootHash it MUST be rejected!
  assert.equal(verifyAuditSliceContent({ manifest: forgedManifest, entriesContent: forgedLines }).ok, true);
  const pinnedFail = verifyAuditSliceContent({
    manifest: forgedManifest,
    entriesContent: forgedLines,
    expectedRootHash: origManifest.rootHash,
  });
  assert.equal(pinnedFail.ok, false);
  if (!pinnedFail.ok) assert.equal(pinnedFail.code, "audit_expected_root_hash_mismatch");

  // Same for delivery certificate: self-consistent forged cert with different title rejected by expectedCertificateHash
  const completionEvent = fixture.events.find((e) => e.type === "task_completed") as TaskCompletedEvent;
  const execution = fixture.snapshot.executions[0]!;
  assert.equal(execution.schema, "execution/v1");
  const origCert = buildDeliveryCertificate({
    algorithm: "sha256",
    repoId: "repo-anchor",
    task: fixture.snapshot.task!,
    execution,
    reviews: fixture.snapshot.reviews,
    reviewConsent: fixture.snapshot.consents?.[0] ?? null,
    completionEvent,
  });
  const forgedCert = buildDeliveryCertificate({
    algorithm: "sha256",
    repoId: "repo-anchor",
    task: { ...fixture.snapshot.task!, title: "Forged Title" },
    execution,
    reviews: fixture.snapshot.reviews,
    reviewConsent: fixture.snapshot.consents?.[0] ?? null,
    completionEvent,
  });
  const certPinFail = verifyDeliveryCertificate(forgedCert, {
    expectedCertificateHash: origCert.certificateHash,
  });
  assert.equal(certPinFail.ok, false);
  if (!certPinFail.ok) assert.equal(certPinFail.code, "audit_expected_certificate_hash_mismatch");

  // G4-02 semantic binding: verify original chain into collector, then test forged certs against real chain
  const collector = createAuditCertificateChainCollector({
    taskId: "task_anchor_001",
    completionOpId: completionEvent.opId,
    executionId: execution.executionId,
  });
  assert.equal(
    verifyAuditSliceContent({
      manifest: origManifest,
      entriesContent: origLines,
      certificateCollector: collector,
    }).ok,
    true,
  );
  const evidence = collector.evidence();

  // Stripping reviewConsent from a self-consistent cert MUST fail against chain that contains canonical consent!
  const strippedConsentCert = buildDeliveryCertificate({
    algorithm: "sha256",
    repoId: "repo-anchor",
    task: fixture.snapshot.task!,
    execution,
    reviews: fixture.snapshot.reviews,
    reviewConsent: null,
    completionEvent,
  });
  const strippedRes = verifyDeliveryCertificate(strippedConsentCert, { chainEvidence: evidence });
  assert.equal(strippedRes.ok, false);
  if (!strippedRes.ok) assert.equal(strippedRes.code, "audit_certificate_consent_mismatch");

  // Wrong repoId MUST fail against chain!
  const wrongRepoCert = buildDeliveryCertificate({
    algorithm: "sha256",
    repoId: "repo-other",
    task: fixture.snapshot.task!,
    execution,
    reviews: fixture.snapshot.reviews,
    reviewConsent: fixture.snapshot.consents?.[0] ?? null,
    completionEvent,
  });
  const wrongRepoRes = verifyDeliveryCertificate(wrongRepoCert, { chainEvidence: evidence });
  assert.equal(wrongRepoRes.ok, false);
  if (!wrongRepoRes.ok) {
    assert.equal(wrongRepoRes.code, "audit_certificate_event_mismatch");
    assert.equal(wrongRepoRes.field, "repoId");
  }

  // Omitting a review that occurred in the canonical chain MUST fail!
  const missingReviewCert = buildDeliveryCertificate({
    algorithm: "sha256",
    repoId: "repo-anchor",
    task: fixture.snapshot.task!,
    execution,
    reviews: [],
    reviewConsent: null,
    completionEvent,
  });
  const missingReviewRes = verifyDeliveryCertificate(missingReviewCert, { chainEvidence: evidence });
  assert.equal(missingReviewRes.ok, false);
  if (!missingReviewRes.ok) assert.equal(missingReviewRes.code, "audit_certificate_event_mismatch");
});

test("G4-04 & G4-05 & G4-08: raw bytes, trailing LF, CRLF, revision gaps, cross-slice sequence, and unattributed strict/diagnostic", () => {
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

  // 2. Delete a middle line -> revision gap detected at line 3
  const deletedMiddle = [...lines.slice(0, 2), ...lines.slice(3)].join("");
  const r2 = verifyAuditSliceContent({ manifest, entriesContent: deletedMiddle });
  assert.equal(r2.ok, false);
  if (!r2.ok) {
    assert.equal(r2.code, "audit_revision_gap");
    assert.equal(r2.line, 3);
  }

  // 3. Delete trailing line (tail truncation) -> reports expected line = eventCount + 1
  const deletedTail = lines.slice(0, -1).join("");
  const rTail = verifyAuditSliceContent({ manifest, entriesContent: deletedTail });
  assert.equal(rTail.ok, false);
  if (!rTail.ok) {
    assert.equal(rTail.code, "audit_manifest_count_mismatch");
    assert.equal(rTail.line, 6);
  }

  // 4. Delete final trailing LF byte -> rejected!
  const missingTrailingLf = lines.join("").slice(0, -1);
  const rNoLf = verifyAuditSliceContent({ manifest, entriesContent: missingTrailingLf });
  assert.equal(rNoLf.ok, false);
  if (!rNoLf.ok) {
    assert.equal(rNoLf.code, "audit_manifest_entries_digest_mismatch");
    assert.equal(rNoLf.line, 6);
  }

  // 5. Replace LF with CRLF -> rejected!
  const crlfContent = lines.join("").replace("\n", "\r\n");
  const rCrlf = verifyAuditSliceContent({ manifest, entriesContent: crlfContent });
  assert.equal(rCrlf.ok, false);
  if (!rCrlf.ok) {
    assert.equal(rCrlf.code, "audit_manifest_entries_digest_mismatch");
    assert.equal(rCrlf.line, 1);
  }

  // 6. Swap two lines -> rejected
  const swapped = [lines[0], lines[2], lines[1], ...lines.slice(3)].join("");
  const r3 = verifyAuditSliceContent({ manifest, entriesContent: swapped });
  assert.equal(r3.ok, false);
  if (!r3.ok) assert.equal(r3.line, 2);

  // 7. Tamper manifest rootHash
  const badRootManifest = { ...manifest, rootHash: `sm3:${"f".repeat(64)}` };
  const r4 = verifyAuditSliceContent({ manifest: badRootManifest, entriesContent: lines.join("") });
  assert.equal(r4.ok, false);
  if (!r4.ok) assert.equal(r4.code, "audit_manifest_root_hash_mismatch");

  // 8. Pure revision gap on export MUST throw AuditChainGapError
  const gapAcc = createAuditChainAccumulator({
    repoId: "repo-gap",
    algorithm: "sha256",
    window: { fromRevision: 1, toRevision: 3, utcDate: null, after: null, before: null },
  });
  gapAcc.addEvent(fixture.events[0]!);
  assert.throws(() => gapAcc.addEvent(fixture.events[2]!), AuditChainGapError);

  // 9. Time-filtered window allows non-contiguous revisions while enforcing occurredAt window
  const timeAcc = createAuditChainAccumulator({
    repoId: "repo-time",
    algorithm: "sha256",
    window: {
      fromRevision: null,
      toRevision: 6,
      utcDate: "2026-08-11",
      after: "2026-08-11T00:00:00.000Z",
      before: "2026-08-11T23:59:59.999Z",
    },
  });
  const timeLines = [fixture.events[0]!, fixture.events[4]!].map((e) => timeAcc.addEvent(e).line).join("");
  const timeManifest = timeAcc.finalize();
  assert.equal(verifyAuditSliceContent({ manifest: timeManifest, entriesContent: timeLines }).ok, true);

  // 10. Cross-slice sequence rejects cross-repo & reversed dates
  const seqRepoMismatch = verifyAuditSliceSequence(
    {
      repoId: "repo-a",
      window: { fromRevision: 1, toRevision: 3, utcDate: null, after: null, before: null },
      firstRevision: 1,
      lastRevision: 3,
      rootHash: manifest.rootHash,
    },
    {
      repoId: "repo-b",
      window: { fromRevision: 4, toRevision: 6, utcDate: null, after: null, before: null },
      firstRevision: 4,
      lastRevision: 6,
      prevRootHash: manifest.rootHash,
    },
  );
  assert.equal(seqRepoMismatch?.code, "audit_slice_sequence_invalid");
  assert.equal(seqRepoMismatch?.field, "repoId");

  const seqReversedDate = verifyAuditSliceSequence(
    {
      repoId: "repo-a",
      window: {
        fromRevision: null,
        toRevision: 3,
        utcDate: "2026-11-21",
        after: "2026-11-21T00:00:00.000Z",
        before: "2026-11-21T23:59:59.999Z",
      },
      firstRevision: 1,
      lastRevision: 3,
      rootHash: manifest.rootHash,
    },
    {
      repoId: "repo-a",
      window: {
        fromRevision: null,
        toRevision: 6,
        utcDate: "2026-11-20",
        after: "2026-11-20T00:00:00.000Z",
        before: "2026-11-20T23:59:59.999Z",
      },
      firstRevision: 4,
      lastRevision: 6,
      prevRootHash: manifest.rootHash,
    },
  );
  assert.equal(seqReversedDate?.code, "audit_slice_sequence_invalid");
  assert.equal(seqReversedDate?.field, "window.utcDate");

  // 11. G4-08: Missing personId marks export attributionStatus="incomplete", fails strict verify, and yields diagnostic status (never ok:true)
  const unattributedEvents = fixture.events.map((event, idx) =>
    idx === 1 ? ({ ...event, actor: { principal: { personId: "" }, executor: null } } as typeof event) : event,
  );
  const unattrAcc = createAuditChainAccumulator({
    repoId: "repo-unattr",
    algorithm: "sha256",
    window: { fromRevision: 1, toRevision: 6, utcDate: null, after: null, before: null },
  });
  const unattrLines = unattributedEvents.map((e) => unattrAcc.addEvent(e).line).join("");
  const unattrManifest = unattrAcc.finalize();
  assert.equal(unattrManifest.attributionStatus, "incomplete");
  assert.equal(unattrManifest.personAttribution.complete, false);
  assert.equal(unattrManifest.personAttribution.unattributedEvents, 1);

  const strictUnattr = verifyAuditSliceContent({ manifest: unattrManifest, entriesContent: unattrLines });
  assert.equal(strictUnattr.ok, false);
  if (!strictUnattr.ok) {
    assert.equal(strictUnattr.code, "audit_person_attribution_missing");
    assert.equal(strictUnattr.line, 2);
    assert.notEqual(strictUnattr.diagnostic, true);
  }

  const diagUnattr = verifyAuditSliceContent({
    manifest: unattrManifest,
    entriesContent: unattrLines,
    requirePersonAttribution: false,
  });
  assert.equal(diagUnattr.ok, false);
  assert.equal("diagnostic" in diagUnattr && diagUnattr.diagnostic, true);
  if (!diagUnattr.ok && diagUnattr.diagnostic === true) {
    assert.equal(diagUnattr.verificationStatus, "diagnostic_incomplete_attribution");
    assert.equal(diagUnattr.strictVerified, false);
    assert.equal(diagUnattr.chainIntegrityOk, true);
    assert.equal(diagUnattr.attributionVerified, false);
    assert.equal(diagUnattr.line, 2);
  }
});

test("G4-07: external-resolution and sibling-resolution done certificates verify standalone and against canonical chain", () => {
  const fixture = lifecycleFixture({
    taskId: "task_res_001",
    executionId: "exec_res_001",
    reviewId: "rev_res_001",
  });
  const baseCompletion = fixture.events.find((e) => e.type === "task_completed") as TaskCompletedEvent;

  const externalEvent: TaskCompletedEvent = {
    ...baseCompletion,
    opId: "op_complete_external",
    eventId: "ev_complete_external",
    payload: {
      task: baseCompletion.payload.task,
      externalResolution: {
        commitSha: "a".repeat(40),
        rationale: "Landed in upstream hotfix commit.",
        factRef: "fact/F-12345678",
      },
      documentClaims: baseCompletion.payload.documentClaims,
    },
  };
  const externalCert = buildDeliveryCertificate({
    algorithm: "sm3",
    repoId: "repo-res",
    task: fixture.snapshot.task!,
    execution: null,
    reviews: [],
    reviewConsent: null,
    completionEvent: externalEvent,
  });
  assert.equal(externalCert.completionKind, "external-resolution");
  assert.equal(externalCert.executionId, null);
  assert.equal(externalCert.submission, null);
  assert.equal(externalCert.commitSha, "a".repeat(40));
  assert.deepEqual(externalCert.resolution, {
    kind: "external-resolution",
    commitSha: "a".repeat(40),
    rationale: "Landed in upstream hotfix commit.",
    factRef: "fact/F-12345678",
  });
  assert.equal(verifyDeliveryCertificate(externalCert).ok, true);

  // Chain-bind external-resolution certificate (using sha256 chain + sm3 cert!)
  const extAcc = createAuditChainAccumulator({
    repoId: "repo-res",
    algorithm: "sha256",
    window: { fromRevision: 6, toRevision: 6, utcDate: null, after: null, before: null },
  });
  const extLines = extAcc.addEvent(externalEvent).line;
  const extManifest = extAcc.finalize();
  const extCollector = createAuditCertificateChainCollector({
    taskId: "task_res_001",
    completionOpId: externalEvent.opId,
    executionId: null,
  });
  assert.equal(
    verifyAuditSliceContent({ manifest: extManifest, entriesContent: extLines, certificateCollector: extCollector }).ok,
    true,
  );
  const extBound = verifyDeliveryCertificate(externalCert, { chainEvidence: extCollector.evidence() });
  assert.equal(extBound.ok, true, JSON.stringify(extBound));

  // Sibling resolution
  const siblingEvent: TaskCompletedEvent = {
    ...baseCompletion,
    opId: "op_complete_sibling",
    eventId: "ev_complete_sibling",
    payload: {
      task: baseCompletion.payload.task,
      siblingResolution: {
        sourceTaskId: "task_sibling_winner",
        rationale: "Superseded and delivered by sibling task.",
        factRef: "fact/F-87654321",
      },
      documentClaims: baseCompletion.payload.documentClaims,
    },
  };
  const siblingCert = buildDeliveryCertificate({
    algorithm: "sha256",
    repoId: "repo-res",
    task: fixture.snapshot.task!,
    execution: null,
    reviews: [],
    reviewConsent: null,
    completionEvent: siblingEvent,
  });
  assert.equal(siblingCert.completionKind, "sibling-resolution");
  assert.equal(siblingCert.commitSha, null);
  assert.equal(siblingCert.executionId, null);
  assert.equal(verifyDeliveryCertificate(siblingCert).ok, true);

  // Tamper resolution.sourceTaskId -> rejected
  const badSibling = {
    ...siblingCert,
    resolution: { ...siblingCert.resolution!, sourceTaskId: "task_other" },
  };
  const badSibRes = verifyDeliveryCertificate(badSibling);
  assert.equal(badSibRes.ok, false);
  if (!badSibRes.ok) assert.equal(badSibRes.code, "audit_certificate_hash_mismatch");
});

test("DM-02: date/time slices allow historical out-of-order revisions while rejecting overlaps and equal boundaries", () => {
  const fixture = lifecycleFixture({
    taskId: "task_dm02_001",
    executionId: "exec_dm02_001",
    reviewId: "rev_dm02_001",
  });
  // Mirror real historical ledger: 2026-08-19 carries rev 47768, 2026-08-31 carries rev 41601.
  const evAug19 = {
    ...fixture.events[0]!,
    workspaceRevision: 47768,
    opId: "op_aug19_47768",
    eventId: "ev_aug19_47768",
    occurredAt: "2026-08-19T02:33:20.837Z",
  };
  const evAug31 = {
    ...fixture.events[1]!,
    workspaceRevision: 41601,
    opId: "op_aug31_41601",
    eventId: "ev_aug31_41601",
    occurredAt: "2026-08-31T09:59:08.131Z",
  };

  const acc1 = createAuditChainAccumulator({
    repoId: "repo-dm02",
    algorithm: "sm3",
    window: {
      fromRevision: null,
      toRevision: 286571,
      utcDate: "2026-08-19",
      after: "2026-08-19T00:00:00.000Z",
      before: "2026-08-19T23:59:59.999Z",
    },
  });
  const lines1 = acc1.addEvent(evAug19).line;
  const manifest1 = acc1.finalize();

  const acc2 = createAuditChainAccumulator({
    repoId: "repo-dm02",
    algorithm: "sm3",
    prevRootHash: manifest1.rootHash,
    window: {
      fromRevision: null,
      toRevision: 286571,
      utcDate: "2026-08-31",
      after: "2026-08-31T00:00:00.000Z",
      before: "2026-08-31T23:59:59.999Z",
    },
  });
  const lines2 = acc2.addEvent(evAug31).line;
  const manifest2 = acc2.finalize();

  const v1 = verifyAuditSliceContent({ manifest: manifest1, entriesContent: lines1 });
  const v2 = verifyAuditSliceContent({
    manifest: manifest2,
    entriesContent: lines2,
    expectedPrevRootHash: manifest1.rootHash,
  });
  assert.equal(v1.ok, true);
  assert.equal(v2.ok, true);
  if (v1.ok && v2.ok) {
    assert.equal(verifyAuditSliceSequence(v1, v2), null);
    // Negative: reversed date order rejected
    const reversed = verifyAuditSliceSequence({ ...v2, rootHash: v2.rootHash }, { ...v1, prevRootHash: v2.rootHash });
    assert.equal(reversed?.code, "audit_slice_sequence_invalid");
    // Negative: same UTC date rejected
    const sameDay = verifyAuditSliceSequence(v1, { ...v1, prevRootHash: v1.rootHash });
    assert.equal(sameDay?.code, "audit_slice_sequence_invalid");
  }

  // Positive: custom non-overlapping time windows with reversed revisions succeed
  const customA = {
    repoId: "repo-dm02",
    window: {
      fromRevision: null,
      toRevision: null,
      utcDate: null,
      after: "2026-08-19T00:00:00.000Z",
      before: "2026-08-19T12:00:00.000Z",
    },
    firstRevision: 500,
    lastRevision: 500,
    rootHash: manifest1.rootHash,
  };
  const customB = {
    repoId: "repo-dm02",
    window: {
      fromRevision: null,
      toRevision: null,
      utcDate: null,
      after: "2026-08-19T12:00:00.001Z",
      before: "2026-08-19T23:59:59.999Z",
    },
    firstRevision: 100,
    lastRevision: 100,
    prevRootHash: manifest1.rootHash,
  };
  assert.equal(verifyAuditSliceSequence(customA, customB), null);

  // Negative: equal boundary endpoints (inclusive overlap) rejected
  const equalBoundary = verifyAuditSliceSequence(customA, {
    ...customB,
    window: { ...customB.window, after: "2026-08-19T12:00:00.000Z" },
  });
  assert.equal(equalBoundary?.code, "audit_slice_sequence_invalid");
  assert.equal(equalBoundary?.field, "window.after");
});

test("DM-04, DM-05, DM-06: imported-migration certificates, historical timestamp normalization, and strictVerified trust basis", () => {
  const fixture = lifecycleFixture({
    taskId: "task_dm04_001",
    executionId: "exec_dm04_001",
    reviewId: "rev_dm04_001",
  });
  // DM-04: Historically imported done task (zero task_completed events)
  const importedTask = { ...fixture.snapshot.task!, taskId: "task_imported_hist", status: "done" as const };
  const importEvent: MigrationImportEventV1 = createMigrationImportEvent({
    eventId: "ev_import_done_001",
    workspaceRevision: 41369,
    opId: "migration-import-done-001",
    actor: { principal: { personId: "person_zeyu" }, executor: null },
    source: "migration-import/v1",
    occurredAt: "2026-08-19T02:33:20.837Z",
    payload: {
      migratedFrom: "task_imported_hist",
      generation: "v0",
      entity: {
        kind: "task",
        provenance: "imported_snapshot",
        task: importedTask,
        originalStatus: "done",
        packagePath: "tasks/task_imported_hist-fixture",
        documentClaim: {
          path: "tasks/task_imported_hist-fixture/INDEX.md",
          sha256: "0".repeat(64),
          size: 128,
          mediaType: "text/markdown",
          policyId: "typed-migration-import/v1",
        },
      },
    },
  });
  const importedCert = buildDeliveryCertificate({
    algorithm: "sm3",
    repoId: "repo-dm04",
    task: importedTask,
    execution: null,
    reviews: [],
    reviewConsent: null,
    completionEvent: importEvent,
  });
  assert.equal(importedCert.completionKind, "imported-migration");
  assert.equal(importedCert.executionId, null);
  assert.equal(importedCert.commitSha, null);
  assert.deepEqual(importedCert.resolution, {
    kind: "imported-migration",
    migratedFrom: "task_imported_hist",
    generation: "v0",
    originalStatus: "done",
    packagePath: "tasks/task_imported_hist-fixture",
  });

  // Unpinned verify is selfConsistent=true, strictVerified=false
  const unpinnedImported = verifyDeliveryCertificate(importedCert);
  assert.equal(unpinnedImported.ok, true);
  if (unpinnedImported.ok) {
    assert.equal(unpinnedImported.selfConsistent, true);
    assert.equal(unpinnedImported.anchorPinned, false);
    assert.equal(unpinnedImported.strictVerified, false);
    assert.equal(unpinnedImported.verificationMode, "self-consistent-only");
  }

  // Joint verify of imported-migration cert against sha256 chain + pinned anchor
  const impAcc = createAuditChainAccumulator({
    repoId: "repo-dm04",
    algorithm: "sha256",
    window: { fromRevision: 41369, toRevision: 41369, utcDate: null, after: null, before: null },
  });
  const impLines = impAcc.addEvent(importEvent).line;
  const impManifest = impAcc.finalize();
  const impCollector = createAuditCertificateChainCollector({
    taskId: "task_imported_hist",
    completionOpId: importEvent.opId,
    executionId: null,
  });
  const impSliceRes = verifyAuditSliceContent({
    manifest: impManifest,
    entriesContent: impLines,
    expectedRootHash: impManifest.rootHash,
    certificateCollector: impCollector,
  });
  assert.equal(impSliceRes.ok, true);
  if (impSliceRes.ok) {
    assert.equal(impSliceRes.strictVerified, true);
  }
  const impCertVerified = verifyDeliveryCertificate(importedCert, {
    expectedAlgorithm: "sm3",
    expectedCertificateHash: importedCert.certificateHash,
    chainEvidence: impCollector.evidence(),
  });
  assert.equal(impCertVerified.ok, true, JSON.stringify(impCertVerified));
  if (impCertVerified.ok) {
    assert.equal(impCertVerified.strictVerified, true);
    assert.equal(impCertVerified.chainEvidence?.coverage, "complete");
  }

  // DM-05: Raw chain has historical +08:00 / no-.sss timestamps while projection-built certificate has normalized UTC .000Z
  const rawEvents = fixture.events.map((ev) => {
    if (ev.type === "review_recorded") {
      return {
        ...ev,
        occurredAt: "2026-08-19T10:33:20+08:00",
        payload: {
          ...ev.payload,
          review: { ...ev.payload.review, reviewedAt: "2026-08-19T10:33:20+08:00" },
        },
      };
    }
    if (ev.type === "review_consent_recorded") {
      const normalizedRev = normalizePersistedEventValue({
        ...ev.payload.review,
        reviewedAt: "2026-08-19T10:33:20+08:00",
      });
      return {
        ...ev,
        occurredAt: "2026-08-19T02:35:00Z",
        payload: {
          ...ev.payload,
          review: { ...ev.payload.review, reviewedAt: "2026-08-19T10:33:20+08:00" },
          consent: {
            ...ev.payload.consent,
            consentedAt: "2026-08-19T10:35:00+08:00",
            reviewDigest: reviewDigest(normalizedRev),
          },
        },
      };
    }
    return ev;
  });
  const normReviews = rawEvents
    .filter(
      (e): e is Extract<(typeof rawEvents)[number], { readonly type: "review_recorded" }> =>
        e.type === "review_recorded",
    )
    .map((e) => normalizePersistedEventValue(e.payload.review));
  const normConsentEvent = rawEvents.find(
    (e): e is Extract<(typeof rawEvents)[number], { readonly type: "review_consent_recorded" }> =>
      e.type === "review_consent_recorded",
  )!;
  const normConsent = normalizePersistedEventValue(normConsentEvent.payload.consent);
  const completionEv = rawEvents.find((e) => e.type === "task_completed") as TaskCompletedEvent;
  const exec = fixture.snapshot.executions[0]!;
  assert.equal(exec.schema, "execution/v1");

  const histCert = buildDeliveryCertificate({
    algorithm: "sha256",
    repoId: "repo-dm05",
    task: fixture.snapshot.task!,
    execution: exec,
    reviews: normReviews,
    reviewConsent: normConsent,
    completionEvent: completionEv,
  });

  const histAcc = createAuditChainAccumulator({
    repoId: "repo-dm05",
    algorithm: "sm3",
    window: { fromRevision: 1, toRevision: 6, utcDate: null, after: null, before: null },
  });
  const histLines = rawEvents.map((e) => histAcc.addEvent(e).line).join("");
  const histManifest = histAcc.finalize();
  const histCollector = createAuditCertificateChainCollector({
    taskId: "task_dm04_001",
    completionOpId: completionEv.opId,
    executionId: exec.executionId,
  });
  assert.equal(
    verifyAuditSliceContent({
      manifest: histManifest,
      entriesContent: histLines,
      expectedRootHash: histManifest.rootHash,
      certificateCollector: histCollector,
    }).ok,
    true,
  );
  const histVerified = verifyDeliveryCertificate(histCert, {
    expectedCertificateHash: histCert.certificateHash,
    chainEvidence: histCollector.evidence(),
  });
  assert.equal(histVerified.ok, true, JSON.stringify(histVerified));
  if (histVerified.ok) {
    assert.equal(histVerified.strictVerified, true);
    assert.equal(histVerified.chainEvidence?.coverage, "complete");
    assert.equal(histVerified.chainEvidence?.reviewsVerifiedCount, 1);
    assert.equal(histVerified.chainEvidence?.consentVerified, true);
  }

  // DM-06: Partial slice covering ONLY completionEvent (rev 6) leaves review & consent uncovered -> strictVerified=false!
  const partialAcc = createAuditChainAccumulator({
    repoId: "repo-dm05",
    algorithm: "sm3",
    window: { fromRevision: 6, toRevision: 6, utcDate: null, after: null, before: null },
  });
  const partialLines = partialAcc.addEvent(completionEv).line;
  const partialManifest = partialAcc.finalize();
  const partialCollector = createAuditCertificateChainCollector({
    taskId: "task_dm04_001",
    completionOpId: completionEv.opId,
    executionId: exec.executionId,
  });
  assert.equal(
    verifyAuditSliceContent({
      manifest: partialManifest,
      entriesContent: partialLines,
      expectedRootHash: partialManifest.rootHash,
      certificateCollector: partialCollector,
    }).ok,
    true,
  );
  const partialCertRes = verifyDeliveryCertificate(histCert, {
    expectedCertificateHash: histCert.certificateHash,
    chainEvidence: partialCollector.evidence(),
  });
  assert.equal(partialCertRes.ok, true, JSON.stringify(partialCertRes));
  if (partialCertRes.ok) {
    assert.equal(partialCertRes.selfConsistent, true);
    assert.equal(partialCertRes.anchorPinned, true);
    assert.equal(partialCertRes.strictVerified, false);
    assert.equal(partialCertRes.verificationMode, "self-consistent-only");
    assert.equal(partialCertRes.chainEvidence?.coverage, "partial");
    assert.deepEqual(partialCertRes.chainEvidence?.uncoveredReviewIds, ["rev_dm04_001"]);
    assert.equal(partialCertRes.chainEvidence?.uncoveredConsentId, normConsent.consentId);
  }

  // DM-06(a): Disjoint pinned daily slices (Nov 1 + Nov 3, gap on Nov 2) where real review & consent fall on gap day
  // MUST classify as coverage="partial" (strictVerified=false), NEVER as canonical mismatch failure!
  const multiDayEvents = fixture.events.map((ev) => {
    if (ev.type === "task_created") {
      return { ...ev, occurredAt: "2026-11-01T10:00:00.000Z" };
    }
    if (ev.type === "execution_started" || ev.type === "execution_submitted") {
      return { ...ev, occurredAt: "2026-11-02T09:00:00.000Z" };
    }
    if (ev.type === "review_recorded") {
      return {
        ...ev,
        occurredAt: "2026-11-02T11:00:00.000Z",
        payload: { ...ev.payload, review: { ...ev.payload.review, reviewedAt: "2026-11-02T11:00:00.000Z" } },
      };
    }
    if (ev.type === "review_consent_recorded") {
      const updatedRev = { ...ev.payload.review, reviewedAt: "2026-11-02T11:00:00.000Z" };
      return {
        ...ev,
        occurredAt: "2026-11-02T12:00:00.000Z",
        payload: {
          ...ev.payload,
          review: updatedRev,
          consent: {
            ...ev.payload.consent,
            consentedAt: "2026-11-02T12:00:00.000Z",
            reviewDigest: reviewDigest(updatedRev),
          },
        },
      };
    }
    return { ...ev, occurredAt: "2026-11-03T15:00:00.000Z" };
  });
  const gapReviews = multiDayEvents
    .filter(
      (e): e is Extract<(typeof multiDayEvents)[number], { readonly type: "review_recorded" }> =>
        e.type === "review_recorded",
    )
    .map((e) => e.payload.review);
  const gapConsentEv = multiDayEvents.find(
    (e): e is Extract<(typeof multiDayEvents)[number], { readonly type: "review_consent_recorded" }> =>
      e.type === "review_consent_recorded",
  )!;
  const gapCompletionEv = multiDayEvents.find((e) => e.type === "task_completed") as TaskCompletedEvent;
  const gapCert = buildDeliveryCertificate({
    algorithm: "sha256",
    repoId: "repo-dm06",
    task: fixture.snapshot.task!,
    execution: exec,
    reviews: gapReviews,
    reviewConsent: gapConsentEv.payload.consent,
    completionEvent: gapCompletionEv,
  });

  const nov1Acc = createAuditChainAccumulator({
    repoId: "repo-dm06",
    algorithm: "sm3",
    window: {
      fromRevision: null,
      toRevision: 6,
      utcDate: "2026-11-01",
      after: "2026-11-01T00:00:00.000Z",
      before: "2026-11-01T23:59:59.999Z",
    },
  });
  const nov1Lines = nov1Acc.addEvent(multiDayEvents[0]!).line;
  const nov1Manifest = nov1Acc.finalize();

  const nov3Acc = createAuditChainAccumulator({
    repoId: "repo-dm06",
    algorithm: "sm3",
    prevRootHash: nov1Manifest.rootHash,
    window: {
      fromRevision: null,
      toRevision: 6,
      utcDate: "2026-11-03",
      after: "2026-11-03T00:00:00.000Z",
      before: "2026-11-03T23:59:59.999Z",
    },
  });
  const nov3Lines = nov3Acc.addEvent(gapCompletionEv).line;
  const nov3Manifest = nov3Acc.finalize();

  const gapCollector = createAuditCertificateChainCollector({
    taskId: "task_dm04_001",
    completionOpId: gapCompletionEv.opId,
    executionId: exec.executionId,
  });
  assert.equal(
    verifyAuditSliceContent({
      manifest: nov1Manifest,
      entriesContent: nov1Lines,
      certificateCollector: gapCollector,
    }).ok,
    true,
  );
  assert.equal(
    verifyAuditSliceContent({
      manifest: nov3Manifest,
      entriesContent: nov3Lines,
      expectedPrevRootHash: nov1Manifest.rootHash,
      expectedRootHash: nov3Manifest.rootHash,
      certificateCollector: gapCollector,
    }).ok,
    true,
  );
  const gapDayRes = verifyDeliveryCertificate(gapCert, {
    expectedCertificateHash: gapCert.certificateHash,
    chainEvidence: gapCollector.evidence(),
  });
  assert.equal(gapDayRes.ok, true, JSON.stringify(gapDayRes));
  if (gapDayRes.ok) {
    assert.equal(gapDayRes.selfConsistent, true);
    assert.equal(gapDayRes.anchorPinned, true);
    assert.equal(gapDayRes.strictVerified, false);
    assert.equal(gapDayRes.chainEvidence?.coverage, "partial");
    assert.deepEqual(gapDayRes.chainEvidence?.uncoveredReviewIds, ["rev_dm04_001"]);
    assert.equal(gapDayRes.chainEvidence?.uncoveredConsentId, gapConsentEv.payload.consent.consentId);
    assert.equal(gapDayRes.chainEvidence?.consentVerified, "not_in_slice_window");
  }

  // Provable conflict inside a covered slice (review claims timestamp inside covered Nov 3 slice) MUST STILL FAIL!
  const forgedInCoveredDayCert = buildDeliveryCertificate({
    algorithm: "sha256",
    repoId: "repo-dm06",
    task: fixture.snapshot.task!,
    execution: exec,
    reviews: [{ ...gapReviews[0]!, reviewedAt: "2026-11-03T10:00:00.000Z" }],
    reviewConsent: null,
    completionEvent: gapCompletionEv,
  });
  const forgedDayFail = verifyDeliveryCertificate(forgedInCoveredDayCert, {
    expectedCertificateHash: forgedInCoveredDayCert.certificateHash,
    chainEvidence: gapCollector.evidence(),
  });
  assert.equal(forgedDayFail.ok, false);
  if (!forgedDayFail.ok) assert.equal(forgedDayFail.code, "audit_certificate_event_mismatch");

  // Providing all 3 contiguous daily slices (Nov 1 + Nov 2 + Nov 3) proves complete coverage -> strictVerified=true!
  const nov2Acc = createAuditChainAccumulator({
    repoId: "repo-dm06",
    algorithm: "sm3",
    prevRootHash: nov1Manifest.rootHash,
    window: {
      fromRevision: null,
      toRevision: 6,
      utcDate: "2026-11-02",
      after: "2026-11-02T00:00:00.000Z",
      before: "2026-11-02T23:59:59.999Z",
    },
  });
  const nov2Lines = multiDayEvents
    .slice(1, 5)
    .map((e) => nov2Acc.addEvent(e).line)
    .join("");
  const nov2Manifest = nov2Acc.finalize();
  const nov3LinkedAcc = createAuditChainAccumulator({
    repoId: "repo-dm06",
    algorithm: "sm3",
    prevRootHash: nov2Manifest.rootHash,
    window: {
      fromRevision: null,
      toRevision: 6,
      utcDate: "2026-11-03",
      after: "2026-11-03T00:00:00.000Z",
      before: "2026-11-03T23:59:59.999Z",
    },
  });
  const nov3LinkedLines = nov3LinkedAcc.addEvent(gapCompletionEv).line;
  const nov3LinkedManifest = nov3LinkedAcc.finalize();
  const fullDayCollector = createAuditCertificateChainCollector({
    taskId: "task_dm04_001",
    completionOpId: gapCompletionEv.opId,
    executionId: exec.executionId,
  });
  assert.equal(
    verifyAuditSliceContent({
      manifest: nov1Manifest,
      entriesContent: nov1Lines,
      certificateCollector: fullDayCollector,
    }).ok,
    true,
  );
  assert.equal(
    verifyAuditSliceContent({
      manifest: nov2Manifest,
      entriesContent: nov2Lines,
      expectedPrevRootHash: nov1Manifest.rootHash,
      certificateCollector: fullDayCollector,
    }).ok,
    true,
  );
  assert.equal(
    verifyAuditSliceContent({
      manifest: nov3LinkedManifest,
      entriesContent: nov3LinkedLines,
      expectedPrevRootHash: nov2Manifest.rootHash,
      expectedRootHash: nov3LinkedManifest.rootHash,
      certificateCollector: fullDayCollector,
    }).ok,
    true,
  );
  const fullDayRes = verifyDeliveryCertificate(gapCert, {
    expectedCertificateHash: gapCert.certificateHash,
    chainEvidence: fullDayCollector.evidence(),
  });
  assert.equal(fullDayRes.ok, true, JSON.stringify(fullDayRes));
  if (fullDayRes.ok) {
    assert.equal(fullDayRes.strictVerified, true);
    assert.equal(fullDayRes.chainEvidence?.coverage, "complete");
  }

  // DM-06(b): Completion-only slice with reviews=[] and reviewConsent=null MUST report coverage="partial"
  // (cannot prove absence of reviews/consent without covering the task/execution lifecycle window!)
  const emptyReviewCert = buildDeliveryCertificate({
    algorithm: "sha256",
    repoId: "repo-dm05",
    task: fixture.snapshot.task!,
    execution: exec,
    reviews: [],
    reviewConsent: null,
    completionEvent: completionEv,
  });
  const completionOnlyEmptyRes = verifyDeliveryCertificate(emptyReviewCert, {
    expectedCertificateHash: emptyReviewCert.certificateHash,
    chainEvidence: partialCollector.evidence(),
  });
  assert.equal(completionOnlyEmptyRes.ok, true, JSON.stringify(completionOnlyEmptyRes));
  if (completionOnlyEmptyRes.ok) {
    assert.equal(completionOnlyEmptyRes.selfConsistent, true);
    assert.equal(completionOnlyEmptyRes.anchorPinned, true);
    assert.equal(completionOnlyEmptyRes.strictVerified, false);
    assert.equal(completionOnlyEmptyRes.chainEvidence?.coverage, "partial");
    assert.equal(completionOnlyEmptyRes.chainEvidence?.consentVerified, "not_in_slice_window");
  }

  // DM-06(c): Cursor-truncated date slice chained with prior full day MUST report partial when a real review
  // occurred on that day BEFORE the cursor (never falsely rejecting as audit_certificate_event_mismatch),
  // while still rejecting real content conflicts inside observed events or inside the fully-covered prior day!
  const day1Events = multiDayEvents.slice(0, 2); // rev 1 (Nov 1), rev 2 -> let's put rev 1..2 on Nov 1, rev 3..6 on Nov 2
  const cursorSplitBaseEvents = multiDayEvents.map((ev, idx) => {
    const occurredAt =
      idx === 0 ? "2026-11-01T10:00:00.000Z" : idx === 1 ? "2026-11-01T12:00:00.000Z" : `2026-11-02T1${idx}:00:00.000Z`;
    if (ev.type === "review_recorded") {
      return {
        ...ev,
        occurredAt,
        payload: { ...ev.payload, review: { ...ev.payload.review, reviewedAt: occurredAt } },
      };
    }
    return { ...ev, occurredAt };
  });
  const cursorSplitReviewEv = cursorSplitBaseEvents.find((e) => e.type === "review_recorded")!;
  const cursorSplitReviewDigest = reviewDigest(cursorSplitReviewEv.payload.review);
  const cursorSplitEvents = cursorSplitBaseEvents.map((ev) => {
    if (ev.type === "review_consent_recorded") {
      return {
        ...ev,
        payload: {
          ...ev.payload,
          review: cursorSplitReviewEv.payload.review,
          consent: {
            ...ev.payload.consent,
            consentedAt: ev.occurredAt,
            reviewDigest: cursorSplitReviewDigest,
          },
        },
      };
    }
    return ev;
  });
  void day1Events;
  const cursorSplitConsentEv = cursorSplitEvents.find((e) => e.type === "review_consent_recorded")!;
  const cursorSplitCompletionEv = cursorSplitEvents.find((e) => e.type === "task_completed")!;
  const cursorSplitCert = buildDeliveryCertificate({
    algorithm: "sha256",
    repoId: "repo-dm06-cursor",
    task: fixture.snapshot.task!,
    execution: exec,
    reviews: [cursorSplitReviewEv.payload.review],
    reviewConsent: cursorSplitConsentEv.payload.consent,
    completionEvent: cursorSplitCompletionEv,
  });

  const fullDay1Acc = createAuditChainAccumulator({
    repoId: "repo-dm06-cursor",
    algorithm: "sm3",
    window: {
      fromRevision: null,
      toRevision: 6,
      utcDate: "2026-11-01",
      after: "2026-11-01T00:00:00.000Z",
      before: "2026-11-01T23:59:59.999Z",
    },
  });
  const fullDay1Lines = cursorSplitEvents
    .slice(0, 2)
    .map((e) => fullDay1Acc.addEvent(e).line)
    .join("");
  const fullDay1Manifest = fullDay1Acc.finalize();

  // Day 2 exported with --cursor 4 (skipping rev 3 execution_submitted and rev 4 review_recorded on Nov 2!)
  const truncatedDay2Acc = createAuditChainAccumulator({
    repoId: "repo-dm06-cursor",
    algorithm: "sm3",
    prevRootHash: fullDay1Manifest.rootHash,
    window: {
      fromRevision: 5,
      toRevision: 6,
      utcDate: "2026-11-02",
      after: "2026-11-02T00:00:00.000Z",
      before: "2026-11-02T23:59:59.999Z",
      cursorTruncated: true,
    },
  });
  const truncatedDay2Lines = cursorSplitEvents
    .slice(4)
    .map((e) => truncatedDay2Acc.addEvent(e).line)
    .join("");
  const truncatedDay2Manifest = truncatedDay2Acc.finalize();

  const cursorSplitCollector = createAuditCertificateChainCollector({
    taskId: "task_dm04_001",
    completionOpId: cursorSplitCompletionEv.opId,
    executionId: exec.executionId,
  });
  assert.equal(
    verifyAuditSliceContent({
      manifest: fullDay1Manifest,
      entriesContent: fullDay1Lines,
      certificateCollector: cursorSplitCollector,
    }).ok,
    true,
  );
  assert.equal(
    verifyAuditSliceContent({
      manifest: truncatedDay2Manifest,
      entriesContent: truncatedDay2Lines,
      expectedPrevRootHash: fullDay1Manifest.rootHash,
      expectedRootHash: truncatedDay2Manifest.rootHash,
      certificateCollector: cursorSplitCollector,
    }).ok,
    true,
  );
  const cursorTruncRes = verifyDeliveryCertificate(cursorSplitCert, {
    expectedCertificateHash: cursorSplitCert.certificateHash,
    chainEvidence: cursorSplitCollector.evidence(),
  });
  assert.equal(cursorTruncRes.ok, true, JSON.stringify(cursorTruncRes));
  if (cursorTruncRes.ok) {
    assert.equal(cursorTruncRes.selfConsistent, true);
    assert.equal(cursorTruncRes.strictVerified, false);
    assert.equal(cursorTruncRes.chainEvidence?.coverage, "partial");
    assert.deepEqual(cursorTruncRes.chainEvidence?.uncoveredReviewIds, [cursorSplitReviewEv.payload.review.reviewId]);
    assert.equal(cursorTruncRes.chainEvidence?.consentVerified, true);
  }

  // Real content conflict on observed consent (rev 5, after cursor) MUST STILL FAIL!
  const tamperedConsentAfterCursorCert = buildDeliveryCertificate({
    algorithm: "sha256",
    repoId: "repo-dm06-cursor",
    task: fixture.snapshot.task!,
    execution: exec,
    reviews: [cursorSplitReviewEv.payload.review],
    reviewConsent: { ...cursorSplitConsentEv.payload.consent, consentedBy: "person_forged" },
    completionEvent: cursorSplitCompletionEv,
  });
  const tamperedConsentRes = verifyDeliveryCertificate(tamperedConsentAfterCursorCert, {
    expectedCertificateHash: tamperedConsentAfterCursorCert.certificateHash,
    chainEvidence: cursorSplitCollector.evidence(),
  });
  assert.equal(tamperedConsentRes.ok, false);
  if (!tamperedConsentRes.ok) assert.equal(tamperedConsentRes.code, "audit_certificate_consent_mismatch");

  // Forged review claiming timestamp strictly inside fully-covered Day 1 MUST STILL FAIL!
  const forgedDay1Review = { ...cursorSplitReviewEv.payload.review, reviewedAt: "2026-11-01T15:00:00.000Z" };
  const forgedDay1ReviewCert = buildDeliveryCertificate({
    algorithm: "sha256",
    repoId: "repo-dm06-cursor",
    task: fixture.snapshot.task!,
    execution: exec,
    reviews: [forgedDay1Review],
    reviewConsent: null,
    completionEvent: cursorSplitCompletionEv,
  });
  const forgedDay1Res = verifyDeliveryCertificate(forgedDay1ReviewCert, {
    expectedCertificateHash: forgedDay1ReviewCert.certificateHash,
    chainEvidence: cursorSplitCollector.evidence(),
  });
  assert.equal(forgedDay1Res.ok, false);
  if (!forgedDay1Res.ok) assert.equal(forgedDay1Res.code, "audit_certificate_event_mismatch");
});

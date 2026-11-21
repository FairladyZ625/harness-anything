// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditGenesisChainHash,
  buildDeliveryCertificate,
  createAuditChainAccumulator,
  type AuditExportManifestV1,
  type AuditHashAlgorithm,
  type PersistedCanonicalEventV1,
} from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { runLedgerAuditExport, runLedgerAuditVerify, runTaskDeliveryCertificate } from "../src/cli-audit-commands.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("thin command parser routes ledger audit-export and task delivery-certificate with strict flags", () => {
  const exportParsed = parseThinCommand([
    "ledger",
    "audit-export",
    "--algorithm",
    "sm3",
    "--from-revision",
    "1",
    "--to-revision",
    "50",
    "--limit",
    "10",
    "--output-dir",
    "/tmp/out",
    "--json",
  ]);
  assert.equal(exportParsed.ok, true);
  if (exportParsed.ok) {
    assert.equal(exportParsed.command.method, "repo.task.read");
    assert.deepEqual(exportParsed.command.action, {
      kind: "ledger-audit-export",
      algorithm: "sm3",
      fromRevision: 1,
      toRevision: 50,
      limit: 10,
      outputDir: "/tmp/out",
    });
  }

  const mutuallyExclusive = parseThinCommand([
    "ledger",
    "audit-export",
    "--date",
    "2026-11-21",
    "--after",
    "2026-11-21T00:00:00Z",
  ]);
  assert.equal(mutuallyExclusive.ok, false);
  if (!mutuallyExclusive.ok) assert.equal(mutuallyExclusive.code, "invalid_field");

  const certParsed = parseThinCommand([
    "task",
    "delivery-certificate",
    "task_abc123",
    "--algorithm",
    "sm3",
    "--output",
    "/tmp/cert.json",
    "--json",
  ]);
  assert.equal(certParsed.ok, true);
  if (certParsed.ok) {
    assert.equal(certParsed.command.method, "repo.task.read");
    assert.deepEqual(certParsed.command.action, {
      kind: "task-delivery-certificate",
      taskId: "task_abc123",
      algorithm: "sm3",
      output: "/tmp/cert.json",
    });
  }
});

test("CLI multi-page streaming audit-export, atomic staging, pinned anchors, mixed-algorithm cert, raw-byte checks, and human errors", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "ha-audit-cli-"));
  const emptyHome = path.join(workDir, "empty-home");
  try {
    const fixture = lifecycleFixture({
      taskId: "task_cli_001",
      executionId: "exec_cli_001",
      reviewId: "rev_cli_001",
    });

    const mockExportDaemon = (
      events: readonly PersistedCanonicalEventV1[],
      algorithm: AuditHashAlgorithm,
      prevRootHash?: string,
      repoId = "repo-cli-test",
    ) => {
      return async (requested: { readonly action: Readonly<Record<string, unknown>> }) => {
        const limit = Number(requested.action.limit ?? 2);
        const cursor = requested.action.cursor === undefined ? 0 : Number(requested.action.cursor);
        const fromRev = requested.action.fromRevision === undefined ? 1 : Number(requested.action.fromRevision);
        const toRev = requested.action.toRevision === undefined ? events.length : Number(requested.action.toRevision);
        const startAfter = Math.max(cursor, fromRev - 1);
        const slice = events
          .filter((e) => e.workspaceRevision > startAfter && e.workspaceRevision <= toRev)
          .slice(0, limit);
        const last = slice.at(-1)?.workspaceRevision ?? startAfter;
        const hasMore = last < toRev && slice.length === limit;
        return {
          ok: true,
          evidence: JSON.stringify({
            schema: "audit-export-page/v1",
            repoId,
            sourceRevision: events.length,
            effectiveToRevision: toRev,
            algorithm,
            prevRootHash: prevRootHash ?? auditGenesisChainHash(algorithm),
            window: { fromRevision: fromRev, toRevision: toRev, utcDate: null, after: null, before: null },
            events: slice,
            count: slice.length,
            scannedCount: slice.length,
            hasMore,
            page: { limit, cursor: cursor === 0 ? null : String(cursor), nextCursor: hasMore ? String(last) : null },
          }),
        };
      };
    };

    // G4-03: Default export WITHOUT --output-dir returns a single bounded page (1 RPC call, never accumulates all pages)
    let defaultCalls = 0;
    const defaultParsed = parseThinCommand(["ledger", "audit-export", "--limit", "2", "--json"]);
    assert.equal(defaultParsed.ok, true);
    if (defaultParsed.ok) {
      const inner = mockExportDaemon(fixture.events, "sha256");
      const defaultRes = await runLedgerAuditExport(defaultParsed.command, async (req) => {
        defaultCalls += 1;
        return inner(req);
      });
      assert.equal(defaultCalls, 1);
      assert.equal(defaultRes.ok, true);
      const payload = JSON.parse(String(defaultRes.evidence)) as { readonly count: number; readonly hasMore: boolean };
      assert.equal(payload.count, 2);
      assert.equal(payload.hasMore, true);
    }

    // Export Slice 1 (revs 1..3) and Slice 2 (revs 4..6) with SM3 & multi-page limit=2
    const slice1Dir = path.join(workDir, "slice-1");
    const slice2Dir = path.join(workDir, "slice-2");
    const concurrentDir = path.join(workDir, "slice-1-concurrent");

    const parsed1 = parseThinCommand([
      "ledger",
      "audit-export",
      "--algorithm",
      "sm3",
      "--from-revision",
      "1",
      "--to-revision",
      "3",
      "--limit",
      "2",
      "--output-dir",
      slice1Dir,
      "--json",
    ]);
    assert.equal(parsed1.ok, true);
    if (!parsed1.ok) return;

    const parsed1Concurrent = parseThinCommand([
      "ledger",
      "audit-export",
      "--algorithm",
      "sm3",
      "--from-revision",
      "1",
      "--to-revision",
      "3",
      "--limit",
      "2",
      "--output-dir",
      concurrentDir,
      "--json",
    ]);
    assert.equal(parsed1Concurrent.ok, true);
    if (!parsed1Concurrent.ok) return;

    const [res1, res1Concurrent] = await Promise.all([
      runLedgerAuditExport(parsed1.command, mockExportDaemon(fixture.events, "sm3")),
      runLedgerAuditExport(parsed1Concurrent.command, mockExportDaemon(fixture.events, "sm3")),
    ]);
    assert.equal(res1.ok, true);
    assert.equal(res1.pagesRead, 2);
    const manifest1 = res1.manifest as AuditExportManifestV1;
    assert.equal(manifest1.rootHash, (res1Concurrent.manifest as AuditExportManifestV1).rootHash);

    // G4-06 & DM-07: Content-addressed entries file + single-switch manifest; failed auth or page 2 preserves prior export with zero .tmp residue!
    const entries1Path = path.join(slice1Dir, manifest1.entriesFile);
    const manifest1Path = path.join(slice1Dir, "audit-manifest.json");
    const originalEntries1 = readFileSync(entries1Path, "utf8");
    const originalManifest1 = readFileSync(manifest1Path, "utf8");

    const authFailRes = await runLedgerAuditExport(parsed1.command, async () => ({
      ok: false,
      code: "actor_unauthorized",
      summary: "forbidden",
    }));
    assert.equal(authFailRes.ok, false);
    assert.equal(readFileSync(entries1Path, "utf8"), originalEntries1);
    assert.equal(readFileSync(manifest1Path, "utf8"), originalManifest1);
    assert.deepEqual(readdirSync(slice1Dir).sort(), [manifest1.entriesFile, "audit-manifest.json"].sort());

    let pageAttempt = 0;
    const baseDaemon = mockExportDaemon(fixture.events, "sm3");
    const midFailRes = await runLedgerAuditExport(parsed1.command, async (req) => {
      pageAttempt += 1;
      if (pageAttempt === 2) return { ok: false, code: "daemon_unavailable", summary: "mid-stream fail" };
      return baseDaemon(req);
    });
    assert.equal(midFailRes.ok, false);
    assert.equal(readFileSync(entries1Path, "utf8"), originalEntries1);
    assert.equal(readFileSync(manifest1Path, "utf8"), originalManifest1);
    assert.deepEqual(readdirSync(slice1Dir).sort(), [manifest1.entriesFile, "audit-manifest.json"].sort());

    const parsed2 = parseThinCommand([
      "ledger",
      "audit-export",
      "--algorithm",
      "sm3",
      "--from-revision",
      "4",
      "--to-revision",
      "6",
      "--limit",
      "2",
      "--prev-root-hash",
      manifest1.rootHash,
      "--output-dir",
      slice2Dir,
      "--json",
    ]);
    assert.equal(parsed2.ok, true);
    if (!parsed2.ok) return;
    const res2 = await runLedgerAuditExport(
      parsed2.command,
      mockExportDaemon(fixture.events, "sm3", manifest1.rootHash),
    );
    assert.equal(res2.ok, true);
    assert.equal(res2.pagesRead, 2);
    const manifest2 = res2.manifest as AuditExportManifestV1;

    // G4-02: Export delivery certificate with SHA-256 while audit slices use SM3!
    const completionEvent = fixture.events.find((e) => e.type === "task_completed");
    assert.ok(completionEvent && completionEvent.type === "task_completed");
    const execution = fixture.snapshot.executions[0]!;
    assert.equal(execution.schema, "execution/v1");
    const cert = buildDeliveryCertificate({
      algorithm: "sha256",
      repoId: "repo-cli-test",
      task: fixture.snapshot.task!,
      execution,
      reviews: fixture.snapshot.reviews,
      reviewConsent: fixture.snapshot.consents?.[0] ?? null,
      completionEvent,
    });
    const certPath = path.join(workDir, "delivery-certificate.json");
    const parsedCert = parseThinCommand([
      "task",
      "delivery-certificate",
      "task_cli_001",
      "--algorithm",
      "sha256",
      "--output",
      certPath,
      "--json",
    ]);
    assert.equal(parsedCert.ok, true);
    if (!parsedCert.ok) return;
    const certRes = await runTaskDeliveryCertificate(parsedCert.command, async () => ({
      ok: true,
      evidence: JSON.stringify({
        schema: "task-delivery-certificate/v1",
        certificate: cert,
        status: "ready",
        watermark: 6,
        sourceRevision: 6,
      }),
    }));
    assert.equal(certRes.ok, true);
    assert.equal(certRes.outputPath, certPath);

    // Real zero-daemon offline CLI subprocess invocation (empty HOME, no daemon, no DB!)
    const runOfflineCli = (args: readonly string[], json = true) => {
      const child = spawnSync(
        process.execPath,
        ["packages/cli/src/index.ts", "ledger", "audit-verify", ...args, ...(json ? ["--json"] : [])],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", HOME: emptyHome },
          timeout: 30_000,
        },
      );
      return {
        status: child.status,
        stdout: child.stdout,
        stderr: child.stderr,
        body: json ? (JSON.parse(child.stdout.trim()) as Record<string, unknown>) : null,
      };
    };

    // G4-01 & G4-02 Positive: verify chained SM3 slice1+slice2 + SHA-256 cert with pinned trust anchors!
    const okRun = runOfflineCli([
      "--manifest",
      manifest1Path,
      "--manifest",
      path.join(slice2Dir, "audit-manifest.json"),
      "--certificate",
      certPath,
      "--algorithm",
      "sm3",
      "--certificate-algorithm",
      "sha256",
      "--expected-root-hash",
      manifest2.rootHash,
      "--expected-certificate-hash",
      cert.certificateHash,
    ]);
    assert.equal(okRun.status, 0, JSON.stringify(okRun.body));
    assert.equal(okRun.body?.ok, true);
    assert.equal(okRun.body?.selfConsistent, true);
    assert.equal(okRun.body?.strictVerified, true);
    assert.equal(okRun.body?.certificateChainCoverage, "complete");
    assert.equal(okRun.body?.sliceCount, 2);
    assert.equal(okRun.body?.totalEvents, 6);
    assert.deepEqual(okRun.body?.trustAnchor, {
      mode: "pinned",
      chainAnchorPinned: true,
      certificateAnchorPinned: true,
      expectedRootHash: manifest2.rootHash,
      expectedCertificateHash: cert.certificateHash,
    });

    // DM-06: Single-artifact pinning (pinning ONLY rootHash when verifying chain+cert) MUST NOT claim pinned or strictVerified!
    const rootOnlyPin = runOfflineCli([
      "--manifest",
      manifest1Path,
      "--manifest",
      path.join(slice2Dir, "audit-manifest.json"),
      "--certificate",
      certPath,
      "--algorithm",
      "sm3",
      "--certificate-algorithm",
      "sha256",
      "--expected-root-hash",
      manifest2.rootHash,
    ]);
    assert.equal(rootOnlyPin.status, 0, JSON.stringify(rootOnlyPin.body));
    assert.equal(rootOnlyPin.body?.selfConsistent, true);
    assert.equal(rootOnlyPin.body?.strictVerified, false);
    assert.equal(rootOnlyPin.body?.verificationStatus, "self_consistent_only");
    assert.equal((rootOnlyPin.body?.trustAnchor as { mode: string }).mode, "partially-pinned");
    assert.equal((rootOnlyPin.body?.trustAnchor as { chainAnchorPinned: boolean }).chainAnchorPinned, true);
    assert.equal(
      (rootOnlyPin.body?.trustAnchor as { certificateAnchorPinned: boolean }).certificateAnchorPinned,
      false,
    );

    // DM-06: Pinning ONLY certificateHash when verifying chain+cert MUST ALSO report partially-pinned and strictVerified=false!
    const certOnlyPin = runOfflineCli([
      "--manifest",
      manifest1Path,
      "--manifest",
      path.join(slice2Dir, "audit-manifest.json"),
      "--certificate",
      certPath,
      "--algorithm",
      "sm3",
      "--certificate-algorithm",
      "sha256",
      "--expected-certificate-hash",
      cert.certificateHash,
    ]);
    assert.equal(certOnlyPin.status, 0, JSON.stringify(certOnlyPin.body));
    assert.equal(certOnlyPin.body?.selfConsistent, true);
    assert.equal(certOnlyPin.body?.strictVerified, false);
    assert.equal((certOnlyPin.body?.trustAnchor as { mode: string }).mode, "partially-pinned");
    assert.equal((certOnlyPin.body?.trustAnchor as { chainAnchorPinned: boolean }).chainAnchorPinned, false);
    assert.equal((certOnlyPin.body?.trustAnchor as { certificateAnchorPinned: boolean }).certificateAnchorPinned, true);

    // DM-06: Partial slice coverage (only rev 6 completion slice, excluding rev 4 review & rev 5 consent) MUST report strictVerified=false even with BOTH pins!
    const completionOnlyDir = path.join(workDir, "completion-only-slice");
    const parsedCompletionOnly = parseThinCommand([
      "ledger",
      "audit-export",
      "--algorithm",
      "sm3",
      "--from-revision",
      "6",
      "--to-revision",
      "6",
      "--output-dir",
      completionOnlyDir,
      "--json",
    ]);
    assert.equal(parsedCompletionOnly.ok, true);
    if (parsedCompletionOnly.ok) {
      const compRes = await runLedgerAuditExport(parsedCompletionOnly.command, mockExportDaemon(fixture.events, "sm3"));
      const compManifest = compRes.manifest as AuditExportManifestV1;
      const partialRun = runOfflineCli([
        "--manifest",
        path.join(completionOnlyDir, "audit-manifest.json"),
        "--certificate",
        certPath,
        "--algorithm",
        "sm3",
        "--certificate-algorithm",
        "sha256",
        "--expected-root-hash",
        compManifest.rootHash,
        "--expected-certificate-hash",
        cert.certificateHash,
      ]);
      assert.equal(partialRun.status, 0, JSON.stringify(partialRun.body));
      assert.equal(partialRun.body?.selfConsistent, true);
      assert.equal(partialRun.body?.strictVerified, false);
      assert.equal(partialRun.body?.certificateChainCoverage, "partial");
      const partialHuman = runOfflineCli(
        [
          "--manifest",
          path.join(completionOnlyDir, "audit-manifest.json"),
          "--certificate",
          certPath,
          "--algorithm",
          "sm3",
          "--certificate-algorithm",
          "sha256",
          "--expected-root-hash",
          compManifest.rootHash,
          "--expected-certificate-hash",
          cert.certificateHash,
        ],
        false,
      );
      assert.equal(partialHuman.status, 0);
      assert.match(partialHuman.stdout, /strictVerified=false/u);
      assert.match(partialHuman.stdout, /coverage=partial/u);
    }

    // G4-01 Negative: pinned --expected-root-hash rejects self-consistent forged replacement slice
    const forgedDir = path.join(workDir, "forged-slice");
    const forgedEvents = fixture.events.map((e, i) =>
      i === 0 && e.type === "task_created"
        ? { ...e, payload: { ...e.payload, task: { ...e.payload.task, title: "Replaced" } } }
        : e,
    );
    const forgedParsed = parseThinCommand([
      "ledger",
      "audit-export",
      "--algorithm",
      "sm3",
      "--from-revision",
      "1",
      "--to-revision",
      "3",
      "--output-dir",
      forgedDir,
      "--json",
    ]);
    assert.equal(forgedParsed.ok, true);
    if (forgedParsed.ok) {
      await runLedgerAuditExport(forgedParsed.command, mockExportDaemon(forgedEvents, "sm3"));
      const forgedReject = runOfflineCli([
        "--manifest",
        path.join(forgedDir, "audit-manifest.json"),
        "--expected-root-hash",
        manifest1.rootHash,
      ]);
      assert.equal(forgedReject.status, 1);
      assert.equal(forgedReject.body?.code, "audit_expected_root_hash_mismatch");
    }

    // G4-04 Negative: equal-length single-byte tamper + non-JSON default human stderr preserves line/field/message!
    const tamperedEntries1 = originalEntries1.replace("task_cli_001", "task_cli_002");
    assert.equal(Buffer.byteLength(tamperedEntries1), Buffer.byteLength(originalEntries1));
    writeFileSync(entries1Path, tamperedEntries1, "utf8");
    const badByte = runOfflineCli(["--manifest", manifest1Path]);
    assert.equal(badByte.status, 1);
    assert.equal(badByte.body?.code, "audit_entry_digest_mismatch");
    assert.equal(badByte.body?.line, 1);

    const humanBadByte = runOfflineCli(["--manifest", manifest1Path], false);
    assert.equal(humanBadByte.status, 1);
    assert.match(humanBadByte.stderr, /audit_entry_digest_mismatch/u);
    assert.match(humanBadByte.stderr, /line=1/u);
    assert.match(humanBadByte.stderr, /field=eventDigest/u);
    writeFileSync(entries1Path, originalEntries1, "utf8");

    // G4-04 Negative: deleting trailing LF byte or replacing LF with CRLF MUST fail!
    writeFileSync(entries1Path, originalEntries1.slice(0, -1), "utf8");
    const badNoLf = runOfflineCli(["--manifest", manifest1Path]);
    assert.equal(badNoLf.status, 1);
    assert.equal(badNoLf.body?.code, "audit_manifest_entries_digest_mismatch");
    assert.equal(badNoLf.body?.line, 3);

    writeFileSync(entries1Path, originalEntries1.replace("\n", "\r\n"), "utf8");
    const badCrlf = runOfflineCli(["--manifest", manifest1Path]);
    assert.equal(badCrlf.status, 1);
    assert.equal(badCrlf.body?.code, "audit_manifest_entries_digest_mismatch");
    assert.equal(badCrlf.body?.line, 1);
    writeFileSync(entries1Path, originalEntries1, "utf8");

    // G4-04 Negative: deleting last line reports expected line=3
    const split1 = originalEntries1.slice(0, -1).split("\n");
    writeFileSync(entries1Path, `${split1[0]}\n${split1[1]}\n`, "utf8");
    const badTail = runOfflineCli(["--manifest", manifest1Path]);
    assert.equal(badTail.status, 1);
    assert.equal(badTail.body?.code, "audit_manifest_count_mismatch");
    assert.equal(badTail.body?.line, 3);
    writeFileSync(entries1Path, originalEntries1, "utf8");

    // G4-05 Negative: cross-repo chained slice rejected
    const otherRepoDir = path.join(workDir, "other-repo-slice");
    const parsedOtherRepo = parseThinCommand([
      "ledger",
      "audit-export",
      "--algorithm",
      "sm3",
      "--from-revision",
      "4",
      "--to-revision",
      "6",
      "--prev-root-hash",
      manifest1.rootHash,
      "--output-dir",
      otherRepoDir,
      "--json",
    ]);
    assert.equal(parsedOtherRepo.ok, true);
    if (parsedOtherRepo.ok) {
      await runLedgerAuditExport(
        parsedOtherRepo.command,
        mockExportDaemon(fixture.events, "sm3", manifest1.rootHash, "repo-different"),
      );
      const crossRepoFail = runOfflineCli([
        "--manifest",
        manifest1Path,
        "--manifest",
        path.join(otherRepoDir, "audit-manifest.json"),
      ]);
      assert.equal(crossRepoFail.status, 1);
      assert.equal(crossRepoFail.body?.code, "audit_slice_sequence_invalid");
      assert.equal(crossRepoFail.body?.field, "repoId");
    }

    // G4-08 Negative & Diagnostic: missing personId blocks strict verify AND --allow-unattributed returns distinct diagnostic status (exit 1, never ok:true)
    const unattrDir = path.join(workDir, "unattr-slice");
    const unattrEvents = fixture.events
      .slice(0, 3)
      .map((e, i) => (i === 1 ? ({ ...e, actor: { principal: { personId: "" }, executor: null } } as typeof e) : e));
    const unattrParsed = parseThinCommand([
      "ledger",
      "audit-export",
      "--algorithm",
      "sha256",
      "--from-revision",
      "1",
      "--to-revision",
      "3",
      "--output-dir",
      unattrDir,
      "--json",
    ]);
    assert.equal(unattrParsed.ok, true);
    if (unattrParsed.ok) {
      const unattrExport = await runLedgerAuditExport(unattrParsed.command, mockExportDaemon(unattrEvents, "sha256"));
      assert.equal(unattrExport.ok, true);
      assert.equal(unattrExport.attributionStatus, "incomplete");
      assert.ok(Array.isArray(unattrExport.warnings) && unattrExport.warnings.length > 0);
      const unattrManifestPath = path.join(unattrDir, "audit-manifest.json");

      const strictFail = runOfflineCli(["--manifest", unattrManifestPath]);
      assert.equal(strictFail.status, 1);
      assert.equal(strictFail.body?.ok, false);
      assert.equal(strictFail.body?.code, "audit_person_attribution_missing");
      assert.equal(strictFail.body?.line, 2);

      const diagRun = runOfflineCli(["--manifest", unattrManifestPath, "--allow-unattributed"]);
      assert.equal(diagRun.status, 1);
      assert.equal(diagRun.body?.ok, false);
      assert.equal(diagRun.body?.diagnostic, true);
      assert.equal(diagRun.body?.verificationStatus, "diagnostic_incomplete_attribution");
      assert.equal(diagRun.body?.strictVerified, false);
      assert.equal(diagRun.body?.chainIntegrityOk, true);
      assert.equal(diagRun.body?.attributionVerified, false);

      const diagHuman = runOfflineCli(["--manifest", unattrManifestPath, "--allow-unattributed"], false);
      assert.equal(diagHuman.status, 1);
      assert.match(diagHuman.stderr, /diagnostic_incomplete_attribution/u);
    }

    // In-process algorithm mismatch branch check
    const receipts: Record<string, unknown>[] = [];
    const code = await runLedgerAuditVerify(
      ["ledger", "audit-verify", "--manifest", manifest1Path, "--algorithm", "sha256", "--json"],
      (receipt) => receipts.push(receipt),
    );
    assert.equal(code, 1);
    assert.equal(receipts[0]?.code, "audit_algorithm_mismatch");

    // Verify standalone SHA-256 export determinism
    const shaAcc = createAuditChainAccumulator({
      repoId: "repo-cli-test",
      algorithm: "sha256",
      window: { fromRevision: 1, toRevision: 3, utcDate: null, after: null, before: null },
    });
    const shaLines = fixture.events
      .slice(0, 3)
      .map((e) => shaAcc.addEvent(e).line)
      .join("");
    const shaManifest = shaAcc.finalize();
    const shaDir = path.join(workDir, "sha-slice");
    const shaEntriesPath = path.join(shaDir, shaManifest.entriesFile);
    const shaManifestPath = path.join(shaDir, "audit-manifest.json");
    const shaParsed = parseThinCommand([
      "ledger",
      "audit-export",
      "--algorithm",
      "sha256",
      "--from-revision",
      "1",
      "--to-revision",
      "3",
      "--output-dir",
      shaDir,
      "--json",
    ]);
    assert.equal(shaParsed.ok, true);
    if (shaParsed.ok) {
      await runLedgerAuditExport(shaParsed.command, mockExportDaemon(fixture.events.slice(0, 3), "sha256"));
      assert.equal(readFileSync(shaEntriesPath, "utf8"), shaLines);
      assert.equal(
        (JSON.parse(readFileSync(shaManifestPath, "utf8")) as AuditExportManifestV1).rootHash,
        shaManifest.rootHash,
      );
      const shaOk = runOfflineCli(["--manifest", shaManifestPath, "--algorithm", "sha256"]);
      assert.equal(shaOk.status, 0);
      assert.equal(shaOk.body?.ok, true);
      assert.equal(shaOk.body?.selfConsistent, true);
      assert.equal(shaOk.body?.strictVerified, false);
      assert.equal((shaOk.body?.trustAnchor as { mode: string }).mode, "self-consistent-only");
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

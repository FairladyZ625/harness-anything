// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("CLI multi-page streaming audit-export, delivery-certificate export, and zero-daemon offline audit-verify", async () => {
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
            repoId: "repo-cli-test",
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

    // Concurrent exports to independent output dirs produce identical deterministic manifests without collision
    const [res1, res1Concurrent] = await Promise.all([
      runLedgerAuditExport(parsed1.command, mockExportDaemon(fixture.events, "sm3")),
      runLedgerAuditExport(parsed1Concurrent.command, mockExportDaemon(fixture.events, "sm3")),
    ]);
    assert.equal(res1.ok, true);
    assert.equal(res1.pagesRead, 2);
    const manifest1 = res1.manifest as AuditExportManifestV1;
    assert.equal(manifest1.rootHash, (res1Concurrent.manifest as AuditExportManifestV1).rootHash);

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

    // Export delivery certificate to file via runTaskDeliveryCertificate
    const completionEvent = fixture.events.find((e) => e.type === "task_completed");
    assert.ok(completionEvent && completionEvent.type === "task_completed");
    const execution = fixture.snapshot.executions[0]!;
    assert.equal(execution.schema, "execution/v1");
    const cert = buildDeliveryCertificate({
      algorithm: "sm3",
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
      "sm3",
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
    const runOfflineCli = (args: readonly string[]) => {
      const child = spawnSync(
        process.execPath,
        ["packages/cli/src/index.ts", "ledger", "audit-verify", ...args, "--json"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", HOME: emptyHome },
          timeout: 30_000,
        },
      );
      return { status: child.status, body: JSON.parse(child.stdout.trim()) as Record<string, unknown> };
    };

    // Positive: verify chained slice1 + slice2 + delivery certificate completely offline!
    const okRun = runOfflineCli([
      "--manifest",
      path.join(slice1Dir, "audit-manifest.json"),
      "--manifest",
      path.join(slice2Dir, "audit-manifest.json"),
      "--certificate",
      certPath,
      "--algorithm",
      "sm3",
    ]);
    assert.equal(okRun.status, 0);
    assert.equal(okRun.body.ok, true);
    assert.equal(okRun.body.sliceCount, 2);
    assert.equal(okRun.body.totalEvents, 6);

    // Negative 1: tamper one byte inside slice1 JSONL
    const entries1Path = path.join(slice1Dir, "audit-events.jsonl");
    const originalEntries1 = readFileSync(entries1Path, "utf8");
    const tamperedEntries1 = originalEntries1.replace("Fixture", "Tamperd");
    writeFileSync(entries1Path, tamperedEntries1, "utf8");
    const badByte = runOfflineCli(["--manifest", path.join(slice1Dir, "audit-manifest.json")]);
    assert.equal(badByte.status, 1);
    assert.equal(badByte.body.ok, false);
    assert.equal(badByte.body.code, "audit_entry_digest_mismatch");
    assert.equal(badByte.body.line, 1);
    writeFileSync(entries1Path, originalEntries1, "utf8");

    // Negative 2: delete middle line in slice1 JSONL
    const split1 = originalEntries1.trimEnd().split("\n");
    writeFileSync(entries1Path, `${split1[0]}\n${split1[2]}\n`, "utf8");
    const badDelete = runOfflineCli(["--manifest", path.join(slice1Dir, "audit-manifest.json")]);
    assert.equal(badDelete.status, 1);
    assert.equal(badDelete.body.code, "audit_chain_prev_hash_mismatch");
    assert.equal(badDelete.body.line, 2);
    writeFileSync(entries1Path, originalEntries1, "utf8");

    // Negative 3: swap two lines in slice1 JSONL
    writeFileSync(entries1Path, `${split1[1]}\n${split1[0]}\n${split1[2]}\n`, "utf8");
    const badSwap = runOfflineCli(["--manifest", path.join(slice1Dir, "audit-manifest.json")]);
    assert.equal(badSwap.status, 1);
    assert.equal(badSwap.body.code, "audit_chain_prev_hash_mismatch");
    assert.equal(badSwap.body.line, 1);
    writeFileSync(entries1Path, originalEntries1, "utf8");

    // Negative 4: tamper manifest rootHash
    const manifest1Path = path.join(slice1Dir, "audit-manifest.json");
    const originalManifest1 = readFileSync(manifest1Path, "utf8");
    const forgedManifest = {
      ...(JSON.parse(originalManifest1) as AuditExportManifestV1),
      rootHash: `sm3:${"e".repeat(64)}`,
    };
    writeFileSync(manifest1Path, JSON.stringify(forgedManifest), "utf8");
    const badRoot = runOfflineCli(["--manifest", manifest1Path]);
    assert.equal(badRoot.status, 1);
    assert.equal(badRoot.body.code, "audit_manifest_root_hash_mismatch");
    writeFileSync(manifest1Path, originalManifest1, "utf8");

    // Negative 5: tamper certificate submissionDigest and reviewConsent
    const originalCert = readFileSync(certPath, "utf8");
    const badSubCert = { ...JSON.parse(originalCert), submissionDigest: `sha256:${"0".repeat(64)}` };
    writeFileSync(certPath, JSON.stringify(badSubCert), "utf8");
    const badSubRun = runOfflineCli(["--certificate", certPath]);
    assert.equal(badSubRun.status, 1);
    assert.equal(badSubRun.body.code, "audit_certificate_submission_digest_mismatch");

    const badConsentCert = {
      ...JSON.parse(originalCert),
      reviewConsent: { ...JSON.parse(originalCert).reviewConsent, reviewDigest: `sha256:${"9".repeat(64)}` },
    };
    writeFileSync(certPath, JSON.stringify(badConsentCert), "utf8");
    const badConsentRun = runOfflineCli(["--certificate", certPath]);
    assert.equal(badConsentRun.status, 1);
    assert.equal(badConsentRun.body.code, "audit_certificate_consent_mismatch");

    // Negative 6: algorithm mismatch (in-process check for fast branch coverage)
    const receipts: Record<string, unknown>[] = [];
    const code = await runLedgerAuditVerify(
      ["ledger", "audit-verify", "--manifest", manifest1Path, "--algorithm", "sha256", "--json"],
      (receipt) => receipts.push(receipt),
    );
    assert.equal(code, 1);
    assert.equal(receipts[0]?.code, "audit_algorithm_mismatch");

    // Confirm createAuditChainAccumulator still supports sha256 standalone verification
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
    const shaEntriesPath = path.join(shaDir, "audit-events.jsonl");
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
      assert.equal(shaOk.body.ok, true);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

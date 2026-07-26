// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectCasGarbage } from "../src/index.ts";
import { writeContentAddressedBlob } from "../../kernel/src/index.ts";

test("CAS garbage collection previews and reclaims only unreferenced verified objects", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cas-gc-"));
  try {
    const harnessRoot = path.join(rootDir, "harness");
    const sessionsRoot = path.join(harnessRoot, "sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(path.join(harnessRoot, "harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n", "utf8");
    const referenced = writeContentAddressedBlob(rootDir, "referenced body", "text/plain");
    const orphan = writeContentAddressedBlob(rootDir, "orphan body", "text/plain");
    writeFileSync(path.join(sessionsRoot, "kept.md"), `${JSON.stringify({
      schema: "session-entity/v1",
      sessionId: "kept",
      lifecycle: "sealed",
      archiveStatus: "complete",
      runtime: "codex",
      source: "runtime",
      detectedAt: "2026-07-26T00:00:00.000Z",
      exportedAt: "2026-07-26T00:01:00.000Z",
      bodyRef: { store: "authored-cas/v1", ...referenced },
      snapshot: {
        capturedAt: "2026-07-26T00:01:00.000Z",
        completeness: "complete",
        captureRange: { messageCount: 1 },
        privacyScan: { scannerVersion: "publish-redaction/v1", passed: true, findings: [] }
      }
    })}\n`, "utf8");

    const preview = collectCasGarbage(rootDir, { apply: false });
    assert.equal(preview.mode, "dry-run");
    assert.deepEqual(preview.orphans.map((entry) => entry.ref), [orphan.ref]);
    assert.deepEqual(preview.referenced.map((entry) => entry.ref), [referenced.ref]);
    assert.equal(preview.reclaimed.length, 0);
    assert.equal(existsSync(path.join(rootDir, orphan.ref)), true);

    const applied = collectCasGarbage(rootDir, { apply: true });
    assert.equal(applied.mode, "apply");
    assert.deepEqual(applied.reclaimed.map((entry) => entry.ref), [orphan.ref]);
    assert.equal(applied.after.orphanCount, 0);
    assert.equal(applied.after.objectCount, 1);
    assert.equal(existsSync(path.join(rootDir, orphan.ref)), false);
    assert.equal(existsSync(path.join(rootDir, referenced.ref)), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CAS garbage collection reports corrupt objects and never reclaims them", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cas-gc-corrupt-"));
  try {
    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(harnessRoot, { recursive: true });
    writeFileSync(path.join(harnessRoot, "harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n", "utf8");
    const object = writeContentAddressedBlob(rootDir, "verified body", "text/plain");
    writeFileSync(path.join(rootDir, object.ref), "changed body", "utf8");

    const report = collectCasGarbage(rootDir, { apply: true });

    assert.deepEqual(report.orphans, []);
    assert.deepEqual(report.reclaimed, []);
    assert.deepEqual(report.invalid.map((entry) => entry.ref), [object.ref]);
    assert.equal(existsSync(path.join(rootDir, object.ref)), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

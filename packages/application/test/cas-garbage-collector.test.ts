// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectCasGarbage } from "../src/index.ts";
import { writeContentAddressedBlobWithDisposition } from "../../kernel/src/index.ts";

test("CAS garbage collection reclaims only never-tracked objects without conservative references", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cas-gc-"));
  try {
    const harnessRoot = path.join(rootDir, "harness");
    const sessionsRoot = path.join(harnessRoot, "sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(path.join(harnessRoot, "harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n", "utf8");
    initGit(harnessRoot);
    const referenced = writeContentAddressedBlobWithDisposition(rootDir, "referenced body", "text/plain");
    const digestReferenced = writeContentAddressedBlobWithDisposition(rootDir, "digest referenced body", "text/plain");
    const tracked = writeContentAddressedBlobWithDisposition(rootDir, "tracked body", "text/plain");
    const historical = writeContentAddressedBlobWithDisposition(rootDir, "historical body", "text/plain");
    const exportOrphan = writeContentAddressedBlobWithDisposition(rootDir, "failed export orphan", "text/plain");
    const syncOrphan = writeContentAddressedBlobWithDisposition(rootDir, "failed sync orphan", "text/plain");
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
    writeFileSync(path.join(sessionsRoot, "digest-only.md"), `${JSON.stringify({ sha256: digestReferenced.sha256 })}\n`, "utf8");
    git(harnessRoot, "add", "harness.yaml", "sessions", ...[tracked, historical].map((entry) => repoRelativeObject(rootDir, entry.ref)));
    git(harnessRoot, "commit", "-m", "seed protected CAS objects");
    git(harnessRoot, "rm", "--cached", "--", repoRelativeObject(rootDir, historical.ref));

    const preview = collectCasGarbage(rootDir, { apply: false });
    assert.equal(preview.mode, "dry-run");
    assert.deepEqual(preview.orphans.map((entry) => entry.ref).sort(), [exportOrphan.ref, syncOrphan.ref].sort());
    assert.deepEqual(preview.referenced.map((entry) => entry.ref).sort(), [
      digestReferenced.ref,
      historical.ref,
      referenced.ref,
      tracked.ref
    ].sort());
    assert.equal(preview.referenced.find((entry) => entry.ref === tracked.ref)?.reason, "git-tracked");
    assert.equal(preview.referenced.find((entry) => entry.ref === historical.ref)?.reason, "git-history");
    assert.equal(preview.referenced.find((entry) => entry.ref === digestReferenced.ref)?.reason, "referenced");
    assert.equal(preview.reclaimed.length, 0);
    assert.equal(existsSync(path.join(rootDir, exportOrphan.ref)), true);
    assert.equal(existsSync(path.join(rootDir, syncOrphan.ref)), true);

    const applied = collectCasGarbage(rootDir, { apply: true });
    assert.equal(applied.mode, "apply");
    assert.deepEqual(applied.reclaimed.map((entry) => entry.ref).sort(), [exportOrphan.ref, syncOrphan.ref].sort());
    assert.equal(applied.after.orphanCount, 0);
    assert.equal(applied.after.objectCount, 4);
    assert.equal(existsSync(path.join(rootDir, exportOrphan.ref)), false);
    assert.equal(existsSync(path.join(rootDir, syncOrphan.ref)), false);
    assert.equal(existsSync(path.join(rootDir, referenced.ref)), true);
    assert.equal(existsSync(path.join(rootDir, digestReferenced.ref)), true);
    assert.equal(existsSync(path.join(rootDir, tracked.ref)), true);
    assert.equal(existsSync(path.join(rootDir, historical.ref)), true);
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
    initGit(harnessRoot);
    const object = writeContentAddressedBlobWithDisposition(rootDir, "verified body", "text/plain");
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

function initGit(harnessRoot: string): void {
  git(harnessRoot, "init", "-q");
  git(harnessRoot, "config", "user.name", "Harness Test");
  git(harnessRoot, "config", "user.email", "harness@example.test");
}

function git(harnessRoot: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", harnessRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

function repoRelativeObject(rootDir: string, ref: string): string {
  return path.relative(path.join(rootDir, "harness"), path.join(rootDir, ref)).split(path.sep).join("/");
}

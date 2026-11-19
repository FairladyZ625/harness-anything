// harness-test-tier: contract
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalLedgerCut } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import {
  importCenterRelocation,
  readCenterRelocated,
  retireCenter,
  verifyRelocationBundle,
} from "../src/center-relocation.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";

test("relocation import verifies every digest, advances oldEpoch by one, and removes a tampered destination", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-center-relocation-")),
    bundle = path.join(root, "bundle"),
    payload = path.join(bundle, "payload"),
    destination = path.join(root, "restored"),
    stateRoot = path.join(root, "fleet"),
    body = Buffer.from("portable relocation payload\n"),
    digest = `sha256:${createHash("sha256").update(body).digest("hex")}`,
    tipHash = canonicalLedgerCut("center-test", null).headDigest,
    ledgerPath = path.join(payload, "ledger.sqlite");
  try {
    mkdirSync(payload, { recursive: true });
    writeFileSync(path.join(payload, "ledger.sqlite-placeholder"), body);
    const database = new DatabaseSync(ledgerPath);
    try {
      database.exec(
        "CREATE TABLE ledger_meta (singleton INTEGER PRIMARY KEY, repo_id TEXT NOT NULL, revision INTEGER NOT NULL); " +
          "CREATE TABLE event (revision INTEGER NOT NULL, op_id TEXT NOT NULL, digest TEXT NOT NULL); " +
          "INSERT INTO ledger_meta VALUES (1, 'center-test', 0);",
      );
    } finally {
      database.close();
    }
    const ledgerDigest = `sha256:${createHash("sha256").update(readFileSync(ledgerPath)).digest("hex")}`;
    writeFileSync(
      path.join(bundle, "manifest.json"),
      `${JSON.stringify({
        schema: "relocation-bundle/v1",
        repoId: "center-test",
        finalRevision: 0,
        tipHash,
        writerEpoch: 7,
        createdAt: "2026-11-19T00:00:00.000Z",
        files: [
          { path: "ledger.sqlite", size: readFileSync(ledgerPath).byteLength, sha256: ledgerDigest },
          { path: "ledger.sqlite-placeholder", size: body.byteLength, sha256: digest },
        ],
      })}\n`,
    );
    const imported = importCenterRelocation({
      bundleDir: bundle,
      destinationRoot: destination,
      stateRoot,
      expectedRepoId: "center-test",
      expectedFinalRevision: 0,
      expectedTipHash: tipHash,
      writerHolderId: "new-center",
    });
    assert.equal(imported.newEpoch, 8);
    assert.deepEqual(readFileSync(path.join(destination, "ledger.sqlite-placeholder")), body);
    const next = openPersistentWriterEpoch({ stateRoot, holderId: "next-center" });
    try {
      assert.equal(next.acquire("center-test").epoch, 9);
    } finally {
      next.close();
    }
    rmSync(destination, { recursive: true, force: true });
    writeFileSync(path.join(payload, "ledger.sqlite-placeholder"), "tampered\n");
    assert.throws(
      () => importCenterRelocation({ bundleDir: bundle, destinationRoot: destination, stateRoot }),
      /digest differs/u,
    );
    assert.equal(readCenterRelocated(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retire writes the irreversible tombstone and writer-epoch seal, and old writers fail closed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-center-retire-"));
  try {
    const tombstone = retireCenter({
      userRoot: root,
      repoId: "center-test",
      oldEpoch: 4,
      finalRevision: 20,
      tipHash: "sha256:tip",
      newExternalUrl: "https://new.example.invalid",
      newLoginUrl: "https://login.example.invalid",
      spkiSha256: "sha256:spki",
    });
    assert.equal(readCenterRelocated(root)?.newEpoch, 5);
    assert.equal(tombstone.newEpoch, 5);
    assert.equal(
      JSON.parse(readFileSync(path.join(root, "fleet", "writer-epochs", "center-test.retired.json"), "utf8"))
        .retiredEpoch,
      4,
    );
    const authority = openPersistentWriterEpoch({ stateRoot: path.join(root, "fleet"), holderId: "old-center" });
    try {
      assert.throws(() => authority.acquire("center-test"), { code: "CENTER_MOVED" });
    } finally {
      authority.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relocation manifest rejects absolute paths before touching a destination", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-center-manifest-"));
  try {
    mkdirSync(path.join(root, "payload"), { recursive: true });
    writeFileSync(
      path.join(root, "manifest.json"),
      JSON.stringify({
        schema: "relocation-bundle/v1",
        repoId: "center-test",
        finalRevision: 0,
        tipHash: "sha256:tip",
        writerEpoch: 1,
        createdAt: "2026-11-19T00:00:00.000Z",
        files: [{ path: path.resolve("escape"), size: 0, sha256: "sha256:" + "0".repeat(64) }],
      }),
    );
    assert.throws(() => verifyRelocationBundle(root), /invalid file entry/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

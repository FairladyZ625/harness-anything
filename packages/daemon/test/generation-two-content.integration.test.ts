// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createLedgerBackup,
  drillLedgerBackup,
  openSqliteEventStore,
  sha256Bytes,
} from "../../kernel/test/store/canonical-generation.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

test("real Entity import survives gen2 CLI conversion, Git recovery and a fresh gen2 backup restore", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gen2-entity-")),
    root = path.join(parent, "source"),
    backupDir = path.join(parent, "backup"),
    destination = path.join(parent, "destination"),
    kind = "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16",
    repoId = workspaceId("gen2-content"),
    binding = withRoleBinding(
      { actor: { principal: { personId: "conversion-fixture" }, executor: null }, source: "local" },
      "repo-write",
    ),
    binary = Buffer.from([0, 255, 128, 13, 10, 0]),
    hash = sha256Bytes(binary);
  let cell: Awaited<ReturnType<typeof openBootstrappedRepoCell>> | undefined;
  try {
    mkdirSync(root);
    initRepo(root);
    mkdirSync(path.join(root, "input", "empty-directory"), { recursive: true });
    writeFileSync(path.join(root, "input", "binary.bin"), binary);
    writeFileSync(path.join(root, "input", "zero.bin"), Buffer.alloc(0));
    cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "conversion-fixture" });
    const imported = await cell.run(
      { kind: "entity-import", entityKind: kind, locator: "input", expectedVersion: 0 },
      binding,
    );
    assert.equal(imported.outcome, "applied", JSON.stringify(imported));
    const evidence = JSON.parse(String(imported.evidence)),
      entityId = evidence.preview.entityId;
    const declaration = await cell.read("repo.vertical.declaration.read", {}, binding),
      kindRow = declaration.declaration.entityKinds.find(
        (row: Record<string, unknown>) => `entity-kind/${String(row.kindId)}` === kind,
      );
    const upgraded = await cell.run(
      {
        kind: "vertical-kind-publish-schema",
        kindId: kind,
        expectedVersion: Number(kindRow.revision),
        attributes: { note: { type: "string" } },
      },
      binding,
    );
    assert.equal(upgraded.outcome, "applied", JSON.stringify(upgraded));
    assert.equal(JSON.parse(String(upgraded.evidence)).kindVersion, 2);
    await cell.close();
    cell = undefined;
    createLedgerBackup({ rootInput: root, backupDir });
    const run = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url)),
        "migrate",
        "ledger",
        "--source",
        backupDir,
        "--mode",
        "convert",
        "--destination",
        destination,
        "--json",
      ],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.verification.matches, true);
    assert.equal(receipt.verification.projection.watermark, receipt.plan.convertedEvents);
    const target = openSqliteEventStore({ rootInput: destination, generation: 2, readOnly: true });
    try {
      assert.deepEqual(Buffer.from(target.readContentObject(hash)!), binary);
      const event = target
        .events()
        .find((event) => event.schema === "entity-event/v1" && event.type === "entity_content_observed");
      assert.ok(event && event.schema === "entity-event/v1" && event.type === "entity_content_observed");
      assert.equal(event.payload.entityId, entityId);
      assert.equal(event.payload.artifactContract.kindVersion, 1);
      assert.equal(event.payload.artifactContract.typeIdentity, kind);
      const contentPath = event.payload.ownedContent.bindings.find((binding) => binding.contentSha256 === hash)!.path;
      assert.deepEqual(readFileSync(path.join(destination, "harness", contentPath)), binary);
      assert.ok(event.payload.ownedContent.directories.length > 0);
    } finally {
      target.close();
    }
    const secondBackup = path.join(parent, "gen2-backup");
    const manifest = createLedgerBackup({ rootInput: destination, backupDir: secondBackup, generation: 2 });
    assert.equal(manifest.sqlite.generation, 2);
    assert.equal(manifest.files.filter((file) => file.method === "vacuum-into").length, 2);
    rmSync(root, { recursive: true });
    rmSync(destination, { recursive: true });
    rmSync(backupDir, { recursive: true });
    const restore = drillLedgerBackup({ backupDir: secondBackup, shadowParent: path.join(parent, "restore") });
    assert.equal(existsSync(root), false);
    const restored = openSqliteEventStore({ rootInput: restore.shadowRoot, generation: 2, readOnly: true });
    try {
      assert.deepEqual(Buffer.from(restored.readContentObject(hash)!), binary);
    } finally {
      restored.close();
    }
  } finally {
    await cell?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

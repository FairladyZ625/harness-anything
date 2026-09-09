// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { docSyncWritePlan, makeTaskEventReader, makeTaskEventStore } from "../../kernel/src/index.ts";
import {
  createLedgerBackup,
  generationTwoActivationPath,
  openSqliteEventStore,
  resolveActiveGeneration,
  sqliteLedgerPath,
  sha256Bytes,
  type DocEventV1,
} from "../../kernel/test/store/canonical-generation.fixtures.ts";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url)),
  repoId = "activation-test";

function run(args: readonly string[]) {
  const result = spawnSync(process.execPath, [cli, ...args, "--json"], { encoding: "utf8" });
  assert.equal(result.signal, null, result.stderr);
  assert.ok(result.stdout.trim(), result.stderr);
  return { status: result.status, receipt: JSON.parse(result.stdout.trim()) as Record<string, any> };
}
const migrate = (args: readonly string[]) => run(["migrate", "ledger", ...args]);

function docEvent(revision: number, hash: string, size: number): DocEventV1 {
  const example = JSON.parse(
    readFileSync(new URL("../../kernel/fixtures/canonical-events/doc-event-v1/accepted.json", import.meta.url), "utf8"),
  ) as DocEventV1;
  return {
    ...example,
    eventId: `event-${revision}`,
    opId: `op-${revision}`,
    workspaceRevision: revision,
    occurredAt: `2026-09-0${revision}T10:00:00.000Z`,
    payload: {
      ...example.payload,
      baseLedgerSha: { repoId, revision: revision - 1, headDigest: `sha256:${"0".repeat(64)}` },
      changes: [
        {
          policyId: "opaque-textual-whole-file/v1",
          path: `context/raw-${revision}.bin`,
          baseBlobSha256: null,
          candidate: { sha256: hash, size, mediaType: "text/plain" },
          regionProofs: [],
        },
      ],
    },
  };
}

function fixture() {
  const parent = mkdtempSync(path.join(os.tmpdir(), "ha-generation-activation-")),
    root = path.join(parent, "source"),
    authored = path.join(root, "harness"),
    backupDir = path.join(parent, "backup"),
    destination = path.join(parent, "destination");
  mkdirSync(authored, { recursive: true });
  execFileSync("git", ["init", "-q", authored]);
  execFileSync("git", ["-C", authored, "config", "user.name", "Activation Test"]);
  execFileSync("git", ["-C", authored, "config", "user.email", "activation@example.invalid"]);
  writeFileSync(path.join(authored, ".gitattributes"), "* -text\n");
  execFileSync("git", ["-C", authored, "add", "."]);
  execFileSync("git", ["-C", authored, "commit", "-qm", "fixture"]);
  const store = openSqliteEventStore({ repoId, rootInput: root, generation: 1 }),
    fence = { repoId, holder: "fixture", epoch: 1 },
    body = Buffer.from("raw original text\r\n"),
    hash = sha256Bytes(body);
  store.claimWriter(fence);
  store.appendCommand({
    fence,
    intent: { opId: "command-original", intentDigest: `sha256:${"a".repeat(64)}`, summary: "original request" },
    events: [docEvent(1, hash, body.length), docEvent(2, hash, body.length)],
    blobs: [{ sha256: hash, size: body.length, mediaType: "text/plain", body }],
  });
  store.close();
  createLedgerBackup({ rootInput: root, backupDir });
  return { parent, root, backupDir, destination, body, hash };
}

test("a destination that fails verification is left without an activation certificate", () => {
  const f = fixture();
  try {
    assert.equal(migrate(["--source", f.backupDir, "--mode", "convert", "--destination", f.destination]).status, 0);
    // The candidate is altered after conversion; activation must refuse it and leave nothing selectable.
    const db = new DatabaseSync(sqliteLedgerPath(f.destination, 2));
    db.prepare("UPDATE event SET recorded_at=? WHERE revision=1").run("2000-01-01T00:00:00.000Z");
    db.close();
    const refused = migrate(["--source", f.backupDir, "--mode", "activate", "--destination", f.destination]);
    assert.equal(refused.status, 1);
    assert.match(refused.receipt.hint, /timestamps differ/u);
    assert.equal(existsSync(generationTwoActivationPath(f.destination)), false);
    assert.equal(resolveActiveGeneration({ rootInput: f.destination }), 1);
    // A repository whose activation was refused still answers as generation 1 to every reader.
    assert.equal(run(["events", "tail", "--root", f.destination]).receipt.events.length, 2);
    console.log("GEN2_REFUSED_ACTIVATION_EVIDENCE=" + JSON.stringify(refused.receipt));
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test("activation reports the real state and writer, reader, offline commands and restarts all select generation 2", () => {
  const f = fixture();
  try {
    assert.equal(migrate(["--source", f.backupDir, "--mode", "convert", "--destination", f.destination]).status, 0);
    const verified = migrate(["--source", f.backupDir, "--mode", "verify", "--destination", f.destination]);
    assert.equal(verified.status, 0);
    assert.equal(verified.receipt.active, false, "verification alone never activates");
    assert.equal(resolveActiveGeneration({ rootInput: f.destination }), 1);

    const activated = migrate(["--source", f.backupDir, "--mode", "activate", "--destination", f.destination]);
    assert.equal(activated.status, 0, JSON.stringify(activated.receipt));
    assert.equal(activated.receipt.active, true, "an activated destination must not report active:false");
    assert.equal(existsSync(generationTwoActivationPath(f.destination)), true);
    assert.equal(resolveActiveGeneration({ rootInput: f.destination }), 2);
    console.log("GEN2_ACTIVATION_EVIDENCE=" + JSON.stringify(activated.receipt));

    const retainedBefore = readFileSync(sqliteLedgerPath(f.destination, 1));
    // An ordinary writer, with no generation option, must accept into the activated generation.
    const event = docEvent(3, f.hash, f.body.length),
      writer = makeTaskEventStore({ repoId, rootDir: f.destination });
    try {
      writer.append({
        event,
        plan: docSyncWritePlan(event),
        blobs: [{ sha256: f.hash, size: f.body.length, mediaType: "text/plain", body: f.body.toString("utf8") }],
      });
    } finally {
      void writer.drain();
    }
    assert.deepEqual(readFileSync(sqliteLedgerPath(f.destination, 1)), retainedBefore, "generation 1 stayed frozen");

    // An ordinary reader in this process follows the same certificate.
    const reader = makeTaskEventReader({ repoId, rootDir: f.destination });
    assert.deepEqual(
      reader.read().events.map((value) => value.opId),
      ["op-1", "op-2", "op-3"],
    );
    // The retained generation stays explicitly auditable and unchanged.
    const audit = makeTaskEventReader({ repoId, rootDir: f.destination, generation: 1 });
    assert.deepEqual(
      audit.read().events.map((value) => value.opId),
      ["op-1", "op-2"],
    );

    // A separate process proves restart selection through the real CLI ingress.
    const tail = run(["events", "tail", "--root", f.destination]);
    assert.deepEqual(
      tail.receipt.events.map((value: { opId: string }) => value.opId),
      ["op-1", "op-2", "op-3"],
    );
    assert.deepEqual(
      run(["events", "tail", "--root", f.destination, "--generation", "1"]).receipt.events.map(
        (value: { opId: string }) => value.opId,
      ),
      ["op-1", "op-2"],
    );
    const backupDir = path.join(f.parent, "post-activation-backup"),
      backup = run(["backup", backupDir, "--root", f.destination]);
    assert.equal(backup.status, 0, JSON.stringify(backup.receipt));
    assert.equal(backup.receipt.manifest.sqlite.generation, 2);
    assert.equal(backup.receipt.manifest.accepted.revision, 3);
    console.log("GEN2_RESTART_EVIDENCE=" + JSON.stringify({ tail: tail.receipt, backup: backup.receipt.manifest }));
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

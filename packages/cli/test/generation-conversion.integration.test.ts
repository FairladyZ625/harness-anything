// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  createLedgerBackup,
  openSqliteEventStore,
  sqliteLedgerPath,
  sqliteContentObjectPath,
  sha256Bytes,
  type DocEventV1,
  type AgentRuntimeEventV1,
} from "../../kernel/test/store/canonical-generation.fixtures.ts";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
function invoke(args: string[]) {
  const result = spawnSync(process.execPath, [cli, "migrate", "ledger", ...args, "--json"], { encoding: "utf8" });
  assert.equal(result.signal, null, result.stderr);
  assert.ok(result.stdout.trim(), result.stderr);
  return { status: result.status, receipt: JSON.parse(result.stdout.trim()) };
}

function fixture() {
  const parent = mkdtempSync(path.join(os.tmpdir(), "ha-generation-converter-")),
    root = path.join(parent, "source"),
    authored = path.join(root, "harness"),
    backupDir = path.join(parent, "backup"),
    destination = path.join(parent, "destination");
  mkdirSync(authored, { recursive: true });
  execFileSync("git", ["init", "-q", authored]);
  execFileSync("git", ["-C", authored, "config", "user.name", "Conversion Test"]);
  execFileSync("git", ["-C", authored, "config", "user.email", "conversion@example.invalid"]);
  writeFileSync(path.join(authored, ".gitattributes"), "* -text\n");
  execFileSync("git", ["-C", authored, "add", "."]);
  execFileSync("git", ["-C", authored, "commit", "-qm", "fixture"]);
  const store = openSqliteEventStore({ repoId: "conversion-test", rootInput: root, generation: 1 }),
    fence = { repoId: "conversion-test", holder: "fixture", epoch: 1 },
    body = Buffer.from("raw original text\r\n"),
    hash = sha256Bytes(body),
    example = JSON.parse(
      readFileSync(
        new URL("../../kernel/fixtures/canonical-events/doc-event-v1/accepted.json", import.meta.url),
        "utf8",
      ),
    ) as DocEventV1;
  const events = [1, 2].map(
    (revision): DocEventV1 => ({
      ...example,
      eventId: `event-${revision}`,
      opId: `op-${revision}`,
      workspaceRevision: revision,
      occurredAt: revision === 1 ? "2026-09-09T10:00:00.000Z" : "2026-09-08T10:00:00.000Z",
      payload: {
        ...example.payload,
        baseLedgerSha: { repoId: "conversion-test", revision: 0, headDigest: `sha256:${"0".repeat(64)}` },
        changes: [
          {
            policyId: "opaque-textual-whole-file/v1",
            path: `context/raw-${revision}.bin`,
            baseBlobSha256: null,
            candidate: { sha256: hash, size: body.length, mediaType: "text/plain" },
            regionProofs: [],
          },
        ],
      },
    }),
  );
  store.claimWriter(fence);
  store.appendCommand({
    fence,
    intent: { opId: "command-original", intentDigest: `sha256:${"a".repeat(64)}`, summary: "original request" },
    events,
    blobs: [{ sha256: hash, size: body.length, mediaType: "text/plain", body }],
  });
  store.appendCommand({
    fence,
    intent: { opId: "command-rejected", intentDigest: `sha256:${"b".repeat(64)}`, summary: "stale request" },
    events: [],
    rejectionCode: "revision_conflict",
  });
  const rows = store.eventRows(),
    outcomes = store.outcomes();
  store.close();
  return { parent, root, backupDir, destination, body, hash, rows, outcomes };
}

test("real offline CLI converts, verifies and restores generation 1 bytes, command outcomes and acceptance times", () => {
  const f = fixture();
  try {
    createLedgerBackup({ rootInput: f.root, backupDir: f.backupDir });
    const before = readFileSync(sqliteLedgerPath(f.root, 1)),
      dry = invoke(["--source", f.backupDir, "--mode", "dry-run"]);
    assert.equal(dry.status, 0, JSON.stringify(dry.receipt));
    assert.equal(dry.receipt.plan.ready, true);
    assert.equal(dry.receipt.plan.sourceEvents, 2);
    assert.equal(existsSync(f.destination), false);
    const converted = invoke(["--source", f.backupDir, "--mode", "convert", "--destination", f.destination]);
    assert.equal(converted.status, 0, JSON.stringify(converted.receipt));
    assert.equal(converted.receipt.active, false);
    console.log("GEN2_CONVERSION_EVIDENCE=" + JSON.stringify(converted.receipt));
    assert.equal(converted.receipt.verification.recordedAtPreserved, true);
    assert.deepEqual(readFileSync(sqliteLedgerPath(f.root, 1)), before);
    // Recovery cannot consult the original database, materialization or its object store.
    rmSync(f.root, { recursive: true });
    const restored = openSqliteEventStore({ rootInput: f.destination, generation: 2, readOnly: true });
    try {
      assert.deepEqual(restored.eventRows(), f.rows);
      assert.deepEqual(restored.outcomes(), f.outcomes);
      assert.deepEqual(Buffer.from(restored.readContentObject(f.hash)!), f.body);
      assert.equal(restored.events().length, 2);
    } finally {
      restored.close();
    }
    assert.equal(invoke(["--source", f.backupDir, "--mode", "verify", "--destination", f.destination]).status, 0);
    assert.equal(invoke(["--source", f.backupDir, "--mode", "convert", "--destination", f.destination]).status, 1);
    const db = new DatabaseSync(sqliteLedgerPath(f.destination, 2));
    db.prepare("UPDATE event SET recorded_at=? WHERE revision=1").run("2000-01-01T00:00:00.000Z");
    db.close();
    const failed = invoke(["--source", f.backupDir, "--mode", "verify", "--destination", f.destination]);
    assert.equal(failed.status, 1);
    assert.match(failed.receipt.hint, /timestamps differ/u);
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

for (const historicalFixture of [
  "entity-event-v1/accepted.json",
  "decision-event-v1/accepted-decision-related-d9b187661997.json",
])
  test(`retains contract-incomplete ${historicalFixture} as a readable source witness`, () => {
    const f = fixture();
    try {
      const db = new DatabaseSync(sqliteLedgerPath(f.root, 1));
      // Original schema/content and relation identity cannot be fabricated from today's files.
      const row = JSON.parse(
        readFileSync(new URL(`../../kernel/fixtures/canonical-events/${historicalFixture}`, import.meta.url), "utf8"),
      );
      row.workspaceRevision = 1;
      row.opId = "op-1";
      const bytes = JSON.stringify(row) + "\n";
      db.prepare("UPDATE event SET event_json=?, digest=?, occurred_at=? WHERE revision=1").run(
        bytes,
        `sha256:${sha256Bytes(Buffer.from(bytes))}`,
        row.occurredAt,
      );
      db.close();
      createLedgerBackup({ rootInput: f.root, backupDir: f.backupDir });
      const result = invoke(["--source", f.backupDir, "--mode", "dry-run"]);
      assert.equal(result.status, 0, JSON.stringify(result.receipt));
      assert.equal(result.receipt.plan.mappings[0].disposition, "retained-read-only");
      assert.equal(result.receipt.plan.mappings.length, 2);
      const converted = invoke(["--source", f.backupDir, "--mode", "convert", "--destination", f.destination]);
      assert.equal(converted.status, 0, JSON.stringify(converted.receipt));
      const witness = openSqliteEventStore({ rootInput: f.destination, generation: 2, readOnly: true });
      try {
        const event = witness.eventAtRevision(1)! as any;
        assert.equal(event.schema, "migration-import-event/v1");
        assert.equal(event.payload.entity.kind, "repo-document");
        const claim = event.payload.entity.documentClaim;
        assert.equal(Buffer.from(witness.readContentObject(claim.sha256)!).toString(), bytes);
      } finally {
        witness.close();
      }
    } finally {
      rmSync(f.parent, { recursive: true, force: true });
    }
  });

test("existing migrated repository documents preserve their own content instead of witness JSON", () => {
  const f = fixture();
  try {
    const event = JSON.parse(
      readFileSync(
        new URL(
          "../../kernel/fixtures/canonical-events/migration-import-event-v1/accepted-entity-migrated-4540393b0119.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    event.workspaceRevision = 1;
    event.opId = "op-1";
    event.payload.entity.documentClaim.sha256 = f.hash;
    event.payload.entity.documentClaim.size = f.body.length;
    delete event.payload.entity.destinationPreimage;
    const raw = JSON.stringify(event) + "\n";
    const db = new DatabaseSync(sqliteLedgerPath(f.root, 1));
    db.prepare("UPDATE event SET event_json=?, digest=?, occurred_at=? WHERE revision=1").run(
      raw,
      `sha256:${sha256Bytes(Buffer.from(raw))}`,
      event.occurredAt,
    );
    db.close();
    createLedgerBackup({ rootInput: f.root, backupDir: f.backupDir });
    const result = invoke(["--source", f.backupDir, "--mode", "convert", "--destination", f.destination]);
    assert.equal(result.status, 0, JSON.stringify(result.receipt));
    assert.equal(result.receipt.plan.mappings[0].disposition, "converted");
    const target = openSqliteEventStore({ rootInput: f.destination, generation: 2, readOnly: true });
    try {
      assert.deepEqual(Buffer.from(target.readContentObject(f.hash)!), f.body);
    } finally {
      target.close();
    }
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test("an accepted content size mismatch is corruption, not a historical witness", () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(sqliteLedgerPath(f.root, 1));
    const event = JSON.parse(f.rows[0]!.eventJson);
    event.payload.changes[0].candidate.size += 1;
    const raw = JSON.stringify(event) + "\n";
    db.prepare("UPDATE event SET event_json=?, digest=? WHERE revision=1").run(
      raw,
      `sha256:${sha256Bytes(Buffer.from(raw))}`,
    );
    db.close();
    createLedgerBackup({ rootInput: f.root, backupDir: f.backupDir });
    const result = invoke(["--source", f.backupDir, "--mode", "convert", "--destination", f.destination]);
    assert.equal(result.status, 1, JSON.stringify(result.receipt));
    assert.match(result.receipt.hint, /corrupt accepted content/);
    assert.equal(existsSync(f.destination), false);
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test("offline conversion preserves draft edits and deletion intent before settling accepted files", () => {
  const f = fixture();
  try {
    const authored = path.join(f.root, "harness");
    mkdirSync(path.join(authored, "context"), { recursive: true });
    writeFileSync(path.join(authored, "context/raw-1.bin"), f.body);
    writeFileSync(path.join(authored, "context/raw-2.bin"), f.body);
    execFileSync("git", ["-C", authored, "add", "."]);
    execFileSync("git", ["-C", authored, "commit", "-qm", "accepted baseline"]);
    const draft = Buffer.from([0, 255, 23, 45]);
    writeFileSync(path.join(authored, "context/raw-1.bin"), draft);
    rmSync(path.join(authored, "context/raw-2.bin"));
    writeFileSync(path.join(authored, "untracked-note.txt"), "keep this draft");
    createLedgerBackup({ rootInput: f.root, backupDir: f.backupDir });
    const result = invoke(["--source", f.backupDir, "--mode", "convert", "--destination", f.destination]);
    assert.equal(result.status, 0, JSON.stringify(result.receipt));
    const destinationAuthored = path.join(f.destination, "harness");
    assert.deepEqual(readFileSync(path.join(destinationAuthored, "context/raw-1.bin")), f.body);
    assert.deepEqual(readFileSync(path.join(destinationAuthored, "context/raw-2.bin")), f.body);
    assert.equal(readFileSync(path.join(destinationAuthored, "untracked-note.txt"), "utf8"), "keep this draft");
    const manifests = path.join(f.destination, ".harness/operations/conversion-drafts");
    const parent = readdirSync(manifests)[0]!;
    const report = JSON.parse(readFileSync(path.join(manifests, parent, "manifest.json"), "utf8"));
    const changed = report.drafts.find((d: any) => d.path === "context/raw-1.bin");
    assert.deepEqual(readFileSync(path.join(destinationAuthored, changed.preservedPath)), draft);
    const removed = report.drafts.find((d: any) => d.path === "context/raw-2.bin");
    assert.equal(removed.preservedPath, null);
    assert.equal(removed.mode, null);
    const migratedBackup = path.join(f.parent, "migrated-backup");
    const manifest = createLedgerBackup({ rootInput: f.destination, backupDir: migratedBackup, generation: 2 });
    assert.ok(manifest.files.some((entry) => entry.path.endsWith("conversion-drafts/" + parent + "/manifest.json")));
    assert.deepEqual(readFileSync(path.join(migratedBackup, "payload/harness", changed.preservedPath)), draft);

    assert.deepEqual(readFileSync(path.join(authored, "context/raw-1.bin")), draft);
    assert.equal(existsSync(path.join(authored, "context/raw-2.bin")), false);
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test("valid historical decision relations retain their document transition instead of becoming witnesses", () => {
  const f = fixture();
  try {
    const event = JSON.parse(
      readFileSync(
        new URL(
          "../../kernel/fixtures/canonical-events/decision-event-v1/accepted-decision-related-d9b187661997.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    event.workspaceRevision = 1;
    event.opId = "op-1";
    event.payload.decisionDocumentClaim.sha256 = f.hash;
    event.payload.decisionDocumentClaim.size = f.body.length;
    const raw = JSON.stringify(event) + "\n";
    const db = new DatabaseSync(sqliteLedgerPath(f.root, 1));
    db.prepare("UPDATE event SET event_json=?, digest=?, occurred_at=? WHERE revision=1").run(
      raw,
      `sha256:${sha256Bytes(Buffer.from(raw))}`,
      event.occurredAt,
    );
    db.close();
    createLedgerBackup({ rootInput: f.root, backupDir: f.backupDir });
    const result = invoke(["--source", f.backupDir, "--mode", "dry-run"]);
    assert.equal(result.status, 0, JSON.stringify(result.receipt));
    assert.equal(result.receipt.plan.mappings[0].disposition, "converted");
    assert.equal(result.receipt.plan.mappings[0].destinationDigest, `sha256:${sha256Bytes(Buffer.from(raw))}`);
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test("source witnesses carry available legacy declaration bytes into generation two", () => {
  const f = fixture();
  try {
    const event = JSON.parse(
      readFileSync(
        new URL("../../kernel/fixtures/canonical-events/entity-event-v1/accepted.json", import.meta.url),
        "utf8",
      ),
    );
    event.workspaceRevision = 1;
    event.opId = "op-1";
    const legacyBody = Buffer.from("legacy declaration bytes unavailable to other events\n");
    const legacyHash = sha256Bytes(legacyBody);
    const legacyPath = sqliteContentObjectPath(f.root, legacyHash, 1);
    mkdirSync(path.dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, legacyBody);
    event.payload.declarationDocumentClaim.sha256 = legacyHash;
    event.payload.declarationDocumentClaim.size = legacyBody.length;
    const raw = JSON.stringify(event) + "\n";
    const db = new DatabaseSync(sqliteLedgerPath(f.root, 1));
    db.prepare("UPDATE event SET event_json=?, digest=?, occurred_at=? WHERE revision=1").run(
      raw,
      `sha256:${sha256Bytes(Buffer.from(raw))}`,
      event.occurredAt,
    );
    db.close();
    createLedgerBackup({ rootInput: f.root, backupDir: f.backupDir });
    const result = invoke(["--source", f.backupDir, "--mode", "convert", "--destination", f.destination]);
    assert.equal(result.status, 0, JSON.stringify(result.receipt));
    rmSync(path.dirname(sqliteLedgerPath(f.destination, 1)), { recursive: true });
    const target = openSqliteEventStore({ rootInput: f.destination, generation: 2, readOnly: true });
    try {
      const witness = target.eventAtRevision(1)! as any;
      assert.ok(witness.payload.entity.referencedContentClaims.some((c: any) => c.sha256 === legacyHash));
      assert.deepEqual(Buffer.from(target.readContentObject(legacyHash)!), legacyBody);
    } finally {
      target.close();
    }
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test("live generation 2 writes cannot backfill recordedAt", () => {
  const f = fixture(),
    store = openSqliteEventStore({ repoId: "conversion-test", rootInput: f.root, generation: 2 });
  try {
    assert.throws(
      () =>
        store.appendCommand({
          fence: { repoId: "conversion-test", holder: "live", epoch: 1 },
          intent: { opId: "request", intentDigest: `sha256:${"c".repeat(64)}`, summary: "live" },
          events: [],
          historicalRecord: { recordedAt: "2000-01-01T00:00:00.000Z", eventRecordedAt: [] },
        }),
      /offline conversion/u,
    );
    assert.equal(store.outcomes().length, 0);
  } finally {
    store.close();
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test("conversion preserves a repeated observation one-to-one so no later revision or cut is renumbered", () => {
  const f = fixture();
  try {
    const store = openSqliteEventStore({ repoId: "conversion-test", rootInput: f.root, generation: 1 }),
      fence = { repoId: "conversion-test", holder: "fixture", epoch: 1 },
      events = [3, 4].map((revision) => ({
        schema: "agent-runtime-event/v1",
        type: "runtime_installation_observed",
        eventId: `install-event-${revision}`,
        opId: `install-${revision}`,
        workspaceRevision: revision,
        actor: { principal: { personId: "conversion-test" }, executor: null },
        source: "local",
        occurredAt: "2026-09-09T10:00:00.000Z",
        payload: {
          installationId: "installation-test",
          kindId: "codex",
          protocolFamily: "codex",
          hostRef: "host:test",
          version: "1",
          discoverySource: "wrapper",
          capabilities: [],
        },
      })) as AgentRuntimeEventV1[];
    store.appendCommand({
      fence,
      intent: {
        opId: "installation-command",
        intentDigest: `sha256:${"d".repeat(64)}`,
        summary: "observe installation",
      },
      events,
    });
    store.close();
    createLedgerBackup({ rootInput: f.root, backupDir: f.backupDir });
    const converted = invoke(["--source", f.backupDir, "--mode", "convert", "--destination", f.destination]);
    assert.equal(converted.status, 0, JSON.stringify(converted.receipt));
    // Root's ruling: the repeated observation really happened, so it is preserved read-only rather
    // than dropped, which would have shifted every later revision and cut reference.
    assert.deepEqual(
      [
        converted.receipt.plan.sourceEvents,
        converted.receipt.plan.convertedEvents,
        converted.receipt.plan.retainedEvents,
        converted.receipt.plan.preservedHistoricalEvents,
      ],
      [4, 4, 0, 1],
    );
    assert.equal(converted.receipt.plan.mappings[3].disposition, "converted");
    assert.match(converted.receipt.plan.mappings[3].reasons[0], /preserved read-only/u);
    assert.deepEqual(
      converted.receipt.plan.mappings.map((mapping: { sourceRevision: number; destinationRevision: number }) => [
        mapping.sourceRevision,
        mapping.destinationRevision,
      ]),
      [
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
      ],
    );
    console.log("GEN2_ACCOUNTING_EVIDENCE=" + JSON.stringify(converted.receipt));
    const retained = openSqliteEventStore({ rootInput: f.destination, generation: 1, readOnly: true }),
      target = openSqliteEventStore({ rootInput: f.destination, generation: 2, readOnly: true });
    try {
      assert.equal(retained.eventRows().length, 4);
      assert.equal(target.eventRows().length, 4);
      assert.deepEqual(target.outcome("installation-command")?.memberOpIds, ["install-3", "install-4"]);
      assert.deepEqual(retained.outcome("installation-command")?.memberOpIds, ["install-3", "install-4"]);
    } finally {
      retained.close();
      target.close();
    }
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test("gen2 reuses the evidence conversion without promoting historical CI measurements to verified passes", () => {
  const f = fixture();
  try {
    const event = JSON.parse(
      readFileSync(
        new URL("../../kernel/fixtures/canonical-events/ci-run-observation-v1/accepted.json", import.meta.url),
        "utf8",
      ),
    );
    event.workspaceRevision = 3;
    event.opId = "historical-ci";
    const bytes = JSON.stringify(event) + "\n",
      digest = `sha256:${sha256Bytes(Buffer.from(bytes))}`,
      db = new DatabaseSync(sqliteLedgerPath(f.root, 1));
    db.prepare("INSERT INTO event(revision,op_id,event_json,digest,occurred_at) VALUES(3,?,?,?,?)").run(
      event.opId,
      bytes,
      digest,
      event.occurredAt,
    );
    db.prepare(
      "INSERT INTO command_outcome(op_id,status,first_revision,last_revision,intent_digest,intent_summary) VALUES(?,'accepted_durable',3,3,?,'historical CI observation')",
    ).run(event.opId, digest);
    db.prepare("UPDATE ledger_meta SET revision=3 WHERE singleton=1").run();
    db.close();
    createLedgerBackup({ rootInput: f.root, backupDir: f.backupDir });
    const converted = invoke(["--source", f.backupDir, "--mode", "convert", "--destination", f.destination]);
    assert.equal(converted.status, 0, JSON.stringify(converted.receipt));
    const mapping = converted.receipt.plan.mappings[2];
    assert.equal(mapping.sourceDigest, digest);
    assert.notEqual(mapping.destinationDigest, digest);
    const target = openSqliteEventStore({ rootInput: f.destination, generation: 2, readOnly: true });
    try {
      const current = target.events()[2]!;
      assert.equal(current.schema, "ci-run-observation/v3");
      assert.equal((current.payload as Record<string, unknown>).verification, null);
      assert.deepEqual((current.payload as { gates: unknown[] }).gates, [
        { gate: "G32", result: "pass", metrics: { files: 42 } },
      ]);
      assert.equal(target.outcome(event.opId)?.intentDigest, digest);
    } finally {
      target.close();
    }
    console.log("GEN2_SCHEMA_EVIDENCE=" + JSON.stringify(converted.receipt));
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

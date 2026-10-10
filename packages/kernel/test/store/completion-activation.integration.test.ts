// harness-test-tier: integration
import { localRuntimeStateFileSystem as files } from "../../src/local/local-layout-file-system.ts";
import { createLedgerBackup } from "../../src/store/ledger-backup.ts";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { completionActivationFixture } from "./completion-activation.fixture.ts";
import {
  runCompletionGenerationConversion,
  type CompletionActivationPoint,
} from "../../src/store/completion-generation-conversion.ts";
import { resolveActiveGeneration, sqliteLedgerPath, openSqliteEventStore } from "../../src/store/sqlite-event-store.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection-factory.ts";
import { completionConversionStream } from "../../src/store/completion-generation-target.ts";

for (const interrupt of ["verified", "source-retired", "derived-invalidated", "published"] as const) {
  test(`generation 2 active execution retirement resumes after ${interrupt}`, () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-completion-activation-"));
    try {
      const f = completionActivationFixture(parent),
        calls: CompletionActivationPoint[] = [];
      const input = {
        ...f,
        invalidateDerivedState: () => {
          calls.push("derived-invalidated");
        },
      };
      runCompletionGenerationConversion({ ...input, mode: "convert" });
      assert.throws(() => resolveActiveGeneration({ rootInput: f.destinationRoot }), /upgrade is incomplete/);
      assert.throws(
        () =>
          runCompletionGenerationConversion({
            ...input,
            mode: "activate",
            checkpoint: (point) => {
              if (point === interrupt) throw new Error(`interrupted-${point}`);
            },
          }),
        new RegExp(`interrupted-${interrupt}`),
      );
      if (interrupt === "published") assert.equal(resolveActiveGeneration({ rootInput: f.destinationRoot }), 3);
      else assert.throws(() => resolveActiveGeneration({ rootInput: f.destinationRoot }), /upgrade is incomplete/);
      assert.equal(existsSync(sqliteLedgerPath(f.destinationRoot, 2)), interrupt === "verified");
      assert.equal(existsSync(`${sqliteLedgerPath(f.destinationRoot, 2)}.activation.json`), true);
      const result = runCompletionGenerationConversion({ ...input, mode: "activate" });
      assert.equal(result.active, true);
      assert.ok(calls.includes("derived-invalidated"));
      const store = openSqliteEventStore({ rootInput: f.destinationRoot, generation: 3, readOnly: true });
      const projection = makeTaskProjection({
        rootDir: f.destinationRoot,
        eventStore: completionConversionStream(store),
      });
      try {
        const first = projection.rebuild(),
          second = projection.rebuild();
        assert.equal(first.stateDigest, second.stateDigest);
        const snapshot = projection.read("task-1").snapshot;
        assert.equal(snapshot.executions[0]?.state, "abandoned");
        assert.equal(snapshot.task?.iteration, 1);
        assert.equal(snapshot.lease, null);
        assert.equal(store.revision(), 3);
        assert.equal(store.outcome("original")?.lastRevision, 2);
        assert.equal(store.outcome("rejected")?.rejectionCode, "revision_conflict");
      } finally {
        projection.close();
        store.close();
      }
      console.log("ACTIVATION_RESUME_EVIDENCE=" + JSON.stringify({ interrupt, active: result.active, calls }));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
}

for (const failure of ["unfinished-retirement", "changed-source"] as const) {
  test(`activation rejects ${failure} without retiring source or publishing a certificate`, () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-completion-rejected-"));
    try {
      const f = completionActivationFixture(parent),
        input = { ...f, invalidateDerivedState: () => {} };
      runCompletionGenerationConversion({ ...input, mode: "convert" });
      if (failure === "unfinished-retirement") {
        const database = new DatabaseSync(sqliteLedgerPath(f.destinationRoot, 3));
        database.exec(
          "DELETE FROM event_query_entity WHERE revision>2; DELETE FROM event WHERE revision>2; DELETE FROM command_outcome WHERE first_revision>2; UPDATE ledger_meta SET revision=2",
        );
        database.close();
        rmSync(path.join(f.destinationRoot, ".harness", "cache"), { recursive: true, force: true });
      }
      assert.throws(
        () =>
          runCompletionGenerationConversion({
            ...input,
            mode: "activate",
            checkpoint: (point) => {
              if (failure !== "changed-source" || point !== "verified") return;
              const source = openSqliteEventStore({ repoId: f.repoId, rootInput: f.destinationRoot, generation: 2 });
              const fence = { repoId: f.repoId, holder: "changed", epoch: 8 };
              try {
                source.claimWriter(fence);
                source.appendCommand({
                  fence,
                  intent: { opId: "changed", intentDigest: `sha256:${"c".repeat(64)}`, summary: "changed source" },
                  events: [{ ...f.events[0]!, workspaceRevision: 3, eventId: "changed", opId: "changed" }],
                });
              } finally {
                source.close();
              }
            },
          }),
        failure === "unfinished-retirement" ? /retirement is incomplete/ : /source head changed/,
      );
      assert.equal(existsSync(sqliteLedgerPath(f.destinationRoot, 2)), true);
      assert.equal(existsSync(`${sqliteLedgerPath(f.destinationRoot, 3)}.activation.json`), false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
}

for (const generation of [1, 2] as const)
  for (const empty of [false, true]) {
    test(`generation ${generation} ${empty ? "empty" : "native execution"} converts directly without losing task projection`, () => {
      const parent = mkdtempSync(path.join(tmpdir(), "ha-source-generations-"));
      try {
        const f = completionActivationFixture(parent, generation, empty),
          input = { ...f, invalidateDerivedState: () => {} };
        runCompletionGenerationConversion({ ...input, mode: "convert" });
        runCompletionGenerationConversion({ ...input, mode: "activate" });
        assert.equal(resolveActiveGeneration({ rootInput: f.destinationRoot }), 3);
        const store = openSqliteEventStore({ rootInput: f.destinationRoot, generation: 3, readOnly: true });
        const projection = makeTaskProjection({
          rootDir: f.destinationRoot,
          eventStore: completionConversionStream(store),
        });
        try {
          projection.rebuild();
          assert.equal(store.revision(), empty ? 0 : 3);
          if (!empty) assert.equal(projection.read("task-1").snapshot.executions[0]?.state, "abandoned");
          assert.equal(store.outcome("rejected")?.rejectionCode, "revision_conflict");
          console.log(
            "SOURCE_GENERATION_EVIDENCE=" + JSON.stringify({ generation, empty, revision: store.revision() }),
          );
        } finally {
          projection.close();
          store.close();
        }
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });
  }

test("offline backup accepts the retired shape but conversion rejects an invalid native execution at its write boundary", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-invalid-old-native-"));
  try {
    const f = completionActivationFixture(parent),
      database = new DatabaseSync(sqliteLedgerPath(f.root, 2));
    const row = database.prepare("SELECT event_json FROM event WHERE revision=2").get()!;
    const event = JSON.parse(String(row.event_json));
    event.payload.execution.state = "invented";
    database.prepare("UPDATE event SET event_json=? WHERE revision=2").run(JSON.stringify(event) + "\n");
    database.close();
    const backupDir = path.join(parent, "invalid-backup");
    createLedgerBackup({ rootInput: f.root, generation: 2, backupDir });
    assert.throws(
      () => runCompletionGenerationConversion({ ...f, backupDir, mode: "convert", invalidateDerivedState: () => {} }),
      /invalid|state/,
    );
    assert.equal(existsSync(`${sqliteLedgerPath(f.destinationRoot, 3)}.activation.json`), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("resuming a complete certificate linked before directory fsync finishes its durability boundary", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-link-before-sync-"));
  const sync = files.syncDirectory;
  try {
    const f = completionActivationFixture(parent),
      input = { ...f, invalidateDerivedState: () => {} };
    runCompletionGenerationConversion({ ...input, mode: "convert" });
    let syncs = 0;
    files.syncDirectory = (directory) => {
      if (directory === path.dirname(sqliteLedgerPath(f.destinationRoot, 3)) && ++syncs === 1)
        throw new Error("linked-before-fsync");
      sync(directory);
    };
    assert.throws(() => runCompletionGenerationConversion({ ...input, mode: "activate" }), /linked-before-fsync/);
    assert.equal(existsSync(`${sqliteLedgerPath(f.destinationRoot, 3)}.activation.json`), true);
    assert.equal(existsSync(sqliteLedgerPath(f.destinationRoot, 2)), false);
    assert.equal(runCompletionGenerationConversion({ ...input, mode: "activate" }).active, true);
    assert.equal(syncs, 2);
  } finally {
    files.syncDirectory = sync;
    rmSync(parent, { recursive: true, force: true });
  }
});

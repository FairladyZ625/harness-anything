import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { makeJournaledWriteCoordinator, stablePayloadHash } from "../../src/store/index.ts";
import { docWrite, withTempStore } from "./helpers.ts";

test("payload hashes are stable across object key order", () => {
  assert.equal(
    stablePayloadHash({ body: "x", path: "a.md" }),
    stablePayloadHash({ path: "a.md", body: "x" })
  );
});

test("journal stores payload hash for audit", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(coordinator.enqueue(docWrite("op-1", "task-1", "a.md", "x")));

    const journal = readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8");
    assert.match(journal, /"payloadHash":"[0-9a-f]{64}"/);
  });
});

test("recovery rejects a tampered payloadRef before applying writes", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(coordinator.enqueue(docWrite("op-1", "task-1", "a.md", "trusted")));

    const journalRecord = JSON.parse(readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8")) as {
      readonly payloadRef: {
        readonly path: string;
      };
    };
    writeFileSync(path.join(rootDir, journalRecord.payloadRef.path), JSON.stringify({
      path: "a.md",
      body: "tampered"
    }), "utf8");

    const recoveredCoordinator = makeJournaledWriteCoordinator({ rootDir });
    assert.throws(
      () => Effect.runSync(recoveredCoordinator.recover),
      /payloadRef sha mismatch|payload hash mismatch/
    );
  });
});

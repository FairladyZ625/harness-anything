import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeRuntimeEventLedgerService } from "../src/index.ts";

test("runtime event ledger appends fsynced JSONL and reads schema-validated records", () => {
  const rootDir = createHarnessRoot();
  try {
    const ledger = makeRuntimeEventLedgerService({
      rootInput: rootDir,
      now: () => "2026-07-03T00:00:00.000Z",
      makeEventId: () => "evt_20260703_000001"
    });

    const appended = Effect.runSync(ledger.append({
      kind: "interrupt",
      session: {
        sessionId: "codex-session-1",
        runtime: "codex",
        taskId: "task_01KWK8Z8V1YF1N0V0H2F6R1AYW"
      },
      interrupt: {
        action: "append",
        reason: "task-level steering"
      },
      result: {
        status: "succeeded",
        summary: "User appended task guidance."
      }
    }));

    assert.equal(appended.path, "generated/runtime-events/codex-session-1.jsonl");
    assert.equal(appended.event.interrupt?.action, "append");
    const ledgerPath = path.join(rootDir, ".harness", appended.path);
    assert.equal(existsSync(ledgerPath), true);
    assert.equal(readFileSync(ledgerPath, "utf8").trim().split("\n").length, 1);

    const readBack = Effect.runSync(ledger.readSession("codex-session-1"));
    assert.equal(readBack.events.length, 1);
    assert.deepEqual(readBack.events[0], appended.event);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime event ledger fails closed on invalid JSONL records", () => {
  const rootDir = createHarnessRoot();
  try {
    const ledger = makeRuntimeEventLedgerService({ rootInput: rootDir });
    const ledgerDir = path.join(rootDir, ".harness/generated/runtime-events");
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(path.join(ledgerDir, "codex-session-1.jsonl"), "{\"schema\":\"runtime-event/v1\",\"eventId\":\"bad\"}\n", "utf8");

    const exit = Effect.runSyncExit(ledger.readSession("codex-session-1"));
    assert.equal(exit._tag, "Failure");
    assert.equal(String(exit.cause).includes("eventId"), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function createHarnessRoot(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-events-"));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n", "utf8");
  return rootDir;
}

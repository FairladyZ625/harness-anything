// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeRuntimeEventLedgerService } from "../src/index.ts";
import { makeOperationalJournaledWriteCoordinator } from "../../kernel/src/index.ts";
import { runEffect, runEffectExit } from "./effect-test-helpers.ts";

test("runtime event ledger appends fsynced JSONL and reads schema-validated records", async () => {
  const rootDir = createHarnessRoot();
  try {
    const ledger = makeRuntimeEventLedgerService({
      rootInput: rootDir,
      coordinator: runtimeEventCoordinator(rootDir),
      now: () => "2026-07-03T00:00:00.000Z",
      makeEventId: () => "evt_20260703_000001"
    });

    const appended = await runEffect(ledger.append({
      kind: "interrupt",
      session: {
        sessionId: "codex-session-1",
        runtime: "codex",
        taskId: "task_01KWK8Z8V1YF1N0V0H2F6R1AYW",
        executionId: "exe_01KX7H00000000000000000001"
      },
      actor: {
        principal: { kind: "person", personId: "person_zeyu" },
        executor: { kind: "agent", id: "codex" }
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
    assert.equal(appended.event.schema, "runtime-event/v2");
    const ledgerPath = path.join(rootDir, ".harness", appended.path);
    assert.equal(existsSync(ledgerPath), true);
    assert.equal(readFileSync(ledgerPath, "utf8").trim().split("\n").length, 1);

    const readBack = await runEffect(ledger.readSession("codex-session-1"));
    assert.equal(readBack.events.length, 1);
    assert.deepEqual(readBack.events[0], appended.event);
    assert.equal(readBack.events[0]?.actor?.principal.personId, "person_zeyu");
    assert.deepEqual(readBack.events[0]?.actor?.executor, { kind: "agent", id: "codex" });
    assert.equal("responsibleHuman" in (readBack.events[0]?.actor ?? {}), false);
    assert.equal(readBack.events[0]?.session.executionId, "exe_01KX7H00000000000000000001");
    assert.equal(readBack.events[0]?.session.reviewId, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime event ledger reads legacy v1 rows without actor", async () => {
  const rootDir = createHarnessRoot();
  try {
    const ledger = makeRuntimeEventLedgerService({ rootInput: rootDir, coordinator: runtimeEventCoordinator(rootDir) });
    const ledgerDir = path.join(rootDir, ".harness/generated/runtime-events");
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(path.join(ledgerDir, "codex-session-1.jsonl"), `${JSON.stringify({
      schema: "runtime-event/v1",
      eventId: "evt_20260703_000001",
      recordedAt: "2026-07-03T00:00:00.000Z",
      kind: "result",
      session: { sessionId: "codex-session-1", runtime: "codex" },
      turn: null,
      step: null,
      tool: null,
      approval: null,
      interrupt: null,
      result: { status: "succeeded" },
      cost: null
    })}\n`, "utf8");

    const readBack = await runEffect(ledger.readSession("codex-session-1"));

    assert.equal(readBack.events.length, 1);
    assert.equal(readBack.events[0]?.actor, undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime event ledger fails closed on invalid JSONL records", async () => {
  const rootDir = createHarnessRoot();
  try {
    const ledger = makeRuntimeEventLedgerService({ rootInput: rootDir, coordinator: runtimeEventCoordinator(rootDir) });
    const ledgerDir = path.join(rootDir, ".harness/generated/runtime-events");
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(path.join(ledgerDir, "codex-session-1.jsonl"), "{\"schema\":\"runtime-event/v1\",\"eventId\":\"bad\"}\n", "utf8");

    const exit = await runEffectExit(ledger.readSession("codex-session-1"));
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
  execFileSync("git", ["init", "-q"], { cwd: rootDir });
  execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: rootDir });
  execFileSync("git", ["config", "user.email", "harness@example.com"], { cwd: rootDir });
  return rootDir;
}

function runtimeEventCoordinator(rootDir: string) {
  return makeOperationalJournaledWriteCoordinator({
    rootDir,
    operationalActor: { scope: "operational", kind: "agent", id: "runtime-event-test" }
  });
}

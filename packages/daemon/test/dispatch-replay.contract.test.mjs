// harness-test-tier: contract
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readObserveTail } from "../src/observe-tail.ts";
import {
  validateObserveTailPayload,
  validateObserveTailResult,
} from "../src/protocol/daemon-protocol-gui-types.ts";

const fixture = new URL("../fixtures/runtime/dispatch-replay-ended.jsonl", import.meta.url);
const dispatchId = "dispatch_96e06fd9ca6917fc922e6d58";

// Sanitized from a real ended Claude stream; private paths, prompts, ids, and verbose output are removed.
test("ended dispatch replay exposes sanitized provider turns and can continue from its live cursor", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-replay-"));
  try {
    const target = dispatchPath(rootDir, dispatchId);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(fixture, "utf8"));
    const latest = await replay(rootDir, { kind: "dispatch", dispatchId, direction: "history" });
    assert.deepEqual(validateObserveTailResult(latest), []);
    assert.equal(latest.schema, "daemon.observe-tail/v3");
    assert.equal(latest.status, "ready");
    assert.equal(latest.items.length, 7);
    assert.deepEqual(
      latest.items.map((record) => record.kind),
      [
        "provider_event",
        "provider_event",
        "provider_event",
        "provider_event",
        "provider_event",
        "provider_event",
        "process_exit",
      ],
    );
    assert.match(JSON.stringify(latest.items), /thinking/u);
    assert.match(JSON.stringify(latest.items), /tool_use/u);
    assert.match(JSON.stringify(latest.items), /tool_result/u);
    assert.match(JSON.stringify(latest.items), /Tests passed/u);

    appendFileSync(
      target,
      `${JSON.stringify({
        kind: "provider_event",
        occurredAt: "2026-08-26T05:02:13.000Z",
        event: {
          type: "assistant",
          message: { id: "message-three", role: "assistant", content: [{ type: "text", text: "Followed." }] },
        },
      })}\n`,
    );
    const followed = await replay(rootDir, {
      kind: "dispatch",
      dispatchId,
      direction: "follow",
      cursor: latest.liveCursor,
    });
    assert.deepEqual(followed.items.map((record) => record.event.message.content[0].text), ["Followed."]);
    assert.equal(followed.done, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("dispatch replay shares newest-first history pagination and reports a missing record as empty", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-pages-"));
  try {
    const pagedId = `dispatch_${"b".repeat(24)}`,
      target = dispatchPath(rootDir, pagedId),
      records = Array.from({ length: 70 }, (_, index) => ({
        kind: "provider_event",
        occurredAt: `2026-08-26T05:03:${String(index).padStart(2, "0")}.000Z`,
        event: {
          type: "assistant",
          message: {
            id: `message-${index + 1}`,
            role: "assistant",
            content: [{ type: "text", text: `record ${index + 1}` }],
          },
        },
      }));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

    const latest = await replay(rootDir, { kind: "dispatch", dispatchId: pagedId, direction: "history" });
    assert.equal(latest.items.length, 64);
    assert.equal(textOf(latest.items[0]), "record 7");
    assert.equal(textOf(latest.items[63]), "record 70");
    assert.equal(latest.done, false);
    const older = await replay(rootDir, {
      kind: "dispatch",
      dispatchId: pagedId,
      direction: "history",
      cursor: latest.historyCursor,
    });
    assert.deepEqual(older.items.map(textOf), Array.from({ length: 6 }, (_, index) => `record ${index + 1}`));
    assert.equal(older.done, true);

    const missing = await replay(rootDir, {
      kind: "dispatch",
      dispatchId: `dispatch_${"c".repeat(24)}`,
      direction: "history",
    });
    assert.equal(missing.status, "ready");
    assert.deepEqual(missing.items, []);
    assert.equal(missing.done, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("dispatch replay input requires a canonical dispatch id", () => {
  assert.deepEqual(validateObserveTailPayload({ kind: "dispatch", direction: "history" }), [
    "observe tail dispatch id is invalid",
  ]);
  assert.deepEqual(
    validateObserveTailPayload({ kind: "events", direction: "history", dispatchId }),
    ["observe tail dispatch id is only valid for dispatch tails"],
  );
});

function replay(rootDir, payload) {
  return readObserveTail({
    repoId: "repo-dispatch-replay",
    rootDir,
    mode: "local",
    projection: null,
    userRoot: path.join(rootDir, "user"),
    daemonId: "fixture-daemon",
    payload,
  });
}

function dispatchPath(rootDir, id) {
  return path.join(rootDir, ".harness", "runtime", "dispatches", `${id}.jsonl`);
}

function textOf(record) {
  return record.event.message.content[0].text;
}

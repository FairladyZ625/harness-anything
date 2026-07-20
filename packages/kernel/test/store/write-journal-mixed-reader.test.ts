// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Text, stablePayloadHash } from "../../src/integrity/stable-hash.ts";
import { readJournal } from "../../src/write-coordination/journal/durable.ts";

test("mixed write-journal/v1 and v2 lines decode with honest legacy normalization", () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "harness-mixed-journal-"));
  try {
    const journalDir = path.join(rootDir, ".harness", "journal");
    const payloadDir = path.join(journalDir, "payloads");
    const journalPath = path.join(journalDir, "writes.jsonl");
    mkdirSync(payloadDir, { recursive: true });

    const v1Payload = { text: "legacy" };
    const v2Payload = { text: "dual-axis" };
    const v1Ref = writePayload(payloadDir, "legacy-op", v1Payload);
    const v2Ref = writePayload(payloadDir, "dual-axis-op", v2Payload);
    writeFileSync(journalPath, [
      JSON.stringify({
        schema: "write-journal/v1",
        opId: "legacy-op",
        entityId: "task/task_legacy",
        kind: "progress_append",
        actor: { kind: "agent", id: "legacy-codex" },
        at: "2026-07-12T00:00:00.000Z",
        payloadRef: v1Ref,
        payload: { payloadHash: stablePayloadHash(v1Payload) }
      }),
      JSON.stringify({
        schema: "write-journal/v2",
        opId: "dual-axis-op",
        entityId: "task/task_dual_axis",
        kind: "progress_append",
        actor: {
          principal: { kind: "person", personId: "person_zeyu" },
          executor: { kind: "agent", id: "codex" }
        },
        principalSource: {
          kind: "local-configured",
          authority: "harness.yaml",
          authoritySha256: "sha256:fixture"
        },
        executorSource: "client-asserted",
        at: "2026-07-12T00:01:00.000Z",
        payloadRef: v2Ref,
        payload: { payloadHash: stablePayloadHash(v2Payload) }
      })
    ].join("\n") + "\n", "utf8");

    const records = readJournal(journalPath, rootDir);
    assert.equal(records.length, 2);
    const legacy = records[0];
    assert.equal(legacy?.schema, "write-journal/v1");
    if (legacy?.schema !== "write-journal/v1") assert.fail("expected normalized v1 record");
    assert.deepEqual(legacy.legacyAttribution, {
      status: "unresolved",
      source: "legacy",
      principal: null,
      executor: { kind: "agent", id: "legacy-codex" },
      actor: { kind: "agent", id: "legacy-codex" }
    });

    const current = records[1];
    assert.equal(current?.schema, "write-journal/v2");
    if (current?.schema !== "write-journal/v2") assert.fail("expected v2 record");
    assert.deepEqual(current.actor, {
      principal: { kind: "person", personId: "person_zeyu" },
      executor: { kind: "agent", id: "codex" }
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function writePayload(payloadDir: string, opId: string, payload: Record<string, unknown>): {
  readonly path: string;
  readonly sha256: string;
} {
  const body = JSON.stringify(payload);
  const fileName = `${encodeURIComponent(opId)}.json`;
  writeFileSync(path.join(payloadDir, fileName), body, "utf8");
  return {
    path: `.harness/journal/payloads/${fileName}`,
    sha256: sha256Text(body)
  };
}

// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { rebuildTaskProjection } from "../../src/index.ts";
import { withTempStore } from "./helpers.ts";

const taskId = "task_01J00000000000000000000000";
const consentId = "cns_01J00000000000000000000000";

test("SQLite consent projection rebuild is deterministic after cache deletion", () => {
  withTempStore((rootDir) => {
    writeConsentProjectionFixture(rootDir);
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const first = readConsentProjectionRows(projectionPath);
    rmSync(projectionPath, { force: true });
    rebuildTaskProjection({ rootDir });
    assert.deepEqual(readConsentProjectionRows(projectionPath), first);
    assert.equal(first[0]?.consent_id, consentId);
    assert.equal(first[0]?.state, "consumed");
    assert.equal(first[0]?.principal_json, JSON.stringify({ personId: "person:reviewer" }));
  });
});

function writeConsentProjectionFixture(rootDir: string): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(path.join(taskRoot, "consents"), { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---", "schema: task-package/v2", `task_id: ${taskId}`, "title: Consent projection fixture",
    "lifecycle:", "  bindingSchema: lifecycle-binding/v1", "  engine: local", "  status: in_review",
    `  ref: ${taskId}`, "  titleSnapshot: Consent projection fixture", "  url: ",
    "  bindingCreatedAt: 2026-07-11T00:00:00.000Z", "  bindingFingerprint: sha256:fixture",
    "vertical: default", "preset: default", "---", "", "# Consent projection fixture", ""
  ].join("\n"));
  writeFileSync(path.join(taskRoot, "consents", `${consentId}.md`), `${JSON.stringify({
    schema: "consent/v1",
    consent_id: consentId,
    task_ref: `task/${taskId}`,
    execution_ref: `execution/${taskId}/exe_01J00000000000000000000000`,
    principal: { personId: "person:reviewer" },
    scope: {
      actions: ["approve_execution", "complete_task"],
      content_pin: { algorithm: "execution-consent-pin/v1", digest: `sha256:${"b".repeat(64)}` }
    },
    disclosure: { completion_claim: "ready", known_gaps: [], residual_risks: [] },
    channel: { kind: "agent-relayed", assurance: "relayed-assertion" },
    response: { kind: "utterance", text: "Approved", session_ref: "session/ses_projection_1" },
    recorded_by: {
      principal: { personId: "person:reviewer" },
      executor: { kind: "agent", id: "agent:test" },
      responsibleHuman: "person:reviewer"
    },
    granted_at: "2026-07-11T01:12:00.000Z",
    expires_at: "2026-07-12T01:12:00.000Z",
    state: "consumed",
    consumed_by: `review/${taskId}/rev_01J00000000000000000000000`,
    consumed_at: "2026-07-11T01:15:00.000Z"
  }, null, 2)}\n`);
}

function readConsentProjectionRows(projectionPath: string): ReadonlyArray<Record<string, unknown>> {
  const db = new DatabaseSync(projectionPath, { readOnly: true });
  try {
    return db.prepare("SELECT * FROM consent_projection ORDER BY consent_id").all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

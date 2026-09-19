// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applyFunnel, collectReckoning, renderReport } from "./reckoning.mjs";

function fixture(events = [], sessions = []) {
  const root = mkdtempSync(join(tmpdir(), "nightly-reckoning-"));
  const databasePath = join(root, "task.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(
    "CREATE TABLE event_index(workspace_revision INTEGER, event_json TEXT); CREATE TABLE runtime_session(runtime_session_id TEXT, value_json TEXT)",
  );
  const eventInsert = database.prepare("INSERT INTO event_index VALUES (?, ?)");
  events.forEach((event, index) => eventInsert.run(index + 1, JSON.stringify(event)));
  const sessionInsert = database.prepare("INSERT INTO runtime_session VALUES (?, ?)");
  sessions.forEach((session) => sessionInsert.run(session.runtimeSessionId, JSON.stringify(session)));
  database.close();
  return { root, databasePath };
}

test("quiet window emits an honest quiet attestation", async () => {
  const input = fixture();
  const signals = await collectReckoning({
    ...input,
    since: Date.parse("2026-09-18T23:30:00Z"),
    until: Date.parse("2026-09-19T23:30:00Z"),
  });
  assert.deepEqual(signals, []);
  assert.match(
    renderReport({ generatedAt: "2026-09-19T23:30:00Z", since: Date.parse("2026-09-18T23:30:00Z"), signals }),
    /Quiet attestation/u,
  );
});

test("failed redispatch is upgraded instead of receiving another patch", async () => {
  const input = fixture(
    [],
    [
      {
        runtimeSessionId: "r1",
        outcome: "failed",
        settledAt: "2026-09-19T10:00:00Z",
        taskBindings: [{ taskId: "task-a" }],
      },
      {
        runtimeSessionId: "r2",
        outcome: "succeeded",
        settledAt: "2026-09-19T11:00:00Z",
        taskBindings: [{ taskId: "task-a" }],
      },
    ],
  );
  const signals = await collectReckoning({
    ...input,
    since: Date.parse("2026-09-18T23:30:00Z"),
    until: Date.parse("2026-09-19T23:30:00Z"),
  });
  assert.equal(signals.find((signal) => signal.kind === "rework")?.recommendation, "architecture-defect");
  assert.equal(signals.find((signal) => signal.kind === "abnormal-session")?.recommendation, "fix-framework");
});

test("recent walls failure is a framework candidate and zombie text is a deletion candidate", async () => {
  const input = fixture();
  const reports = join(input.root, "harness/governance/walls/reports");
  mkdirSync(reports, { recursive: true });
  writeFileSync(
    join(reports, "walls-2026-09-19-10-00.md"),
    "WALLS pass=11 red=1 expected=0 notice=0 info=4 total=16\n",
  );
  writeFileSync(join(input.root, "AGENTS.md"), "This rule is deprecated.\n");
  const signals = await collectReckoning({
    ...input,
    since: Date.parse("2026-09-18T23:30:00Z"),
    until: Date.parse("2026-09-19T23:30:00Z"),
  });
  assert.equal(signals.find((signal) => signal.kind === "sentinel-health")?.recommendation, "fix-framework");
  assert.equal(signals.find((signal) => signal.kind === "zombie-rule")?.recommendation, "remove-rule-candidate");
});

test("missing projection fails instead of reporting a quiet window", async () => {
  await assert.rejects(
    collectReckoning({ root: tmpdir(), databasePath: join(tmpdir(), "missing-task.sqlite"), since: 0 }),
    /no local projection/u,
  );
});

test("fact correction and a decision retired within seven days remain evidence-backed", async () => {
  const input = fixture([
    { type: "decision_accepted", decisionId: "dec-a", occurredAt: "2026-09-18T12:00:00Z" },
    { type: "decision_retired", decisionId: "dec-a", occurredAt: "2026-09-19T12:00:00Z" },
    { type: "fact_superseded", factId: "F-A", occurredAt: "2026-09-19T13:00:00Z" },
  ]);
  const signals = await collectReckoning({
    ...input,
    since: Date.parse("2026-09-18T23:30:00Z"),
    until: Date.parse("2026-09-19T23:30:00Z"),
  });
  assert.equal(signals.find((signal) => signal.kind === "short-lived-decision")?.recommendation, "fix-framework");
  assert.equal(signals.find((signal) => signal.kind === "corrected-fact")?.recommendation, "needs-human-judgment");
});

test("a new-rule candidate requires an explicit expiration", () => {
  const [withoutExpiry, withExpiry] = applyFunnel([
    { kind: "external", key: "external:a", occurrences: 1 },
    { kind: "external", key: "external:b", occurrences: 1, proposedRule: { expiresAt: "2026-12-31T00:00:00Z" } },
  ]);
  assert.equal(withoutExpiry.recommendation, "needs-human-judgment");
  assert.equal(withExpiry.recommendation, "new-rule-candidate");
});

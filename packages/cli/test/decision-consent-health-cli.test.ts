// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI decision reckon counts asserted consent as a source-health weakness", () => {
  withTempRoot((rootDir) => {
    const task = runJson(rootDir, ["task", "create", "--title", "Reckon Consent Health"]);
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_RECKON_CONSENT",
      "--title", "Reckon Consent Health",
      "--question", "Should asserted consent be visible to reckon?",
      "--chosen", "Count asserted consent",
      "--rejected", "Keep asserted consent invisible",
      "--why-not", "Weak consent must enter health reporting",
      "--non-load-bearing",
      "--evidence-relation", `C1:relates:task/${task.taskId}:Task relation satisfies the acceptance floor`
    ]);
    runJson(rootDir, ["--actor", "human:person_test", "decision", "accept", "dec_RECKON_CONSENT"]);
    writeAssertedConsentFixture(rootDir, task.taskId);

    const result = runJson(rootDir, ["decision", "reckon", "dec_RECKON_CONSENT", "--task", task.taskId]);

    assert.equal(result.ok, true);
    assert.deepEqual(result.report.consentSourceHealth, { assertedCount: 1, status: "contains-asserted" });
    const taskPackage = taskPackageFor(rootDir, task.taskId);
    assert.match(
      readFileSync(path.join(rootDir, "harness/tasks", taskPackage, "facts.md"), "utf8"),
      /Consent source weakness: 1 asserted consent record/u
    );
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-consent-health-cli-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], { encoding: "utf8" });
  const parsed = JSON.parse(output) as Record<string, any>;
  assert.equal(parsed.ok, true, output);
  return unwrapCommandReceipt(parsed);
}

function taskPackageFor(rootDir: string, taskId: string): string {
  const taskPackage = readdirSync(path.join(rootDir, "harness/tasks")).find((entry) => entry.startsWith(taskId));
  assert.ok(taskPackage);
  return taskPackage;
}

function writeAssertedConsentFixture(rootDir: string, taskId: string): void {
  const consentPath = path.join(rootDir, "harness/tasks", taskPackageFor(rootDir, taskId), "consents/cns_01J00000000000000000000000.md");
  mkdirSync(path.dirname(consentPath), { recursive: true });
  writeFileSync(consentPath, `${JSON.stringify({
    schema: "consent/v2",
    consent_id: "cns_01J00000000000000000000000",
    task_ref: `task/${taskId}`,
    execution_ref: `execution/${taskId}/exe_01J00000000000000000000000`,
    principal: { personId: "person:reviewer" },
    scope: {
      actions: ["approve_execution", "complete_task"],
      content_pin: { algorithm: "execution-consent-pin/v1", digest: `sha256:${"b".repeat(64)}` }
    },
    disclosure: { completion_claim: "ready", known_gaps: [], residual_risks: [] },
    channel: { kind: "agent-relayed", assurance: "relayed-assertion" },
    response: { kind: "authorization-declaration", source: "asserted" },
    source: { strength: "asserted", rationale: "Approval was received through an external channel." },
    recorded_by: {
      principal: { personId: "person:reviewer" },
      executor: { kind: "agent", id: "agent:test" },
      responsibleHuman: "person:reviewer"
    },
    granted_at: "2026-07-11T01:12:00.000Z",
    expires_at: "2026-07-12T01:12:00.000Z",
    state: "open",
    consumed_by: null,
    consumed_at: null
  }, null, 2)}\n`, "utf8");
}

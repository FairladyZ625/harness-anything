// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readUnionAttributionEvents } from "../../kernel/src/index.ts";
import { ensureTestHarnessIdentity, initializeNestedHarnessRepo } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI decision verify warns on a direct load-bearing worktree change", () => {
  withTempRoot((rootDir) => {
    initializeNestedHarnessRepo(rootDir);
    proposeAndAccept(rootDir, "dec_VERIFY_TAMPER", "Keep pinned content auditable");
    const decisionPath = decisionDocumentPath(rootDir, "dec_VERIFY_TAMPER");
    const pinned = readFileSync(decisionPath, "utf8");
    writeFileSync(decisionPath, pinned.replace("Keep pinned content auditable", "Tamper with pinned content"), "utf8");

    const result = runJson(rootDir, ["decision", "verify", "dec_VERIFY_TAMPER"]);

    assert.equal(result.report.mismatchCount, 1);
    assert.deepEqual(result.report.warnings[0].changedFields, ["chosen"]);
    assert.deepEqual(result.report.warnings[0].gitChanges, [{
      commit: "WORKTREE",
      subject: "uncommitted decision document change",
      changedFields: ["chosen"]
    }]);
  });
});

test("CLI load-bearing decision amend appends a pin and verifies cleanly", () => {
  withTempRoot((rootDir) => {
    proposeAndAccept(rootDir, "dec_VERIFY_AMEND", "Refresh the pin");

    runJson(rootDir, [
      "decision", "amend", "dec_VERIFY_AMEND",
      "--append", "chosen:{\"text\":\"Record the sanctioned amendment\"}"
    ]);
    const result = runJson(rootDir, ["decision", "verify", "dec_VERIFY_AMEND"]);
    const body = readFileSync(decisionDocumentPath(rootDir, "dec_VERIFY_AMEND"), "utf8");

    assert.equal(result.report.matchCount, 1);
    assert.equal(result.report.mismatchCount, 0);
    assert.equal((body.match(/action: "amend"/gu) ?? []).length, 1);
  });
});

test("CLI decision repin uses migration attribution and only repairs a verified stale pin", () => {
  withTempRoot((rootDir) => {
    initializeNestedHarnessRepo(rootDir);
    proposeAndAccept(rootDir, "dec_MIGRATION_REPIN", "Require migration attribution");
    const decisionPath = decisionDocumentPath(rootDir, "dec_MIGRATION_REPIN");
    writeFileSync(decisionPath, readFileSync(decisionPath, "utf8")
      .replace("Require migration attribution", "Record the historical post-pin amendment"), "utf8");
    assert.equal(runJson(rootDir, ["decision", "verify", "dec_MIGRATION_REPIN"]).report.mismatchCount, 1);

    runJson(rootDir, [
      "decision", "repin", "dec_MIGRATION_REPIN",
      "--migration-evidence", "task/task_TEST/amend-after-pin"
    ]);

    assert.equal(runJson(rootDir, ["decision", "verify", "dec_MIGRATION_REPIN"]).report.mismatchCount, 0);
    const event = readUnionAttributionEvents(rootDir).find((entry) => (
      entry.schema === "attribution-event/v1" &&
      entry.entityId === "decision/dec_MIGRATION_REPIN" &&
      entry.kind === "decision_amend"
    ));
    assert.equal(event?.schema, "attribution-event/v1");
    if (event?.schema === "attribution-event/v1") {
      assert.deepEqual(event.principalSource, {
        kind: "migration",
        evidenceRef: "task/task_TEST/amend-after-pin"
      });
    }
  });
});

test("CLI decision conformance reports content pin mismatch as a non-blocking warning", () => {
  withTempRoot((rootDir) => {
    initializeNestedHarnessRepo(rootDir);
    runJson(rootDir, ["init"]);
    writeFile(rootDir, "harness/policies/presets/decision-conformance.policy.json", JSON.stringify({
      schema: "preset-policy/decision-conformance/v1",
      presetId: "decision-conformance",
      rules: {
        adoptionCutoff: "2026-07-07T00:00:00.000Z",
        legacyExemptions: [{ kind: "decided-before-cutoff" }, { kind: "missing-decided-at-with-legacy-id" }],
        enforcement: "fail"
      }
    }));
    proposeAndAccept(rootDir, "dec_CONFORMANCE_PIN_WARNING", "Report the mismatch");
    const decisionPath = decisionDocumentPath(rootDir, "dec_CONFORMANCE_PIN_WARNING");
    const pinned = readFileSync(decisionPath, "utf8");
    writeFileSync(decisionPath, pinned
      .replace(/^decidedAt: .*$/mu, "decidedAt: \"2026-07-06T23:59:59.999Z\"")
      .replace("Report the mismatch", "Tamper with the chosen alternative"), "utf8");

    const result = runJson(rootDir, ["check", "--profile", "source-package"]);
    const report = decisionConformanceReport(result);

    assert.equal(report.findings.length, 0);
    assert.equal(report.summary.contentPinWarningCount, 1);
    assert.deepEqual(report.contentPinWarnings[0].changedFields, ["chosen"]);
    assert.equal(report.contentPinWarnings[0].gitChanges.at(-1).commit, "WORKTREE");
  });
});

function proposeAndAccept(rootDir: string, decisionId: string, chosen: string): void {
  runJson(rootDir, [
    "decision", "propose",
    "--id", decisionId,
    "--title", `${decisionId} content pin`,
    "--question", "Should decision content pins retain tamper evidence?",
    "--chosen", chosen,
    "--rejected", "Trust unverified edits",
    "--why-not", "Direct edits must retain tamper evidence"
  ]);
  runJson(rootDir, [
    "decision", "accept", decisionId,
    "--judgment-only", "The human arbiter accepts this content-pin fixture."
  ]);
}

function decisionConformanceReport(result: Record<string, any>): Record<string, any> {
  const entry = result.report.scriptChecks.find((scriptCheck: Record<string, any>) => (
    scriptCheck.scriptId === "vertical:software-coding:decision-conformance"
  ));
  assert.ok(entry);
  return entry.report;
}

function decisionDocumentPath(rootDir: string, decisionId: string): string {
  return path.join(rootDir, `harness/decisions/decision-${decisionId}/decision.md`);
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-content-pin-cli-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const cliArgs = independentDecisionJudgmentArgs(args);
  const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...cliArgs], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      HARNESS_ACTOR: "agent:test",
      HARNESS_DAEMON_MODE: "fixture",
      HARNESS_DAEMON_USER_ROOT: path.join(rootDir, ".daemon-user")
    }
  });
  const parsed = JSON.parse(output) as Record<string, any>;
  assert.equal(parsed.ok, true, output);
  return unwrapCommandReceipt(parsed);
}

function independentDecisionJudgmentArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  if (args[0] !== "decision" || !["accept", "reject", "defer", "supersede", "retire"].includes(args[1] ?? "")) return args;
  return ["--actor", "human:person_test", ...args];
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}

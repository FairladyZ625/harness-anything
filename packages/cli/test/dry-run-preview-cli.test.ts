// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { commandDescriptors } from "../src/cli/command-registry.ts";
import { commandDryRunPreviewRequiredByKind } from "../src/cli/receipt-contracts.ts";
import { dryRunPreviewContractViolation } from "../src/cli/dry-run-preview.ts";
import type { ParsedCommand } from "../src/cli/types.ts";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("dry-run receipt contract reports a missing preview before receipt rendering", () => {
  const action = decisionProposeAction();
  const violation = dryRunPreviewContractViolation(action, {
    ok: true,
    command: "decision-propose",
    decisionId: "dec_PREVIEW",
    report: { schema: "decision-write-cli-report/v1", dryRun: true }
  });

  assert.match(violation ?? "", /must include preview/u);
  assert.match(violation ?? "", /Next:/u);
});

test("every command declaring --dry-run admits the centrally required preview field", () => {
  const dryRunKinds = commandDescriptors
    .filter((descriptor) => descriptor.options.some((option) => option.flag === "--dry-run"))
    .map((descriptor) => descriptor.kind);

  assert.ok(dryRunKinds.length > 0);
  for (const kind of dryRunKinds) {
    assert.equal(commandDryRunPreviewRequiredByKind[kind], true, kind);
  }
});

test("decision propose dry-run previews both chosen and both rejected entries", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dry-run-preview-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    const stdout = execFileSync(process.execPath, [
      cliEntry,
      "--root", rootDir,
      "--json",
      "decision", "propose",
      "--id", "dec_PREVIEW",
      "--title", "probe",
      "--question", "q?",
      "--chosen", "A1",
      "--chosen", "A2",
      "--rejected", "R1",
      "--rejected", "R2",
      "--why-not", "wn",
      "--dry-run"
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        HARNESS_ACTOR: "agent:test",
        HARNESS_DAEMON_MODE: "fixture",
        HARNESS_GIT_AUTHOR_NAME: "Harness Test",
        HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test"
      }
    });
    const receipt = JSON.parse(stdout) as Record<string, any>;
    const preview = receipt.details.report.preview;

    assert.equal(receipt.ok, true);
    assert.equal(preview.schema, "command-dry-run-preview/v1");
    assert.equal(preview.summary.chosenCount, 2);
    assert.equal(preview.summary.rejectedCount, 2);
    assert.deepEqual(preview.paths, [{
      operation: "create",
      path: "harness/decisions/decision-dec_PREVIEW/decision.md"
    }]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function decisionProposeAction(): Extract<ParsedCommand["action"], { readonly kind: "decision-propose" }> {
  return {
    kind: "decision-propose",
    decisionId: "dec_PREVIEW",
    title: "probe",
    question: "q?",
    chosen: [{ text: "A1" }, { text: "A2" }],
    rejected: [{ text: "R1", why_not: "wn" }, { text: "R2", why_not: "wn" }],
    claims: [],
    claimLoadBearing: true,
    fulfillments: [],
    riskTier: "medium",
    urgency: "medium",
    modules: [],
    productLines: [],
    evidenceRelations: [],
    dryRun: true
  };
}

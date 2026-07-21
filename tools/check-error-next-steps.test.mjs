// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assessErrorHint,
  collectCallerRejections,
  inspectErrorNextSteps,
  maxErrorHintLength
} from "./check-error-next-steps.mjs";

const goodDirectWriteHint = "Direct CLI execution is reserved for operator recovery when the daemon is unavailable or stuck. For the normal single-writer path, remove HARNESS_DAEMON_MODE=direct. To run this command through the recovery escape hatch, use 'HARNESS_DAEMON_MODE=direct HARNESS_DIRECT_WRITE_REASON=recovery ha task create --title Example'.";

test("next-step semantics accept the direct-write sample and reject a dead-end hint", () => {
  assert.deepEqual(assessErrorHint(goodDirectWriteHint), { overload: [], nextStep: [] });
  assert.deepEqual(assessErrorHint("Preset script was not found.").nextStep, [
    "does not provide a concrete command, env var, option, or file action"
  ]);
});

test("hint overload rejects long text and command catalog dumps", () => {
  const dump = `Supported commands: ${Array.from({ length: 6 }, (_, index) => `ha task command-${index} --flag <value>`).join("; ")}`;
  const assessed = assessErrorHint(dump);
  assert.equal(assessed.overload.some((issue) => issue.includes("command signatures")), true);
  assert.equal(assessErrorHint(`Unknown command. Run ha help. ${"x".repeat(maxErrorHintLength)}`).overload.length > 0, true);
});

test("gate enumerates CLI registry and direct daemon caller rejections", () => {
  withFixture((rootDir) => {
    const keys = collectCallerRejections(rootDir).map((entry) => entry.key);
    assert.deepEqual(keys, ["cli:missing_title", "cli:unknown_command", "daemon:provider_unavailable"]);
  });
});

test("known debt warns while a new dead-end rejection hard fails", () => {
  withFixture((rootDir) => {
    const warned = inspectErrorNextSteps(rootDir, ["cli:missing_title"]);
    assert.deepEqual(warned.warnings, [
      "cli:missing_title: does not provide a concrete command, env var, option, or file action"
    ]);
    assert.deepEqual(warned.violations, []);

    const failed = inspectErrorNextSteps(rootDir, []);
    assert.equal(failed.violations.some((finding) => finding.startsWith("cli:missing_title:")), true);
  });
});

test("repaid and removed allowlist entries are rejected as stale", () => {
  withFixture((rootDir) => {
    const repaid = inspectErrorNextSteps(rootDir, ["cli:unknown_command"]);
    assert.equal(repaid.violations.includes("allowlist entry cli:unknown_command is stale because every enumerated hint now teaches a next step"), true);
    const removed = inspectErrorNextSteps(rootDir, ["cli:removed_code"]);
    assert.equal(removed.violations.includes("allowlist entry cli:removed_code is stale because the rejection code is no longer enumerated"), true);
  });
});

test("gate detects a command registry dump built inside cliError", () => {
  withFixture((rootDir) => {
    write(rootDir, "packages/cli/src/bad.ts", `
      const commandRegistry = [{ primary: "ha task list" }];
      cliError(CliErrorCode.UnknownCommand, \`Supported commands: \${commandRegistry.map((entry) => entry.primary).join("; ")}\`);
    `);
    const result = inspectErrorNextSteps(rootDir, ["cli:missing_title"]);
    assert.equal(result.violations.some((finding) => finding.includes("dumping the command registry")), true);
  });
});

test("repository inventory covers the mission rejection families", () => {
  const inventory = collectCallerRejections(process.cwd());
  const keys = new Set(inventory.map((entry) => entry.key));
  for (const key of [
    "cli:command_receipt_contract_mismatch",
    "cli:completion_gate_failed",
    "cli:execution_review_required",
    "cli:preset_script_not_found",
    "daemon:provider_unavailable"
  ]) {
    assert.equal(keys.has(key), true, key);
  }
  const provider = inventory.find((entry) => entry.key === "daemon:provider_unavailable");
  assert.equal(provider?.occurrences.every((entry) => assessErrorHint(entry.hint).nextStep.length === 0), true);
});

function withFixture(fn) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-error-next-step-"));
  try {
    write(rootDir, "packages/cli/src/cli/error-codes.ts", `
      export const CliErrorCode = {
        MissingTitle: "missing_title",
        UnknownCommand: "unknown_command"
      } as const;
      export const cliErrorCodeRegistry = {
        [CliErrorCode.MissingTitle]: { category: "parse", defaultHint: "Task title is required." },
        [CliErrorCode.UnknownCommand]: { category: "parse", defaultHint: "Unknown command. Run ha help to list commands." }
      };
    `);
    write(rootDir, "packages/daemon/src/protocol/identity.ts", `
      function run() {
        return identityFailure("identity-provider/unavailable", "provider_unavailable", "Daemon writes require an identity provider. Run ha init with HARNESS_GIT_AUTHOR_NAME and HARNESS_GIT_AUTHOR_EMAIL set.");
      }
    `);
    fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function write(rootDir, relativePath, body) {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body);
}

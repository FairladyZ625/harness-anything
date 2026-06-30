import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findCliHelpContractViolations } from "./check-cli-help-contract.mjs";

test("CLI help contract gate rejects missing command help metadata", () => {
  withTempRoot((rootDir) => {
    writeRegistry(rootDir, `
      const commandUsages = [
        { kind: "new-task", usage: "new-task --title <title> --json" }
      ] as const;
      const commandSummaries = {} satisfies Record<CommandKind, string>;
      const commandExamples = {} satisfies Record<CommandKind, ReadonlyArray<string>>;
      function optionDescription(flag: string): string {
        const descriptions: Record<string, string> = { "--json": "Emit JSON." };
        return descriptions[flag] ?? "Set this command option.";
      }
    `);

    const violations = findCliHelpContractViolations(rootDir);

    assert.equal(violations.includes("command new-task is missing commandSummaries entry"), true);
    assert.equal(violations.includes("command new-task is missing commandExamples entry"), true);
    assert.equal(violations.includes("option --title is missing help description"), true);
    assert.equal(violations.includes("command help must not use generic summary or option-description fallback text"), true);
  });
});

test("CLI help contract gate accepts complete help metadata", () => {
  withTempRoot((rootDir) => {
    writeRegistry(rootDir, `
      const commandUsages = [
        { kind: "new-task", usage: "new-task --title <title> --json" }
      ] as const;
      const commandSummaries = { "new-task": "Create a task." } satisfies Record<CommandKind, string>;
      const commandExamples = { "new-task": ["harness-anything new-task --title Example"] } satisfies Record<CommandKind, ReadonlyArray<string>>;
      function optionDescription(flag: string): string {
        const descriptions: Record<string, string> = { "--title": "Set the task title.", "--json": "Emit JSON." };
        return descriptions[flag]!;
      }
    `);

    assert.deepEqual(findCliHelpContractViolations(rootDir), []);
  });
});

test("CLI help contract gate rejects examples with undocumented flags", () => {
  withTempRoot((rootDir) => {
    writeRegistry(rootDir, `
      const commandUsages = [
        { kind: "new-task", usage: "new-task --title <title>" }
      ] as const;
      const commandSummaries = { "new-task": "Create a task." } satisfies Record<CommandKind, string>;
      const commandExamples = { "new-task": ["harness-anything new-task --title Example --module billing"] } satisfies Record<CommandKind, ReadonlyArray<string>>;
      function optionDescription(flag: string): string {
        const descriptions: Record<string, string> = { "--title": "Set the task title." };
        return descriptions[flag]!;
      }
    `);

    assert.equal(findCliHelpContractViolations(rootDir).includes("command new-task example uses --module but usage does not list it"), true);
  });
});

function writeRegistry(rootDir, body) {
  const dir = path.join(rootDir, "packages/cli/src/cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "command-registry.ts"), body);
}

function withTempRoot(fn) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-help-gate-"));
  try {
    fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

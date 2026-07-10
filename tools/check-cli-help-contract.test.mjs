import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findCliHelpContractViolations } from "./check-cli-help-contract.mjs";

function writeFixture(specEntrySource) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "cli-help-contract-"));
  mkdirSync(path.join(rootDir, "packages/cli/src/cli/command-spec"), { recursive: true });
  writeFileSync(path.join(rootDir, "packages/cli/src/cli/command-registry.ts"), "const derived = commandSpecs.map((entry) => entry);\n");
  writeFileSync(path.join(rootDir, "packages/cli/src/cli/receipt.ts"), "export const receipt = 1;\n");
  writeFileSync(path.join(rootDir, "packages/cli/src/index.ts"), "export const cli = 1;\n");
  writeFileSync(path.join(rootDir, "packages/cli/src/cli/command-spec/command-spec-fixture.ts"), specEntrySource);
  return rootDir;
}

const validEntry = `export const specs = [
  {
    "kind": "fixture-list",
    "usage": "fixture list [--state <state>] [--json]",
    "options": [{"flag":"--state","description":"Filter fixtures by state."},{"flag":"--json","description":"Emit JSON."}],
    "summary": "List fixtures.",
    "examples": ["harness-anything fixture list --state active --json"],
    "receiptContract": { "data": ["rows"], "paths": [] }
  }
];
`;

test("clean fixture passes with no violations", () => {
  const rootDir = writeFixture(validEntry);
  assert.deepEqual(findCliHelpContractViolations(rootDir, { minimumCommands: 1 }), []);
});

test("usage flag without an options declaration is a violation", () => {
  const rootDir = writeFixture(validEntry.replace(
    `{"flag":"--state","description":"Filter fixtures by state."},`,
    ""
  ));
  const violations = findCliHelpContractViolations(rootDir, { minimumCommands: 1 });
  assert.ok(violations.some((entry) => entry.includes("option --state is missing an options declaration")), violations.join("\n"));
});

test("empty option description is a violation", () => {
  const rootDir = writeFixture(validEntry.replace("Filter fixtures by state.", " "));
  const violations = findCliHelpContractViolations(rootDir, { minimumCommands: 1 });
  assert.ok(violations.some((entry) => entry.includes("option --state has an empty description")), violations.join("\n"));
});

test("missing summary, examples, and receipt contract are violations", () => {
  const stripped = validEntry
    .replace(`"summary": "List fixtures.",`, "")
    .replace(`"examples": ["harness-anything fixture list --state active --json"],`, "")
    .replace(`"receiptContract": { "data": ["rows"], "paths": [] }`, `"other": 1`);
  const rootDir = writeFixture(stripped);
  const violations = findCliHelpContractViolations(rootDir, { minimumCommands: 1 });
  assert.ok(violations.some((entry) => entry.includes("missing summary")), violations.join("\n"));
  assert.ok(violations.some((entry) => entry.includes("missing examples")), violations.join("\n"));
  assert.ok(violations.some((entry) => entry.includes("missing command descriptor receipt contract")), violations.join("\n"));
});

test("example flag not present in usage is a violation", () => {
  const rootDir = writeFixture(validEntry.replace("--state active --json", "--state active --unknown"));
  const violations = findCliHelpContractViolations(rootDir, { minimumCommands: 1 });
  assert.ok(violations.some((entry) => entry.includes("example uses --unknown")), violations.join("\n"));
});

test("duplicate command kinds across spec files are violations", () => {
  const rootDir = writeFixture(validEntry);
  writeFileSync(
    path.join(rootDir, "packages/cli/src/cli/command-spec/command-spec-second.ts"),
    validEntry
  );
  const violations = findCliHelpContractViolations(rootDir, { minimumCommands: 1 });
  assert.ok(violations.some((entry) => entry.includes("declared more than once")), violations.join("\n"));
});

test("generic fallback text in spec sources is a violation", () => {
  const rootDir = writeFixture(validEntry.replace("Emit JSON.", "Set this command option."));
  const violations = findCliHelpContractViolations(rootDir, { minimumCommands: 1 });
  assert.ok(violations.some((entry) => entry.includes("must not use generic summary or option-description fallback text")), violations.join("\n"));
});

test("vacuous parse is rejected instead of passing", () => {
  const rootDir = writeFixture("export const specs = [];\n");
  const violations = findCliHelpContractViolations(rootDir);
  assert.ok(violations.some((entry) => entry.includes("vacuous")), violations.join("\n"));
});

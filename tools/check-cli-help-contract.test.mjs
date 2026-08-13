// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findCliHelpContractViolations } from "./check-cli-help-contract.mjs";

test("thin help contract accepts a derived current command directory", () => withFixture(async ({ rootDir }) => {
  assert.deepEqual(await findCliHelpContractViolations(rootDir, { minimumCommands: 1 }), []);
}));

test("thin help contract derives route flags from command paths", () => withFixture(async ({ rootDir, commandPath }) => {
  writeFileSync(commandPath, commandSource("ha doc sync --dry-run", "Preview documents.", ["doc", "sync", "--dry-run"]));
  assert.deepEqual(await findCliHelpContractViolations(rootDir, { minimumCommands: 1 }), []);
  writeFileSync(commandPath, commandSource("ha doc sync --dry-run", "Preview documents.", ["doc", "sync"]));
  assert.match((await findCliHelpContractViolations(rootDir, { minimumCommands: 1 })).join("\n"), /documents unsupported option --dry-run/u);
}));

test("thin help contract rejects options missing from structured inputs", () => withFixture(async ({ rootDir, commandPath }) => {
  writeFileSync(commandPath, commandSource("ha task show <id> --ghost", "Show a task."));
  assert.match((await findCliHelpContractViolations(rootDir, { minimumCommands: 1 })).join("\n"), /documents unsupported option --ghost/u);
}));

test("thin help contract rejects vacuous and duplicate directories", () => withFixture(async ({ rootDir, commandPath }) => {
  writeFileSync(commandPath, commandModule([{ path: ["daemon", "status"], usage: "ha daemon status", summary: "Status.", inputs: [] }, { path: ["daemon", "status"], usage: "ha daemon status", summary: "Again.", inputs: [] }]));
  const violations = await findCliHelpContractViolations(rootDir, { minimumCommands: 3 });
  assert.match(violations.join("\n"), /vacuous/u); assert.match(violations.join("\n"), /duplicate CLI usage/u);
}));

test("thin help contract rejects entrypoints that do not render the directory", () => withFixture(async ({ rootDir, entryPath }) => {
  writeFileSync(entryPath, "export function main() { return 0; }\n");
  assert.match((await findCliHelpContractViolations(rootDir, { minimumCommands: 1 })).join("\n"), /empty argv and --help/u);
}));

async function withFixture(run) { const rootDir = mkdtempSync(path.join(tmpdir(), "thin-help-"));
  try { const commandPath = write(rootDir, "packages/daemon/src/protocol/daemon-protocol.contract.ts", commandSource("ha task show <id>", "Show a task.")); write(rootDir, "packages/cli/src/cli/thin-command.ts", "export function renderThinHelp() { return [...thinCliCommands.map(() => '')]; }\n"); const entryPath = write(rootDir, "packages/cli/src/index.ts", `if (argv.length === 0 || argv.includes("--help")) renderThinHelp();\n`); await run({ rootDir, commandPath, entryPath });
  } finally { rmSync(rootDir, { recursive: true, force: true }); } }
function commandSource(usage, summary, commandPath = ["task", "show"], inputs = []) { return commandModule([{ path: commandPath, usage, summary, inputs }]); }
function commandModule(commands) { return `export const daemonProtocolCommands = Object.freeze(${JSON.stringify(commands)});\nexport const thinCliCommands = daemonProtocolCommands.map(({usage, summary}) => ({usage, summary}));\n`; }
function write(rootDir, relative, body) { const file = path.join(rootDir, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); return file; }

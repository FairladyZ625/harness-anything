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

test("thin help contract requires every structured JSON packet to list its required fields", () => withFixture(async ({ rootDir, commandPath }) => {
  const input = { name: "--from-file", kind: "single", required: true, jsonFields: ["alpha", "beta"], error: { code: "invalid_field", nextAction: "Use --from-file <packet.json>." } };
  writeFileSync(commandPath, commandSource("ha task submit <task-id> --from-file <from-file>", "Submit.", ["task", "submit", "<task-id>"], [input], "    --from-file — required; JSON required fields: alpha"));
  const violations = await findCliHelpContractViolations(rootDir, { minimumCommands: 1 });
  assert.match(violations.join("\n"), /\[json-fields\].*beta/u);
}));

test("thin help contract requires enum values to be projected into help", () => withFixture(async ({ rootDir, commandPath }) => {
  const input = { name: "--mode", kind: "single", required: false, enum: ["alpha", "beta"], error: { code: "invalid_field", nextAction: "Use --mode." } };
  writeFileSync(commandPath, commandSource("ha demo inspect --mode <mode>", "Inspect.", ["demo", "inspect"], [input], "    --mode — optional; values: alpha"));
  assert.match((await findCliHelpContractViolations(rootDir, { minimumCommands: 1 })).join("\n"), /\[enum-values\].*beta/u);
}));

test("thin help contract requires bounded constraints and units to be visible", () => withFixture(async ({ rootDir, commandPath }) => {
  const input = { name: "--rationale", kind: "single", required: true, minLength: 1, maxLength: 199, lengthUnit: "characters", error: { code: "invalid_field", nextAction: "Provide a rationale." } };
  writeFileSync(commandPath, commandSource("ha decision accept <id> --rationale <rationale>", "Accept.", ["decision", "accept", "<id>"], [input], "    --rationale — required"));
  assert.match((await findCliHelpContractViolations(rootDir, { minimumCommands: 1 })).join("\n"), /\[constraints\].*bounded length/u);
}));

test("thin help contract requires parameter relations to be visible", () => withFixture(async ({ rootDir, commandPath }) => {
  const input = { name: "--judgment-only", kind: "single", required: false, requires: ["--rationale"], requiresAny: ["claim-to-evidence relation", "--judgment-only"], conflictsWith: ["--evidence"], error: { code: "invalid_field", nextAction: "Use --judgment-only with rationale." } };
  writeFileSync(commandPath, commandSource("ha decision accept <id> --judgment-only <judgment-only>", "Accept.", ["decision", "accept", "<id>"], [input], "    --judgment-only — optional"));
  assert.match((await findCliHelpContractViolations(rootDir, { minimumCommands: 1 })).join("\n"), /\[parameter-relations\].*--rationale/u);
}));

test("thin help contract requires structured string formats to be visible", () => withFixture(async ({ rootDir, commandPath }) => {
  const input = { name: "--evidence", kind: "repeated", required: false, format: "<type>:<path>:<summary>", error: { code: "invalid_field", nextAction: "Use the evidence format." } };
  writeFileSync(commandPath, commandSource("ha task progress --evidence <evidence>...", "Append.", ["task", "progress"], [input], "    --evidence — repeatable"));
  assert.match((await findCliHelpContractViolations(rootDir, { minimumCommands: 1 })).join("\n"), /\[structured-format\].*<type>:<path>:<summary>/u);
}));

test("thin help contract rejects negative hints without an executable next step", () => withFixture(async ({ rootDir, commandPath }) => {
  const input = { name: "--proposal", kind: "single", required: false, error: { code: "invalid_field", nextAction: "This operation is not permitted." } };
  writeFileSync(commandPath, commandSource("ha decision accept <id> --proposal <proposal>", "Accept.", ["decision", "accept", "<id>"], [input], "    --proposal — optional; This operation is not permitted."));
  assert.match((await findCliHelpContractViolations(rootDir, { minimumCommands: 1 })).join("\n"), /\[actionable-hint\]/u);
}));

test("thin help contract accepts a complete projection of input constraints", () => withFixture(async ({ rootDir, commandPath }) => {
  const input = { name: "--judgment-only", kind: "single", required: true, enum: ["reviewed"], minLength: 1, maxLength: 199, lengthUnit: "characters", format: "<rationale>", requires: ["--rationale"], requiresAny: ["claim-to-evidence relation", "--judgment-only"], conflictsWith: ["--evidence"], error: { code: "invalid_field", nextAction: "Use --judgment-only <rationale>." } };
  const help = "    --judgment-only — required; values: reviewed; length: 1..199 characters; format: <rationale>; requires: --rationale; requires one of: claim-to-evidence relation, --judgment-only; mutually exclusive with: --evidence; next: Use --judgment-only <rationale>.";
  writeFileSync(commandPath, commandSource("ha decision accept <id> --judgment-only <reviewed>", "Accept.", ["decision", "accept", "<id>"], [input], help));
  assert.deepEqual(await findCliHelpContractViolations(rootDir, { minimumCommands: 1 }), []);
}));

async function withFixture(run) { const rootDir = mkdtempSync(path.join(tmpdir(), "thin-help-"));
  try { const commandPath = write(rootDir, "packages/daemon/src/protocol/daemon-protocol.contract.ts", commandSource("ha task show <id>", "Show a task.")); write(rootDir, "packages/cli/src/cli/thin-command.ts", "export function renderThinHelp() { return [...thinCliCommands.map(({ usage, summary, help }) => `  ${usage}\\n    ${summary}${help ? `\\n${help}` : \"\"}`)]; }\n"); const entryPath = write(rootDir, "packages/cli/src/index.ts", `if (argv.length === 0 || argv.includes("--help")) renderThinHelp();\n`); await run({ rootDir, commandPath, entryPath });
  } finally { rmSync(rootDir, { recursive: true, force: true }); } }
function commandSource(usage, summary, commandPath = ["task", "show"], inputs = [], help) { return commandModule([{ path: commandPath, usage, summary, inputs, ...(help === undefined ? {} : { help }) }]); }
function commandModule(commands) { const projected = commands.map((command) => ({ ...command, help: command.help ?? command.inputs.map((input) => `    ${input.name} — ${input.required ? "required" : "optional"}; ${input.enum ? `values: ${input.enum.join(", ")}; ` : ""}${input.error?.nextAction ?? ""}`).join("\\n") })); return `export const daemonProtocolCommands = Object.freeze(${JSON.stringify(projected)});\nexport const thinCliCommands = daemonProtocolCommands.map(({usage, summary, help}) => ({usage, summary, help}));\n`; }
function write(rootDir, relative, body) { const file = path.join(rootDir, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); return file; }

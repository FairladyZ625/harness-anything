import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = path.resolve(import.meta.dirname, "check-cli-structure.mjs");

test("CLI structure check catches multiline generic function declarations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-structure-"));
  writeFixtureTree(root);

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shared\.ts:1: function genericMonolith has 12[1-9] lines; max 120/u);
});

test("CLI structure check rejects duplicate CLI utility helpers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-structure-utilities-"));
  writeFixtureTree(root);
  writeFile(root, "packages/cli/src/commands/migration.ts", [
    "function readOption(argv, name) {",
    "  const index = argv.indexOf(name);",
    "  return index >= 0 ? argv[index + 1] : undefined;",
    "}",
    ""
  ].join("\n"));

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /migration\.ts:1: duplicate readOption implementation; import from packages\/cli\/src\/cli\/parse-options\.ts/u);
});

test("CLI structure check rejects descriptors without direct parse and run references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-structure-descriptor-functions-"));
  writeFixtureTree(root);
  writeFile(root, "packages/cli/src/cli/command-spec/command-spec-core.ts", [
    "const parseHelp = () => null;",
    "export const coreCommandSpecs = defineCommandSpecs([{ kind: 'help', parse: parseHelp }]);",
    ""
  ].join("\n"));

  const result = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /descriptor help must carry direct parse and run function references/u);
});

test("CLI structure check rejects duplicate descriptors for one ParsedCommand kind", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-structure-descriptor-duplicate-"));
  writeFixtureTree(root);
  writeFile(root, "packages/cli/src/cli/command-spec/command-spec-core.ts", [
    "const parseHelp = () => null;",
    "const runHelp = () => null;",
    "export const coreCommandSpecs = defineCommandSpecs([",
    "  { kind: 'help', parse: parseHelp, run: runHelp },",
    "  { kind: 'help', parse: parseHelp, run: runHelp }",
    "]);",
    ""
  ].join("\n"));

  const result = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ParsedCommand kind help must have exactly one registered descriptor; found 2/u);
});

function writeFixtureTree(root) {
  const files = [
    "packages/cli/src/cli/parse-args.ts",
    "packages/cli/src/cli/parser-registry.ts",
    "packages/cli/src/cli/runner-registry.ts",
    "packages/cli/src/cli/parsers/core.ts",
    "packages/cli/src/commands/extensions/index.ts",
    "packages/cli/src/commands/extensions/module.ts",
    "packages/cli/src/commands/extensions/preset.ts",
    "packages/cli/src/commands/extensions/template.ts",
    "packages/cli/src/commands/extensions/vertical.ts"
  ];
  for (const file of files) {
    writeFile(root, file, "export function ok(): void {}\n");
  }
  writeFile(root, "packages/cli/src/cli/types.ts", [
    "export interface ParsedCommand {",
    "  readonly action: { readonly kind: 'help' };",
    "}",
    ""
  ].join("\n"));
  writeFile(root, "packages/cli/src/cli/command-spec/command-spec-core.ts", [
    "const parseHelp = () => null;",
    "const runHelp = () => null;",
    "export const coreCommandSpecs = defineCommandSpecs([{ kind: 'help', parse: parseHelp, run: runHelp }]);",
    ""
  ].join("\n"));
  writeFile(root, "packages/cli/src/cli/command-spec/index.ts", [
    "import { coreCommandSpecs } from './command-spec-core.ts';",
    "export const commandSpecs = [...coreCommandSpecs];",
    "export function commandSpecMap(select) { return Object.fromEntries(commandSpecs.map((spec) => [spec.kind, select(spec)])); }",
    ""
  ].join("\n"));
  writeFile(root, "packages/cli/src/cli/command-registry.ts", [
    "import { commandSpecs } from './command-spec/index.ts';",
    "export const commandDescriptors = commandSpecs;",
    ""
  ].join("\n"));
  writeFile(root, "packages/cli/src/cli/parser-registry.ts", [
    "import { commandSpecs } from './command-spec/index.ts';",
    "export const parserRegistry = commandSpecs.map((spec) => spec.parse);",
    ""
  ].join("\n"));
  writeFile(root, "packages/cli/src/cli/runner-registry.ts", [
    "import { commandSpecMap } from './command-spec/index.ts';",
    "export const runnerRegistry = commandSpecMap((spec) => spec.run);",
    "export function runRegisteredCommand(command) { return runnerRegistry[command.action.kind]; }",
    ""
  ].join("\n"));
  writeFile(root, "packages/cli/src/index.ts", [
    "import { runRegisteredCommand } from './cli/runner-registry.ts';",
    "void runRegisteredCommand;",
    ""
  ].join("\n"));
  writeFile(root, "packages/cli/src/commands/extensions/shared.ts", genericLongFunction());
}

function writeFile(root, relativePath, body) {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, body, "utf8");
}

function genericLongFunction() {
  const lines = [
    "export function genericMonolith<A, I>(",
    "  value: A,",
    "  input: I",
    "): { readonly value: A; readonly input: I } {",
    "  const pair = { value, input };"
  ];
  for (let index = 0; index < 118; index += 1) {
    lines.push(`  void ${index};`);
  }
  lines.push("  return pair;");
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

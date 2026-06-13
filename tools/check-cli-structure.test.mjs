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

function writeFixtureTree(root) {
  const files = [
    "packages/cli/src/cli/parse-args.ts",
    "packages/cli/src/cli/parser-registry.ts",
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

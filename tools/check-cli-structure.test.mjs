// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = path.resolve(import.meta.dirname, "check-cli-structure.mjs");

test("thin CLI structure accepts only parser transport and render on the dist static graph", async () => {
  const root = await fixture();
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CLI structure check passed/u);
});

test("thin CLI structure rejects a kernel public barrel reachable from the dist entry", async () => {
  const root = await fixture();
  write(root, "packages/daemon/src/client/local-daemon-target.ts", [
    "import { readDaemonRegistry } from '../../../kernel/src/index.ts';",
    "export const resolveLocalDaemonTarget = readDaemonRegistry;",
    ""
  ].join("\n"));
  write(root, "packages/kernel/src/index.ts", "export const readDaemonRegistry = () => ({});\n");

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dist static import graph.*kernel public barrel.*packages\/kernel\/src\/index\.ts/u);
});

test("thin CLI structure rejects modules outside the entry parser transport render whitelist", async () => {
  const root = await fixture();
  write(root, "packages/cli/src/index.ts", [
    "import { parseThinCommand } from './cli/thin-command.ts';",
    "import { runCommandThroughDaemon } from './daemon/client.ts';",
    "import { legacy } from './commands/legacy.ts';",
    "function emit(): void {}",
    "void parseThinCommand; void runCommandThroughDaemon; void emit; void legacy;",
    ""
  ].join("\n"));
  write(root, "packages/cli/src/commands/legacy.ts", "export const legacy = true;\n");

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dist static import graph reached module is outside entry\/parser\/transport\/render whitelist.*legacy\.ts/u);
});

test("thin CLI structure retains CLI function complexity limits", async () => {
  const root = await fixture();
  write(root, "packages/cli/src/cli/thin-command.ts", genericLongFunction());

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /thin-command\.ts:1: function genericMonolith has 12[1-9] lines; max 120/u);
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-thin-cli-structure-"));
  write(root, "packages/cli/package.json", JSON.stringify({
    bin: { "harness-anything": "dist/cli/src/index.js", ha: "dist/cli/src/index.js" }
  }));
  write(root, "packages/cli/src/index.ts", [
    "import { parseThinCommand } from './cli/thin-command.ts';",
    "import { runCommandThroughDaemon } from './daemon/client.ts';",
    "function emit(): void {}",
    "if (process.argv.includes('daemon')) void import('./daemon/control.ts');",
    "void parseThinCommand; void runCommandThroughDaemon; void emit;",
    ""
  ].join("\n"));
  write(root, "packages/cli/src/cli/thin-command.ts", "export function parseThinCommand(): void {}\n");
  write(root, "packages/cli/src/daemon/client.ts", [
    "import { resolveLocalDaemonTarget } from '../../../daemon/src/client/local-daemon-target.ts';",
    "export function runCommandThroughDaemon(): void { void resolveLocalDaemonTarget; }",
    ""
  ].join("\n"));
  write(root, "packages/cli/src/daemon/control.ts", "export function runDaemonControl(): void {}\n");
  write(root, "packages/daemon/src/client/local-daemon-target.ts", [
    "import path from 'node:path';",
    "export function resolveLocalDaemonTarget(): void { void path; }",
    ""
  ].join("\n"));
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });
}

function write(root, relativePath, body) {
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
  for (let index = 0; index < 118; index += 1) lines.push(`  void ${index};`);
  lines.push("  return pair;", "}");
  return `${lines.join("\n")}\n`;
}

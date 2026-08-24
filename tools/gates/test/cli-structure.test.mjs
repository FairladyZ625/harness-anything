// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = path.resolve(import.meta.dirname, "../../check-cli-structure.mjs");

test("thin CLI structure accepts the bounded production surface on the dist static graph", async () => {
  const root = await fixture();
  write(root, "packages/cli/src/index.ts", entrySource([
    "import { taskRead } from './commands/task-read.ts';",
    "void taskRead;"
  ]));
  write(root, "packages/cli/src/commands/task-read.ts", "export const taskRead = true;\n");
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
  assert.ok(result.stderr.includes("dist static import graph reached kernel public barrel: packages/kernel/src/index.ts"));
});

test("thin CLI structure rejects a kernel runtime import from any CLI production module", async () => {
  const root = await fixture();
  write(root, "packages/cli/src/index.ts", entrySource([
    "import { taskRead } from './commands/task-read.ts';",
    "void taskRead;"
  ]));
  write(root, "packages/cli/src/commands/task-read.ts", [
    "import { readTask } from '../../../kernel/src/index.ts';",
    "export const taskRead = readTask;",
    ""
  ].join("\n"));
  write(root, "packages/kernel/src/index.ts", "export const readTask = () => ({});\n");

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(
    "dist static import graph reached kernel public barrel: packages/kernel/src/index.ts"
  ));
});

test("thin CLI structure retains CLI function complexity limits", async () => {
  const root = await fixture();
  write(root, "packages/cli/src/cli/thin-command.ts", genericLongFunction());

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /thin-command\.ts:1: function genericMonolith has 12[1-9] lines; max 120/u);
});

test("thin CLI permits only the zero-dependency preset command contract", async () => {
  const root = await fixture();
  write(root, "packages/preset/src/preset-command-contract.ts", [
    "import { runtime } from './preset.contract.ts';",
    "export const presetCommands = runtime;",
    ""
  ].join("\n"));
  write(root, "packages/preset/src/preset.contract.ts", "export const runtime = [];\n");
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /module is outside the thin CLI cross-package graph boundary.*preset\.contract\.ts/u);
});

test("daemon transport graph accepts the line client's thin leaf imports", async () => {
  const root = await fixture();
  write(root, "packages/daemon/src/client/local-json-rpc-client.ts", [
    "import net from 'node:net';",
    "import { currentDaemonProtocolVersion } from '../protocol/version.ts';",
    "export function transport(): void { void net; void currentDaemonProtocolVersion; }",
    ""
  ].join("\n"));
  write(root, "packages/daemon/src/protocol/version.ts", "export const currentDaemonProtocolVersion = 1;\n");
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CLI structure check passed/u);
});

test("daemon transport graph rejects a kernel barrel reachable from the line client", async () => {
  const root = await fixture();
  write(root, "packages/daemon/src/client/local-json-rpc-client.ts", [
    "import { consumeKnownError } from '../../../kernel/src/index.ts';",
    "export function transport(): void { void consumeKnownError; }",
    ""
  ].join("\n"));
  write(root, "packages/kernel/src/index.ts", "export function consumeKnownError(): void {}\n");
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("daemon transport import graph reached kernel public barrel: packages/kernel/src/index.ts"));
});

test("daemon transport graph rejects even a kernel leaf import reachable from the line client", async () => {
  const root = await fixture();
  write(root, "packages/daemon/src/client/local-json-rpc-client.ts", [
    "import { consumeKnownError } from '../../../kernel/src/error-consumption.ts';",
    "export function transport(): void { void consumeKnownError; }",
    ""
  ].join("\n"));
  write(root, "packages/kernel/src/error-consumption.ts", "export function consumeKnownError(): void {}\n");
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("daemon transport import graph reached module is outside the daemon transport allowlist: packages/kernel/src/error-consumption.ts"));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-thin-cli-structure-"));
  write(root, "packages/cli/package.json", JSON.stringify({
    bin: { "harness-anything": "dist/cli/src/index.js", ha: "dist/cli/src/index.js" }
  }));
  write(root, "packages/cli/src/index.ts", entrySource());
  write(root, "packages/cli/src/cli/thin-command.ts", [
    "import { resolveThinCliCommand } from '../../../daemon/src/protocol/daemon-protocol.contract.ts';",
    "export function parseThinCommand(): void { void resolveThinCliCommand; }",
    ""
  ].join("\n"));
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
  write(root, "packages/daemon/src/protocol/daemon-protocol.contract.ts", [
    "import { presetCommands } from '../../../preset/src/preset-command-contract.ts';",
    "export function resolveThinCliCommand(): void { void presetCommands; }",
    ""
  ].join("\n"));
  write(root, "packages/preset/src/preset-command-contract.ts", "export const presetCommands = [];\n");
  return root;
}

function entrySource(additions = []) {
  return [
    "import { parseThinCommand } from './cli/thin-command.ts';",
    "import { runCommandThroughDaemon } from './daemon/client.ts';",
    ...additions.filter((line) => line.startsWith("import ")),
    "function emit(): void {}",
    "if (process.argv.includes('daemon')) void import('./daemon/control.ts');",
    "void parseThinCommand; void runCommandThroughDaemon; void emit;",
    ...additions.filter((line) => !line.startsWith("import ")),
    ""
  ].join("\n");
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

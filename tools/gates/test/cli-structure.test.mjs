// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = path.resolve(import.meta.dirname, "../../check-cli-structure.mjs");
test("thin CLI structure accepts the bounded production surface on the dist static graph", async () => {
  const root = await fixture();
  write(
    root,
    "packages/cli/src/index.ts",
    entrySource(["import { taskRead } from './commands/task-read.ts';", "void taskRead;"]),
  );
  write(root, "packages/cli/src/commands/task-read.ts", "export const taskRead = true;\n");
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CLI structure check passed/u);
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: CLI reads the declared Policy data leaf;
// the exception must not admit its transitive runtime dependencies or the kernel barrel.
test("thin CLI structure accepts the declared CLI Policy data leaf", async () => {
  const root = await cliPolicyFixture();
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CLI structure check passed/u);
});

for (const dependency of ["index.ts", "domain/other-policy.ts"]) {
  test(`thin CLI structure rejects CLI Policy runtime dependency ${dependency}`, async () => {
    const root = await cliPolicyFixture();
    write(
      root,
      "packages/kernel/src/domain/cli-operational-policy.ts",
      `export { cliOperationalPolicy } from '${dependency === "index.ts" ? "../index.ts" : "./other-policy.ts"}';\n`,
    );
    write(root, `packages/kernel/src/${dependency}`, "export const cliOperationalPolicy = {};\n");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`: packages/kernel/src/${dependency}`), result.stderr);
  });
}

test("daemon transport still rejects the CLI Policy leaf", async () => {
  const root = await cliPolicyFixture();
  write(
    root,
    "packages/daemon/src/client/local-json-rpc-client.ts",
    "export { cliOperationalPolicy } from '@harness-anything/kernel/internal/domain/cli-operational-policy';\n",
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /daemon transport import graph reached module is outside the daemon transport allowlist: packages\/kernel\/src\/domain\/cli-operational-policy\.ts/u,
  );
});

test("thin CLI structure rejects a kernel public barrel reachable from the dist entry", async () => {
  const root = await fixture();
  write(
    root,
    "packages/daemon/src/client/local-daemon-target.ts",
    [
      "import { readDaemonRegistry } from '@harness-anything/kernel';",
      "export const resolveLocalDaemonTarget = readDaemonRegistry;",
      "",
    ].join("\n"),
  );
  write(root, "packages/kernel/src/index.ts", "export const readDaemonRegistry = () => ({});\n");

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes("dist static import graph reached kernel public barrel: packages/kernel/src/index.ts"),
  );
});

test("thin CLI structure rejects a kernel runtime import from any CLI production module", async () => {
  const root = await fixture();
  write(
    root,
    "packages/cli/src/index.ts",
    entrySource(["import { taskRead } from './commands/task-read.ts';", "void taskRead;"]),
  );
  write(
    root,
    "packages/cli/src/commands/task-read.ts",
    ["import { readTask } from '@harness-anything/kernel';", "export const taskRead = readTask;", ""].join("\n"),
  );
  write(root, "packages/kernel/src/index.ts", "export const readTask = () => ({});\n");

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes("dist static import graph reached kernel public barrel: packages/kernel/src/index.ts"),
  );
});

test("thin CLI structure rejects an unlisted daemon file reached through a package export", async () => {
  const root = await fixture();
  write(
    root,
    "packages/cli/src/index.ts",
    entrySource(["import { hidden } from '@harness-anything/daemon/internal/hidden';", "void hidden;"]),
  );
  write(root, "packages/daemon/src/hidden.ts", "export const hidden = true;\n");

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes(
      "dist static import graph reached module is outside the thin CLI cross-package graph boundary: " +
        "packages/daemon/src/hidden.ts",
    ),
  );
});

test("thin CLI structure accepts daemon control as the only dynamic entry", async () => {
  const root = await fixture();

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CLI structure check passed/u);
});

test("thin CLI structure rejects a static kernel edge", async () => {
  const root = await fixture();
  write(
    root,
    "packages/cli/src/index.ts",
    entrySource(["import { parse } from './commands/task-read.ts';", "void parse;"]),
  );
  write(
    root,
    "packages/cli/src/commands/task-read.ts",
    [
      "import { parseCanonicalEvent } from '@harness-anything/kernel/internal/domain/doc-sync-canonical-events';",
      "export const parse = parseCanonicalEvent;",
      "",
    ].join("\\n"),
  );
  write(
    root,
    "packages/kernel/src/domain/doc-sync-canonical-events.ts",
    "export function parseCanonicalEvent(): void {}\\n",
  );

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dist static import graph reached kernel domain module/u);
});

// The original pre-restoration assertions are preserved verbatim here for audit:
//
//   assert.notEqual(result.status, 0);
//   assert.match(result.stderr, /thin-command\.ts:1: function genericMonolith has 12[1-9] lines; max 120/u);
//
test("thin CLI structure enforces the re-derived function complexity limit", async () => {
  const root = await fixture();
  write(root, "packages/cli/src/cli/thin-command.ts", genericLongFunction(218));

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /thin-command\.ts:1: function genericMonolith has 22[1-9] lines; max 220/u);
});

// Branch counting is independent of the line limits: reformatting cannot add or
// remove an if/for/while/case/catch/switch keyword or a `?`.
test("CLI branch-count limit stays active with the re-derived line limits", async () => {
  const root = await fixture();
  const branches = Array.from({ length: 41 }, (_, index) => `  if (input === ${index}) return ${index};`).join("\n");
  write(
    root,
    "packages/cli/src/cli/thin-command.ts",
    `export function branchy(input: number): number {\n${branches}\n  return -1;\n}\n`,
  );

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /function branchy has \d+ branch markers; max 40/u);
});

test("thin CLI permits only the zero-dependency preset command contract", async () => {
  const root = await fixture();
  write(
    root,
    "packages/preset/src/preset-command-contract.ts",
    ["import { runtime } from './preset.contract.ts';", "export const presetCommands = runtime;", ""].join("\n"),
  );
  write(root, "packages/preset/src/preset.contract.ts", "export const runtime = [];\n");
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /module is outside the thin CLI cross-package graph boundary.*preset\.contract\.ts/u);
});

test("daemon transport graph accepts the line client's thin leaf imports", async () => {
  const root = await fixture();
  write(
    root,
    "packages/daemon/src/client/local-json-rpc-client.ts",
    [
      "import net from 'node:net';",
      "import { currentDaemonProtocolVersion } from '../protocol/version.ts';",
      "export function transport(): void { void net; void currentDaemonProtocolVersion; }",
      "",
    ].join("\n"),
  );
  write(root, "packages/daemon/src/protocol/version.ts", "export const currentDaemonProtocolVersion = 1;\n");
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CLI structure check passed/u);
});

test("CLI and daemon transport graphs admit the Decisions provider command declaration module", async () => {
  const root = await fixture();
  write(
    root,
    "packages/daemon/src/protocol/daemon-protocol.contract.ts",
    [
      "import { daemonOwnedProtocolCommands } from './daemon-protocol-commands.ts';",
      "export function resolveThinCliCommand(): void { void daemonOwnedProtocolCommands; }",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/daemon/src/protocol/daemon-protocol-commands.ts",
    [
      "import { providerProtocolCommands } from './daemon-protocol-commands-provider.ts';",
      "export const daemonOwnedProtocolCommands = providerProtocolCommands;",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/daemon/src/protocol/daemon-protocol-commands-provider.ts",
    [
      "import { presetCommands } from '@harness-anything/preset/internal/preset-command-contract';",
      "export const providerProtocolCommands = presetCommands;",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/daemon/src/client/local-json-rpc-client.ts",
    [
      "import { daemonOwnedProtocolCommands } from '../protocol/daemon-protocol-commands.ts';",
      "export function transport(): void { void daemonOwnedProtocolCommands; }",
      "",
    ].join("\n"),
  );

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CLI structure check passed/u);
});

test("daemon transport graph rejects a kernel barrel reachable from the line client", async () => {
  const root = await fixture();
  write(
    root,
    "packages/daemon/src/client/local-json-rpc-client.ts",
    [
      "import { consumeKnownError } from '@harness-anything/kernel';",
      "export function transport(): void { void consumeKnownError; }",
      "",
    ].join("\n"),
  );
  write(root, "packages/kernel/src/index.ts", "export function consumeKnownError(): void {}\n");
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes("daemon transport import graph reached kernel public barrel: packages/kernel/src/index.ts"),
  );
});

test("daemon transport graph rejects even a kernel leaf import reachable from the line client", async () => {
  const root = await fixture();
  write(
    root,
    "packages/daemon/src/client/local-json-rpc-client.ts",
    [
      "import { consumeKnownError } from '@harness-anything/kernel/internal/error-consumption';",
      "export function transport(): void { void consumeKnownError; }",
      "",
    ].join("\n"),
  );
  write(root, "packages/kernel/src/error-consumption.ts", "export function consumeKnownError(): void {}\n");
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes(
      "daemon transport import graph reached module is outside the daemon transport allowlist: packages/kernel/src/error-consumption.ts",
    ),
  );
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: thin protocol validators consume pure zero-builtin kernel domain
// judgment leaves (`query-payload-validation.ts`, `receipt-acceptance.ts`) instead of maintaining wire mirrors.
test("CLI and daemon transport graphs admit pure kernel protocol judgment leaves", async () => {
  const root = await protocolKernelJudgmentFixture();
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CLI structure check passed/u);
});

for (const leaf of [
  "packages/kernel/src/domain/query-payload-validation.ts",
  "packages/kernel/src/domain/receipt-acceptance.ts",
]) {
  for (const dependency of ["index.ts", "domain/other-domain.ts"]) {
    test(`CLI and daemon transport graphs reject ${path.basename(leaf)} importing ${dependency}`, async () => {
      const root = await protocolKernelJudgmentFixture();
      write(
        root,
        leaf,
        `export { leaked } from '${dependency === "index.ts" ? "../index.ts" : "./other-domain.ts"}';\n` +
          "export function queryPayloadValidation(): readonly string[] { return []; }\n" +
          "export function validateReceiptAcceptance(): readonly string[] { return []; }\n",
      );
      write(root, `packages/kernel/src/${dependency}`, "export const leaked = true;\n");
      const result = run(root);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(`packages/kernel/src/${dependency}`), result.stderr);
    });
  }
}

async function protocolKernelJudgmentFixture() {
  const root = await fixture();
  write(
    root,
    "packages/daemon/src/protocol/daemon-protocol.contract.ts",
    [
      "import { validateDaemonQueryPayload } from './daemon-protocol-validate-relation-query.ts';",
      "import { validateDaemonGuiCommandReceipt } from './daemon-protocol-validate-results.ts';",
      "export function resolveThinCliCommand(): void { void validateDaemonQueryPayload; void validateDaemonGuiCommandReceipt; }",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/daemon/src/client/local-json-rpc-client.ts",
    [
      "import { validateDaemonQueryPayload } from '../protocol/daemon-protocol-validate-relation-query.ts';",
      "import { validateDaemonGuiCommandReceipt } from '../protocol/daemon-protocol-validate-results.ts';",
      "export function transport(): void { void validateDaemonQueryPayload; void validateDaemonGuiCommandReceipt; }",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/daemon/src/protocol/daemon-protocol-validate-relation-query.ts",
    [
      "import { queryPayloadValidation } from '@harness-anything/kernel/internal/domain/query-payload-validation.ts';",
      "export const validateDaemonQueryPayload = queryPayloadValidation;",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/daemon/src/protocol/daemon-protocol-validate-results.ts",
    [
      "import { validateReceiptAcceptance } from '@harness-anything/kernel/internal/domain/receipt-acceptance.ts';",
      "export const validateDaemonGuiCommandReceipt = validateReceiptAcceptance;",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/kernel/src/domain/contract-validation.ts",
    "export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;\n",
  );
  write(
    root,
    "packages/kernel/src/domain/lifecycle-status.ts",
    "export const TASK_LIFECYCLE_STATUSES = [] as const;\n",
  );
  write(root, "packages/kernel/src/domain/relation-state.ts", "export const relationStates = [] as const;\n");
  write(root, "packages/kernel/src/domain/timestamp.ts", "export const isIsoUtcTimestamp = (): boolean => true;\n");
  write(
    root,
    "packages/kernel/src/domain/query-payload-validation.ts",
    [
      "import { isRecord } from './contract-validation.ts';",
      "import { TASK_LIFECYCLE_STATUSES } from './lifecycle-status.ts';",
      "import { relationStates } from './relation-state.ts';",
      "import { isIsoUtcTimestamp } from './timestamp.ts';",
      "export function queryPayloadValidation(): readonly string[] {",
      "  void isRecord; void TASK_LIFECYCLE_STATUSES; void relationStates; void isIsoUtcTimestamp;",
      "  return [];",
      "}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/kernel/src/domain/receipt-acceptance.ts",
    [
      "import { isIsoUtcTimestamp } from './timestamp.ts';",
      "export function validateReceiptAcceptance(): readonly string[] { void isIsoUtcTimestamp; return []; }",
      "",
    ].join("\n"),
  );
  return root;
}

async function cliPolicyFixture() {
  const root = await fixture();
  write(
    root,
    "packages/cli/src/index.ts",
    entrySource([
      "import { cliOperationalPolicy } from '@harness-anything/kernel/internal/domain/cli-operational-policy';",
      "void cliOperationalPolicy;",
    ]),
  );
  write(
    root,
    "packages/kernel/src/domain/cli-operational-policy.ts",
    "import type { OntologyPolicyDeclaration } from './ontology-source.ts';\n" +
      "export const cliOperationalPolicy = { defaultValue: { waitMaximumMs: 60000 } } satisfies OntologyPolicyDeclaration;\n",
  );
  return root;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-thin-cli-structure-"));
  // The gate enumerates through git; the excludesFile pin keeps host-global ignores out.
  for (const args of [
    ["init", "--quiet"],
    ["config", "core.excludesFile", "/dev/null"],
  ])
    spawnSync("git", args, { cwd: root });
  write(
    root,
    "packages/cli/package.json",
    JSON.stringify({
      bin: { "harness-anything": "dist/cli/src/index.js", ha: "dist/cli/src/index.js" },
    }),
  );
  write(
    root,
    "packages/daemon/package.json",
    JSON.stringify({
      name: "@harness-anything/daemon",
      exports: {
        "./internal/client/local-daemon-target": "./src/client/local-daemon-target.ts",
        "./internal/hidden": "./src/hidden.ts",
        "./internal/protocol/daemon-protocol.contract": "./src/protocol/daemon-protocol.contract.ts",
      },
    }),
  );
  write(
    root,
    "packages/kernel/package.json",
    JSON.stringify({
      name: "@harness-anything/kernel",
      exports: { ".": "./src/index.ts", "./internal/domain/*.ts": "./src/domain/*.ts", "./internal/*": "./src/*.ts" },
    }),
  );
  write(
    root,
    "packages/preset/package.json",
    JSON.stringify({ name: "@harness-anything/preset", exports: { "./internal/*": "./src/*.ts" } }),
  );
  write(root, "packages/cli/src/index.ts", entrySource());
  write(
    root,
    "packages/cli/src/cli/thin-command.ts",
    [
      "import { resolveThinCliCommand } from '@harness-anything/daemon/internal/protocol/daemon-protocol.contract';",
      "export function parseThinCommand(): void { void resolveThinCliCommand; }",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/cli/src/daemon/client.ts",
    [
      "import { resolveLocalDaemonTarget } from '@harness-anything/daemon/internal/client/local-daemon-target';",
      "export function runCommandThroughDaemon(): void { void resolveLocalDaemonTarget; }",
      "",
    ].join("\n"),
  );
  write(root, "packages/cli/src/daemon/control.ts", "export function runDaemonControl(): void {}\n");
  write(
    root,
    "packages/daemon/src/client/local-daemon-target.ts",
    ["import path from 'node:path';", "export function resolveLocalDaemonTarget(): void { void path; }", ""].join("\n"),
  );
  write(
    root,
    "packages/daemon/src/protocol/daemon-protocol.contract.ts",
    [
      "import { presetCommands } from '@harness-anything/preset/internal/preset-command-contract';",
      "export function resolveThinCliCommand(): void { void presetCommands; }",
      "",
    ].join("\n"),
  );
  write(root, "packages/preset/src/preset-command-contract.ts", "export const presetCommands = [];\n");
  write(root, "packages/daemon/src/client/local-json-rpc-client.ts", "export {};\n");
  return root;
}

function entrySource(additions = []) {
  return [
    "import { parseThinCommand } from './cli/thin-command.ts';",
    "import { runCommandThroughDaemon } from './daemon/client.ts';",
    ...additions.filter((line) => line.startsWith("import ")),
    "function emit(): void {}",
    "if (process.argv.includes('daemon')) void import('./daemon/control.ts');",
    ...additions.filter((line) => line.includes("void import(")),
    "void parseThinCommand; void runCommandThroughDaemon; void emit;",
    ...additions.filter((line) => !line.startsWith("import ") && !line.includes("void import(")),
    "",
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

function genericLongFunction(bodyLines = 118) {
  const lines = [
    "export function genericMonolith<A, I>(",
    "  value: A,",
    "  input: I",
    "): { readonly value: A; readonly input: I } {",
    "  const pair = { value, input };",
  ];
  for (let index = 0; index < bodyLines; index += 1) lines.push(`  void ${index};`);
  lines.push("  return pair;", "}");
  return `${lines.join("\n")}\n`;
}

test("daemon transport graph rejects a missing required entry", async () => {
  const root = await fixture();
  try {
    renameSync(
      path.join(root, "packages/daemon/src/client/local-json-rpc-client.ts"),
      path.join(root, "escaped-client.ts"),
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local-json-rpc-client\.ts/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

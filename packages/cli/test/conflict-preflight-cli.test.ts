// harness-test-tier: integration
import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import { runtimeEventPolicyForAction } from "../src/cli/command-event-policy.ts";
import { commandDescriptors } from "../src/cli/command-registry.ts";
import { requiresConflictMarkerPreflight } from "../src/cli/runner-registry.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

const expectedConflictPreflightKinds = [
  "adopt-multica",
  "decision-accept",
  "decision-amend",
  "decision-defer",
  "decision-propose",
  "decision-reckon",
  "decision-reject",
  "decision-relate",
  "decision-relation-replace",
  "decision-relation-retire",
  "decision-retire",
  "decision-supersede",
  "distill-candidate",
  "distill-commit",
  "fact-invalidate",
  "doc-generate",
  "doc-sync-submit",
  "governance-rebuild",
  "init",
  "legacy-copy-safe-docs",
  "legacy-index",
  "legacy-intake-plan",
  "lesson-promote",
  "lesson-sediment",
  "migrate-anchors",
  "migrate-fact-execution",
  "migrate-provenance",
  "migrate-run",
  "migrate-structure",
  "module-register",
  "module-scaffold",
  "module-step",
  "module-unregister",
  "new-task",
  "preset-action",
  "preset-install",
  "preset-run",
  "preset-seed",
  "preset-uninstall",
  "progress-append",
  "record-fact",
  "runtime-event-append",
  "script-run",
  "session-backfill",
  "session-export",
  "session-sync",
  "status",
  "status-set",
  "task-amend",
  "task-archive",
  "task-code-doc-reconcile",
  "task-complete",
  "task-delete",
  "task-list",
  "task-relate",
  "task-reopen",
  "task-review",
  "task-review-execution",
  "task-supersede",
  "task-tree"
].sort();

const expectedAutoRuntimeEventKinds = [
  "decision-accept",
  "decision-amend",
  "decision-defer",
  "decision-propose",
  "decision-reckon",
  "decision-reject",
  "decision-relate",
  "decision-relation-replace",
  "decision-relation-retire",
  "decision-retire",
  "decision-supersede",
  "distill-candidate",
  "distill-commit",
  "fact-invalidate",
  "module-register",
  "module-scaffold",
  "module-step",
  "module-unregister",
  "new-task",
  "progress-append",
  "record-fact",
  "status-set",
  "task-claim",
  "task-amend",
  "task-archive",
  "task-code-doc-reconcile",
  "task-complete",
  "task-delete",
  "task-relate",
  "task-reopen",
  "task-release",
  "task-review",
  "task-review-execution",
  "task-supersede",
  "worktree-create"
].sort();

const expectedDeferredRuntimeEventKinds = [
  "adopt-multica",
  "governance-rebuild",
  "init",
  "legacy-copy-safe-docs",
  "legacy-index",
  "legacy-intake-plan",
  "lesson-promote",
  "lesson-sediment",
  "migrate-anchors",
  "migrate-fact-execution",
  "migrate-provenance",
  "migrate-run",
  "migrate-structure",
  "preset-action",
  "preset-install",
  "preset-run",
  "preset-seed",
  "preset-uninstall",
  "script-run"
].sort();

test("CLI conflict preflight classification covers every mutating descriptor", () => {
  const actual = commandDescriptors
    .filter((descriptor) => requiresConflictMarkerPreflight(descriptor.kind))
    .map((descriptor) => descriptor.kind)
    .sort();

  assert.deepEqual(actual, expectedConflictPreflightKinds);
});

test("CLI runtime event policy classifies every command kind", () => {
  const actualAuto = commandDescriptors
    .filter((descriptor) => runtimeEventPolicyForAction(descriptor.kind) === "auto")
    .map((descriptor) => descriptor.kind)
    .sort();
  const actualDeferred = commandDescriptors
    .filter((descriptor) => runtimeEventPolicyForAction(descriptor.kind) === "deferred")
    .map((descriptor) => descriptor.kind)
    .sort();
  const actualDirect = commandDescriptors
    .filter((descriptor) => runtimeEventPolicyForAction(descriptor.kind) === "direct")
    .map((descriptor) => descriptor.kind)
    .sort();

  assert.deepEqual(actualAuto, expectedAutoRuntimeEventKinds);
  assert.deepEqual(actualDeferred, expectedDeferredRuntimeEventKinds);
  assert.deepEqual(actualDirect, ["runtime-event-append"]);
});

test("CLI conflict preflight blocks representative write commands before output", () => {
  withTempRoot((rootDir) => {
    writeConflictMarker(rootDir);

    const cases: ReadonlyArray<{
      readonly args: ReadonlyArray<string>;
      readonly missingPath: string;
      readonly env?: NodeJS.ProcessEnv;
    }> = [
      { args: ["init"], missingPath: "harness/harness.yaml" },
      { args: ["module", "register", "billing", "--title", "Billing", "--scope", "packages/billing/**"], missingPath: "harness/modules.json" },
      { args: ["preset", "seed"], missingPath: ".harness/presets", env: { HARNESS_USER_HOME: path.join(rootDir, ".harness") } },
      { args: ["preset", "run", "module", "check", "--task", "task-1"], missingPath: ".harness/evidence/presets/module" },
      { args: ["preset", "action", "module", "check", "--task", "task-1"], missingPath: ".harness/evidence/presets/module" },
      { args: ["script", "run", "missing-script", "--task", "task-1"], missingPath: ".harness" },
      { args: ["migrate-run", "--plan-only", "--out-dir", "migration-session"], missingPath: "migration-session/session.json" },
      { args: ["lesson-promote", "task-1", "candidate-1", "--apply"], missingPath: ".harness/generated/lessons" }
    ];

    for (const entry of cases) {
      const result = runJson(rootDir, entry.args, entry.env);
      assert.equal(result.ok, false, entry.args.join(" "));
      assert.equal(result.error?.code, "conflict_marker_present", entry.args.join(" "));
      assert.equal(existsSync(path.join(rootDir, entry.missingPath)), false, entry.args.join(" "));
    }
  }, { identity: false });
});

test("CLI conflict preflight treats list-then-vanished files as transient", () => {
  withTempRoot((rootDir) => {
    const vanishedPath = path.join(rootDir, "harness/vanished.md");
    mkdirSync(path.dirname(vanishedPath), { recursive: true });
    writeFileSync(vanishedPath, "transient source\n", "utf8");
    const preloadPath = writeVanishedReadPreload(rootDir, vanishedPath);

    const result = runJson(rootDir, ["task", "create", "--title", "TOCTOU Safe"], {
      NODE_OPTIONS: `--require ${preloadPath}`
    });

    assert.equal(result.ok, true);
    assert.equal(result.command, "new-task");
  });
});

test("CLI write coordinator flush rechecks conflict markers after early preflight", () => {
  withTempRoot((rootDir) => {
    writeConflictMarker(rootDir);
    const markerPath = path.join(rootDir, "AGENTS.md");
    const preloadPath = writeFirstReadCleanPreload(rootDir, markerPath);

    const result = runJson(rootDir, ["task", "create", "--title", "Blocked At Flush"], {
      NODE_OPTIONS: `--require ${preloadPath}`
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "write_rejected");
    assert.match(result.error?.hint ?? "", /Git conflict marker found/u);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks")), false);
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T, options: { readonly identity?: boolean } = {}): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-conflict-preflight-"));
  try {
    if (options.identity !== false) ensureTestHarnessIdentity(rootDir);
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeConflictMarker(rootDir: string): void {
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(path.join(rootDir, "AGENTS.md"), [
    "<<<<<<< HEAD",
    "left",
    "=======",
    "right",
    ">>>>>>> branch",
    ""
  ].join("\n"), "utf8");
}

function writeFirstReadCleanPreload(rootDir: string, filePath: string): string {
  const preloadPath = path.join(rootDir, "first-read-clean-preload.cjs");
  writeFileSync(preloadPath, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    `const filePath = ${JSON.stringify(filePath)};`,
    "const originalReadFileSync = fs.readFileSync;",
    "let cleanReadsRemaining = 1;",
    "fs.readFileSync = function patchedReadFileSync(candidate, ...args) {",
    "  if (String(candidate) === filePath && cleanReadsRemaining > 0) {",
    "    cleanReadsRemaining -= 1;",
    "    return 'clean source\\n';",
    "  }",
    "  return originalReadFileSync.call(this, candidate, ...args);",
    "};",
    "syncBuiltinESMExports();",
    ""
  ].join("\n"), "utf8");
  return preloadPath;
}

function writeVanishedReadPreload(rootDir: string, vanishedPath: string): string {
  const preloadPath = path.join(rootDir, "vanished-preload.cjs");
  writeFileSync(preloadPath, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    `const vanishedPath = ${JSON.stringify(vanishedPath)};`,
    "const originalReadFileSync = fs.readFileSync;",
    "fs.readFileSync = function patchedReadFileSync(filePath, ...args) {",
    "  if (String(filePath) === vanishedPath) {",
    "    const error = new Error(`ENOENT: no such file or directory, open '${vanishedPath}'`);",
    "    error.code = 'ENOENT';",
    "    error.path = vanishedPath;",
    "    throw error;",
    "  }",
    "  return originalReadFileSync.call(this, filePath, ...args);",
    "};",
    "syncBuiltinESMExports();",
    ""
  ].join("\n"), "utf8");
  return preloadPath;
}

function runJson(rootDir: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HARNESS_DAEMON_MODE: "direct",
        HARNESS_ACTOR: "agent:conflict-preflight-test",
        HARNESS_GIT_AUTHOR_NAME: "Harness Test",
        HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test",
        ...env
      }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

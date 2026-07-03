import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { commandDescriptors } from "../src/cli/command-registry.ts";
import { requiresConflictMarkerPreflight } from "../src/cli/runner-registry.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

const expectedConflictPreflightKinds = [
  "adopt-multica",
  "decision-accept",
  "decision-amend",
  "decision-defer",
  "decision-propose",
  "decision-reject",
  "decision-retire",
  "decision-supersede",
  "governance-rebuild",
  "init",
  "legacy-copy-safe-docs",
  "legacy-index",
  "legacy-intake-plan",
  "lesson-promote",
  "lesson-sediment",
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
  "script-run",
  "status",
  "status-set",
  "task-archive",
  "task-complete",
  "task-delete",
  "task-list",
  "task-reopen",
  "task-review",
  "task-supersede"
].sort();

test("CLI conflict preflight classification covers every mutating descriptor", () => {
  const actual = commandDescriptors
    .filter((descriptor) => requiresConflictMarkerPreflight(descriptor.kind))
    .map((descriptor) => descriptor.kind)
    .sort();

  assert.deepEqual(actual, expectedConflictPreflightKinds);
});

test("CLI conflict preflight blocks representative write commands before output", () => {
  withTempRoot((rootDir) => {
    writeConflictMarker(rootDir);

    const cases: ReadonlyArray<{
      readonly args: ReadonlyArray<string>;
      readonly missingPath: string;
    }> = [
      { args: ["init"], missingPath: "harness/harness.yaml" },
      { args: ["module", "register", "billing", "--title", "Billing", "--scope", "packages/billing/**"], missingPath: "harness/modules.json" },
      { args: ["preset", "seed"], missingPath: ".harness/user-presets" },
      { args: ["preset", "run", "module", "check", "--task", "task-1"], missingPath: ".harness/evidence/presets/module" },
      { args: ["preset", "action", "module", "check", "--task", "task-1"], missingPath: ".harness/evidence/presets/module" },
      { args: ["script", "run", "missing-script", "--task", "task-1"], missingPath: ".harness" },
      { args: ["migrate-run", "--plan-only", "--out-dir", "migration-session"], missingPath: "migration-session/session.json" },
      { args: ["lesson-promote", "task-1", "candidate-1", "--apply"], missingPath: ".harness/generated/lessons" }
    ];

    for (const entry of cases) {
      const result = runJson(rootDir, entry.args);
      assert.equal(result.ok, false, entry.args.join(" "));
      assert.equal(result.error?.code, "conflict_marker_present", entry.args.join(" "));
      assert.equal(existsSync(path.join(rootDir, entry.missingPath)), false, entry.args.join(" "));
    }
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-conflict-preflight-"));
  try {
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

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    return JSON.parse(stdout) as Record<string, any>;
  } catch (error) {
    const failure = error as { readonly stdout?: string };
    return JSON.parse(failure.stdout ?? "{}") as Record<string, any>;
  }
}

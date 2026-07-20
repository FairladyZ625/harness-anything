// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repoRoot, "tools/check-write-coordinator-boundary.mjs");

test("WriteCoordinator boundary check accepts the repository's explicit F6 debt allowlist", () => {
  const result = runChecker(repoRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WriteCoordinator boundary check passed/);
});

test("WriteCoordinator boundary check catches renamed metabolic policy imports as a documented bypass fixture", () => {
  const root = makeFixtureRoot();
  try {
    writeCoordinator(root, [
      "import { evaluateEntityDisposition as decideWrite } from '../entity/disposition.ts';",
      "export function makeJournaledWriteCoordinator() {",
      "  return decideWrite({ entityRef: 'task/example', action: 'hard-delete' });",
      "}"
    ]);

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /named-import:\.\.\/entity\/disposition\.ts:evaluateEntityDisposition:decideWrite/);
    assert.match(result.stderr, /call-import:\.\.\/entity\/disposition\.ts:evaluateEntityDisposition:decideWrite/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WriteCoordinator boundary check catches dynamic policy imports as a documented bypass fixture", () => {
  const root = makeFixtureRoot();
  try {
    writeCoordinator(root, [
      "export async function makeJournaledWriteCoordinator() {",
      "  return import('../entity/disposition.ts');",
      "}"
    ]);

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dynamic-import:\.\.\/entity\/disposition\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WriteCoordinator boundary check fails closed on allowlist entries without refs", () => {
  const root = makeFixtureRoot();
  const policyRoot = mkdtempSync(path.join(tmpdir(), "ha-f6-policy-"));
  try {
    writeCoordinator(root, [
      "export function makeJournaledWriteCoordinator() {",
      "  return {};",
      "}"
    ]);
    writeFileSync(path.join(policyRoot, "check-write-coordinator-boundary.json"), JSON.stringify({
      schema: "harness-anything/gate-allowlist/v1",
      gateId: "check-write-coordinator-boundary",
      entries: {
        knownMetabolicDecisionDebt: [
          {
            value: "packages/kernel/src/write-coordination/journal/coordinator.ts#local-function:assertHardDeleteAllowed",
            reason: "fixture omits ref"
          }
        ]
      }
    }, null, 2), "utf8");

    const result = runChecker(root, { env: { HARNESS_GATE_ALLOWLIST_DIR: policyRoot } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must include a non-empty ref/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-f6-boundary-"));
  mkdirSync(path.join(root, "packages/kernel/src/write-coordination/journal"), { recursive: true });
  mkdirSync(path.join(root, "packages/kernel/src/entity"), { recursive: true });
  mkdirSync(path.join(root, "packages/kernel/src/domain"), { recursive: true });
  writeFileSync(path.join(root, "packages/kernel/src/entity/disposition.ts"), "export function evaluateEntityDisposition() { return { allowed: true }; }\n", "utf8");
  writeFileSync(path.join(root, "packages/kernel/src/domain/index.ts"), [
    "export function isDomainStatus() { return true; }",
    "export function isPackageDisposition() { return true; }",
    "export function isTerminalStatus() { return false; }"
  ].join("\n"), "utf8");
  return root;
}

function writeCoordinator(root, lines) {
  writeFileSync(path.join(root, "packages/kernel/src/write-coordination/journal/coordinator.ts"), `${lines.join("\n")}\n`, "utf8");
}

function runChecker(root, options = {}) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) }
  });
}

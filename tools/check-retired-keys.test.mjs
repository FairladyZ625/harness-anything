// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repoRoot, "tools/check-retired-keys.mjs");

for (const fixture of [
  {
    name: "task createdBy",
    relativePath: "harness/tasks/task_CREATED_BY/INDEX.md",
    key: "createdBy",
    body: frontmatter(["schema: task-package/v2", "task_id: task_CREATED_BY", "createdBy: { name: Legacy }"])
  },
  {
    name: "decision proposedBy",
    relativePath: "harness/decisions/decision-dec_PROPOSED/decision.md",
    key: "proposedBy",
    body: frontmatter(["schema: decision-package/v1", "decision_id: dec_PROPOSED", "proposedBy: { kind: agent, id: legacy }"])
  },
  {
    name: "decision arbiter",
    relativePath: "harness/decisions/decision-dec_ARBITER/decision.md",
    key: "arbiter",
    body: frontmatter(["schema: decision-package/v1", "decision_id: dec_ARBITER", "arbiter: { kind: human, id: legacy }"])
  }
]) {
  test(`positive control rejects retired top-level ${fixture.name}`, () => {
    const root = makeFixtureRoot({ [fixture.relativePath]: fixture.body });
    try {
      const result = runChecker(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`${escapeRegExp(fixture.relativePath.slice("harness/".length))}: retired top-level key ${fixture.key}`, "u"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("negative control accepts clean task and decision documents", () => {
  const root = makeFixtureRoot({
    "harness/tasks/task_CLEAN/INDEX.md": frontmatter(["schema: task-package/v2", "task_id: task_CLEAN"]),
    "harness/decisions/decision-dec_CLEAN/decision.md": frontmatter(["schema: decision-package/v1", "decision_id: dec_CLEAN"])
  });
  try {
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 task INDEX\.md, 1 decision\.md, 0 retired keys/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("negative control preserves active contentPins[].arbiter", () => {
  const root = makeFixtureRoot({
    "harness/decisions/decision-dec_PIN/decision.md": frontmatter([
      "schema: decision-package/v1",
      "decision_id: dec_PIN",
      "contentPins:",
      "  - action: accept",
      "    arbiter: { kind: human, id: active-arbiter }",
      "    digest: sha256:test"
    ])
  });
  try {
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 decision\.md, 0 retired keys/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("absent ledger reports SKIPPED, never a pass", () => {
  // Public checkouts have no harness/ (private git-ignored subrepo). Scanning nothing there is
  // expected — but it must not masquerade as a green scan.
  const root = makeFixtureRoot({});
  try {
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SKIPPED: no canonical ledger/u);
    assert.match(result.stdout, /this is not a pass/u);
    assert.doesNotMatch(result.stdout, /passed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger root present but empty is an instrument failure, not a pass", () => {
  // If the ledger exists yet yields zero documents, the checker is pointed at the wrong place.
  // Staying silent here would let a broken instrument certify every future PR green.
  const root = makeFixtureRoot({});
  mkdirSync(path.join(root, "harness/tasks"), { recursive: true });
  try {
    const result = runChecker(root);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /holds 0 authored documents/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixtureRoot(files) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-retired-keys-"));
  for (const [relativePath, body] of Object.entries(files)) {
    const file = path.join(root, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, "utf8");
  }
  return root;
}

function runChecker(root) {
  return spawnSync(process.execPath, [checkerPath, "--root", root], { encoding: "utf8" });
}

function frontmatter(lines) {
  return ["---", ...lines, "---", "", "# Fixture", ""].join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

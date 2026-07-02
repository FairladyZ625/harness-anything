import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Schema } from "effect";
import { createTaskPackagePath, resolveHarnessLayout, taskDocumentPath, taskPackagePath } from "../../src/layout/index.ts";
import {
  LegacyCollisionReportSchema,
  LegacyIndexSchema
} from "../../src/schemas/registry.ts";

const legacyIndexValidUrl = new URL("../../fixtures/schemas/legacy-index/valid.json", import.meta.url);
const legacyIndexInvalidUrl = new URL("../../fixtures/schemas/legacy-index/invalid.json", import.meta.url);
const collisionValidUrl = new URL("../../fixtures/schemas/legacy-collision-report/valid.json", import.meta.url);
const collisionInvalidUrl = new URL("../../fixtures/schemas/legacy-collision-report/invalid.json", import.meta.url);

test("legacy storage layout is inside authored harness root", () => {
  const layout = resolveHarnessLayout("/repo");

  assert.equal(layout.legacyRoot, path.join("/repo", "harness", "legacy"));
  assert.equal(layout.legacyTasksRoot, path.join(layout.legacyRoot, "tasks"));
  assert.equal(layout.legacyDocsRoot, path.join(layout.legacyRoot, "docs"));
  assert.equal(layout.legacyIndexPath, path.join(layout.legacyRoot, "index.json"));
  assert.equal(layout.legacyCollisionReportPath, path.join(layout.legacyRoot, "collision-report.json"));
  assert.equal(layout.legacyRebuildGuidePath, path.join(layout.legacyRoot, "rebuild-guide.md"));
  assert.equal(layout.taskPackagePath("task_1"), taskPackagePath("/repo", "task_1"));
  assert.equal(layout.createTaskPackagePath("task_1", "Layout Task"), createTaskPackagePath("/repo", "task_1", "Layout Task"));
  assert.equal(layout.taskDocumentPath("task_1", "task_plan.md"), taskDocumentPath("/repo", "task_1", "task_plan.md"));
});

test("layout resolver honors harness.yaml layout roots and upward discovery", () => {
  withTempRoot((rootDir) => {
    const configPath = path.join(rootDir, "harness", "harness.yaml");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, [
      "schema: harness-anything/v1",
      "layout:",
      "  authoredRoot: .harness-private/coding-agent-harness",
      "  localRoot: .harness-local",
      "tasks:",
      "  root: .harness-private/coding-agent-harness/planning/tasks",
      ""
    ].join("\n"), "utf8");
    const nestedRoot = path.join(rootDir, "packages", "cli");
    mkdirSync(nestedRoot, { recursive: true });

    const layout = resolveHarnessLayout(nestedRoot);

    assert.equal(layout.rootDir, rootDir);
    assert.equal(layout.authoredRoot, path.join(rootDir, ".harness-private/coding-agent-harness"));
    assert.equal(layout.localRoot, path.join(rootDir, ".harness-local"));
    assert.equal(layout.tasksRoot, path.join(rootDir, ".harness-private/coding-agent-harness/planning/tasks"));
    assert.equal(layout.legacyRoot, path.join(layout.authoredRoot, "legacy"));
  });
});

test("layout resolver discovers private self-host structure roots", () => {
  withTempRoot((rootDir) => {
    const configPath = path.join(rootDir, ".harness-private", "coding-agent-harness", "harness.yaml");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, [
      "version: 2",
      "structure:",
      "  harnessRoot: coding-agent-harness",
      "  planningRoot: coding-agent-harness/planning",
      "  tasksRoot: coding-agent-harness/planning/tasks",
      "  generatedRoot: coding-agent-harness/governance/generated",
      ""
    ].join("\n"), "utf8");
    const nestedRoot = path.join(rootDir, "packages", "cli");
    mkdirSync(nestedRoot, { recursive: true });

    const layout = resolveHarnessLayout(nestedRoot);

    assert.equal(layout.rootDir, rootDir);
    assert.equal(layout.authoredRoot, path.join(rootDir, ".harness-private/coding-agent-harness"));
    assert.equal(layout.tasksRoot, path.join(rootDir, ".harness-private/coding-agent-harness/planning/tasks"));
    assert.equal(layout.generatedRoot, path.join(rootDir, ".harness-private/coding-agent-harness/governance/generated"));
  });
});

test("layout resolver does not cross a git worktree boundary to borrow parent harness config", () => {
  withTempRoot((rootDir) => {
    const parentConfigPath = path.join(rootDir, "harness", "harness.yaml");
    mkdirSync(path.dirname(parentConfigPath), { recursive: true });
    writeFileSync(parentConfigPath, "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n", "utf8");
    const worktreeRoot = path.join(rootDir, ".worktrees", "feature");
    mkdirSync(worktreeRoot, { recursive: true });
    writeFileSync(path.join(worktreeRoot, ".git"), "gitdir: ../../.git/worktrees/feature\n", "utf8");
    writeFileSync(path.join(worktreeRoot, "package.json"), "{\"name\":\"feature\"}\n", "utf8");

    const layout = resolveHarnessLayout(worktreeRoot);

    assert.equal(layout.rootDir, worktreeRoot);
    assert.equal(layout.authoredRoot, path.join(worktreeRoot, "harness"));
  });
});

test("legacy index schema decodes and encodes valid fixture", async () => {
  const fixture = JSON.parse(await readFile(legacyIndexValidUrl, "utf8")) as unknown;
  const decoded = Schema.decodeUnknownSync(LegacyIndexSchema)(fixture);
  const encoded = Schema.encodeSync(LegacyIndexSchema)(decoded);

  assert.deepEqual(encoded, fixture);
});

test("legacy index schema rejects repo-root legacy storage and automatic migration treatment", async () => {
  const fixture = JSON.parse(await readFile(legacyIndexInvalidUrl, "utf8")) as unknown;

  assert.throws(() => Schema.decodeUnknownSync(LegacyIndexSchema)(fixture));
});

test("legacy index schema rejects traversal paths and short digests", async () => {
  const fixture = JSON.parse(await readFile(legacyIndexValidUrl, "utf8")) as Record<string, any>;
  fixture.entries[0].storedPath = "harness/legacy/../../package.json";
  fixture.entries[0].evidencePointers[0].path = "harness/legacy/tasks/../outside.md";
  fixture.entries[0].sourceDigest = "sha256:not-a-real-digest";

  assert.throws(() => Schema.decodeUnknownSync(LegacyIndexSchema)(fixture));
});

test("legacy index schema rejects backslash legacy paths", async () => {
  const fixture = JSON.parse(await readFile(legacyIndexValidUrl, "utf8")) as Record<string, any>;
  fixture.entries[0].storedPath = "harness/legacy/tasks\\outside.md";

  assert.throws(() => Schema.decodeUnknownSync(LegacyIndexSchema)(fixture));
});

test("legacy collision report schema decodes fixed no-overwrite policy", async () => {
  const fixture = JSON.parse(await readFile(collisionValidUrl, "utf8")) as unknown;
  const decoded = Schema.decodeUnknownSync(LegacyCollisionReportSchema)(fixture);
  const encoded = Schema.encodeSync(LegacyCollisionReportSchema)(decoded);

  assert.deepEqual(encoded, fixture);
});

test("legacy collision report schema rejects overwrite and custom suffix policy", async () => {
  const fixture = JSON.parse(await readFile(collisionInvalidUrl, "utf8")) as unknown;

  assert.throws(() => Schema.decodeUnknownSync(LegacyCollisionReportSchema)(fixture));
});

test("legacy collision report schema rejects overwrite-shaped entries", async () => {
  const fixture = JSON.parse(await readFile(collisionValidUrl, "utf8")) as Record<string, any>;
  fixture.entries[0].chosenPath = fixture.entries[0].targetPath;
  fixture.entries[0].suffixIndex = 0;

  assert.throws(() => Schema.decodeUnknownSync(LegacyCollisionReportSchema)(fixture));
});

test("legacy collision report schema rejects wrong suffix kind", async () => {
  const fixture = JSON.parse(await readFile(collisionValidUrl, "utf8")) as Record<string, any>;
  fixture.entries[0].kind = "directory";
  fixture.entries[0].chosenPath = "harness/legacy/docs/standards.legacy-import-1";

  assert.throws(() => Schema.decodeUnknownSync(LegacyCollisionReportSchema)(fixture));
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-layout-contract-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

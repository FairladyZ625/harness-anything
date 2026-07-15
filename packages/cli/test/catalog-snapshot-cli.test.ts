// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readCatalogSnapshot } from "../src/commands/extensions/catalog-snapshot.ts";

test("catalog snapshot reuses project-over-user-over-builtin preset resolution and real registries", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-catalog-snapshot-"));
  const previousUserHome = process.env.HARNESS_USER_HOME;
  process.env.HARNESS_USER_HOME = path.join(rootDir, ".empty-user-home");
  try {
    writeHarnessConfig(rootDir);
    writePreset(rootDir, ".harness/user-presets/standard-task/preset.json", "standard-task", "User Standard", "1.5.0");
    writePreset(rootDir, ".harness/user-presets/user-only/preset.json", "user-only", "User Only", "1.0.0");
    writePreset(rootDir, ".harness/presets/standard-task/preset.json", "standard-task", "Project Standard", "2.0.0");

    const snapshot = readCatalogSnapshot({ rootDir });
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    if (!snapshot.ok) return;

    const standard = snapshot.presets.find((preset) => preset.id === "standard-task");
    assert.equal(standard?.source, "project");
    assert.equal(standard?.title, "Project Standard");
    assert.equal(snapshot.presets.find((preset) => preset.id === "user-only")?.source, "user");
    assert.equal(snapshot.presets.find((preset) => preset.id === "module")?.source, "builtin");
    assert.equal(snapshot.activeVerticalId, "software/coding");
    assert.deepEqual(snapshot.verticals.map((vertical) => vertical.id), ["software/coding"]);
    assert.equal(snapshot.customVerticalsImplemented, false);
    assert.ok(snapshot.templates.length > 0);
    assert.deepEqual(snapshot.adapters.map((adapter) => adapter.id), ["local", "multica"]);
    assert.deepEqual(snapshot.adapters.map((adapter) => adapter.writable), [true, false]);
  } finally {
    if (previousUserHome === undefined) delete process.env.HARNESS_USER_HOME;
    else process.env.HARNESS_USER_HOME = previousUserHome;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function writeHarnessConfig(rootDir: string): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  writeFileSync(path.join(harnessRoot, "harness.yaml"), [
    "schema: harness-anything/v1",
    "layout:",
    "  authoredRoot: harness",
    "  localRoot: .harness",
    ""
  ].join("\n"), "utf8");
}

function writePreset(rootDir: string, relativePath: string, id: string, title: string, version: string): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({
    schema: "preset-manifest/v1",
    id,
    title,
    vertical: "software/coding",
    version,
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [],
    profiles: [{ id: "baseline", title: "Baseline", checkerProfile: "standard", templateSelections: [] }],
    defaultProfile: "baseline"
  }, null, 2), "utf8");
}

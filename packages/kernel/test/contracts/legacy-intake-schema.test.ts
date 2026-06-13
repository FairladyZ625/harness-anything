import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Schema } from "effect";
import { resolveHarnessLayout } from "../../src/layout/index.ts";
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

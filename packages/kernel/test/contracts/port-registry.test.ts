import assert from "node:assert/strict";
import test from "node:test";
import * as ports from "../../src/ports/index.ts";

// The kernel's cognitive boundary is exactly three ports (LifecycleEngine,
// ArtifactStore, TemplateLibrary) plus the WriteCoordinator write seam.
// Adding a tag here requires an ADR and a design-package decision-log entry
// before this list may change (03-system-architecture, decision log E10-E13).
const sanctionedPortTags = [
  "@harness-anything/kernel/ArtifactStore",
  "@harness-anything/kernel/LifecycleEngine",
  "@harness-anything/kernel/TemplateLibrary",
  "@harness-anything/kernel/WriteCoordinator"
];

function isContextTag(value: unknown): value is { key: string } {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { key?: unknown }).key === "string"
  );
}

test("ports expose exactly the sanctioned Context tags", () => {
  const exportedTagKeys = Object.values(ports)
    .filter(isContextTag)
    .map((tag) => tag.key)
    .sort();

  assert.deepEqual(exportedTagKeys, sanctionedPortTags);
});

test("the write seam is not injectable from the ports surface", () => {
  const exportNames = Object.keys(ports);
  assert.equal(exportNames.includes("ArtifactStoreWriter"), false);
  for (const value of Object.values(ports)) {
    if (isContextTag(value)) {
      assert.equal(/Writer/.test(value.key), false);
    }
  }
});

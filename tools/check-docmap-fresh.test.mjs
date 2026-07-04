import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkDocmapFresh } from "./check-docmap-fresh.mjs";

test("docmap freshness check fails when persisted manifest differs from derived canonical docs", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-docmap-fresh-"));
  try {
    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(path.join(harnessRoot, "adr"), { recursive: true });
    writeFileSync(path.join(harnessRoot, "AGENTS.md"), "# Agents\n");
    writeFileSync(path.join(harnessRoot, "adr", "ADR-0001-one.md"), "# ADR One\n");
    writeFileSync(path.join(harnessRoot, "docmap.json"), `${JSON.stringify({
      schema: "docmap/v1",
      documents: []
    }, null, 2)}\n`);

    const result = checkDocmapFresh(rootDir);

    assert.equal(result.ok, false);
    assert.equal(result.skipped, false);
    assert.match(result.message, /stale/u);
    assert.equal(result.diff?.some((line) => line.includes("adr:ADR-0001-one")), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("docmap freshness check skips public checkouts without private harness docmap", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-docmap-fresh-skip-"));
  try {
    const result = checkDocmapFresh(rootDir);

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

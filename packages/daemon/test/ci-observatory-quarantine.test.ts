// harness-test-tier: contract
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readCiObservatory } from "../src/ci-observatory-read.ts";

test("CI observatory fails closed on malformed quarantine ownership", () => {
  const rootDir = mkdtempSync(path.join(process.cwd(), ".tmp-ci-observatory-invalid-"));
  mkdirSync(path.join(rootDir, "tools"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "tools/test-quarantine.json"),
    JSON.stringify({
      schema: "harness-test-quarantine/v1",
      tests: [{ test: "x", ownerTask: "", quarantinedAt: "2026-08-01" }],
    }),
  );
  try {
    assert.throws(
      () =>
        readCiObservatory({
          rootDir,
          projection: {
            readCiRunObservations: () => ({ status: "ready", events: [], watermark: 0, sourceRevision: 0 }),
          } as never,
        }),
      /ownerTask/u,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CI observatory rejects quarantine ownership outside the two real task id shapes", () => {
  for (const ownerTask of ["task_owner1", "task_2301", "task_f7cc215a54a194898ad733c20"]) {
    const rootDir = mkdtempSync(path.join(process.cwd(), ".tmp-ci-observatory-shape-"));
    mkdirSync(path.join(rootDir, "tools"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "tools/test-quarantine.json"),
      JSON.stringify({
        schema: "harness-test-quarantine/v1",
        tests: [{ test: "x", ownerTask, quarantinedAt: "2026-08-01" }],
      }),
    );
    try {
      assert.throws(
        () =>
          readCiObservatory({
            rootDir,
            projection: {
              readCiRunObservations: () => ({ status: "ready", events: [], watermark: 0, sourceRevision: 0 }),
            } as never,
          }),
        /ownerTask/u,
        ownerTask,
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

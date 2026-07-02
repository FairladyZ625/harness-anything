import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { makeHumanFallbackSessionProbe, makeProvenanceSessionExporter } from "../src/index.ts";

test("provenance session exporter writes human fallback markdown and reads it by id", () => {
  const rootDir = createHarnessRoot();
  try {
    const exporter = makeProvenanceSessionExporter({
      rootInput: rootDir,
      currentSessionProbe: makeHumanFallbackSessionProbe({
        now: () => "2026-07-03T00:00:00.000Z",
        user: () => "zeyu"
      }),
      now: () => "2026-07-03T00:01:00.000Z"
    });

    const exported = Effect.runSync(exporter.exportCurrentSession());
    assert.equal(exported.path, "sessions/human-cli-1783036800000.md");
    assert.deepEqual(exported.session, {
      schema: "provenance-session/v1",
      sessionId: "human-cli-1783036800000",
      runtime: "human",
      source: "manual",
      detectedAt: "2026-07-03T00:00:00.000Z",
      exportedAt: "2026-07-03T00:01:00.000Z",
      user: "zeyu"
    });

    const sessionPath = path.join(rootDir, "harness", exported.path);
    assert.equal(existsSync(sessionPath), true);
    const body = readFileSync(sessionPath, "utf8");
    assert.match(body, /^schema: provenance-session\/v1$/m);
    assert.match(body, /^sessionId: human-cli-1783036800000$/m);
    assert.match(body, /^runtime: human$/m);
    assert.match(body, /^source: manual$/m);

    const readBack = Effect.runSync(exporter.readById("human-cli-1783036800000"));
    assert.deepEqual(readBack, exported);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provenance session exporter fails visibly for missing or unsafe session ids", () => {
  const rootDir = createHarnessRoot();
  try {
    const exporter = makeProvenanceSessionExporter({
      rootInput: rootDir,
      currentSessionProbe: makeHumanFallbackSessionProbe()
    });

    const missing = Effect.runSyncExit(exporter.readById("missing-session"));
    assert.equal(missing._tag, "Failure");
    assert.equal(String(missing.cause).includes("session not found: missing-session"), true);

    const unsafe = Effect.runSyncExit(exporter.readById("../escape"));
    assert.equal(unsafe._tag, "Failure");
    assert.equal(String(unsafe.cause).includes("invalid session id: ../escape"), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function createHarnessRoot(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-provenance-session-"));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n", "utf8");
  return rootDir;
}

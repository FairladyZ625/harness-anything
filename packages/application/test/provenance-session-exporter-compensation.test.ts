// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeProvenanceSessionExporter, readSessionEntity } from "../src/index.ts";
import {
  makeJournaledWriteCoordinator,
  makeMarkdownArtifactStore,
  type WriteAttribution,
  type WriteCoordinator,
  type WriteError
} from "../../kernel/src/index.ts";
import { runEffect } from "./effect-test-helpers.ts";

const testAttribution = {
  actor: { principal: { kind: "person", personId: "person_test" }, executor: { kind: "agent", id: "test" } },
  principalSource: { kind: "local-configured", authority: "harness.yaml", authoritySha256: "sha256:test" },
  executorSource: "client-asserted"
} as const satisfies WriteAttribution;

test("provenance session exporter never removes a pre-existing CAS body when a later write fails", async () => {
  const rootDir = createHarnessRoot();
  try {
    const logsRoot = path.join(rootDir, "runtime-logs", "codex");
    mkdirSync(logsRoot, { recursive: true });
    writeFileSync(path.join(logsRoot, "rollout-preexisting-body.jsonl"), [
      JSON.stringify({
        timestamp: "2026-07-03T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Shared immutable body." }
      }),
      ""
    ].join("\n"));
    const session = {
      runtime: "codex",
      sessionId: "preexisting-body",
      source: "runtime",
      detectedAt: "2026-07-03T00:00:00.000Z"
    } as const;
    const options = {
      currentSessionProbe: { currentSession: Effect.succeed(session) },
      runtimeLogRoots: { codex: [logsRoot] },
      now: () => "2026-07-03T00:01:00.000Z"
    } as const;
    const successful = makeProvenanceSessionExporter({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: testAttribution }),
      artifactStore: makeMarkdownArtifactStore({ rootDir }),
      ...options
    });
    await runEffect(successful.exportCurrentSession());
    const bodyRef = readSessionEntity(rootDir, session.sessionId).manifest.bodyRef;
    rmSync(path.join(rootDir, "harness", "sessions", `${session.sessionId}.md`));

    const error = { _tag: "WriteRejected", reason: "forced rejection" } satisfies WriteError;
    const failing = makeProvenanceSessionExporter({
      rootInput: rootDir,
      coordinator: failingCoordinator(error),
      artifactStore: makeMarkdownArtifactStore({ rootDir }),
      ...options
    });
    const result = await runEffect(Effect.either(failing.exportCurrentSession()));

    assert.equal(result._tag, "Left");
    assert.equal(existsSync(path.join(rootDir, bodyRef.ref)), true);
    assert.equal(readFileSync(path.join(rootDir, bodyRef.ref), "utf8").includes("Shared immutable body."), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function createHarnessRoot(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-provenance-compensation-"));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n", "utf8");
  return rootDir;
}

function failingCoordinator(error: WriteError): WriteCoordinator {
  return {
    enqueue: () => Effect.fail(error),
    flush: () => Effect.fail(error),
    recover: Effect.fail(error)
  };
}

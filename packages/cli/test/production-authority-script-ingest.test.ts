// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ParsedCommand } from "../src/cli/types.ts";
import { productionScriptIngestAttemptIntent } from "../src/daemon/production-authority-script-ingest.ts";

const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4";
const command: ParsedCommand = {
  rootDir: "/repo",
  json: true,
  action: {
    kind: "preset-entrypoint",
    presetId: "artifact-scaffold",
    entrypointName: "scaffold",
    entrypointType: "action",
    taskId,
    allowScripts: true,
    inputs: {}
  }
};

test("production script ingest admits one task-artifact batch as one semantic document mutation", () => {
  const authoredRoot = mkdtempSync(path.join(tmpdir(), "ha-script-ingest-"));
  try {
    const intent = productionScriptIngestAttemptIntent(command, operation([
      artifactWrite("report.md", "# Report\n"),
      artifactWrite("data.json", "{}\n")
    ]), authoredRoot);

    assert.equal(intent.commandName, "script.scope-ingest");
    assert.equal(intent.mutations.length, 1);
    assert.equal(intent.mutations[0]?.entity.canonicalRef, `task/${taskId}`);
    assert.equal(intent.mutations[0]?.action, "document");
    assert.deepEqual(intent.portablePaths.sort(), [
      `tasks/${taskId}/artifacts/data.json`,
      `tasks/${taskId}/artifacts/report.md`
    ]);
  } finally {
    rmSync(authoredRoot, { recursive: true, force: true });
  }
});

test("production script ingest admits the runtime batch for a slugged task package", () => {
  const authoredRoot = mkdtempSync(path.join(tmpdir(), "ha-script-ingest-"));
  try {
    const packageName = `${taskId}-architecture-rot-audit`;
    mkdirSync(path.join(authoredRoot, "tasks", packageName), { recursive: true });
    writeFileSync(path.join(authoredRoot, "tasks", packageName, "INDEX.md"), [
      "---",
      `task_id: ${taskId}`,
      "---",
      "# Architecture rot audit",
      ""
    ].join("\n"));
    const registryPath = `tasks/${packageName}/artifacts/.machine-evidence.registry.json`;
    const intent = productionScriptIngestAttemptIntent(command, operation([{
      path: registryPath,
      body: "{}\n",
      baseBlobSha256: null
    }]), authoredRoot);

    assert.deepEqual(intent.portablePaths, [registryPath]);
  } finally {
    rmSync(authoredRoot, { recursive: true, force: true });
  }
});

test("production script ingest fails closed outside the bound task artifact scope and on stale CAS", () => {
  const authoredRoot = mkdtempSync(path.join(tmpdir(), "ha-script-ingest-"));
  try {
    assert.throws(
      () => productionScriptIngestAttemptIntent(command, operation([{
        path: `tasks/${taskId}/INDEX.md`, body: "denied\n", baseBlobSha256: null
      }]), authoredRoot),
      /AUTHORITY_SCRIPT_SCOPE_PATH_DENIED/u
    );

    const artifactDir = path.join(authoredRoot, `tasks/${taskId}/artifacts`);
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(path.join(artifactDir, "report.md"), "current\n");
    assert.throws(
      () => productionScriptIngestAttemptIntent(command, operation([
        artifactWrite("report.md", "replacement\n")
      ]), authoredRoot),
      /AUTHORITY_SCRIPT_SCOPE_BASE_CAS_CONFLICT/u
    );
  } finally {
    rmSync(authoredRoot, { recursive: true, force: true });
  }
});

function artifactWrite(name: string, body: string) {
  return { path: `tasks/${taskId}/artifacts/${name}`, body, baseBlobSha256: null };
}

function operation(writes: ReadonlyArray<{ readonly path: string; readonly body: string; readonly baseBlobSha256: string | null }>) {
  return {
    opId: "script-test",
    entityId: `entity/script-run/${"a".repeat(32)}`,
    kind: "script_ingest" as const,
    payload: { writes }
  };
}

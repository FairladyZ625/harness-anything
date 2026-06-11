import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI creates a local task with stable JSON output", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["new-task", "task-1", "--title", "Task One"]);

    assert.deepEqual(result, {
      ok: true,
      command: "new-task",
      taskId: "task-1",
      status: "planned"
    });
    assert.match(readFileSync(path.join(rootDir, "tasks/task-1/INDEX.md"), "utf8"), /engine: local/);
    assert.match(readFileSync(path.join(rootDir, ".journal/writes.jsonl"), "utf8"), /"schema":"write-journal\/v1"/);
  });
});

test("CLI status set mutates local task state through the write journal", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["new-task", "task-1", "--title", "Task One"]);
    const result = runJson(rootDir, ["task", "status", "set", "task-1", "active"]);

    assert.equal(result.ok, true);
    assert.equal(result.status, "active");
    assert.match(readFileSync(path.join(rootDir, "tasks/task-1/INDEX.md"), "utf8"), /status: active/);
    assert.match(readFileSync(path.join(rootDir, ".journal/watermark.json"), "utf8"), /write-watermark\/v1/);
  });
});

test("CLI rejects invalid local lifecycle transitions with a stable error code", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["new-task", "task-1", "--title", "Task One"]);
    const failure = runJson(rootDir, ["task", "status", "set", "task-1", "done"], false);

    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "invalid_transition");
  });
});

test("CLI missing task errors do not leak local root paths", () => {
  withTempRoot((rootDir) => {
    const jsonFailure = runJson(rootDir, ["task", "status", "set", "missing-task", "active"], false);

    assert.equal(jsonFailure.ok, false);
    assert.equal(jsonFailure.error?.code, "task_not_found");
    assert.equal(JSON.stringify(jsonFailure).includes(rootDir), false);

    const humanFailure = runText(rootDir, ["task", "status", "set", "missing-task", "active"], false);
    assert.equal(humanFailure.includes(rootDir), false);
    assert.match(humanFailure, /task not found: missing-task/);
  });
});

test("CLI refuses to set status for non-local engine bindings", () => {
  withTempRoot((rootDir) => {
    mkdirSync(path.join(rootDir, "tasks/task-1"), { recursive: true });
    writeFileSync(path.join(rootDir, "tasks/task-1/INDEX.md"), [
      "---",
      "schema: task-package/v2",
      "task_id: task-1",
      "title: External Task",
      "lifecycle:",
      "  bindingSchema: lifecycle-binding/v1",
      "  engine: multica",
      "  status: active",
      "  ref: FAI-1",
      "  titleSnapshot: External Task",
      "  url: ",
      "  bindingCreatedAt: 2026-06-12T00:00:00.000Z",
      "  bindingFingerprint: sha256:external",
      "packageDisposition: active",
      "vertical: default",
      "preset: default",
      "---",
      ""
    ].join("\n"));

    const failure = runJson(rootDir, ["task", "status", "set", "task-1", "done"], false);

    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "engine_owns_status");
  });
});

test("CLI appends progress through the write journal", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["new-task", "task-1", "--title", "Task One"]);
    const result = runJson(rootDir, ["task", "progress", "append", "task-1", "--text", "Implemented local CLI"]);

    assert.equal(result.ok, true);
    assert.equal(result.path, "progress.md");
    assert.equal(readFileSync(path.join(rootDir, "tasks/task-1/progress.md"), "utf8"), "Implemented local CLI\n");
    const payloadBodies = readdirSync(path.join(rootDir, ".journal/payloads"))
      .map((entry) => readFileSync(path.join(rootDir, ".journal/payloads", entry), "utf8"));
    assert.equal(payloadBodies.some((body) => body.includes("\"path\":\"progress.md\"")), true);
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, unknown> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return JSON.parse(failure.stdout ?? "{}") as Record<string, unknown>;
  }
}

function runText(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): string {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return stdout;
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stderr?: string };
    return failure.stderr ?? "";
  }
}

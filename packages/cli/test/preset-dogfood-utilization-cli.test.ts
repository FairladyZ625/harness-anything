import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI dogfood utilization preset audits log-backed usage signals", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "harness/tasks/task-dogfood/INDEX.md", [
      "---",
      "schema: task-package/v2",
      "task_id: task-dogfood",
      "title: Dogfood fixture",
      "preset: standard-task",
      "---",
      "# Dogfood fixture",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/tasks/task-dogfood/artifacts/evidence.json", JSON.stringify({
      schema: "preset-script-output/v1",
      mode: "capability-smoke",
      presetId: "publish-standard",
      entrypoint: "scaffold",
      taskId: "task-dogfood"
    }, null, 2));
    writeFile(rootDir, ".harness/generated/runtime-events/session-1.jsonl", `${JSON.stringify({
      kind: "result",
      session: { sessionId: "session-1", runtime: "codex", taskId: "task-dogfood" },
      result: { status: "succeeded", summary: "CLI command succeeded: preset-action" }
    })}\n`);
    writeFile(rootDir, ".harness/generated/distill/task-dogfood/candidate.json", JSON.stringify({
      schema: "distill-candidate/v1",
      candidateId: "candidate",
      taskId: "task-dogfood"
    }, null, 2));

    const inspected = runJson(rootDir, ["preset", "inspect", "dogfood-utilization-audit"]);
    assert.equal(inspected.preset.kind, "process-action");
    assert.deepEqual(inspected.preset.entrypoints, ["audit"]);

    const listed = runJson(rootDir, ["script", "list", "--source", "preset", "--purpose", "audit"]);
    assert.equal(listed.scripts.some((script: Record<string, unknown>) => script.id === "preset:dogfood-utilization-audit:audit"), true);

    const unauthorized = runJson(rootDir, ["preset", "action", "dogfood-utilization-audit", "audit", "--task", "task-dogfood"], false);
    assert.equal(unauthorized.error.code, "preset_script_authorization_required");

    const blocked = runJson(rootDir, ["preset", "action", "dogfood-utilization-audit", "audit", "--task", "task-dogfood", "--allow-scripts"], false);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, "preset_script_result_failed");
    assert.equal(blocked.report.schema, "dogfood-utilization-audit/v1");
    assert.equal(blocked.report.status, "blocked");
    assert.equal(blocked.report.items.some((item: Record<string, any>) => item.id === "standard-task" && item.status === "green" && item.signals.taskUses === 1), true);
    assert.equal(blocked.report.items.some((item: Record<string, any>) => item.id === "publish-standard" && item.status === "green" && item.signals.presetEvidenceArtifacts === 1), true);
    assert.equal(blocked.report.items.some((item: Record<string, any>) => item.id === "runtime-events" && item.status === "green" && item.signals.rows === 1), true);
    assert.equal(blocked.report.orphanCandidates.some((item: Record<string, unknown>) => item.id === "module"), true);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-dogfood/artifacts/dogfood-utilization-audit.json")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-dogfood/artifacts/dogfood-utilization-audit.md")), true);
  });
});

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    const parsed = JSON.parse(output) as Record<string, any>;
    if (expectSuccess) assert.equal(parsed.ok, true, output);
    return unwrapCommandReceipt(parsed);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "harness-preset-dogfood-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}

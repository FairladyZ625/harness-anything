// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDocSyncSubmitRequest } from "@harness-anything/daemon";
import { cliDaemonServiceHostServices } from "../src/composition/daemon-service-host-services.ts";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const registryBody = readFileSync(path.join(repoRoot, "tools/write-road-registry.json"), "utf8");

test("doc sync selection diagnostics name only selected blockers and ignore unrelated machine products", () => {
  withFixture(({ rootDir, harnessRoot, taskId }) => {
    const selectedPath = `tasks/${taskId}/INDEX.md`;
    writeFileSync(path.join(harnessRoot, selectedPath), taskIndex("high"), "utf8");
    writeFileSync(path.join(harnessRoot, "unrelated-machine-output.log"), "machine output\n", "utf8");

    assert.throws(
      () => buildSelectedRequest(rootDir, [selectedPath]),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /selected path/i);
        assert.match(message, /INDEX\.md/u);
        assert.doesNotMatch(message, /unrelated-machine-output\.log/u);
        return true;
      }
    );
  });
});

test("doc sync submits a large selected file batch without importing unrelated machine products", () => {
  withFixture(({ rootDir, harnessRoot, taskId }) => {
    const selectedPaths = Array.from({ length: 12 }, (_, index) =>
      `tasks/${taskId}/artifacts/agent-note-${String(index + 1).padStart(2, "0")}.md`
    );
    for (const selectedPath of selectedPaths) {
      const absolutePath = path.join(harnessRoot, selectedPath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, `# Selected ${selectedPath}\n`, "utf8");
    }
    const unrelatedPaths = [
      ...Array.from({ length: 13 }, (_, index) => `governance/walls/reports/machine-${index + 1}.md`),
      ...Array.from({ length: 13 }, (_, index) => `context/benchmark/run-${index + 1}/launchd/stderr.log`)
    ];
    for (const unrelatedPath of unrelatedPaths) {
      const absolutePath = path.join(harnessRoot, unrelatedPath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, "third-party machine product\n", "utf8");
    }

    const request = buildSelectedRequest(rootDir, selectedPaths);
    assert.equal(request.payload.changes.length, 12);
    assert.deepEqual(request.payload.changes.map((change) => change.path).sort(), selectedPaths);
  });
});

function buildSelectedRequest(rootDir: string, selectedPaths: ReadonlyArray<string>) {
  return buildDocSyncSubmitRequest(
    rootDir,
    "canonical",
    selectedPaths,
    { kind: "agent", id: "codex-test" },
    cliDaemonServiceHostServices.docSync,
    { sessionId: "session-doc-sync-selection", runtime: "codex" }
  );
}

function withFixture(fn: (fixture: { readonly rootDir: string; readonly harnessRoot: string; readonly taskId: string }) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-sync-selection-"));
  const harnessRoot = path.join(rootDir, "harness");
  const taskId = "task_01KX3W4V1EDPHPTGWYYBQQ2J75";
  const taskRoot = path.join(harnessRoot, "tasks", taskId);
  try {
    mkdirSync(path.join(rootDir, "tools"), { recursive: true });
    writeFileSync(path.join(rootDir, "tools", "write-road-registry.json"), registryBody, "utf8");
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex("medium"), "utf8");
    writeFileSync(path.join(taskRoot, "task_plan.md"), "# Plan\n\n## Goal\nOriginal prose.\n", "utf8");
    initHarnessGit(harnessRoot);
    fn({ rootDir, harnessRoot, taskId });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function taskIndex(urgency: string): string {
  return [
    "---",
    "schema: task-package/v2",
    "task_id: task_01KX3W4V1EDPHPTGWYYBQQ2J75",
    "status: active",
    `urgency: ${urgency}`,
    "vertical: software/coding",
    "preset: standard-task",
    "---",
    "# Task",
    ""
  ].join("\n");
}

function initHarnessGit(harnessRoot: string): void {
  git(harnessRoot, "init");
  git(harnessRoot, "config", "user.name", "Harness Test");
  git(harnessRoot, "config", "user.email", "harness@example.test");
  git(harnessRoot, "add", ".");
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", "seed"], {
    stdio: "ignore",
    env: gitEnvironment(harnessRoot, {
      GIT_AUTHOR_NAME: "Harness Test",
      GIT_AUTHOR_EMAIL: "harness@example.test",
      GIT_COMMITTER_NAME: "Harness Test",
      GIT_COMMITTER_EMAIL: "harness@example.test"
    })
  });
}

function git(harnessRoot: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", harnessRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnvironment(harnessRoot)
  }).trimEnd();
}

function gitEnvironment(harnessRoot: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const emptyHome = path.join(harnessRoot, ".empty-home");
  mkdirSync(emptyHome, { recursive: true });
  const configPath = path.join(emptyHome, "empty.gitconfig");
  writeFileSync(configPath, "", "utf8");
  return {
    ...process.env,
    HOME: emptyHome,
    GIT_CONFIG_GLOBAL: configPath,
    ...overrides
  };
}

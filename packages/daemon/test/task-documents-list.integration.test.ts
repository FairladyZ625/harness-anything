// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { type RepoCellBinding } from "../src/repo-cell.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;

test("repo.tasks.documents.list returns package-relative projected documents including artifacts/", async () => {
  const repoId = "task-doc-list";
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-${repoId}-`));
  initRepo(rootDir);
  const cell = await openRepoCell({ repoId: workspaceId(repoId), rootDir: canonicalRoot(rootDir), ownerId: `daemon-${repoId}` });
  const binding: RepoCellBinding = { actor, source: "local" };
  try {
    assert.equal((await cell.run({ kind: "task-create", taskId: "task-doc", title: "Docs" }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-start", taskId: "task-doc", executionId: "execution-doc" }, binding)).outcome, "applied");
    // artifacts/ 文件走真实通道 task-artifact-add 进投影(destination 自动落 artifacts/)。
    writeFileSync(path.join(rootDir, "mission-report.md"), "# Report\n\nMission report.\n");
    const added = await cell.run({ kind: "task-artifact-add", taskId: "task-doc", source: "mission-report.md", destination: "report.md" }, binding);
    assert.equal(added.outcome, "applied", JSON.stringify(added));

    const listed = await cell.read("repo.tasks.documents.list", { taskId: "task-doc" });
    assert.equal(listed.ok, true);
    assert.equal(listed.taskId, "task-doc");
    const paths = listed.documents.map((row) => row.path);
    // 路径相对任务包根:不带 tasks/task-doc/ 前缀,不是绝对路径。
    assert.ok(paths.every((value) => !value.startsWith("/") && !value.startsWith("tasks/")));
    assert.ok(paths.includes("artifacts/report.md"));
    const artifact = listed.documents.find((row) => row.path === "artifacts/report.md");
    assert.equal(artifact?.mediaType, "text/markdown");
    assert.match(String(artifact?.blobSha256), /^[0-9a-f]{64}$/u);
    // 只列本任务包:其他任务的文档不得混入。
    assert.ok(paths.every((value) => !value.includes("task-doc-docs")));
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("repo.tasks.documents.list rejects an unknown task with task_not_found", async () => {
  const repoId = "task-doc-list-missing";
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-${repoId}-`));
  initRepo(rootDir);
  const cell = await openRepoCell({ repoId: workspaceId(repoId), rootDir: canonicalRoot(rootDir), ownerId: `daemon-${repoId}` });
  try {
    await assert.rejects(
      () => cell.read("repo.tasks.documents.list", { taskId: "task-missing" }),
      (error: unknown) => (error as { code?: string }).code === "task_not_found",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Task Doc List Test");
  git(rootDir, "config", "user.email", "task-doc-list@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
}

function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

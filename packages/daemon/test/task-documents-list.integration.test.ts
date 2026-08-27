// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const cell = await openRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(rootDir),
    ownerId: `daemon-${repoId}`,
  });
  const binding: RepoCellBinding = { actor, source: "local" };
  try {
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task-doc", title: "Docs" }, binding)).outcome,
      "applied",
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task-doc", executionId: "execution-doc" }, binding)).outcome,
      "applied",
    );
    // artifacts/ 文件走真实通道 task-artifact-add 进投影(destination 自动落 artifacts/)。
    writeFileSync(path.join(rootDir, "mission-report.md"), "# Report\n\nMission report.\n");
    const added = await cell.run(
      { kind: "task-artifact-add", taskId: "task-doc", source: "mission-report.md", destination: "report.md" },
      binding,
    );
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
  const cell = await openRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(rootDir),
    ownerId: `daemon-${repoId}`,
  });
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

test("task documents expose the live worktree copy and mark it uncommitted", async () => {
  const repoId = "task-doc-worktree";
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-${repoId}-`));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(rootDir),
    ownerId: `daemon-${repoId}`,
  });
  const binding: RepoCellBinding = { actor, source: "local" };
  try {
    const created = (await cell.run({ kind: "task-create", taskId: "task-doc", title: "Docs" }, binding)) as {
        readonly outcome: string;
        readonly packagePath?: string;
      },
      packagePath = String(created.packagePath);
    assert.equal(created.outcome, "applied");
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task-doc", executionId: "execution-doc" }, binding)).outcome,
      "applied",
    );
    const packageDir = path.join(rootDir, "harness", packagePath),
      planPath = path.join(packageDir, "task_plan.md"),
      scaffold = readFileSync(planPath, "utf8"),
      committedBody = `${scaffold}\n## Worker Notes\n\nCanonical body.\n`;
    writeFileSync(planPath, committedBody);
    const submitted = await cell.run({ kind: "doc-submit", paths: [`${packagePath}/task_plan.md`] }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));

    // 改前:工作树与已提交投影一致,不标未提交。
    const before = (await cell.read("repo.tasks.document.read", { taskId: "task-doc", path: "task_plan.md" })) as {
      readonly uncommitted: boolean;
      readonly worktreeBody: string | null;
    };
    assert.equal(before.uncommitted, false);
    assert.match(before.worktreeBody ?? "", /Canonical body/u);

    // 磁盘上直接改写(未 doc-sync):读面必须给出工作树实时内容并标注未提交。
    writeFileSync(planPath, committedBody.replace("Canonical body.", "Fresh worktree body."));
    const after = (await cell.read("repo.tasks.document.read", { taskId: "task-doc", path: "task_plan.md" })) as {
      readonly uncommitted: boolean;
      readonly worktreeBody: string | null;
      readonly body: string;
    };
    assert.equal(after.uncommitted, true);
    assert.match(after.worktreeBody ?? "", /Fresh worktree body/u);
    assert.match(after.body, /Canonical body/u);

    // 清单同样标注;新建(从未 sync)的文件也出现在清单里。
    mkdirSync(path.join(packageDir, "artifacts"), { recursive: true });
    writeFileSync(path.join(packageDir, "artifacts", "notes.md"), "# Notes\n");
    const listed = (await cell.read("repo.tasks.documents.list", { taskId: "task-doc" })) as {
      readonly documents: readonly { readonly path: string; readonly uncommitted: boolean }[];
    };
    const plan = listed.documents.find((row) => row.path === "task_plan.md");
    assert.equal(plan?.uncommitted, true);
    const fresh = listed.documents.find((row) => row.path === "artifacts/notes.md");
    assert.equal(fresh?.uncommitted, true);
    assert.equal((fresh as { readonly mediaType?: string } | undefined)?.mediaType, "text/markdown");
    const freshRead = (await cell.read("repo.tasks.document.read", {
      taskId: "task-doc",
      path: "artifacts/notes.md",
    })) as {
      readonly blobSha256: string | null;
      readonly uncommitted: boolean;
      readonly worktreeBody: string | null;
    };
    assert.equal(freshRead.blobSha256, null);
    assert.equal(freshRead.uncommitted, true);
    assert.match(freshRead.worktreeBody ?? "", /Notes/u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoCellBinding } from "../src/repo-cell.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import type { ArtifactsListResult } from "../src/protocol/artifacts-gui-contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;

test("repo.artifacts.list joins the ledger timeline across task packages", { timeout: 60_000 }, async () => {
  const repoId = "artifacts-gui-read";
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-${repoId}-`));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(rootDir),
    ownerId: `daemon-${repoId}`,
  });
  const binding: RepoCellBinding = { actor, source: "local" };
  try {
    const created = (await cell.run({ kind: "task-create", taskId: "task-artifact", title: "Artifacts" }, binding)) as {
      readonly outcome: string;
      readonly packagePath?: string;
    };
    assert.equal(created.outcome, "applied");
    const packagePath = String(created.packagePath);
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task-artifact", executionId: "execution-artifact" }, binding))
        .outcome,
      "applied",
    );
    // 台账侧:task-artifact-add 走真实 doc 事件(destination 自动落 artifacts/)。
    writeFileSync(path.join(rootDir, "weathering.html"), "<h1>Weathering escalation</h1>\n");
    writeFileSync(path.join(rootDir, "report.md"), "# Report\n\nMission report.\n");
    for (const destination of ["reports/weathering-escalation-decisions.html", "reports/report.md"]) {
      const source = destination.endsWith(".html") ? "weathering.html" : "report.md";
      assert.equal(
        (await cell.run({ kind: "task-artifact-add", taskId: "task-artifact", source, destination }, binding)).outcome,
        "applied",
      );
    }
    // 工作树侧:从未 doc-sync 的产物(mtime 来源)+ 非 artifacts/ 目录的 html(阴性)。
    const packageDir = path.join(rootDir, "harness", packagePath);
    writeFileSync(path.join(packageDir, "artifacts", "unsynced.html"), "<p>draft</p>\n");
    mkdirSync(path.join(packageDir, "docs"), { recursive: true });
    writeFileSync(path.join(packageDir, "docs", "not-an-artifact.html"), "<p>no</p>\n");

    const list = async (payload: Readonly<Record<string, unknown>> = {}): Promise<ArtifactsListResult> =>
      parseDaemonGuiReadResult("repo.artifacts.list", await cell.read("repo.artifacts.list", payload));

    const html = await list();
    assert.equal(html.ok, true);
    assert.equal(html.kind, "html");
    assert.equal(html.repoId, workspaceId(repoId));
    assert.deepEqual(html.counts, { html: 2, md: 1 });
    // 两个文件都产自本测试的"现在",先后取决于毫秒级时钟,断言集合而非顺序。
    const htmlPaths = [...html.artifacts.map((row) => row.path)].sort();
    assert.deepEqual(htmlPaths, ["artifacts/reports/weathering-escalation-decisions.html", "artifacts/unsynced.html"]);
    const committed = html.artifacts.find(
      (row) => row.path === "artifacts/reports/weathering-escalation-decisions.html",
    )!;
    assert.equal(committed.taskId, "task-artifact");
    assert.equal(committed.taskTitle, "Artifacts");
    assert.equal(committed.packagePath, packagePath);
    assert.equal(committed.timeSource, "ledger");
    assert.match(committed.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    const unsynced = html.artifacts.find((row) => row.path === "artifacts/unsynced.html")!;
    assert.equal(unsynced.timeSource, "mtime");
    assert.notEqual(unsynced.taskId, null);
    // 时间线整体按时间倒序。
    for (let index = 1; index < html.artifacts.length; index += 1)
      assert.ok(html.artifacts[index - 1]!.time >= html.artifacts[index]!.time, "timeline must be time-desc");
    // 非 artifacts/ 目录的 html 不得混入时间线。
    assert.ok(!htmlPaths.some((value) => value.includes("docs/")));

    const markdown = await list({ kind: "md" });
    assert.equal(markdown.kind, "md");
    assert.deepEqual(
      markdown.artifacts.map((row) => row.path),
      ["artifacts/reports/report.md"],
    );
    assert.equal(markdown.artifacts[0]!.timeSource, "ledger");
    assert.equal(markdown.artifacts[0]!.taskId, "task-artifact");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Artifacts GUI Test");
  git(rootDir, "config", "user.email", "artifacts-gui@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
}

function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

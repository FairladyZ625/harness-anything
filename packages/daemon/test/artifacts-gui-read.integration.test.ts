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
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
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
      readonly opId: string;
      readonly packagePath?: string;
    };
    assert.equal(created.outcome, "applied");
    const packagePath = String(created.packagePath);
    await waitForFixturePublication(cell, created.opId, binding);
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
    // 一份真实的二进制产物:UTF-8 解不开,只能按原始字节走 raw 策略。
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.from([0xff, 0xd8, 0x00, 0x80]),
      Buffer.from("\n%%EOF"),
    ]);
    writeFileSync(path.join(rootDir, "dossier.pdf"), pdf);
    const sources: Readonly<Record<string, string>> = {
      "reports/weathering-escalation-decisions.html": "weathering.html",
      "reports/report.md": "report.md",
      "reports/dossier.pdf": "dossier.pdf",
    };
    for (const destination of Object.keys(sources)) {
      const source = sources[destination]!;
      const added = await cell.run(
        { kind: "task-artifact-add", taskId: "task-artifact", source, destination },
        binding,
      );
      assert.equal(added.outcome, "applied", JSON.stringify(added));
      await waitForFixturePublication(cell, added.opId, binding);
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
    assert.deepEqual(html.counts, { html: 2, md: 1, raw: 1 });
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

    // raw 面:这条行以前根本不存在,时间线只认 html/md,已入账的 PDF 是不可见的。
    const raw = await list({ kind: "raw" });
    assert.equal(raw.kind, "raw");
    assert.deepEqual(
      raw.artifacts.map((row) => row.path),
      ["artifacts/reports/dossier.pdf"],
    );
    const dossier = raw.artifacts[0]!;
    assert.equal(dossier.mediaType, "application/octet-stream");
    assert.equal(dossier.sizeBytes, pdf.byteLength);
    assert.equal(dossier.taskId, "task-artifact");
    assert.equal(dossier.packagePath, packagePath);
    assert.equal(dossier.timeSource, "ledger", "an accepted raw artifact carries ledger time, not mtime");
    // 阴性:二进制行不得漏进文本面。
    assert.ok(!html.artifacts.some((row) => row.path.endsWith(".pdf")));
    assert.ok(!markdown.artifacts.some((row) => row.path.endsWith(".pdf")));
    // 行上的字节数与媒体类型是真的:与 document.read 的同一份内容对象一致。
    const read = (await cell.read("repo.tasks.document.read", {
      taskId: "task-artifact",
      path: "artifacts/reports/dossier.pdf",
    })) as { readonly contentKind: string; readonly size: number | null; readonly mediaType: string | null };
    assert.equal(read.contentKind, "binary");
    assert.equal(read.size, dossier.sizeBytes);
    assert.equal(read.mediaType, dossier.mediaType);
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

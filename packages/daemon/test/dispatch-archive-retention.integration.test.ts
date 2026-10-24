// harness-test-tier: integration
// 打开仓库(attach)是保留策略的唯一执行点:这里从真实 openRepoCell 走一遍,证明默认 60 天
// 设置在 attach 时删掉超期归档流、保留未超期的归档与仍在运行的 live 流。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { dispatchStreamPath, openDispatchStream } from "../src/dispatch-stream.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

function initRepo(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    [
      "schema: harness-anything/v1",
      "name: dispatch-retention-test",
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      "settings:",
      "  defaultVertical: software/coding",
      "  defaultPreset: standard-task",
      "  defaultProfile: baseline",
      "",
    ].join("\n"),
  );
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "--quiet");
  git("config", "user.name", "Retention Test");
  git("config", "user.email", "retention@example.invalid");
  git("add", "harness/harness.yaml");
  git("commit", "--quiet", "-m", "fixture");
}

function archivedStreamFixture(rootDir: string, dispatchId: string, ageDays: number): string {
  const at = new Date(Date.now() - ageDays * 86_400_000);
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: null,
    executionId: null,
    runtimeSessionId: `runtime-${dispatchId}`,
    instanceId: "instance-retention",
    startedAt: at.toISOString(),
  });
  const live = dispatchStreamPath(rootDir, dispatchId),
    archive = path.join(path.dirname(live), "archive"),
    archived = path.join(archive, `${dispatchId}.jsonl`);
  mkdirSync(archive, { recursive: true });
  renameSync(live, archived);
  utimesSync(archived, at, at);
  return archived;
}

test("opening a repository prunes archived dispatch streams past the default 60-day retention", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-dispatch-retention-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    const rootDir = canonicalRoot(root),
      expired = archivedStreamFixture(rootDir, "dispatch_0123456789abcdef01234567", 61),
      retained = archivedStreamFixture(rootDir, "dispatch_23456789abcdef0123456789", 30),
      liveId = "dispatch_456789abcdef0123456789ab";
    openDispatchStream(rootDir, {
      dispatchId: liveId,
      taskId: null,
      executionId: null,
      runtimeSessionId: "runtime-still-live",
      instanceId: "instance-retention",
      startedAt: new Date().toISOString(),
    });
    const liveFile = dispatchStreamPath(rootDir, liveId);

    cell = await openRepoCell({
      repoId: workspaceId("dispatch-retention"),
      rootDir,
      ownerId: "dispatch-retention-test",
    });

    // The prune rides the attach write queue; the observable is the file itself, not the queue
    // counter (which drops before the queued work runs).
    for (let round = 0; round < 500 && existsSync(expired); round += 1)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(existsSync(expired), false, "the 61-day-old archived stream is pruned at attach");
    assert.equal(existsSync(retained), true, "the 30-day-old archived stream is inside retention");
    assert.equal(existsSync(liveFile), true, "a still-live stream is never touched");
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

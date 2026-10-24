// harness-test-tier: integration
// 打开仓库(attach)是保留策略的唯一执行点:这里从真实 openRepoCell 走一遍,证明默认 60 天
// 设置在 attach 时删掉超期归档流、保留未超期的归档与仍在运行的 live 流。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { dispatchStreamPath, openDispatchStream } from "../src/dispatch-stream.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { actor } from "./task-surface.fixtures.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";

const binding = withPolicyGroup({ actor, source: "local" as const }, "contributor");

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
  // No mtime backdating: attach must age the stream from the header inside it.
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

    // The prune rides the attach write queue behind git-backed publication work; poll the file
    // itself (the queue counter drops before the queued work runs) with a bounded deadline.
    for (let round = 0; round < 150 && existsSync(expired); round += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(expired), false, "the 61-day-old archived stream is pruned at attach");
    assert.equal(existsSync(retained), true, "the 30-day-old archived stream is inside retention");
    assert.equal(existsSync(liveFile), true, "a still-live stream is never touched");
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Fact archived before attach still protects the expired stream its evidence names", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-dispatch-retention-archived-fact-")),
    factId = "F-0000ARCH",
    protectedId = "dispatch_1300000000000000000000ff";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    const rootDir = canonicalRoot(root),
      repoId = workspaceId("dispatch-retention-archived-fact");
    cell = await openRepoCell({ repoId, rootDir, ownerId: "dispatch-retention-archived-fact" });
    const fact = await cell.run(
        {
          kind: "fact-record",
          factId,
          statement: "This run's transcript is the evidence for the finding.",
          evidenceSource: `.harness/runtime/dispatches/archive/${protectedId}.jsonl`,
          confidence: "high",
          memoryClass: "episodic",
        },
        binding,
      ),
      archived = await cell.run({ kind: "fact-archive", factId, reason: "closeout bookkeeping" }, binding);
    assert.equal(fact.outcome, "applied", JSON.stringify(fact));
    assert.equal(archived.outcome, "applied", JSON.stringify(archived));
    await waitForFixturePublication(cell, archived.opId, binding);
    assert.equal(
      existsSync(path.join(rootDir, "harness", "facts", `${factId}.md`)),
      false,
      "archive retires the managed document; only the canonical row keeps the evidence source",
    );

    // Both streams appear after the Fact is already archived, so the attach prune below is the
    // first retention pass that can see this evidence — the exact case where a disk scan of
    // facts/*.md would have deleted the named stream.
    const protectedStream = archivedStreamFixture(rootDir, protectedId, 120),
      expired = archivedStreamFixture(rootDir, "dispatch_2400000000000000000000ff", 61);

    await cell.close();
    cell = await openRepoCell({ repoId, rootDir, ownerId: "dispatch-retention-archived-fact" });
    // The unprotected stream being gone is the proof the prune ran in this attach.
    for (let round = 0; round < 150 && existsSync(expired); round += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(expired), false, "the prune ran at this attach");
    assert.equal(existsSync(protectedStream), true, "an archived Fact's evidence still holds its stream back");
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

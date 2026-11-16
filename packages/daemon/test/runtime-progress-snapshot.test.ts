// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectRuntimeWorkspaceProgress, runtimeProgressSnapshot } from "../src/runtime-continuation-context.ts";
import { continuationMission } from "../src/runtime-spawn-fallback.ts";

const outcome = {
  classification: "provider_fault",
  reason: "断流😀".repeat(5000),
  provider: { instance: "fixture", model: "fixture", kind: "agy" },
  attemptGroupId: "group",
  attemptIndex: 0,
} as const;

test("fallback snapshot is deterministic and <=2048 UTF-8 bytes for oversized multibyte fields", () => {
  const workspace = { head: "abc1234 " + "提交😀".repeat(1000), changedFiles: 999999, unavailable: null },
    mission = continuationMission(outcome, "original mission", workspace, "implementation"),
    snapshot = mission.match(/<runtime-progress>[\s\S]*?<\/runtime-progress>/u)![0];
  assert.ok(Buffer.byteLength(snapshot, "utf8") <= 2048, String(Buffer.byteLength(snapshot)));
  assert.ok(Buffer.byteLength(mission, "utf8") <= 2048, "bounded continuation prefix plus the fixture mission");
  assert.equal(mission, continuationMission(outcome, "original mission", workspace, "implementation"));
  assert.match(snapshot, /Changed files: 999999/u);
  assert.match(snapshot, /Last attempt: provider_fault/u);
  assert.equal(snapshot.includes("\ufffd"), false);
  assert.ok(mission.endsWith("original mission"));
});

test("host snapshot counts a large porcelain file list without including filenames or diffs", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "runtime-progress-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    git("init", "-q");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "progress base",
    );
    for (let index = 0; index < 1200; index += 1)
      writeFileSync(path.join(cwd, `private-name-${index}`), "do not inline");
    const workspace = await collectRuntimeWorkspaceProgress(cwd),
      snapshot = runtimeProgressSnapshot({
        workspace,
        node: "implementation",
        classification: "gate_red",
        reason: outcome.reason,
      });
    assert.match(workspace.head!, /^[a-f0-9]+ progress base/u);
    assert.equal(workspace.changedFiles, 1200);
    assert.equal(workspace.unavailable, null);
    assert.ok(Buffer.byteLength(snapshot, "utf8") <= 2048);
    assert.doesNotMatch(snapshot, /private-name|do not inline/u);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("unavailable Git is reported explicitly without claiming zero changes", async () => {
  const workspace = await collectRuntimeWorkspaceProgress(tmpdir());
  assert.equal(workspace.changedFiles, null);
  assert.equal(workspace.head, null);
  assert.match(
    runtimeProgressSnapshot({ workspace, node: "review", classification: null, reason: null }),
    /Changed files: unavailable/u,
  );
});

// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createScheduleV1, type ScheduleV1 } from "../../kernel/src/index.ts";
import { dispatchClaimedSchedule } from "../src/schedule-action-runtime.ts";
import { launchArgs } from "../src/agent-runtime-launch-config.ts";
import {
  prepareScheduleOccurrenceWorkspace,
  settleScheduleOccurrenceWorkspace,
} from "../src/schedule-occurrence-workspace.ts";

test("detect occurrences use the canonical root without creating a worktree", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-schedule-detect-"));
  try {
    const workspace = prepareScheduleOccurrenceWorkspace(root, schedule("detect", "occurrence-detect"));
    assert.equal(workspace.cwd, root);
    assert.equal(workspace.runtime.worktree, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduled dispatch resolves writable roots against the canonical repository root", async () => {
  const root = path.join(tmpdir(), "ha-schedule-canonical"),
    occurrence = path.join(root, ".worktrees", "occ-backup"),
    created = createScheduleV1({
      scheduleId: "backup",
      name: "Backup",
      mode: "remediate",
      spec: {
        trigger: { kind: "interval", everyMs: 60_000, anchorAt: "2026-09-15T00:00:00.000Z" },
        target: { kind: "agent", agentId: "backup-agent", runtimeInstanceId: "codex-backup" },
        mission: "Back up the ledger.",
        writableRoots: ["tmp/harness-backup", ".harness/restore-drills"],
      },
      actor: { principal: { personId: "schedule-test" }, executor: null },
      occurredAt: "2026-09-15T00:00:00.000Z",
    }),
    claimed = {
      ...created,
      status: {
        ...created.status,
        activeRun: {
          occurrenceId: "occ-backup",
          kind: "manual" as const,
          scheduledFor: "2026-09-15T00:00:00.000Z",
          claimedAt: "2026-09-15T00:00:00.000Z",
          nodeId: "local",
          assignmentId: null,
          claimFence: "claim-backup",
          attemptIndex: 0,
        },
      },
    };
  let spawned: Parameters<Parameters<typeof dispatchClaimedSchedule>[0]["spawn"]>[0] | null = null,
    argv: readonly string[] = [];
  await dispatchClaimedSchedule({
    schedule: claimed,
    workspace: {
      rootDir: root,
      cwd: occurrence,
      runtime: {
        scheduleId: "backup",
        occurrenceId: "occ-backup",
        claimFence: "claim-backup",
        mode: "remediate",
      },
    },
    idempotencyKey: "dispatch-backup",
    now: () => "2026-09-15T00:01:00.000Z",
    spawn: async (value) => {
      spawned = value;
      argv = launchArgs(
        {
          schemaVersion: 2,
          instanceId: "codex-backup",
          name: "Codex Backup",
          kindId: "codex",
          installationId: "codex-installation",
          providerId: "openai",
          models: ["gpt-5.6-sol"],
          defaultModel: "gpt-5.6-sol",
          enabled: true,
          isolationState: "enforced",
          auth: { mode: "subscription" },
          codex: {},
        },
        "gpt-5.6-sol",
        value.mission,
        undefined,
        null,
        "workspace-write",
        false,
        value.writableRoots,
      );
      return { outcome: "applied", dispatchId: "dispatch-backup", runtimeSessionId: "runtime-backup" };
    },
    linkDispatch: async () => ({ outcome: "applied" }),
    settleFailure: async () => ({ outcome: "applied" }),
  });
  assert.equal(spawned?.cwd, occurrence);
  assert.deepEqual(spawned?.writableRoots, [
    path.join(root, "tmp", "harness-backup"),
    path.join(root, ".harness", "restore-drills"),
  ]);
  assert.deepEqual(argv.slice(0, 12), [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--config",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "--config",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    "--add-dir",
    path.join(root, "tmp", "harness-backup"),
    "--add-dir",
    path.join(root, ".harness", "restore-drills"),
  ]);
});

test("remediate occurrences start from origin/main and clean empty worktrees", () => {
  const fixture = repositoryFixture();
  try {
    const workspace = prepareScheduleOccurrenceWorkspace(fixture.root, schedule("remediate", "occurrence-clean"));
    assert.equal(git(workspace.cwd, "rev-parse", "HEAD"), git(fixture.root, "rev-parse", "origin/main"));
    assert.equal(settleScheduleOccurrenceWorkspace(fixture.root, workspace.runtime).retainedDetail, null);
    assert.equal(existsSync(workspace.cwd), false);
    assert.throws(() => git(fixture.root, "rev-parse", "occ-occurrence-clean"));
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

for (const change of ["dirty", "commit"] as const)
  test(`remediate occurrences retain a ${change} worktree and name its path`, () => {
    const fixture = repositoryFixture();
    try {
      const workspace = prepareScheduleOccurrenceWorkspace(fixture.root, schedule("remediate", `occurrence-${change}`));
      writeFileSync(path.join(workspace.cwd, "result.txt"), change);
      if (change === "commit") {
        git(workspace.cwd, "add", "result.txt");
        git(workspace.cwd, "commit", "-qm", "occurrence result");
      }
      const detail = settleScheduleOccurrenceWorkspace(fixture.root, workspace.runtime).retainedDetail;
      assert.equal(detail?.includes(workspace.cwd), true);
      assert.equal(existsSync(workspace.cwd), true);
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });

function schedule(mode: "detect" | "remediate", occurrenceId: string): ScheduleV1 {
  return {
    scheduleId: "workspace-test",
    mode,
    status: { activeRun: { occurrenceId, claimFence: `claim-${occurrenceId}` } },
  } as ScheduleV1;
}

function repositoryFixture(): { readonly base: string; readonly root: string } {
  const base = mkdtempSync(path.join(tmpdir(), "ha-schedule-workspace-")),
    remote = path.join(base, "remote.git"),
    root = path.join(base, "canonical");
  git(base, "init", "--bare", "-q", remote);
  git(base, "init", "-q", "-b", "main", root);
  git(root, "config", "user.name", "Schedule Test");
  git(root, "config", "user.email", "schedule@example.invalid");
  writeFileSync(path.join(root, "README.md"), "base\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "base");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
  return { base, root };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

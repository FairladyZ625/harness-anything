// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createScheduleV1, type ScheduleV1 } from "@harness-anything/kernel";
import { dispatchClaimedSchedule } from "../src/schedule-action-runtime.ts";
import { launchArgs } from "../src/agent-runtime-launch-config.ts";
import {
  prepareScheduleOccurrenceWorkspace,
  settleScheduleOccurrenceWorkspace,
} from "../src/schedule-occurrence-workspace.ts";
import { nodeModulesSetupAdapter } from "../src/worktree-setup-node-modules.ts";

test("detect occurrences use the canonical root without creating a worktree", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-schedule-detect-"));
  try {
    // A detect occurrence makes no worktree, so it never reads the setup (an unbootstrapped repository has none).
    const workspace = await prepareScheduleOccurrenceWorkspace(root, schedule("detect", "occurrence-detect"), () => {
      throw new Error("detect read the worktree setup");
    });
    assert.equal(workspace.cwd, root);
    assert.equal(workspace.runtime.worktree, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduled dispatch spawns from the occurrence workspace without extra writable roots", async () => {
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
      );
      return { outcome: "applied", dispatchId: "dispatch-backup", runtimeSessionId: "runtime-backup" };
    },
    linkDispatch: async () => ({ outcome: "applied" }),
    settleFailure: async () => ({ outcome: "applied" }),
  });
  assert.equal(spawned?.cwd, occurrence);
  assert.equal("writableRoots" in (spawned ?? {}), false);
  assert.deepEqual(argv.slice(0, 8), [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--config",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "--config",
    "sandbox_workspace_write.exclude_slash_tmp=true",
  ]);
  assert.equal(argv.includes("--add-dir"), false);
});

test("remediate occurrences start from the default branch and clean empty worktrees", async () => {
  const fixture = repositoryFixture();
  try {
    const workspace = await prepareScheduleOccurrenceWorkspace(
      fixture.root,
      schedule("remediate", "occurrence-clean"),
      () => [],
    );
    assert.equal(workspace.runtime.worktree?.baseRef, "origin/main");
    assert.equal(git(workspace.cwd, "rev-parse", "HEAD"), git(fixture.root, "rev-parse", "origin/main"));
    assert.equal((await settleScheduleOccurrenceWorkspace(fixture.root, workspace.runtime)).detail, null);
    assert.equal(existsSync(workspace.cwd), false);
    assert.throws(() => git(fixture.root, "rev-parse", "occ-occurrence-clean"));
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("remediate occurrences retain a dirty worktree and name its path", async () => {
  const fixture = repositoryFixture();
  try {
    const workspace = await prepareScheduleOccurrenceWorkspace(
      fixture.root,
      schedule("remediate", "occurrence-dirty"),
      () => [],
    );
    writeFileSync(path.join(workspace.cwd, "result.txt"), "dirty");
    const detail = (await settleScheduleOccurrenceWorkspace(fixture.root, workspace.runtime)).detail;
    assert.equal(detail, `Occurrence worktree retained at ${workspace.cwd} (uncommitted changes).`);
    assert.equal(existsSync(workspace.cwd), true);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("remediate occurrences keep unmerged commits at an archive tag before removing the worktree", async () => {
  const fixture = repositoryFixture();
  try {
    const workspace = await prepareScheduleOccurrenceWorkspace(
      fixture.root,
      schedule("remediate", "occurrence-commit"),
      () => [],
    );
    writeFileSync(path.join(workspace.cwd, "result.txt"), "commit");
    git(workspace.cwd, "add", "result.txt");
    git(workspace.cwd, "commit", "-qm", "occurrence result");
    const head = git(workspace.cwd, "rev-parse", "HEAD"),
      detail = (await settleScheduleOccurrenceWorkspace(fixture.root, workspace.runtime)).detail;
    assert.equal(
      detail,
      `Occurrence worktree ${workspace.cwd} removed; 1 unmerged commit kept at tag archive/wt-occ-occurrence-commit.`,
    );
    assert.equal(existsSync(workspace.cwd), false);
    assert.equal(git(fixture.root, "rev-parse", "archive/wt-occ-occurrence-commit^{commit}"), head);
    assert.throws(() => git(fixture.root, "rev-parse", "--verify", "refs/heads/occ-occurrence-commit"));
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("the node-modules setup resolves workspace packages in the worktree and shares the rest of the store", async () => {
  const fixture = repositoryFixture();
  try {
    const store = storeFixture(fixture.root),
      workspace = await prepareScheduleOccurrenceWorkspace(
        fixture.root,
        schedule("remediate", "occurrence-deps"),
        () => ["node-modules"],
      ),
      resolve = createRequire(path.join(workspace.cwd, "index.js")).resolve;
    assert.equal(resolve("@fixture/pkg"), path.join(realpathSync(workspace.cwd), "packages", "pkg", "index.js"));
    assert.equal(resolve("sentinel-pkg"), path.join(realpathSync(store), "sentinel-pkg", "index.js"));
    assert.equal(realpathSync(path.join(workspace.cwd, "node_modules", ".bin", "pkg")), resolve("@fixture/pkg"));
    // The mirrored store is the adapter's own doing: it neither marks the worktree dirty nor blocks removal.
    assert.equal((await settleScheduleOccurrenceWorkspace(fixture.root, workspace.runtime)).detail, null);
    assert.equal(existsSync(workspace.cwd), false);
    assert.equal(existsSync(path.join(store, "sentinel-pkg", "index.js")), true);
    assert.equal(existsSync(path.join(store, "@fixture", "pkg", "index.js")), true);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("the mirrored store is removed at reclaim even where node_modules is not ignored", async () => {
  const fixture = repositoryFixture({ ignoreNodeModules: false });
  try {
    const store = storeFixture(fixture.root),
      workspace = await prepareScheduleOccurrenceWorkspace(
        fixture.root,
        schedule("remediate", "occurrence-bare"),
        () => ["node-modules"],
      );
    assert.equal(git(workspace.cwd, "status", "--porcelain"), "?? node_modules/");
    assert.equal((await settleScheduleOccurrenceWorkspace(fixture.root, workspace.runtime)).detail, null);
    assert.equal(existsSync(workspace.cwd), false);
    assert.equal(existsSync(path.join(store, "sentinel-pkg", "index.js")), true);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("a repository that declares no setup gets a bare worktree, even with a root node_modules", async () => {
  const fixture = repositoryFixture();
  try {
    storeFixture(fixture.root);
    const workspace = await prepareScheduleOccurrenceWorkspace(
      fixture.root,
      schedule("remediate", "occurrence-nodeps"),
      () => [],
    );
    assert.equal(existsSync(path.join(workspace.cwd, "node_modules")), false);
    assert.equal((await settleScheduleOccurrenceWorkspace(fixture.root, workspace.runtime)).detail, null);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("a failing setup step fails the occurrence workspace and names the step and its log", async () => {
  const fixture = repositoryFixture();
  try {
    await assert.rejects(
      prepareScheduleOccurrenceWorkspace(fixture.root, schedule("remediate", "occurrence-failed"), () => [
        "run: exit 3",
      ]),
      /setup step 1 \(run: exit 3\) failed: exit code 3\. Log: .*harness-setup\/step-1\.log\./u,
    );
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test(
  "a node_modules mirror that cannot be written fails the adapter and leaves no half-made store",
  { skip: process.platform === "win32" },
  () => {
    const fixture = repositoryFixture(),
      worktree = mkdtempSync(path.join(fixture.base, "wt-"));
    try {
      mkdirSync(path.join(fixture.root, "node_modules"));
      chmodSync(worktree, 0o555);
      assert.throws(() => nodeModulesSetupAdapter.prepare({ rootDir: fixture.root, cwd: worktree }), /EACCES/u);
      assert.equal(existsSync(path.join(worktree, "node_modules")), false);
      chmodSync(worktree, 0o755);
      nodeModulesSetupAdapter.prepare({ rootDir: fixture.root, cwd: worktree });
      assert.equal(lstatSync(path.join(worktree, "node_modules")).isDirectory(), true);
    } finally {
      chmodSync(worktree, 0o755);
      rmSync(fixture.base, { recursive: true, force: true });
    }
  },
);

function schedule(mode: "detect" | "remediate", occurrenceId: string): ScheduleV1 {
  return {
    scheduleId: "workspace-test",
    mode,
    status: { activeRun: { occurrenceId, claimFence: `claim-${occurrenceId}` } },
  } as ScheduleV1;
}

function repositoryFixture({ ignoreNodeModules = true } = {}): { readonly base: string; readonly root: string } {
  const base = mkdtempSync(path.join(tmpdir(), "ha-schedule-workspace-")),
    remote = path.join(base, "remote.git"),
    root = path.join(base, "canonical");
  git(base, "init", "--bare", "-q", remote);
  git(base, "init", "-q", "-b", "main", root);
  git(root, "config", "user.name", "Schedule Test");
  git(root, "config", "user.email", "schedule@example.invalid");
  writeFileSync(path.join(root, "README.md"), "base\n");
  // Same form as this repository: a trailing slash matches directories only.
  writeFileSync(path.join(root, ".gitignore"), `${ignoreNodeModules ? "node_modules/\n" : ""}.worktrees\n`);
  mkdirSync(path.join(root, "packages", "pkg"), { recursive: true });
  writeFileSync(path.join(root, "packages", "pkg", "package.json"), '{ "name": "@fixture/pkg" }\n');
  writeFileSync(path.join(root, "packages", "pkg", "index.js"), "module.exports = 'pkg';\n");
  git(root, "add", "README.md", ".gitignore", "packages");
  git(root, "commit", "-qm", "base");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
  return { base, root };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** An installed store in npm's shape: third-party packages as directories, workspaces and bins as relative links. */
function storeFixture(root: string): string {
  const store = path.join(root, "node_modules");
  mkdirSync(path.join(store, "sentinel-pkg"), { recursive: true });
  writeFileSync(path.join(store, "sentinel-pkg", "index.js"), "module.exports = 'sentinel';\n");
  mkdirSync(path.join(store, "@fixture"));
  symlinkSync(path.join("..", "..", "packages", "pkg"), path.join(store, "@fixture", "pkg"));
  mkdirSync(path.join(store, ".bin"));
  symlinkSync(path.join("..", "@fixture", "pkg", "index.js"), path.join(store, ".bin", "pkg"));
  return store;
}

// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  defaultDaemonUserRoot,
  runDaemonCommand,
  runRawJson,
  stopDaemon,
  withTempRootAsync
} from "./helpers/daemon-cli.ts";
import {
  forcedCommandRequest,
  receiptDataString,
  writeForcedCommandTeamRoster
} from "./helpers/forced-command-daemon.ts";

test("forced-command progress writes preserve the thin-client executor in the task lease", async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = defaultDaemonUserRoot(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_ACTOR: "agent:test", HARNESS_DAEMON_MODE: "fixture", HARNESS_DAEMON_USER_ROOT: userRoot });
    const created = runRawJson(rootDir, ["new-task", "--title", "Lease Executor Refresh"], {
      HARNESS_ACTOR: "agent:test",
      HARNESS_DAEMON_MODE: "fixture",
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    enableLeaseEnforcement(rootDir);
    writeForcedCommandTeamRoster(rootDir);

    try {
      runDaemonCommand(rootDir, ["daemon", "start", "--service", "--json"], { HARNESS_DAEMON_USER_ROOT: userRoot });
      const taskId = receiptDataString(created, "taskId");
      const codex = { kind: "agent", id: "codex" } as const;
      const claude = { kind: "agent", id: "claude-code" } as const;
      const claimed = await forcedCommandRequest(rootDir, userRoot, "person_alice", "repo.task.claim", {
        repo: { repoId: "canonical", canonicalRoot: rootDir },
        payload: { taskId, executor: codex, ttlMs: 60_000 }
      });
      assert.equal(claimed.ok, true, JSON.stringify(claimed));

      const progressed = await forcedCommandRequest(rootDir, userRoot, "person_alice", "repo.command.run", {
        repo: { repoId: "canonical", canonicalRoot: rootDir },
        payload: {
          command: {
            rootDir,
            json: true,
            action: { kind: "progress-append", taskId, text: "refresh lease", evidence: [], dryRun: false }
          },
          executor: codex
        }
      });
      assert.equal(progressed.ok, true, JSON.stringify(progressed));

      const holder = await forcedCommandRequest(rootDir, userRoot, "person_alice", "repo.task.holder", {
        repo: { repoId: "canonical", canonicalRoot: rootDir },
        payload: { taskId }
      });
      const effectiveHolder = (((holder.details as Record<string, unknown>).data as Record<string, unknown>).effectiveHolder as Record<string, unknown>);
      assert.deepEqual(effectiveHolder.executor, codex);

      const collision = await forcedCommandRequest(rootDir, userRoot, "person_bob", "repo.task.claim", {
        repo: { repoId: "canonical", canonicalRoot: rootDir },
        payload: { taskId, executor: claude, ttlMs: 60_000 }
      });
      assert.equal(collision.ok, false);
      assert.match((collision.error as { hint?: string }).hint ?? "", /current holder principal=person_alice, executor=agent:codex/u);
    } finally {
      await stopDaemon(rootDir, userRoot);
    }
  });
});

function enableLeaseEnforcement(rootDir: string): void {
  const harnessRoot = path.join(rootDir, "harness");
  const configPath = path.join(harnessRoot, "harness.yaml");
  const config = readFileSync(configPath, "utf8");
  writeFileSync(configPath, `${config.trimEnd()}\n  tasks:\n    leaseEnforcement: true\n`, "utf8");
  git(harnessRoot, "add", "harness.yaml");
  git(harnessRoot, "commit", "-m", "test: enable task lease enforcement");
}

function git(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: path.join(rootDir, ".home"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Lease Executor Fixture",
      GIT_AUTHOR_EMAIL: "lease-executor-fixture@example.com",
      GIT_COMMITTER_NAME: "Lease Executor Fixture",
      GIT_COMMITTER_EMAIL: "lease-executor-fixture@example.com"
    }
  }).trim();
}

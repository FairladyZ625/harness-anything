// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  pollUntil,
  runDaemonCommand,
  runRawJson,
  runRawJsonMaybeFail,
  stopDaemon,
  withTempRoot,
  withTempRootAsync
} from "./helpers/daemon-cli.ts";
import { daemonStatusRepoIds, daemonStatusRepos } from "./helpers/daemon-thin-client-fixtures.ts";

test("daemon client fails unregistered cwd in multi-repo registry with register hint", () => {
  withTempRoot((workspaceRoot) => {
    const userRoot = path.join(workspaceRoot, "user-daemon");
    const alphaRoot = path.join(workspaceRoot, "alpha");
    const betaRoot = path.join(workspaceRoot, "beta");
    const outsiderRoot = path.join(workspaceRoot, "outsider");
    for (const rootDir of [alphaRoot, betaRoot, outsiderRoot]) {
      mkdirSync(rootDir, { recursive: true });
      runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture", HARNESS_DAEMON_USER_ROOT: userRoot });
    }
    registerRepo(alphaRoot, userRoot, "alpha");
    registerRepo(betaRoot, userRoot, "beta");

    const failed = runRawJsonMaybeFail(outsiderRoot, ["task", "list"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_USER_ROOT: userRoot
    });

    assert.notEqual(failed.status, 0);
    assert.equal(failed.receipt.ok, false);
    assert.match(((failed.receipt.error as Record<string, unknown>).hint as string), /ha daemon repo register --repo-id <id> --root/u);
  });
});

test("daemon client --repo override targets a registered repo from a different cwd", async () => {
  await withTempRootAsync(async (workspaceRoot) => {
    const userRoot = path.join(workspaceRoot, "user-daemon");
    const alphaRoot = path.join(workspaceRoot, "alpha");
    const betaRoot = path.join(workspaceRoot, "beta");
    try {
      for (const rootDir of [alphaRoot, betaRoot]) {
        mkdirSync(rootDir, { recursive: true });
        runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture", HARNESS_DAEMON_USER_ROOT: userRoot });
      }
      registerRepo(alphaRoot, userRoot, "alpha");
      registerRepo(betaRoot, userRoot, "beta");

      const listed = runRawJson(betaRoot, ["--repo", "alpha", "task", "list"], {
        HARNESS_DAEMON_MODE: "local",
        HARNESS_DAEMON_USER_ROOT: userRoot,
        HARNESS_DAEMON_IDLE_MS: "60000"
      });
      assert.equal(listed.ok, true);

      const status = await pollUntil(
        () => runDaemonCommand(betaRoot, ["--repo", "alpha", "daemon", "status", "--user-root", userRoot, "--json"], {
          HARNESS_DAEMON_USER_ROOT: userRoot
        }),
        (candidate) => candidate.repoId === "alpha" && (candidate.repos as Array<{ repoId: string }>).length === 2,
        (candidate, error) => JSON.stringify({ candidate, error: String(error ?? ""), listed })
      );
      assert.equal(status.rootDir, realpathSync.native(alphaRoot));
      assert.deepEqual((status.repos as Array<{ repoId: string }>).map((repo) => repo.repoId), ["alpha", "beta"]);
    } finally {
      await stopDaemon(betaRoot, userRoot);
    }
  });
});

test("daemon service reconciles registry register and unregister changes", async () => {
  await withTempRootAsync(async (workspaceRoot) => {
    const userRoot = path.join(workspaceRoot, "user-daemon");
    const alphaRoot = path.join(workspaceRoot, "alpha");
    const betaRoot = path.join(workspaceRoot, "beta");
    for (const rootDir of [alphaRoot, betaRoot]) {
      mkdirSync(rootDir, { recursive: true });
      runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture", HARNESS_DAEMON_USER_ROOT: userRoot });
    }
    registerRepo(alphaRoot, userRoot, "alpha");

    try {
      const listed = runRawJson(alphaRoot, ["task", "list"], {
        HARNESS_DAEMON_MODE: "local",
        HARNESS_DAEMON_USER_ROOT: userRoot,
        HARNESS_DAEMON_IDLE_MS: "15000"
      });
      assert.equal(listed.ok, true);
      assert.deepEqual(daemonStatusRepoIds(alphaRoot, userRoot, "alpha"), ["alpha"]);

      registerRepo(betaRoot, userRoot, "beta");
      await pollUntil(
        () => daemonStatusRepoIds(alphaRoot, userRoot, "alpha"),
        (repoIds) => repoIds.includes("beta"),
        (repoIds, error) => JSON.stringify({ repoIds, error: String(error ?? "") })
      );

      runDaemonCommand(betaRoot, ["daemon", "repo", "unregister", "--repo-id", "beta", "--user-root", userRoot, "--no-link", "--json"], {
        HARNESS_DAEMON_USER_ROOT: userRoot
      });
      await pollUntil(
        () => daemonStatusRepos(alphaRoot, userRoot, "alpha").find((repo) => repo.repoId === "beta")?.state,
        (state) => state === "detached",
        (state, error) => JSON.stringify({ state, error: String(error ?? "") })
      );
    } finally {
      await stopDaemon(alphaRoot, userRoot);
    }
  });
});

test("daemon repo commands register list and unregister the user-level registry", () => {
  withTempRoot((rootDir) => {
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "schema: harness-anything/v1\n", "utf8");
    const userRoot = path.join(rootDir, "user-harness");

    const register = runDaemonCommand(rootDir, [
      "daemon", "repo", "register", "--repo-id", "canonical", "--display-name", "Canonical",
      "--user-root", userRoot, "--no-link", "--json"
    ]);
    assert.equal(register.ok, true);
    assert.equal((register.repo as { repoId?: string }).repoId, "canonical");
    assert.equal((register.repo as { state?: string }).state, "enabled");

    const list = runDaemonCommand(rootDir, ["daemon", "repo", "list", "--user-root", userRoot, "--json"]);
    assert.equal(list.ok, true);
    assert.equal(list.count, 1);
    assert.deepEqual((list.repos as Array<{ repoId: string; state: string }>).map((repo) => [repo.repoId, repo.state]), [["canonical", "enabled"]]);

    const unregister = runDaemonCommand(rootDir, ["daemon", "repo", "unregister", "--repo-id", "canonical", "--user-root", userRoot, "--no-link", "--json"]);
    assert.equal(unregister.ok, true);
    assert.equal((unregister.repo as { state?: string }).state, "disabled");
  });
});

function registerRepo(rootDir: string, userRoot: string, repoId: string): void {
  runDaemonCommand(rootDir, [
    "daemon", "repo", "register", "--repo-id", repoId, "--root", rootDir,
    "--user-root", userRoot, "--no-link", "--json"
  ], { HARNESS_DAEMON_USER_ROOT: userRoot });
}

// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { daemonCliBinDirectory, prepareBoundRuntimeLaunch } from "../src/runtime-spawn-context.ts";
import type { RuntimeSpawnerInput } from "../src/runtime-spawn-types.ts";
import { resolveDispatchCwd } from "../src/runtime-resume-admission.ts";

test("an unbound runtime inherits its spawning daemon route and runtime actor", async () => {
  const prepared = {
      env: { HOME: "/isolated/home", PATH: "/provider/bin" },
    } as Parameters<typeof prepareBoundRuntimeLaunch>[0]["prepared"],
    launch = await prepareBoundRuntimeLaunch({
      input: { rootDir: "/repo", repoId: "repo", now: () => new Date().toISOString() } as RuntimeSpawnerInput,
      prepared,
      daemonRoute: { userRoot: "/operator/state", daemonId: "studio", endpoint: "/daemon.sock" },
      cliBinDir: "/installation/bin",
      runtimeActor: "agent:runtime-session:ceo",
      taskId: null,
    });
  assert.equal(launch.env.HARNESS_DAEMON_USER_ROOT, "/operator/state");
  assert.equal(launch.env.HARNESS_DAEMON_ID, "studio");
  assert.equal(launch.env.HARNESS_DAEMON_ENDPOINT, "/daemon.sock");
  assert.equal(launch.env.HARNESS_DAEMON_REPO_ID, "repo");
  assert.equal(launch.env.HARNESS_CANONICAL_ROOT, "/repo");
  assert.equal(launch.env.HARNESS_ACTOR, "agent:runtime-session:ceo");
  assert.equal(launch.env.HARNESS_TASK_BOUND, undefined);
  assert.equal(launch.env.HOME, prepared.env.HOME);
  assert.equal(launch.env.PATH?.split(path.delimiter)[0], "/installation/bin");
});

test("runtime CLI bin resolves from the nearest daemon installation", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-cli-bin-")),
    modulePath = path.join(root, "packages", "daemon", "dist", "runtime-spawn-context.js"),
    binDirectory = path.join(root, "node_modules", ".bin");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.dirname(modulePath), { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(path.join(binDirectory, "ha"), "#!/usr/bin/env node\n");
  assert.equal(daemonCliBinDirectory(pathToFileURL(modulePath).href), binDirectory);
});

test("an artifact task resume discards an inherited canonical cwd and any explicit override", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-package-cwd-")),
    taskPackage = path.join(root, "task-package");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(taskPackage);
  for (const request of [{}, { cwd: { scope: "repo-root" } }]) {
    assert.deepEqual(resolveDispatchCwd(root, request, root, null, taskPackage), {
      cwd: taskPackage,
      worktree: null,
    });
  }
  assert.equal(resolveDispatchCwd(root, {}, root, null).cwd, root);
});

test("runtime CLI bin stays absent when the daemon installation has no ha entry", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-cli-missing-")),
    modulePath = path.join(root, "node_modules", "@harness-anything", "daemon", "dist", "runtime-spawn-context.js");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.dirname(modulePath), { recursive: true });
  assert.equal(daemonCliBinDirectory(pathToFileURL(modulePath).href), undefined);
});

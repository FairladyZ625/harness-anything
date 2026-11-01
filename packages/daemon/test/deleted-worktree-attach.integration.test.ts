// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { appendRuntimeWorkerRecord } from "../src/dispatch-stream.ts";
import { currentWorktreeHead } from "../src/runtime-continuation-context.ts";
import { checkoutTaskWorktree } from "../src/task-worktree.ts";
import {
  openBootstrappedRepoCell as openRepoCell,
  registerBootstrappedDaemonRepo as registerDaemonRepo,
} from "./repo-settings.fixture.ts";
import { signInPolicyTestUser, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { definition, installation } from "./fixtures/runtime-ingress.ts";

for (const deletion of ["git-remove", "direct-rm"] as const) {
  test(`canonical survives ${deletion} of an observed task worktree in the same daemon`, async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-deleted-worktree-")),
      rootDir = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      repoId = `deleted-worktree-${deletion}`,
      taskId = "task_0123456789abcdef01234567";
    rosterRepo(rootDir, repoId);
    const checkout = await checkoutTaskWorktree(
      rootDir,
      taskId,
      { branch: taskId, path: `.worktrees/${taskId}` },
      { setup: [], setupStepTimeoutMs: 1000 },
    );
    assert.ok(checkout);
    registerDaemonRepo({
      canonicalRoot: rootDir,
      repoId,
      userRoot,
      createConvenienceLinks: false,
      runtimeInstances: [{ instanceId: definition.instanceId, enabled: true }],
    });
    signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
    // A real, separately owned process makes adoption exercise the live watcher path.
    // It has no provider output, credentials, or network access.
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: "pipe" });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const resources: { host?: Awaited<ReturnType<typeof openDaemonHost>> } = {};
    t.after(async () => {
      await resources.host?.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill();
        await exited;
      }
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });
    let cell: Awaited<ReturnType<typeof openRepoCell>>;
    const host = await openDaemonHost({
      daemonId: repoId,
      userRoot,
      openCell: async (input) => {
        cell = await openRepoCell({
          ...input,
          runtimeInstances: () => [
            {
              schemaVersion: 2,
              instanceId: definition.instanceId,
              name: "Deleted worktree fixture",
              kindId: definition.kindId,
              installationId: definition.installationId,
              providerId: definition.providerId,
              models: [definition.model],
              defaultModel: definition.model,
              enabled: true,
              permissionMode: "workspace-write",
              codex: {},
              authMode: definition.authMode,
              authState: "configured",
              authReadiness: { status: "ready", code: null, hint: null },
              isolationState: "enforced",
            },
          ],
          prepareRuntimeLaunch: async (_instanceId, request) => ({
            definition,
            installation,
            executablePath: installation.executablePath,
            args: [],
            env: process.env,
            cwd: request.cwd,
            prompt: request.prompt,
          }),
          runtimeLaunch: () => ({
            pid: child.pid!,
            onOutput: () => undefined,
            onErrorOutput: () => undefined,
            onExit: () => undefined,
            terminate: () => {
              child.kill();
            },
          }),
        });
        return cell;
      },
    });
    resources.host = host;
    await host.attachmentsSettled();
    const binding = withPolicyGroup(
        { actor: { principal: { personId: "writer" }, executor: null }, source: "local" as const },
        "admin",
      ),
      spawned = await cell!.spawnRuntime(
        {
          runtimeInstanceId: definition.instanceId,
          cwd: { scope: "repo-relative", path: `.worktrees/${taskId}` },
          prompt: "Observe this task worktree",
          dispatchKey: "deleted-worktree",
        },
        binding,
      );
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    appendRuntimeWorkerRecord(rootDir, String(spawned.dispatchId), { kind: "process_started", pid: child.pid! });
    // Delete outside the daemon while its canonical cell and workspace watcher are open.
    if (deletion === "git-remove")
      execFileSync("git", ["-C", rootDir, "worktree", "remove", checkout.cwd], { stdio: "pipe" });
    else
      execFileSync(process.execPath, [
        "-e",
        "require('node:fs').rmSync(process.argv[1], {recursive:true, force:true})",
        checkout.cwd,
      ]);
    assert.equal(existsSync(checkout.cwd), false);
    assert.equal(await currentWorktreeHead(checkout.cwd), null, "a removed HEAD is unavailable, not an attach fault");
    if (deletion === "direct-rm")
      assert.match(
        execFileSync("git", ["-C", rootDir, "worktree", "list", "--porcelain"], { encoding: "utf8" }),
        /prunable/u,
        "direct deletion deliberately leaves stale Git registration",
      );
    assert.equal((await host.run(repoId, { kind: "task-list" }, auth)).outcome, "applied");
    assert.equal(
      (await host.run(repoId, { kind: "task-create", taskId: "task_after_delete", title: "After deletion" }, auth))
        .outcome,
      "applied",
    );
    // Reattach within this host, with the same durable dispatch and no daemon replacement.
    assert.equal((await host.admin({ kind: "update", repoId, state: "disabled" }, auth)).outcome, "applied");
    assert.equal((await host.admin({ kind: "update", repoId, state: "enabled" }, auth)).outcome, "applied");
    const status = host.status().repos.find((repo) => repo.repoId === repoId);
    const read = await host.run(repoId, { kind: "task-list" }, auth);
    assert.equal(read.outcome, "applied", JSON.stringify({ read, status }));
    assert.equal(host.status().repos.find((repo) => repo.repoId === repoId)?.state, "attached");
    assert.equal(
      (await host.run(repoId, { kind: "task-create", taskId: "task_after_attach", title: "After reattach" }, auth))
        .outcome,
      "applied",
    );
  });
}

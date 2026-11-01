// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareEdgeTaskDelivery, type FleetDeliveryTask } from "../src/fleet-task-delivery.ts";
import {
  fetchWorkerDelivery,
  pushWorkerBranch,
  readPublishedTaskCut,
  workerGitIdentityForPerson,
  workerPushFailureCode,
} from "../src/runtime-worker-push.ts";

for (const denialMode of ["permission", "cas"])
  test(`edge delivery checks permission and remote CAS (${denialMode})`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-delivery-cas-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
    for (const name of [
      "HARNESS_TASK_BOUND",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
    ])
      delete env[name];
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe", env }).trim();
    const remote = path.join(root, "origin.git"),
      first = path.join(root, "first"),
      second = path.join(root, "second"),
      taskId = "task_delivery_cas";
    git(root, "init", "--bare", "-b", "main", remote);
    git(root, "clone", remote, first);
    for (const cwd of [first]) {
      git(cwd, "config", "user.name", "owner");
      git(cwd, "config", "user.email", "owner@users.noreply.github.com");
    }
    git(first, "commit", "--allow-empty", "-qm", "base");
    git(first, "push", "origin", "main");
    git(root, "clone", "--no-local", remote, second);
    git(second, "config", "user.name", "owner");
    git(second, "config", "user.email", "owner@users.noreply.github.com");
    for (const cwd of [first, second]) {
      git(cwd, "worktree", "add", "-b", taskId, path.join(cwd, "worker"), "origin/main");
      writeFileSync(path.join(cwd, "worker", "delivery.txt"), cwd);
      git(path.join(cwd, "worker"), "add", "delivery.txt");
      git(path.join(cwd, "worker"), "commit", "-qm", "feat: delivery");
    }
    const snapshot = (nodeId: string): FleetDeliveryTask =>
      ({
        task: { iteration: 0 },
        executions: [],
        workspace: { kind: "worktree", path: "worker" },
        lease: {
          phase: "held",
          executionId: nodeId,
          actor: { principal: { personId: "owner" }, executor: null },
          expiresAt: "2099-01-01T00:00:00.000Z",
          source: { kind: "node", nodeId: nodeId },
        },
      }) as unknown as FleetDeliveryTask;
    const ready = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const old = prepareEdgeTaskDelivery({
      workspaceRoot: first,
      authorize: async () => {
        if (denialMode === "permission") throw new Error("authorization denied before push");
        ready.resolve();
        await release.promise;
        return "owner";
      },
      action: { kind: "task-submit", taskId },
      readTask: async () => snapshot("old"),
    });
    // Attach the rejection observer before unblocking the operation.
    const rejected = assert.rejects(old, denialMode === "permission" ? /authorization denied/u : /stale info/u);
    if (denialMode === "permission") {
      await rejected;
      assert.equal(git(first, "ls-remote", "--heads", "origin", taskId), "");
      return;
    }
    await ready.promise;
    const accepted = await prepareEdgeTaskDelivery({
      workspaceRoot: second,
      authorize: async () => "owner",
      action: { kind: "task-submit", taskId },
      readTask: async () => snapshot("new"),
    });
    git(first, "fetch", "origin");
    release.resolve();
    await rejected;
    assert.equal(git(remote, "rev-parse", `refs/heads/${taskId}`), accepted.commitSha);
    assert.equal(
      await fetchWorkerDelivery(first, taskId, String(accepted.commitSha), workerGitIdentityForPerson("owner")),
      accepted.commitSha,
    );
    await assert.rejects(
      fetchWorkerDelivery(first, taskId, git(first, "rev-parse", "main"), workerGitIdentityForPerson("owner")),
      /does not match published/u,
    );
    assert.equal(git(first, "for-each-ref", "--format=%(refname)", "refs/harness/delivery"), "");
    git(second, "config", "user.email", "other@example.invalid");
    git(path.join(second, "worker"), "commit", "--allow-empty", "-qm", "wrong identity");
    git(path.join(second, "worker"), "push", "origin", `HEAD:refs/heads/${taskId}`);
    await assert.rejects(
      fetchWorkerDelivery(first, taskId, undefined, workerGitIdentityForPerson("owner")),
      /not the conventional identity/u,
    );
    git(first, "remote", "remove", "origin");
    // With no origin, no cut is known: the lease expectation is empty without touching a network,
    // and a publication that cannot reach its remote maps to the one delivery failure code.
    assert.equal(await readPublishedTaskCut(first, taskId), "");
    const pushed = await pushWorkerBranch({
      cwd: path.join(first, "worker"),
      canonicalRoot: first,
      taskId,
      expectedRemoteCommit: "",
    });
    assert.equal(pushed.ok, false);
    assert.equal(workerPushFailureCode(pushed), "delivery_publish_failed");
  });

// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareEdgeTaskDelivery, type FleetDeliveryTask } from "../src/fleet-task-delivery.ts";
import { fetchWorkerDelivery, readWorkerRemoteCommit } from "../src/runtime-worker-push.ts";

for (const denialMode of ["node", "owner", "permission", "cas"])
  test(`delivery checks current node, owner, permission and remote CAS (${denialMode})`, async (t) => {
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
      git(cwd, "config", "user.name", "Delivery Test");
      git(cwd, "config", "user.email", "delivery@example.invalid");
    }
    git(first, "commit", "--allow-empty", "-qm", "base");
    git(first, "push", "origin", "main");
    git(root, "clone", "--no-local", remote, second);
    git(second, "config", "user.name", "Delivery Test");
    git(second, "config", "user.email", "delivery@example.invalid");
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
    let reads = 0;
    const old = prepareEdgeTaskDelivery({
      workspaceRoot: first,
      nodeId: "old",
      authorize: async () => {
        if (denialMode === "permission") throw new Error("authorization denied before push");
        return denialMode === "owner" ? "changed-owner" : "owner";
      },
      action: { kind: "task-submit", taskId },
      readTask: async () => {
        if (++reads === 2) {
          ready.resolve();
          await release.promise;
        }
        return snapshot(reads === 2 && denialMode === "node" ? "new" : "old");
      },
    });
    // Attach the rejection observer before unblocking the operation.
    const rejected = assert.rejects(
      old,
      denialMode === "permission"
        ? /authorization denied/u
        : denialMode === "cas"
          ? /stale info/u
          : /current node, owner/u,
    );
    await ready.promise;
    const accepted = await prepareEdgeTaskDelivery({
      workspaceRoot: second,
      nodeId: "new",
      authorize: async () => "owner",
      action: { kind: "task-submit", taskId },
      readTask: async () => snapshot("new"),
    });
    git(first, "fetch", "origin");
    release.resolve();
    await rejected;
    assert.equal(git(remote, "rev-parse", `refs/heads/${taskId}`), accepted.commitSha);
    assert.equal(await fetchWorkerDelivery(first, taskId, String(accepted.commitSha)), accepted.commitSha);
    await assert.rejects(
      fetchWorkerDelivery(first, taskId, git(first, "rev-parse", "main")),
      /does not match published/u,
    );
    assert.equal(git(first, "for-each-ref", "--format=%(refname)", "refs/harness/delivery"), "");
    git(second, "config", "user.email", "other@example.invalid");
    git(path.join(second, "worker"), "commit", "--allow-empty", "-qm", "wrong identity");
    git(path.join(second, "worker"), "push", "origin", `HEAD:refs/heads/${taskId}`);
    await assert.rejects(fetchWorkerDelivery(first, taskId), /not the conventional identity/u);
    git(first, "remote", "remove", "origin");
    await assert.rejects(readWorkerRemoteCommit(first, taskId), { code: "delivery_publish_failed" });
  });

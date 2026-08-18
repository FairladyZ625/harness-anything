// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fleetTaskRoute } from "../src/daemon/client.ts";

test("fleet task routing requires both edge config and remote-edge registry mode", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-task-route-")), userRoot = path.join(root, "user");
  t.after(() => rmSync(root, { recursive: true, force: true })); mkdirSync(userRoot);
  const env = { HARNESS_DAEMON_USER_ROOT: userRoot }, config = { schema: "fleet-edge-config/v1", repoId: "route-repo", host: "center", port: 7443, caPath: "/fleet/ca.pem", nodeId: "edge-one", credential: "machine-secret", assignmentId: "assignment-edge-one", viewRoot: "/view", quotaBytes: 64 * 1024 * 1024 };
  writeFileSync(path.join(root, "fleet-edge.json"), `${JSON.stringify(config)}\n`);
  const registry = (mode: "local" | "remote-edge", canonicalRoot = root) => writeFileSync(path.join(userRoot, "registry.json"), `${JSON.stringify({ schema: "harness-daemon-registry/v1", repos: [{ repoId: "route-repo", canonicalRoot, state: "enabled", mode }] })}\n`);
  const command = (method: string, action: Record<string, unknown>) => ({ rootDir: root, method, action }) as never;

  registry("local");
  assert.equal(await fleetTaskRoute(command("repo.task.run", { kind: "task-start", taskId: "task_one" }), env), null, "a stray config cannot change local-mode behavior");

  registry("remote-edge", path.join(root, "another-workspace"));
  assert.equal(await fleetTaskRoute(command("repo.task.run", { kind: "task-start", taskId: "task_one" }), env), null, "a remote-edge registration for another root cannot authorize this workspace");
  registry("remote-edge");
  const routed = await fleetTaskRoute(command("repo.task.run", { kind: "task-start", verb: "start", commandType: "StartExecution", taskId: "task_one" }), env);
  assert.deepEqual(routed?.action, { kind: "task-start", taskId: "task_one" });
  assert.equal(await fleetTaskRoute(command("repo.task.run", { kind: "task-complete", taskId: "task_one" }), env), null, "unsupported commands keep the explicit local repo-mode rejection path");

  writeFileSync(path.join(root, "task.json"), '{"title":"Structured edge task","riskTier":"high"}\n');
  const structured = await fleetTaskRoute(command("repo.task.create", { kind: "task-create", fromFile: "task.json", presetId: "standard-task" }), env);
  assert.deepEqual(structured?.action, { title: "Structured edge task", riskTier: "high", kind: "task-create", presetId: "standard-task" });
  const inline = await fleetTaskRoute(command("repo.task.create", { kind: "task-create", jsonInput: '{"title":"Inline edge task"}' }), env);
  assert.deepEqual(inline?.action, { title: "Inline edge task", kind: "task-create" });
  assert.equal(await fleetTaskRoute(command("repo.task.create", { kind: "task-create", taskId: "task_admin", createMode: "admin", title: "Admin" }), env), null);
});

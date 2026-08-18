// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "../../daemon/src/client/local-daemon-target.ts";
import { readDaemonPid } from "../../daemon/src/runtime.ts";
import { makeTaskEventStore, REPLAY_TASK_GRAPH, taskLifecycleWritePlan, type TaskEventV1 } from "../../kernel/src/index.ts";

const cli = path.resolve("packages/cli/src/index.ts");

test("registered workspace CLI command auto-starts the daemon, retries, and succeeds", () => {
  const fixture = setup();
  try {
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.root, fixture.userRoot, "autostart");
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "create", "--id", "task-autostart", "--admin", "--title", "Auto"]).outcome, "applied");
    const previousPid = readDaemonPid(fixture.userRoot, "default"); assert.ok(previousPid);
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
    waitForDaemonDown(fixture.userRoot);
    // The daemon is gone; a plain CLI command must bring it back and still answer.
    const result = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "task", "list"], { encoding: "utf8", env: cliEnv(fixture.root, fixture.userRoot) });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const receipt = JSON.parse(result.stdout) as { ok: boolean; outcome: string; error?: { code: string } };
    assert.equal(receipt.ok, true, JSON.stringify(receipt)); assert.equal(receipt.outcome, "applied");
    const restartedPid = readDaemonPid(fixture.userRoot, "default");
    assert.ok(restartedPid, "autostart must leave a resident daemon pid file"); assert.notEqual(restartedPid, previousPid);
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
  } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
});

test("semantic sources and agent execution cross the daemon before transport-bound human review completes", () => {
  const fixture = setup(), taskId = "task-executor-axis", executionId = "exec-executor-axis", reviewId = "review-executor-axis";
  try {
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.root, fixture.userRoot, "executor-axis");
    const created = run(fixture.root, fixture.userRoot, ["task", "create", "--id", taskId, "--admin", "--title", "Executor Axis"]);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const packagePath = String(created.packagePath), closeoutPath = `${packagePath}/closeout.md`;

    assert.equal(run(fixture.root, fixture.userRoot, ["task", "start", taskId, "--execution-id", executionId], "agent:claude-code").outcome, "applied");
    writeFileSync(path.join(fixture.root, "harness", closeoutPath), "# Closeout\n\n## Summary\n\nExecutor attribution restored.\n\n## Verification\n\nEnd-to-end daemon flow.\n\n## Residual Risk\n\nNone.\n", "utf8");
    assert.equal(run(fixture.root, fixture.userRoot, ["doc", "sync", "--submit", "--execution-id", executionId, "--path", closeoutPath], "agent:claude-code").outcome, "applied");
    const commitSha = git(fixture.root, "rev-parse", "HEAD");

    writeFileSync(path.join(fixture.root, "submission.json"), JSON.stringify({ completionClaim: "Executor axis is covered.", deliverables: ["daemon actor binding"], outputs: [closeoutPath], verificationNotes: ["end-to-end daemon flow"], knownGaps: [], residualRisks: [], commitSha }));
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "submit", taskId, "--execution-id", executionId, "--from-file", "submission.json"], "agent:claude-code").outcome, "applied");
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "code-doc", "reconcile", taskId, "--execution-id", executionId, "--commit-sha", commitSha, "--iteration", "0", "--path", "README.md"], "agent:claude-code").outcome, "applied");

    writeFileSync(path.join(fixture.root, "review.json"), JSON.stringify({ verdict: "approved", reason: "Human review accepted the agent execution.", evidenceChecked: ["end-to-end daemon flow"], commitSha, iteration: 0 }));
    const reviewed = run(fixture.root, fixture.userRoot, ["task", "review-execution", taskId, "--execution-id", executionId, "--review-id", reviewId, "--from-file", "review.json"]);
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    writeFileSync(path.join(fixture.root, "consent.json"), JSON.stringify({ reviewDigest: reviewed.reviewDigest, contentDigest: reviewed.contentDigest }));
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "review-consent", taskId, "--execution-id", executionId, "--review-id", reviewId, "--consent-id", "consent-executor-axis", "--from-file", "consent.json"]).outcome, "applied");
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "complete", taskId, "--execution-id", executionId, "--ci", "passed"]).outcome, "applied");

    const shown = run(fixture.root, fixture.userRoot, ["task", "show", taskId]), snapshot = JSON.parse(String(shown.evidence)) as { task: { status: string; createdBy: unknown }; executions: { actor: unknown }[]; reviews: { actor: unknown }[] };
    assert.equal(snapshot.task.status, "done");
    assert.deepEqual(snapshot.task.createdBy, { principal: { personId: "owner" }, executor: null });
    assert.deepEqual(snapshot.executions[0]?.actor, { principal: { personId: "owner" }, executor: { kind: "agent", id: "claude-code" } });
    assert.deepEqual(snapshot.reviews[0]?.actor, { principal: { personId: "owner" }, executor: null });
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "create", "--id", "task-source", "--admin", "--title", "Source"], "agent:codex").outcome, "applied");
    const sourceTask = JSON.parse(String(run(fixture.root, fixture.userRoot, ["task", "show", "task-source"]).evidence)) as { task: { createdBy: unknown } };
    assert.deepEqual(sourceTask.task.createdBy, { principal: { personId: "owner" }, executor: { kind: "agent", id: "codex" } });
    writeFileSync(path.join(fixture.root, "artifact.md"), "# Artifact\n", "utf8");
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "artifact", "add", "task-source", "--source", "artifact.md", "--destination", "proof.md"]).outcome, "applied");
    assert.equal(run(fixture.root, fixture.userRoot, ["relation", "list", "--source", "task/task-source"]).outcome, "applied");
  } finally {
    stop(fixture.root, fixture.userRoot);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("dry-run contract migration prints each manual task once", () => {
  const fixture = setup(), repoId = "contract-receipt", taskId = "task_legacy_l1";
  try {
    seedLegacyTask(fixture.root, repoId, taskId);
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.root, fixture.userRoot, repoId);
    const result = spawnSync(process.execPath, [cli, "--root", fixture.root, "task", "contract", "migrate", "--dry-run", "--task", taskId], { encoding: "utf8", env: cliEnv(fixture.root, fixture.userRoot) });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal((result.stdout.match(new RegExp(taskId, "gu")) ?? []).length, 1, result.stdout);
    const receipt = run(fixture.root, fixture.userRoot, ["task", "contract", "migrate", "--dry-run", "--task", taskId]);
    const evidence = JSON.parse(String(receipt.evidence)) as { report: readonly { taskId: string; status: string; reason: string }[]; manual: readonly { taskId: string; status: string; reason: string }[] };
    assert.deepEqual(evidence.manual, [evidence.report[0]], "JSON keeps the manual subset for machine consumers");
  } finally {
    stop(fixture.root, fixture.userRoot);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("autostart gives up after two attempts with a classified bind-timeout error", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "requires POSIX non-root permission semantics" : false }, () => {
  const fixture = setup();
  try {
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.root, fixture.userRoot, "autostart-fail");
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
    waitForDaemonDown(fixture.userRoot);
    // A read-only user root makes every spawned `daemon serve` die on its pid write,
    // so the autostart loop exhausts its two attempts and reports why.
    chmodSync(fixture.userRoot, 0o555);
    const result = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "task", "list"], { encoding: "utf8", env: cliEnv(fixture.root, fixture.userRoot) });
    assert.notEqual(result.status, 0);
    const receipt = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; hint: string } };
    assert.equal(receipt.ok, false);
    assert.equal(receipt.error.code, "daemon_bind_timeout");
    assert.match(receipt.error.hint, /did not accept connections/u);
    assert.match(receipt.error.hint, /daemon serve/u);
    assert.equal(readDaemonPid(fixture.userRoot, "default"), null, "no daemon may claim to be resident after failed starts");
  } finally { chmodSync(fixture.userRoot, 0o755); rmSync(fixture.parent, { recursive: true, force: true }); }
});

function cliEnv(root: string, userRoot: string, actor?: string): NodeJS.ProcessEnv { const { HARNESS_ACTOR: _actor, ...base } = process.env; return { ...base, HOME: path.join(root, ".home"), GIT_CONFIG_GLOBAL: "/dev/null", HARNESS_DAEMON_USER_ROOT: userRoot, ...(actor ? { HARNESS_ACTOR: actor } : {}) }; }
function setup(): { parent: string; root: string; userRoot: string } { const parent = mkdtempSync(path.join(tmpdir(), "ha-autostart-")), root = path.join(parent, "repo"), userRoot = path.join(parent, "user");
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# Fixture\n", "utf8");
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n", "utf8");
  writeFileSync(path.join(root, "harness/people.yaml"), `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`, "utf8");
  git(root, "init", "--quiet"); git(root, "config", "user.name", "Autostart Test"); git(root, "config", "user.email", "autostart@example.test");
  git(root, "add", "README.md", "harness/harness.yaml", "harness/people.yaml"); git(root, "commit", "--quiet", "-m", "fixture"); return { parent, root, userRoot }; }
function register(root: string, userRoot: string, repoId: string): void { assert.equal(run(root, userRoot, ["daemon", "repo", "register", "--repo-id", repoId, "--root", root, "--no-link"]).ok, true); }
function run(root: string, userRoot: string, args: readonly string[], actor?: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], { encoding: "utf8", env: cliEnv(root, userRoot, actor) });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`); return JSON.parse(result.stdout) as Record<string, unknown>; }
function waitForDaemonDown(userRoot: string): void { const socketPath = localUserDaemonEndpoint(userRoot, "default");
  for (let attempt = 0; attempt < 200; attempt += 1) { if (readDaemonPid(userRoot, "default") === null && !existsSync(socketPath)) return; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
  throw new Error("previous daemon did not drain before the autostart probe"); }
function stop(root: string, userRoot: string): void { if (readDaemonPid(userRoot, "default") !== null) spawnSync(process.execPath, [cli, "--root", root, "--json", "daemon", "stop"], { encoding: "utf8", env: cliEnv(root, userRoot) }); }
function git(root: string, ...args: string[]): string { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
function seedLegacyTask(root: string, repoId: string, taskId: string): void {
  const actor = { principal: { personId: "owner" }, executor: null } as const, event: TaskEventV1 = { schema: "task-event/v1", eventId: "event-contract-receipt", workspaceRevision: 1, opId: "op-contract-receipt", taskId, type: "task_created", actor, source: "local", occurredAt: "2026-08-18T00:00:00.000Z", payload: { task: { schema: "task/v1", taskId, title: "Legacy contract receipt", taskClass: "standard", status: "planned", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0, createdBy: actor, completionGateIds: [], presetSnapshotDigest: null } } };
  makeTaskEventStore({ repoId, rootDir: root }).append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
}

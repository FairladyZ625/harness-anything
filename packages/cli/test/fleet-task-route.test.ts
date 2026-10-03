// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { daemonProtocolCommands } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { parseFleetFrame } from "@harness-anything/daemon/internal/fleet/contract";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import {
  fleetDocRoute,
  fleetRuntimeRoute,
  fleetScheduleRoute,
  fleetTaskRoute,
} from "../src/daemon/fleet-command-route.ts";

test("fleet task routing requires both edge config and remote-edge registry mode", async (t) => {
  // Registry roots are compared after realpath; a symlinked tmpdir (macOS /var) must not fail the match.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-fleet-task-route-"))),
    userRoot = path.join(root, "user");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(userRoot);
  const env = { HARNESS_DAEMON_USER_ROOT: userRoot },
    config = {
      schema: "fleet-edge-config/v1",
      repoId: "route-repo",
      host: "center",
      port: 7443,
      caPath: "/fleet/ca.pem",
      nodeId: "edge-one",
      credential: "machine-secret",
      viewRoot: "/view",
      quotaBytes: 64 * 1024 * 1024,
    };
  writeFileSync(path.join(root, "fleet-edge.json"), `${JSON.stringify(config)}\n`);
  const registry = (mode: "local" | "remote-edge", canonicalRoot = root) =>
    writeFileSync(
      path.join(userRoot, "registry.json"),
      `${JSON.stringify({
        schema: "harness-daemon-registry/v2",
        connections: [{ id: "local", kind: "local", displayName: "This device", state: "enabled" }],
        repos: [
          {
            repoId: "route-repo",
            canonicalRoot,
            displayName: "Route Repo",
            authoredBranch: "main",
            mode,
            connectionId: "local",
            state: "enabled",
            registeredAt: "2026-07-07T00:00:00.000Z",
          },
        ],
      })}\n`,
    );
  const command = (method: string, action: Record<string, unknown>, rootDir = root) =>
    ({ rootDir, method, action }) as never;

  registry("local");
  assert.equal(
    await fleetTaskRoute(command("repo.task.run", { kind: "task-start", taskId: "task_one" }), env),
    null,
    "a stray config cannot change local-mode behavior",
  );

  registry("remote-edge", path.join(root, "another-workspace"));
  assert.equal(
    await fleetTaskRoute(command("repo.task.run", { kind: "task-start", taskId: "task_one" }), env),
    null,
    "a remote-edge registration for another root cannot authorize this workspace",
  );
  registry("remote-edge");
  const undeclaredRead = command("repo.tasks.documents.list", {
    kind: "task-documents-list",
    taskId: "task_one",
  });
  assert.equal(await fleetTaskRoute(undeclaredRead, env), null);
  assert.equal(await fleetDocRoute(undeclaredRead, env), null);
  const routed = await fleetTaskRoute(command("repo.task.run", { kind: "task-start", taskId: "task_one" }), env);
  assert.deepEqual(routed?.action, { kind: "task-start", taskId: "task_one" });
  assert.deepEqual(
    (await fleetTaskRoute(command("repo.task.read", { kind: "task-show", taskId: "task_one" }), env))?.action,
    { kind: "task-show", taskId: "task_one" },
  );
  assert.deepEqual(
    (await fleetTaskRoute(command("repo.task.run", { kind: "task-settle", taskId: "task_one" }), env))?.action,
    { kind: "task-settle", taskId: "task_one" },
  );
  const docStatus = await fleetDocRoute(
    command("repo.task.read", { kind: "doc-status", paths: ["context/notes.md"] }),
    env,
  );
  assert.equal(docStatus?.method, "daemon.fleet.doc.sync");
  assert.equal(docStatus?.payload.dryRun, true);
  assert.deepEqual(docStatus?.payload.paths, ["context/notes.md"]);
  const docSubmitAll = await fleetDocRoute(command("repo.task.run", { kind: "doc-submit", paths: [], all: true }), env);
  assert.equal(docSubmitAll?.payload.dryRun, false);
  assert.deepEqual(docSubmitAll?.payload.paths, []);
  assert.equal(docSubmitAll?.payload.all, true);
  for (const [kind, action] of [
    ["doc-conflict-resolve", "resolve"],
    ["doc-conflict-discard-local", "discard-local"],
    ["doc-conflict-overwrite-center", "overwrite-center"],
  ] as const) {
    const conflict = command("repo.task.run", { kind, conflictId: "cflt-one" });
    assert.equal(await fleetTaskRoute(conflict, env), null);
    const routedConflict = await fleetDocRoute(conflict, env);
    assert.equal(routedConflict?.method, "daemon.fleet.conflict.exit");
    assert.equal(routedConflict?.payload.action, action);
    assert.equal(routedConflict?.payload.conflictId, "cflt-one");
  }
  const child = path.join(root, "worktrees", "nested");
  mkdirSync(child, { recursive: true });
  const childRouted = await fleetTaskRoute(
    command(
      "repo.task.run",
      {
        kind: "task-progress-append",
        taskId: "task_one",
        executionId: "execution_one",
        text: "nested cwd",
        evidence: [],
      },
      child,
    ),
    env,
  );
  assert.equal(
    childRouted?.workspaceRoot,
    root,
    "commands from descendants still materialize the registered workspace",
  );
  assert.deepEqual(childRouted?.action, {
    kind: "task-progress-append",
    taskId: "task_one",
    executionId: "execution_one",
    text: "nested cwd",
    evidence: [],
  });
  const complete = await fleetTaskRoute(
    command("repo.task.run", { kind: "task-complete", taskId: "task_one", consent: true }),
    env,
  );
  assert.deepEqual(complete?.action, { kind: "task-complete", taskId: "task_one", consent: true });
  for (const action of [
    { kind: "fact-record", taskId: "task_one", statement: "observed", source: "test", confidence: "high" },
    { kind: "task-declare-executor", taskId: "task_one", reason: "repair" },
    { kind: "task-code-doc-reconcile", taskId: "task_one", paths: ["packages/cli/src/index.ts"] },
  ])
    assert.deepEqual((await fleetTaskRoute(command("repo.task.run", action), env))?.action, action);
  const review = await fleetTaskRoute(
    command("repo.task.run", {
      kind: "task-review-execution",
      taskId: "task_one",
      reviewId: "review_one",
      jsonInput: '{"verdict":"approved","reason":"checked","evidenceChecked":["tests"]}',
      commandType: "RecordReview",
    }),
    env,
  );
  assert.deepEqual(review?.action, {
    kind: "task-review-execution",
    taskId: "task_one",
    reviewId: "review_one",
    verdict: "approved",
    reason: "checked",
    evidenceChecked: ["tests"],
  });
  writeFileSync(path.join(root, "task.json"), '{"title":"Structured edge task","riskTier":"high"}\n');
  const structured = await fleetTaskRoute(
    command("repo.task.create", { kind: "task-create", fromFile: "task.json", presetId: "standard-task" }),
    env,
  );
  assert.deepEqual(structured?.action, {
    title: "Structured edge task",
    riskTier: "high",
    kind: "task-create",
    presetId: "standard-task",
  });
  const inline = await fleetTaskRoute(
    command("repo.task.create", { kind: "task-create", jsonInput: '{"title":"Inline edge task"}' }),
    env,
  );
  assert.deepEqual(inline?.action, { title: "Inline edge task", kind: "task-create" });
  writeFileSync(path.join(root, "edge-plan.md"), "# Edge plan\n\n## Brief\n\nAuthored on the edge.\n");
  const withPlan = await fleetTaskRoute(
    command("repo.task.create", { kind: "task-create", title: "Edge plan task", planFile: "edge-plan.md" }),
    env,
  );
  assert.deepEqual(withPlan?.action, {
    kind: "task-create",
    title: "Edge plan task",
    plan: "# Edge plan\n\n## Brief\n\nAuthored on the edge.\n",
  });
  // The real-machine edge retest (F-31931F21) sent a 950-character plan; the route must hand the
  // whole body to the wire action, never a truncated or scaffolded stand-in.
  const longFiller = "边缘节点提交的多段计划正文，逐字穿过 Fleet 通道进入中心任务包并原样读回。",
    longHead = "# 边缘计划\n\n## Brief\n",
    longTail = "\n## Verification\n跑通本回归测试。\n";
  let longBody = "";
  while (longHead.length + longBody.length + longTail.length < 950) longBody += `${longFiller}\n`;
  const longPlan = longHead + longBody.slice(0, 950 - longHead.length - longTail.length) + longTail;
  assert.equal(longPlan.length, 950);
  writeFileSync(path.join(root, "edge-plan-950.md"), longPlan);
  const withLongPlan = await fleetTaskRoute(
    command("repo.task.create", { kind: "task-create", title: "Edge long plan task", planFile: "edge-plan-950.md" }),
    env,
  );
  assert.deepEqual(withLongPlan?.action, {
    kind: "task-create",
    title: "Edge long plan task",
    plan: longPlan,
  });
  assert.equal(
    await fleetTaskRoute(
      command("repo.task.create", { kind: "task-create", taskId: "task_admin", createMode: "admin", title: "Admin" }),
      env,
    ),
    null,
  );

  const runtime = await fleetRuntimeRoute(
    command("repo.agentRuntime.spawn", {
      kind: "runtime-run",
      runtimeInstanceId: "codex-one",
      taskId: "task_one",
      cwd: { scope: "repo-root" },
      prompt: "work",
      idempotencyKey: "runtime-route",
      detach: false,
    }),
    env,
  );
  assert.equal(runtime?.workspaceRoot, root);
  assert.equal(runtime?.credential, "machine-secret");
  assert.deepEqual(runtime?.action, {
    kind: "fleet-runtime",
    method: "repo.agentRuntime.spawn",
    payload: {
      runtimeInstanceId: "codex-one",
      taskId: "task_one",
      cwd: { scope: "repo-root" },
      prompt: "work",
      idempotencyKey: "runtime-route",
    },
  });
  const missing: string[] = [],
    unexpected: string[] = [];
  for (const descriptor of daemonProtocolCommands) {
    const kind = "actionKind" in descriptor ? descriptor.actionKind : descriptor.id;
    const entry = command(descriptor.method, { kind });
    const routed =
      (await fleetScheduleRoute(entry, env)) ??
      (await fleetRuntimeRoute(entry, env)) ??
      (await fleetTaskRoute(entry, env)) ??
      (await fleetDocRoute(entry, env));
    if (descriptor.admission["remote-edge"] === "via-center-forward" && routed === null) missing.push(descriptor.id);
    if (descriptor.admission["remote-edge"] === "rejected" && routed !== null) unexpected.push(descriptor.id);
  }
  t.diagnostic(JSON.stringify({ declaredForwardWithoutRoute: missing, declaredRejectedWithRoute: unexpected }));
  assert.deepEqual(missing, []);
  assert.deepEqual(unexpected, []);

  for (const argv of [
    ["task", "list", "--kind", "fix", "--parent", "task_one", "--limit", "500", "--depth", "all"],
    ["task", "show", "task_one"],
    ["work", "list", "--all", "--limit", "500"],
    ["work", "show", "task_one"],
  ]) {
    const parsed = parseThinCommand(argv, root);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;
    const routed = await fleetTaskRoute(parsed.command, env);
    assert.ok(routed, argv.join(" "));
    assert.doesNotThrow(
      () =>
        parseFleetFrame({
          schema: "fleet.repository.read/v1",
          messageId: "read",
          repoId: "route-repo",
          accessToken: null,
          method: "repo.task.read",
          payload: routed.action,
        }),
      argv.join(" "),
    );
  }
});

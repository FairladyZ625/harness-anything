// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { daemonProtocolCommands } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { parseFleetFrame, isFleetTaskAction } from "@harness-anything/daemon/internal/fleet/command-protocol";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { fleetRuntimeRoute, fleetScheduleRoute, fleetTaskRoute } from "../src/daemon/fleet-command-route.ts";

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

  const actionForDescriptor = (descriptor: (typeof daemonProtocolCommands)[number]): Record<string, unknown> => {
    const actionKind = "actionKind" in descriptor ? descriptor.actionKind : descriptor.id,
      canonical =
        daemonProtocolCommands.find(
          (candidate) => ("actionKind" in candidate ? candidate.actionKind : candidate.id) === actionKind,
        ) ?? descriptor;
    const action: Record<string, unknown> = {
        kind: actionKind,
      },
      inputs = "inputs" in canonical ? canonical.inputs : [],
      payloadFields = "payloadFields" in canonical ? canonical.payloadFields : [],
      inputByField = new Map(
        inputs.map((input) => [
          input.field ?? input.name.slice(2).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
          input,
        ]),
      ),
      payloadByField = new Map(payloadFields.map((field) => [field.field, field]));
    const valueFor = (input: (typeof inputs)[number]): unknown => {
      const field =
          input.field ?? input.name.slice(2).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
        payload = payloadByField.get(field),
        type = payload?.type;
      if (input.enum?.length) return input.enum[0];
      if (field === "taskId") return "task_one";
      if (field === "decisionId") return `dec_${"a".repeat(24)}`;
      if (field === "dispatchId") return `dispatch_${"a".repeat(24)}`;
      if (field === "executionId") return `execution_${"a".repeat(24)}`;
      if (type === "number" || input.projection === "number") return 0;
      if (type === "json-object") return {};
      if (type === "json-object-array") return [];
      if (type === "string-array" || input.kind === "repeated") return ["probe"];
      if (input.kind === "boolean") return true;
      return "probe";
    };
    const packetValue = (field: string): unknown => {
      const payload = payloadByField.get(field);
      if (payload?.type === "number") return 0;
      if (payload?.type === "boolean") return true;
      if (payload?.type === "json-object") return {};
      if (payload?.type === "json-object-array") return [];
      if (payload?.type === "string-array") return [];
      if (["claims", "chosen", "evidenceChecked", "findings", "rejected", "resolutions", "responses"].includes(field))
        return [];
      return "probe";
    };
    const encodedValue = (input: (typeof inputs)[number]): unknown => {
      const codec = typeof input.codec === "object" ? input.codec : undefined;
      if (!codec) return valueFor(input);
      const packet = Object.fromEntries((input.jsonFields ?? []).map((field) => [field, packetValue(field)]));
      if (codec.kind === "json-object") {
        const raw = JSON.stringify(packet);
        if (codec.source === "file") {
          const file = `fleet-payload-${actionKind}-${input.name.slice(2).replace(/[^a-z0-9]+/giu, "-")}.json`;
          writeFileSync(path.join(root, file), `${raw}\n`);
          return file;
        }
        return raw;
      }
      const file = `fleet-payload-${actionKind}-${input.name.slice(2).replace(/[^a-z0-9]+/giu, "-")}.txt`;
      writeFileSync(path.join(root, file), "probe\n");
      return file;
    };
    const add = (input: (typeof inputs)[number]): void => {
      const field =
        input.field ?? input.name.slice(2).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());
      if (Object.hasOwn(action, field)) return;
      action[field] = encodedValue(input);
      for (const required of input.requires ?? []) {
        const dependency = inputs.find((candidate) => candidate.name === required);
        if (dependency) add(dependency);
      }
      for (const required of input.requiresAny ?? []) {
        const dependency = inputs.find((candidate) => candidate.name === required);
        if (dependency) {
          add(dependency);
          break;
        }
      }
    };
    for (const input of inputs) if (input.required) add(input);
    for (const group of "actionConstraints" in canonical ? (canonical.actionConstraints ?? []) : []) {
      const selected = group.some((field) => Object.hasOwn(action, field));
      if (!selected) {
        const input = inputByField.get(group[0]);
        if (input) add(input);
      }
    }
    for (const token of "syntaxPath" in canonical ? canonical.syntaxPath : canonical.path) {
      const match = token.match(/^<([a-z][a-z0-9-]*)>$/u);
      if (!match) continue;
      const field = match[1]!.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());
      if (Object.hasOwn(action, field)) continue;
      action[field] =
        field === "taskId"
          ? "task_one"
          : field === "decisionId"
            ? `dec_${"a".repeat(24)}`
            : field === "dispatchId"
              ? `dispatch_${"a".repeat(24)}`
              : field === "executionId"
                ? `execution_${"a".repeat(24)}`
                : `${field}_one`;
    }
    return action;
  };

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
  for (const action of [
    { kind: "agent-install", packageSource: "agent.json", expectedVersion: 0 },
    { kind: "agent-delete", reason: "cleanup", expectedVersion: 0 },
    { kind: "agent-retire", reason: "cleanup" },
    { kind: "squad-install", packageSource: "squad.json", expectedVersion: 0 },
    { kind: "squad-delete", reason: "cleanup", expectedVersion: 0 },
  ]) {
    const { kind } = action;
    assert.deepEqual((await fleetTaskRoute(command("repo.task.run", action), env))?.action, action, kind);
  }
  for (const kind of ["schedule-list", "schedule-show", "schedule-runs"]) {
    const read = command("repo.task.read", { kind, scheduleId: "edge-schedule" });
    assert.equal(await fleetScheduleRoute(read, env), null, `${kind} must avoid the network runtime route`);
    assert.deepEqual((await fleetTaskRoute(read, env))?.action, { kind, scheduleId: "edge-schedule" });
  }
  const undeclaredRead = command("repo.tasks.documents.list", {
    kind: "task-documents-list",
    taskId: "task_one",
  });
  assert.equal(await fleetTaskRoute(undeclaredRead, env), null);
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
  for (const kind of ["doc-status", "doc-dry-run"]) {
    const read = command("repo.task.read", { kind, paths: ["context/notes.md"] });
    assert.deepEqual((await fleetTaskRoute(read, env))?.action, { kind, paths: ["context/notes.md"] });
  }
  const docRetire = command("repo.task.run", {
    kind: "doc-retire",
    paths: ["context/notes.md"],
    reason: "The authored note is obsolete.",
  });
  assert.deepEqual((await fleetTaskRoute(docRetire, env))?.action, docRetire.action);
  const docSubmitAll = await fleetTaskRoute(
    command("repo.task.run", { kind: "doc-submit", paths: [], all: true }),
    env,
  );
  assert.deepEqual(docSubmitAll?.action, { kind: "doc-submit", paths: [], all: true });
  for (const kind of ["doc-conflict-resolve", "doc-conflict-discard-local", "doc-conflict-overwrite-center"]) {
    const conflict = command("repo.task.run", { kind, conflictId: "cflt-one" });
    assert.deepEqual((await fleetTaskRoute(conflict, env))?.action, conflict.action, kind);
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
    {
      kind: "fact-record",
      taskId: "task_one",
      statement: "observed",
      evidenceSource: "test",
      confidence: "high",
    },
    { kind: "task-declare-executor", taskId: "task_one", reason: "repair" },
  ])
    assert.deepEqual((await fleetTaskRoute(command("repo.task.run", action), env))?.action, action);
  const review = await fleetTaskRoute(
    command("repo.task.run", {
      kind: "task-review-execution",
      taskId: "task_one",
      reviewId: "review_one",
      jsonInput: '{"verdict":"approved","reason":"checked","evidenceChecked":["tests"],"findings":[],"resolutions":[]}',
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
    findings: [],
    resolutions: [],
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

  // The edge resolves both sources before crossing TLS: the packet fields plus the body text are
  // what the center receives, with no from-file or body-file path it could misread as local.
  const decisionPacket = {
      title: "Edge decision",
      question: "Can the edge submit the same Decision packet as the center?",
      riskTier: "low",
      urgency: "medium",
      decisionClass: "ordinary",
      chosen: [{ id: "CH1", text: "Forward the decoded packet." }],
      rejected: [{ id: "RJ1", text: "Require the center's file path.", whyNot: "The edge owns that file." }],
      claims: [],
    },
    decisionBody = "# Edge decision\n\nRecorded from the edge node.\n";
  writeFileSync(path.join(root, "decision.json"), `${JSON.stringify(decisionPacket)}\n`);
  writeFileSync(path.join(root, "decision-body.md"), decisionBody);
  const decisionRoute = await fleetTaskRoute(
    command("repo.task.run", {
      kind: "decision-propose",
      fromFile: "decision.json",
      bodyFile: "decision-body.md",
    }),
    env,
  );
  assert.deepEqual(decisionRoute?.action, { ...decisionPacket, kind: "decision-propose", body: decisionBody });
  const decisionWithoutBody = await fleetTaskRoute(
    command("repo.task.run", { kind: "decision-propose", fromFile: "decision.json" }),
    env,
  );
  assert.deepEqual(decisionWithoutBody?.action, { ...decisionPacket, kind: "decision-propose" });
  const decisionFromJsonInput = await fleetTaskRoute(
    command("repo.task.run", {
      kind: "decision-propose",
      jsonInput: JSON.stringify(decisionPacket),
      body: decisionBody,
    }),
    env,
  );
  assert.deepEqual(decisionFromJsonInput?.action, {
    ...decisionPacket,
    kind: "decision-propose",
    body: decisionBody,
  });

  const runtime = await fleetRuntimeRoute(
    command("repo.agentRuntime.spawn", {
      kind: "runtime-run",
      runtimeInstanceId: "codex-one",
      taskId: "task_one",
      cwd: { scope: "repo-root" },
      prompt: "work",
      dispatchKey: "runtime-route",
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
      dispatchKey: "runtime-route",
    },
  });
  const runtimeRead = await fleetRuntimeRoute(
    command("repo.agentRuntime.sessions.read", {
      kind: "runtime-status",
      runtimeSessionId: "runtime_one",
    }),
    env,
  );
  assert.deepEqual(runtimeRead?.action, {
    kind: "fleet-runtime",
    method: "repo.agentRuntime.sessions.read",
    payload: { runtimeSessionId: "runtime_one" },
  });
  const steerCommand = parseThinCommand(["runtime", "steer", "dispatch_123", "--prompt", "change direction"], root);
  assert.equal(steerCommand.ok, true);
  if (steerCommand.ok) {
    assert.equal(steerCommand.command.method, "repo.agentRuntime.steer");
    const routedSteer = await fleetRuntimeRoute(steerCommand.command, env);
    assert.ok(routedSteer, `no fleet route for ${steerCommand.command.method} at ${steerCommand.command.rootDir}`);
    assert.deepEqual(routedSteer.action, {
      kind: "fleet-runtime",
      method: "repo.agentRuntime.steer",
      payload: { dispatchId: "dispatch_123", prompt: "change direction" },
    });
  }
  const cancelCommand = parseThinCommand(["runtime", "cancel", "runtime_one"], root);
  assert.equal(cancelCommand.ok, true, JSON.stringify(cancelCommand));
  if (cancelCommand.ok) {
    const routedCancel = await fleetRuntimeRoute(cancelCommand.command, env);
    assert.deepEqual(routedCancel?.action, {
      kind: "fleet-runtime",
      method: "repo.agentRuntime.cancel",
      payload: { runtimeSessionId: "runtime_one" },
    });
  }
  const handoffDispatch = `dispatch_${"a".repeat(24)}`,
    handoffCommand = parseThinCommand(["runtime", "handoff", "export", handoffDispatch], root);
  assert.equal(handoffCommand.ok, true, JSON.stringify(handoffCommand));
  if (handoffCommand.ok) {
    const routedHandoff = await fleetRuntimeRoute(handoffCommand.command, env);
    assert.deepEqual(routedHandoff?.action, {
      kind: "fleet-runtime",
      method: "repo.agentRuntime.handoff",
      payload: { operation: "export", dispatchId: handoffDispatch },
    });
  }
  const missing: string[] = [],
    unexpected: string[] = [];
  for (const descriptor of daemonProtocolCommands) {
    const entry = command(descriptor.method, actionForDescriptor(descriptor));
    const routed =
      (await fleetScheduleRoute(entry, env)) ??
      (await fleetRuntimeRoute(entry, env)) ??
      (await fleetTaskRoute(entry, env));
    if (
      (descriptor.admission["remote-edge"] === "via-center-forward" ||
        descriptor.admission["remote-edge"] === "edge-replica") &&
      routed === null
    )
      missing.push(descriptor.id);
    if (descriptor.admission["remote-edge"] === "rejected" && routed !== null) unexpected.push(descriptor.id);
  }
  t.diagnostic(JSON.stringify({ declaredForwardWithoutRoute: missing, declaredRejectedWithRoute: unexpected }));
  assert.deepEqual(missing, []);
  assert.deepEqual(unexpected, []);

  // task list is answered from the edge replica: it routes to the edge, and the center wire no longer takes it.
  const replicaList = parseThinCommand(
    ["task", "list", "--kind", "fix", "--parent", "task_one", "--limit", "500", "--depth", "all"],
    root,
  );
  assert.equal(replicaList.ok, true);
  if (replicaList.ok) {
    const routed = await fleetTaskRoute(replicaList.command, env);
    assert.ok(routed, "task list");
    assert.throws(() =>
      parseFleetFrame({
        schema: "fleet.repository.read/v1",
        messageId: "read",
        repoId: "route-repo",
        accessToken: null,
        method: "repo.task.read",
        payload: routed.action,
      }),
    );
  }
  for (const argv of [["work", "show", "task_one"]]) {
    const parsed = parseThinCommand(argv, root);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;
    const routed = await fleetTaskRoute(parsed.command, env);
    assert.ok(routed, argv.join(" "));
    assert.throws(
      () =>
        parseFleetFrame({
          schema: "fleet.repository.read/v1",
          messageId: "read",
          repoId: "route-repo",
          accessToken: null,
          method: "repo.task.read",
          payload: routed.action,
        }),
      /closed schema fleet\.repository\.read\/v1/u,
    );
  }
  writeFileSync(path.join(root, "body.md"), "# Authored on the edge\n" + "Long prose. ".repeat(80));
  writeFileSync(path.join(root, "work-plan.md"), "# Edge work\n\n## Mission\n\nCreate the work from the edge.\n");
  writeFileSync(path.join(root, "ids.txt"), "# edge-local batch\nF-0000EDGE\n");
  writeFileSync(
    path.join(root, "decision-review.json"),
    JSON.stringify({
      reviewId: "review-edge",
      reviewContentDigest: `sha256:${"a".repeat(64)}`,
      verdict: "approved",
      reason: "Checked independently.",
      findings: [],
      evidenceChecked: [],
      reportRef: "decisions/decision-dec_edge/artifacts/reports/edge.md",
    }),
  );
  for (const argv of [
    [
      "work",
      "create",
      "--title",
      "Edge work",
      "--decision",
      "dec_51BE0FEB9A078031D052101951",
      "--kind",
      "feat",
      "--risk-tier",
      "medium",
      "--urgency",
      "high",
      "--slug",
      "edge-work",
      "--plan-file",
      "work-plan.md",
      "--locale",
      "zh-CN",
    ],
    ["fact", "reclassify", "F-0000EDGE", "--type", "closeout", "--rationale", "Verified."],
    ["fact", "archive", "--ids-file", "ids.txt", "--reason", "Finished."],
    ["fact", "unarchive", "F-0000EDGE", "--reason", "Restore."],
    ["decision", "amend", "dec_edge", "--reason", "Clarify.", "--body-file", "body.md"],
    ["decision", "claim", "add", "dec_edge", "--id", "C1", "--text", "One writer.", "--non-load-bearing"],
    ["decision", "claim", "fulfill", "dec_edge", "--id", "C1", "--mode", "evidenced"],
    ["decision", "review", "dec_edge", "--from-file", "decision-review.json"],
    ["decision", "accept", "dec_edge", "--rationale", "Approved.", "--judgment-only", "Verified."],
    ["decision", "reject", "dec_edge", "--rationale", "Rejected."],
    ["decision", "defer", "dec_edge", "--rationale", "Deferred."],
    ["decision", "reckon", "dec_edge", "--task", "task_edge"],
    ["task", "attest", "task_edge", "--gate", "gate_one", "--result", "pass", "--note", "Checked"],
    ["task", "annotate", "task_edge", "--execution-id", "exe_edge", "--note", "Corrected", "--kind", "correction"],
    [
      "task",
      "witness-revoke",
      "task_edge",
      "--execution-id",
      "exe_edge",
      "--gate",
      "gate_one",
      "--run-id",
      "run_one",
      "--reason",
      "Stopped",
    ],
    ["task", "supersede", "task_old", "--title", "Replacement"],
    ["task", "delete", "--soft", "task_edge", "--reason", "Obsolete"],
    ["script", "run", "vertical:software:document", "--dry-run"],
    ["preset", "upgrade", "task_edge"],
    ["decision", "transition", "superseded", "dec_edge"],
    ["decision", "repin", "dec_edge", "--migration-evidence", "task/task_edge/evidence"],
    ["distill", "candidate", "--task", "task_edge", "--entity", "software/document/report"],
    [
      "distill",
      "promote",
      "--task",
      "task_edge",
      "--candidate",
      "harness/tasks/task_edge/artifacts/candidate.json",
      "--claim",
      "Observed a result.",
    ],
  ]) {
    const parsed = parseThinCommand(argv, root);
    assert.ok(parsed.ok, JSON.stringify(parsed));
    if (!parsed.ok) continue;
    const routed = await fleetTaskRoute(parsed.command, env);
    assert.ok(routed, argv.join(" "));
    assert.equal(isFleetTaskAction(JSON.parse(JSON.stringify(routed.action))), true, JSON.stringify(routed.action));
    for (const field of ["fromFile", "bodyFile", "idsFile"])
      assert.equal(Object.hasOwn(routed.action as object, field), false);
  }
  // A resident preset process has a dedicated lifetime/status port; it cannot use the task writer wire.
  const preset = parseThinCommand(
    ["script", "run", "preset:standard-task/check", "--idempotency-key", "edge-run"],
    root,
  );
  assert.ok(preset.ok);
  if (preset.ok) assert.equal(await fleetTaskRoute(preset.command, env), null);
  // task show and work list are edge-replica now: the CLI still routes them to the edge daemon, but
  // their actions no longer form a legal center-forwarded repository-read frame.
  for (const argv of [
    ["task", "show", "task_one"],
    ["work", "list", "--all", "--limit", "500"],
  ]) {
    const parsed = parseThinCommand(argv, root);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      const routed = await fleetTaskRoute(parsed.command, env);
      assert.ok(routed, argv.join(" "));
      assert.throws(
        () =>
          parseFleetFrame({
            schema: "fleet.repository.read/v1",
            messageId: "read",
            repoId: "route-repo",
            accessToken: null,
            method: "repo.task.read",
            payload: routed.action,
          }),
        /closed schema fleet\.repository\.read\/v1/u,
      );
    }
  }
});

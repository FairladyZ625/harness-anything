// harness-test-tier: integration
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";
import {
  cli,
  createRuntimeFixture,
  installIdentities,
  readPublishedDispatch,
  run,
  runMaybe,
  seedTask,
} from "./runtime-cli.fixtures.ts";
import { readFileSync } from "node:fs";
import {
  livingDeliverableProtocol,
  taskPlanSection,
  taskPrPublicationNote,
  taskQueryGuidance,
} from "@harness-anything/daemon/internal/runtime-spawn-mission";
import { safePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { runCommandThroughDaemon } from "../src/daemon/client.ts";
import { realizedTaskPlan as realizedPlan } from "../../../tools/fixtures/task-plan.mjs";
import { renderedRulingContract, writeIdentity, workerWorktreeBoundary } from "./runtime-cli.fixtures.ts";

test("a worker escalation blocks its task until the owner answers and resumes with that answer", async (context) => {
  const fixture = createRuntimeFixture(context),
    { parent, root, env } = fixture,
    task = seedTask(root, env, "worker-escalation"),
    answer = "Keep the original ownership boundary; the owner will handle the shared host change.",
    question = "May this worker change the shared host lifecycle?";
  writeProviderExecutable(
    path.join(parent, "bin", "codex"),
    [
      'const childProcess = require("node:child_process");',
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") { console.log("codex 0.0.0-runtime-cli-fixture"); process.exit(0); }',
      'if (args[0] === "login" && args[1] === "status") process.exit(0);',
      'const prompt = fs.readFileSync(0, "utf8");',
      `fs.writeFileSync(${JSON.stringify(path.join(parent, "observed-worker-prompt.md"))}, prompt);`,
      `const cli = ${JSON.stringify(cli)}, taskId = prompt.match(/^Canonical Task ID: (\\S+)$/mu)?.[1];`,
      'if (!taskId) { process.stderr.write("dispatch task id missing"); process.exit(7); }',
      'const run = (argv, env = process.env) => { const result = childProcess.spawnSync(process.execPath, [cli, "--root", process.cwd(), "--json", ...argv], { encoding: "utf8", env }); const receipt = result.stdout.trim() ? JSON.parse(result.stdout) : {}; return { status: result.status, code: receipt.code ?? null }; };',
      "const noCredentialEnv = { ...process.env }; delete noCredentialEnv.HARNESS_EXECUTION_CREDENTIAL;",
      'const relayed = process.env.HARNESS_DAEMON_RELAY === "1";',
      `const noCredential = relayed ? run(["task", "show", taskId], noCredentialEnv) : run(["task", "escalate", taskId, "--question", ${JSON.stringify(question)}], noCredentialEnv);`,
      `const otherTask = run(["task", "escalate", "task-outside-dispatch", "--question", ${JSON.stringify(question)}]);`,
      `const escalated = run(["task", "escalate", taskId, "--question", ${JSON.stringify(question)}, "--option", "Keep boundary", "--option", "Expand scope", "--recommend", "Keep boundary", "--reason", "The shared host file is outside this dispatch."]);`,
      'const credentialProbe = relayed ? noCredential.status === 0 : noCredential.code === "execution_credential_rejected";',
      'if (!credentialProbe || otherTask.code !== "execution_credential_rejected" || escalated.status !== 0) { process.stderr.write("credential probe failed: " + JSON.stringify({ relayed, noCredential, otherTask, escalated })); process.exit(8); }',
      "const answered = prompt.includes(" + JSON.stringify("Owner answer to worker escalation") + ");",
      `const expectedAnswer = ${JSON.stringify(answer)};`,
      "const injected = prompt.includes(expectedAnswer);",
      'const conclusion = injected ? "owner-answer-injected" : answered ? "answer-missing" : "worker-escalated:" + JSON.stringify({ noCredential, otherTask });',
      'console.log(JSON.stringify({ type: "thread.started", thread_id: "provider-escalation" }));',
      'console.log(JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: conclusion } }));',
      'console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));',
    ].join("\n"),
  );

  installIdentities(parent, root, env);
  run(root, env, ["task", "start", task.taskId, "--execution-id", task.executionId]);
  const first = runMaybe(root, env, [
    "agent",
    "run",
    "terra",
    "--cwd",
    ".",
    "--task",
    task.taskId,
    "--prompt",
    "escalate now",
    "--no-stream",
  ]);
  assert.equal(first.status, 1, `${first.stderr}\n${JSON.stringify(first.receipt)}`);
  const firstSpawn = first.receipt.spawn as Record<string, unknown>;
  assert.equal(typeof firstSpawn.dispatchId, "string", JSON.stringify(first.receipt));
  const dispatchId = String(firstSpawn.dispatchId),
    dispatches = runMaybe(root, env, ["task", "dispatches", task.taskId]).receipt.dispatches as Array<
      Record<string, unknown>
    >,
    firstDispatch = dispatches.find((row) => row.dispatchId === dispatchId);
  assert.equal(firstDispatch?.classification, "awaiting_ruling", JSON.stringify(firstDispatch));
  assert.equal(dispatches.length, 1, "an escalation must settle as waiting, without automatic re-dispatch");
  assert.deepEqual(firstDispatch?.ruling, {
    question,
    options: ["Keep boundary", "Expand scope"],
    path: `${task.packagePath}/artifacts/rulings/${dispatchId}.md`,
  });
  assert.equal(firstDispatch?.reason, question);
  const shownWhileBlocked = run(root, env, ["task", "show", task.taskId]);
  assert.equal(JSON.parse(String(shownWhileBlocked.evidence)).task.status, "blocked");

  const agenda = run(root, env, ["agenda"]),
    agendaRows = (agenda.awaitingRuling ?? []) as Array<Record<string, unknown>>,
    agendaRow = agendaRows.find((row) => row.dispatchId === dispatchId);
  assert.equal(agendaRow?.question, question, JSON.stringify(agenda));
  assert.deepEqual(agendaRow?.options, ["Keep boundary", "Expand scope"]);
  assert.match(String(agenda.summary), /待你处理/u);

  const rulingPath = path.join(root, task.packagePath, "artifacts", "rulings", `${dispatchId}.md`),
    resolutionSource = path.join(parent, "owner-resolution.json");
  writeFileSync(rulingPath, "");
  run(root, env, ["doc", "sync", "--submit", "--path", `${task.packagePath}/artifacts/rulings/${dispatchId}.md`]);
  writeFileSync(
    resolutionSource,
    JSON.stringify({
      schema: "worker-escalation-resolution/v1",
      dispatchId,
      taskId: task.taskId,
      answer,
      answeredAt: "2026-11-02T00:00:00.000Z",
    }),
  );
  run(root, env, [
    "task",
    "artifact",
    "add",
    task.taskId,
    "--source",
    resolutionSource,
    "--destination",
    `${task.packagePath}/artifacts/rulings/${dispatchId}.resolution.md`,
  ]);
  run(root, env, ["task", "escalation", "resolve", task.taskId, "--dispatch-id", dispatchId, "--answer", answer]);
  const shownAfterResolution = run(root, env, ["task", "show", task.taskId]);
  assert.equal(JSON.parse(String(shownAfterResolution.evidence)).task.status, "planned");
  run(root, env, ["task", "start", task.taskId]);
  const next = runMaybe(root, env, [
    "agent",
    "run",
    "terra",
    "--cwd",
    ".",
    "--task",
    task.taskId,
    "--prompt",
    "continue",
    "--no-stream",
  ]);
  assert.equal(next.status, 1, `${next.stderr}\n${JSON.stringify(next.receipt)}`);
  const nextDispatchId = String((next.receipt.spawn as Record<string, unknown>).dispatchId);
  assert.notEqual(nextDispatchId, dispatchId);
  assert.ok(
    (await readPublishedDispatch(path.join(parent, "observed-worker-prompt.md"))).includes(answer),
    "the next worker process must receive the owner's ruling answer",
  );
  assert.match(
    await readPublishedDispatch(path.join(task.artifactRoot, "missions", `${nextDispatchId}.md`)),
    new RegExp(`Owner answer to worker escalation ${dispatchId}: ${answer}`, "u"),
  );
});

test(
  "Daemon request contracts receive executor attribution only on declared surfaces",
  { timeout: 300_000 },
  async (context) => {
    const fixture = createRuntimeFixture(context);
    const { root, env } = fixture;
    const { taskId, executionId } = seedTask(root, env, "executor");
    run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
    // #1572: with HARNESS_ACTOR declared, the daemon request log is the server-side proof that executor
    // attribution still arrives — inside the action for repo.task.run writes (task start) and at payload
    // level for preset methods (task create) — while nothing is ever rejected for an undeclared executor.
    const requests = readFileSync(path.join(root, ".harness", "requests", "requests.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      requests.find((entry) => entry.method === "repo.task.run" && entry.command === "task-start")?.executor,
      { kind: "agent", id: "runtime-cli-test" },
    );
    assert.deepEqual(requests.find((entry) => entry.method === "repo.task.create")?.executor, {
      kind: "agent",
      id: "runtime-cli-test",
    });
    assert.equal(
      requests.some((entry) => entry.code === "invalid_request"),
      false,
      JSON.stringify(requests.filter((entry) => entry.code === "invalid_request")),
    );
    // A contracted read method with no CLI argv (repo.tasks.documents.list declares a closed payload
    // without executor) stands in for "the next new command": with an explicit HARNESS_ACTOR, injection
    // must follow the daemon-declared surface, so the real daemon accepts the request instead of
    // rejecting an undeclared executor.
    const probe = await runCommandThroughDaemon(
      {
        rootDir: safePath(root),
        repoId: "runtime-cli",
        json: true,
        method: "repo.tasks.documents.list",
        action: { kind: "task-documents-list", taskId },
      },
      undefined,
      { env: { ...env, HARNESS_ACTOR: "agent:injection-probe" } },
    );
    assert.equal(probe.ok, true, JSON.stringify(probe));
  },
);

test(
  "CLI installs identities, updates squads and assembles wildcard worker prompts",
  { timeout: 300_000 },
  async (context) => {
    const fixture = createRuntimeFixture(context);
    const { parent, root, env } = fixture;
    const { squadSource } = installIdentities(parent, root, env);
    const agents = JSON.parse(String(run(root, env, ["agent", "list"]).evidence)) as { agents: Array<{ id: string }> },
      squads = JSON.parse(String(run(root, env, ["squad", "list"]).evidence)) as { squads: Array<{ id: string }> };
    assert.deepEqual(
      agents.agents.map(({ id }) => id),
      ["any-worker", "fable", "opencode-worker", "outsider", "terra"],
    );
    assert.deepEqual(
      squads.squads.map(({ id }) => id),
      ["core-squad"],
    );
    writeIdentity(squadSource, {
      id: "core-squad",
      title: "Core Squad",
      kind: "squad",
      squad: {
        id: "core-squad",
        name: "Core Squad",
        leader: "fable",
        workers: ["terra", "opencode-worker"],
        leaderTurnBudget: 8,
        roster: "# Core Squad\n\nFable delegates; humans edited this roster.",
      },
    });
    run(root, env, ["squad", "install", "--source", squadSource]);
    const squad = JSON.parse(String(run(root, env, ["squad", "inspect", "core-squad"]).evidence)) as {
      squad: { roster: string };
    };
    assert.match(squad.squad.roster, /humans edited/u);
    const { taskId, executionId } = seedTask(root, env, "identity");
    run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
    // The wildcard worker completes its provider turn but delivers nothing on the task, so the
    // dispatch settles unknown and the no-stream wait exits 1 (F-4C182EEE).
    const wildcard = runMaybe(root, env, [
      "agent",
      "run",
      "any-worker",
      "--prompt",
      "wildcard prompt",
      "--cwd",
      ".",
      "--task",
      taskId,
      "--no-stream",
    ]);
    assert.equal(wildcard.status, 1, `${wildcard.stderr}\n${JSON.stringify(wildcard.receipt)}`);
    const wildcardText = String((wildcard.receipt.result as Record<string, unknown>).text);
    assert.ok(
      wildcardText.startsWith(
        "final:# Agent Identity: Any Worker (any-worker)\n\nUse any compatible runtime.\n\n# Harness Execution Discipline",
      ),
      wildcardText,
    );
    assert.match(wildcardText, /# Worker Role/u);
    const wildcardDispatchId = String((wildcard.receipt.spawn as Record<string, unknown>).dispatchId);
    assert.ok(
      wildcardText.endsWith(
        `# Assigned Mission\n${taskPlanSection(realizedPlan("identity"))}\n\n${taskQueryGuidance(taskId)}\n\n${renderedRulingContract(wildcardDispatchId)}\n\n${workerWorktreeBoundary}\n\n本任务的提交将由评审员 closeout-reviewer 审查（内置默认）。提交即自动派评审；预算未耗尽时 changes_requested 会回到本轮返工并携带评审报告，预算耗尽后由业主使用 ha task rework <task-id> --reason <why> 退回。\n\n${livingDeliverableProtocol("baseline")!}\n\n${taskPrPublicationNote}\n\nwildcard prompt` +
          `\n\nTask ${taskId} is not submitted: the worker exited without a submitted delivery. ` +
          `Recover the stopped worker with: ha agent run any-worker --task ${taskId} ` +
          `--recover-dispatch ${wildcardDispatchId} --execution-id ${executionId} ` +
          "--expected-version <revision> --idempotency-key <key>",
      ),
      wildcardText,
    );
    assert.ok(
      wildcardText.indexOf("# Worker Role") < wildcardText.indexOf("prompt://review") &&
        wildcardText.indexOf("prompt://review") < wildcardText.indexOf("# Standard Task") &&
        wildcardText.indexOf("# Standard Task") < wildcardText.indexOf("# Mission"),
      "the role prompt, declared prompts, and preset must reach the real CLI dispatch in declaration order",
    );
  },
);

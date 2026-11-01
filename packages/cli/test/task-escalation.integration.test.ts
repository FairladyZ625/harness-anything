// harness-test-tier: integration
import assert from "node:assert/strict";
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
      `const noCredential = run(["task", "escalate", taskId, "--question", ${JSON.stringify(question)}], noCredentialEnv);`,
      `const otherTask = run(["task", "escalate", "task-outside-dispatch", "--question", ${JSON.stringify(question)}]);`,
      `const escalated = run(["task", "escalate", taskId, "--question", ${JSON.stringify(question)}, "--option", "Keep boundary", "--option", "Expand scope", "--recommend", "Keep boundary", "--reason", "The shared host file is outside this dispatch."]);`,
      'if (noCredential.code !== "execution_credential_rejected" || otherTask.code !== "execution_credential_rejected" || escalated.status !== 0) { process.stderr.write("credential probe failed: " + JSON.stringify({ noCredential, otherTask, escalated })); process.exit(8); }',
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

  run(root, env, ["task", "escalation", "resolve", task.taskId, "--dispatch-id", dispatchId, "--answer", answer]);
  const shownAfterResolution = run(root, env, ["task", "show", task.taskId]);
  assert.equal(JSON.parse(String(shownAfterResolution.evidence)).task.status, "planned");
  run(root, env, ["task", "start", task.taskId, "--execution-id", task.executionId]);
  const next = runMaybe(root, env, [
    "agent",
    "run",
    "terra",
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

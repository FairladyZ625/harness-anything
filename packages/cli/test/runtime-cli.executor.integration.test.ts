// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { safePath } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { runCommandThroughDaemon } from "../src/daemon/client.ts";
import { run } from "./runtime-cli.commands.fixture.ts";
import { createRuntimeFixture, seedTask } from "./runtime-cli.setup.fixture.ts";

test("Daemon request contracts receive executor attribution only on declared surfaces", async (context) => {
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
});

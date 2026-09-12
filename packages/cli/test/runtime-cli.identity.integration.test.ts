// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { run } from "./runtime-cli.commands.fixture.ts";
import { createRuntimeFixture, installIdentities, seedTask, writeIdentity } from "./runtime-cli.setup.fixture.ts";

test("CLI installs identities, updates squads and assembles wildcard worker prompts", async (context) => {
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
  const wildcard = run(root, env, [
    "agent",
    "run",
    "any-worker",
    "--prompt",
    "wildcard prompt",
    "--task",
    taskId,
    "--no-stream",
  ]);
  const wildcardText = String((wildcard.result as Record<string, unknown>).text);
  assert.ok(
    wildcardText.startsWith(
      "final:# Agent Identity: Any Worker (any-worker)\n\nUse any compatible runtime.\n\n# Harness Execution Discipline",
    ),
    wildcardText,
  );
  assert.match(wildcardText, /# Worker Role/u);
  assert.ok(wildcardText.endsWith("# Assigned Mission\nwildcard prompt"), wildcardText);
  assert.ok(
    wildcardText.indexOf("# Worker Role") < wildcardText.indexOf("prompt://review") &&
      wildcardText.indexOf("prompt://review") < wildcardText.indexOf("# Standard Task") &&
      wildcardText.indexOf("# Standard Task") < wildcardText.indexOf("# Mission"),
    "the role prompt, declared prompts, and preset must reach the real CLI dispatch in declaration order",
  );
});

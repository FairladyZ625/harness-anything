import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext } from "node:test";
import { localUserDaemonEndpoint } from "../src/daemon/client.ts";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";
import { realizedTaskPlan as realizedPlan } from "../../../tools/fixtures/task-plan.mjs";
import { run, runMaybe, published } from "./runtime-cli.commands.fixture.ts";
import { writeProgressProvider } from "./runtime-cli.provider.fixture.ts";

export function createRuntimeFixture(context: TestContext) {
  const parent = mkdtempSync(path.join(process.platform === "win32" ? tmpdir() : "/tmp", "ha-runtime-cli-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    daemonId = `runtime-cli-test-${randomUUID()}`,
    binRoot = path.join(parent, "bin"),
    version = "0.0.0-runtime-cli-fixture",
    {
      HARNESS_DAEMON_ENDPOINT: _endpoint,
      HARNESS_DAEMON_REPO_ID: _repoId,
      HARNESS_DAEMON_ID: _daemonId,
      ...baseEnv
    } = process.env;
  mkdirSync(root, { recursive: true });
  mkdirSync(binRoot, { recursive: true });
  writeProgressProvider(path.join(binRoot, "codex"), version);
  writeProgressProvider(path.join(binRoot, "claude"), version);
  writeProviderExecutable(
    path.join(binRoot, "gh"),
    'if (process.argv[2] !== "run" || process.argv[3] !== "list") process.exit(1); console.log("[]");\n',
  );
  const env = {
    ...baseEnv,
    HOME: path.join(parent, "home"),
    TMPDIR: process.platform === "win32" ? baseEnv.TMPDIR : "/tmp",
    PATH: [
      binRoot,
      ...(process.env.PATH ?? "")
        .split(path.delimiter)
        .filter((entry) => ["codex", "codex.cmd", "codex.exe"].every((name) => !existsSync(path.join(entry, name)))),
    ].join(path.delimiter),
    OPENAI_API_KEY: "sk-must-not-reach-notifier",
    HARNESS_NOTIFY_TEST_SECRET: "must-not-reach-notifier",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: daemonId,
    HARNESS_DAEMON_ENDPOINT: localUserDaemonEndpoint(userRoot, daemonId),
    HARNESS_ACTOR: "agent:runtime-cli-test",
  };
  context.after(() => {
    runMaybe(root, env, ["daemon", "stop"]);
    rmSync(parent, { recursive: true, force: true });
  });
  assert.equal(run(root, env, ["daemon", "start", "--service"]).ok, true);
  run(root, env, ["init", "--repo-id", "runtime-cli", "--person-id", "owner", "--display-name", "Owner"]);
  run(root, env, [
    "runtime",
    "instance",
    "create",
    "--id",
    "cli-worker",
    "--name",
    "CLI Worker",
    "--kind",
    "codex",
    "--provider",
    "openai",
    "--model",
    "runtime-test-model",
    "--auth",
    "subscription",
  ]);
  return { parent, root, userRoot, daemonId, env, version };
}

export function seedTask(root: string, env: NodeJS.ProcessEnv, scenario: string) {
  const taskId = `task-runtime-${scenario}`,
    executionId = `exec-runtime-${scenario}`,
    created = run(root, env, ["task", "create", "--id", taskId, "--admin", "--title", scenario]),
    packagePath = String(created.packagePath),
    artifactRoot = path.join(root, "harness", packagePath, "artifacts");
  published(root, env, created);
  writeFileSync(path.join(root, "harness", packagePath, "task_plan.md"), realizedPlan(scenario));
  run(root, env, ["doc", "sync", "--submit", "--path", `${packagePath}/task_plan.md`]);
  return { taskId, executionId, packagePath, artifactRoot };
}

export function installIdentities(parent: string, root: string, env: NodeJS.ProcessEnv) {
  mkdirSync(path.join(root, "harness", "skills", "review"), { recursive: true });
  writeFileSync(
    path.join(root, "harness", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review\n---\nReview fixture.\n",
  );
  run(root, env, [
    "runtime",
    "instance",
    "create",
    "--id",
    "claude-worker",
    "--name",
    "Claude Worker",
    "--kind",
    "claude",
    "--provider",
    "anthropic",
    "--model",
    "runtime-test-model",
    "--auth",
    "subscription",
  ]);
  const identities = [
      {
        id: "fable",
        name: "Fable",
        instructions: "Lead precisely.",
        runtime_type: "codex",
        instance: "cli-worker",
        role: "commander",
      },
      {
        id: "terra",
        name: "Terra",
        instructions: "Review precisely.",
        runtime_type: "codex",
        instance: "cli-worker",
        role: "worker",
      },
      {
        id: "outsider",
        name: "Outsider",
        instructions: "Work outside the squad.",
        runtime_type: "codex",
        instance: "cli-worker",
        role: "worker",
      },
      {
        id: "opencode-worker",
        name: "OpenCode Worker",
        instructions: "Use OpenCode.",
        runtime_type: "claude",
        instance: "claude-worker",
        role: "worker",
      },
      {
        id: "any-worker",
        name: "Any Worker",
        instructions: "Use any compatible runtime.",
        runtime_type: "any",
        instance: "cli-worker",
        role: "worker",
      },
    ],
    squadSource = path.join(parent, "core-squad");
  for (const identity of identities) {
    const agentSource = path.join(parent, identity.id);
    writeIdentity(agentSource, {
      id: identity.id,
      title: identity.name,
      kind: "agent",
      agent: {
        ...identity,
        skills: [{ id: "review", path: "skills/review" }],
        prompts: ["prompt://review"],
        preset: "standard-task",
      },
    });
    run(root, env, ["agent", "install", "--source", agentSource]);
  }
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
      roster: "# Core Squad\n\nFable delegates to Terra and OpenCode Worker.",
    },
  });
  run(root, env, ["squad", "install", "--source", squadSource]);
  return { squadSource };
}

export function writeIdentity(
  target: string,
  identity: Record<string, unknown> & { agent?: Record<string, unknown>; squad?: Record<string, unknown> },
): void {
  const kind = String(identity.kind) as "agent" | "squad",
    declaration = kind === "agent" ? identity.agent : identity.squad;
  mkdirSync(target, { recursive: true });
  writeFileSync(
    path.join(target, kind === "agent" ? "agent.json" : "squad.json"),
    `${JSON.stringify({ schema: `${kind}-declaration/v1`, ...declaration }, null, 2)}\n`,
  );
}

// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";

const cli = path.resolve("packages/cli/src/index.ts");

test("agent create consumes structured designer output, validates before install, and the created Agent runs", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-agent-create-cli-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    binRoot = path.join(parent, "bin");
  mkdirSync(root, { recursive: true });
  mkdirSync(binRoot, { recursive: true });
  writeProvider(path.join(binRoot, "codex"));
  const env = {
    ...process.env,
    HOME: path.join(parent, "home"),
    PATH: [binRoot, process.env.PATH ?? ""].join(path.delimiter),
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: "agent-create-test",
    HARNESS_ACTOR: "agent:agent-create-test",
  };
  try {
    assert.equal(run(root, env, ["daemon", "start", "--service"]).ok, true);
    run(root, env, [
      "init",
      "--repo-id",
      "agent-create",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
    ]);
    const designerRoot = path.join(parent, "designer"),
      squadRoot = path.join(parent, "squad");
    writeAgent(designerRoot, {
      schema: "agent-declaration/v1",
      id: "meta-designer",
      name: "Meta Designer",
      instructions: "Design only.",
      runtime_type: "codex",
    });
    const preview = run(root, env, [
      "agent",
      "install",
      "--source",
      designerRoot,
      "--dry-run",
    ]);
    assert.equal(preview.outcome, "pending");
    assert.equal((preview.proof as Record<string, unknown>).durable, false);
    assert.equal(
      (preview.proof as Record<string, unknown>).canonicalVisible,
      false,
    );
    assert.equal(
      existsSync(path.join(root, "harness", "agents", "meta-designer.json")),
      false,
    );
    const installed = run(root, env, [
      "agent",
      "install",
      "--source",
      designerRoot,
    ]);
    writeSquad(squadRoot, {
      schema: "squad-declaration/v1",
      id: "designer-squad",
      name: "Designer Squad",
      leader: "meta-designer",
      workers: ["meta-designer"],
      roster: "# Designer Squad",
    });
    const squadInstalled = run(root, env, [
      "squad",
      "install",
      "--source",
      squadRoot,
    ]);
    for (const receipt of [installed, squadInstalled]) {
      assert.equal(receipt.outcome, "applied");
      assert.equal((receipt.proof as Record<string, unknown>).durable, true);
      assert.equal(
        (receipt.proof as Record<string, unknown>).canonicalVisible,
        true,
      );
      const evidence = JSON.parse(String(receipt.evidence)) as {
        event: { schema: string; opId: string; path: string };
      };
      assert.equal(evidence.event.schema, "agent-entity-event/v1");
      assert.equal(evidence.event.opId, receipt.opId);
      assert.match(evidence.event.path, /^(?:agents|squads)\/.+\.json$/u);
    }
    assert.equal(
      existsSync(path.join(root, "harness", "agents", "meta-designer.json")),
      true,
    );
    assert.equal(
      existsSync(path.join(root, "harness", "squads", "designer-squad.json")),
      true,
    );
    assert.equal(existsSync(path.join(root, ".harness", "agents")), false);
    assert.equal(existsSync(path.join(root, ".harness", "squads")), false);
    run(root, env, ["daemon", "stop"]);
    assert.equal(run(root, env, ["daemon", "start", "--service"]).ok, true);
    const agentList = JSON.parse(
        String(run(root, env, ["agent", "list"]).evidence),
      ) as {
        agents: Array<{ id: string }>;
      },
      squadList = JSON.parse(
        String(run(root, env, ["squad", "list"]).evidence),
      ) as { squads: Array<{ id: string }> };
    assert.equal(
      agentList.agents.some(({ id }) => id === "meta-designer"),
      true,
    );
    assert.equal(
      squadList.squads.some(({ id }) => id === "designer-squad"),
      true,
    );
    const inventory = run(root, env, ["runtime", "instance", "list"]),
      installation = (
        inventory.installations as Array<Record<string, unknown>>
      ).find((row) => row.version === "codex agent-create-fixture");
    assert.ok(installation);
    run(root, env, [
      "runtime",
      "instance",
      "create",
      "--id",
      "builder",
      "--name",
      "Builder",
      "--kind",
      "codex",
      "--installation",
      String(installation.installationId),
      "--provider",
      "openai",
      "--model",
      "runtime-test-model",
      "--auth",
      "subscription",
    ]);
    const created = run(root, env, [
      "task",
      "create",
      "--id",
      "agent-create-task",
      "--admin",
      "--title",
      "Agent create",
    ]) as Record<string, unknown>;
    run(root, env, [
      "task",
      "start",
      "agent-create-task",
      "--execution-id",
      "agent-create-execution",
    ]);
    const generated = {
      schema: "agent-declaration/v1",
      id: "mechanic-agent",
      name: "Mechanical Repair",
      instructions: "MECHANIC_INSTRUCTIONS_WITNESS",
      runtime_type: "codex",
    };
    const create = run(root, env, [
      "agent",
      "create",
      "builder",
      "--agent",
      "meta-designer",
      "--prompt",
      "Create a small mechanical repair Agent",
      "--task",
      "agent-create-task",
    ]) as Record<string, unknown>;
    assert.deepEqual(create.declaration, generated);
    assert.equal((create.installation as Record<string, unknown>).ok, true);
    const requests = readFileSync(
      path.join(root, ".harness", "requests", "requests.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(
      requests.some((row) => row.command === "agent-validate"),
      true,
    );
    const inspected = JSON.parse(
      String(run(root, env, ["agent", "inspect", "mechanic-agent"]).evidence),
    ) as Record<string, unknown>;
    assert.deepEqual(
      (inspected.agent as Record<string, unknown>).instructions,
      generated.instructions,
    );
    const duplicate = runMaybe(root, env, [
      "agent",
      "create",
      "builder",
      "--agent",
      "meta-designer",
      "--prompt",
      "Create the same Agent",
      "--task",
      "agent-create-task",
    ]);
    assert.equal(duplicate.status, 1);
    assert.equal(duplicate.receipt.code, "agent_id_conflict");
    assert.match(
      String(duplicate.receipt.nextAction),
      /ha agent inspect mechanic-agent.*ha agent create/u,
    );
    const unavailable = runMaybe(root, env, [
      "agent",
      "create",
      "builder",
      "--agent",
      "meta-designer",
      "--prompt",
      "UNKNOWN_RUNTIME",
      "--task",
      "agent-create-task",
    ]);
    assert.equal(unavailable.status, 1);
    assert.equal(unavailable.receipt.code, "agent_runtime_type_unavailable");
    assert.match(
      String(unavailable.receipt.nextAction),
      /ha runtime instance list.*retry ha agent create/u,
    );
    const child = run(root, env, [
      "runtime",
      "run",
      "builder",
      "--agent",
      "mechanic-agent",
      "--prompt",
      "WRITE_WITNESS",
      "--task",
      "agent-create-task",
      "--no-stream",
    ]);
    assert.equal(child.outcome, "succeeded");
    assert.equal(existsSync(path.join(root, "created-by-agent.txt")), true);
    assert.equal(
      readFileSync(path.join(root, "created-by-agent.txt"), "utf8"),
      "created by mechanic-agent\n",
    );
    const dispatch = JSON.parse(
      readFileSync(
        path.join(
          root,
          "harness",
          String(created.packagePath),
          "artifacts",
          "dispatches",
          `${String((child.spawn as Record<string, unknown>).dispatchId)}.json`,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const mission = readFileSync(
      path.join(root, "harness", String(dispatch.missionRef)),
      "utf8",
    );
    assert.equal(dispatch.agentId, "mechanic-agent");
    assert.match(mission, /MECHANIC_INSTRUCTIONS_WITNESS/u);
    const stream = readFileSync(
      path.join(
        root,
        ".harness",
        "runtime",
        "dispatches",
        `${String((child.spawn as Record<string, unknown>).dispatchId)}.jsonl`,
      ),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(
      stream.some((row) => row.kind === "provider_event"),
      true,
    );
  } finally {
    runMaybe(root, env, ["daemon", "stop"]);
    rmSync(parent, { recursive: true, force: true });
  }
});

function run(
  root: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Record<string, unknown> {
  const result = runMaybe(root, env, args);
  assert.equal(
    result.status,
    0,
    `${result.stderr}\n${JSON.stringify(result.receipt)}`,
  );
  return result.receipt;
}
function runMaybe(
  root: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): {
  readonly status: number | null;
  readonly receipt: Record<string, unknown>;
  readonly stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [cli, "--root", root, "--json", ...args],
    { encoding: "utf8", env },
  );
  return {
    status: result.status,
    receipt: result.stdout.trim()
      ? (JSON.parse(result.stdout) as Record<string, unknown>)
      : {},
    stderr: result.stderr,
  };
}
function writeAgent(root: string, declaration: Record<string, unknown>): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, "agent.json"),
    `${JSON.stringify(declaration, null, 2)}\n`,
  );
}
function writeSquad(root: string, declaration: Record<string, unknown>): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, "squad.json"),
    `${JSON.stringify(declaration, null, 2)}\n`,
  );
}
function writeProvider(target: string): void {
  writeProviderExecutable(
    target,
    `const fs = require("node:fs");\nconst prompt = fs.readFileSync(0, "utf8"), args = process.argv.slice(2);\nif (args[0] === "--version") { console.log("codex agent-create-fixture"); process.exit(0); }\nif (args[0] === "login" && args[1] === "status") process.exit(0);\nconst declaration = prompt.includes("UNKNOWN_RUNTIME") ? ${JSON.stringify({ schema: "agent-declaration/v1", id: "unavailable-agent", name: "Unavailable", instructions: "Unavailable instructions.", runtime_type: "opencode" })} : ${JSON.stringify({ schema: "agent-declaration/v1", id: "mechanic-agent", name: "Mechanical Repair", instructions: "MECHANIC_INSTRUCTIONS_WITNESS", runtime_type: "codex" })};\nconst session = "agent-create-provider-session";\nconsole.log(JSON.stringify({ type: "thread.started", thread_id: session }));\nif (prompt.includes("# Agent declaration protocol") && prompt.includes('schema exactly "agent-declaration/v1"')) console.log(JSON.stringify({ type: "item.completed", item: { id: "declaration", type: "agent_message", text: JSON.stringify(declaration) } }));\nelse { if (prompt.includes("WRITE_WITNESS")) fs.writeFileSync("created-by-agent.txt", "created by mechanic-agent\\n"); console.log(JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", changes: [{ path: "created-by-agent.txt", kind: "add" }], status: "completed" } })); console.log(JSON.stringify({ type: "item.completed", item: { id: "final", type: "agent_message", text: "mechanic result" } })); }\nconsole.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));\n`,
  );
}

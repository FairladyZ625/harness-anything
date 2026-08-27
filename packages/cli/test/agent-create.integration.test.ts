// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";

const cli = path.resolve("packages/cli/src/index.ts");
const ontologySquad = {
  schema: "squad-declaration/v1",
  id: "ontology-squad",
  name: "Ontology 里程碑小队",
  leader: "ontology-commander",
  workers: ["sol", "terra", "luna", "glm-5-3", "ae-discrimination"],
  leaderTurnBudget: 8,
  roster:
    "默认派 sol:kernel / daemon / CLI 写路 / identity / gate 语义 / 任何需要读懂现有契约再改的活,以及所有子锚的第一版实现 -> sol\n明确机械且范围已被 sol 或 Commander 圈死的后端改造(按清单改、按模板生成、批量迁移)-> terra\n纯跑命令收数、生成测量表、重命名、整理清单 -> luna\n只有 packages/gui 渲染器与视图的核心前端逻辑 -> glm-5-3;GUI 之外不派它\n对已交回实现做变异/分辨力复核 -> ae-discrimination\n\n这个里程碑难且重要:拿不准派谁就派 sol,不要为了省额度降级。承重判断(限值数字、Entity 取舍、门的去留)不派 worker,由 Commander 整理成选项上报 CEO。一个 worker 一个 worktree,文件面不重叠。worker 回报里没有真实命令输出的,退回重做,不进综合报告。",
} as const;

test("agent create runs and ontology-squad reinstall stays on the canonical Entity write road", () => {
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
    run(root, env, ["init", "--repo-id", "agent-create", "--person-id", "owner", "--display-name", "Owner"]);
    const designerRoot = path.join(parent, "designer"),
      squadRoot = path.join(parent, "squad"),
      ontologySquadRoot = path.join(parent, "ontology-squad");
    writeAgent(designerRoot, {
      schema: "agent-declaration/v1",
      id: "meta-designer",
      name: "Meta Designer",
      instructions: "Design only.",
      runtime_type: "codex",
    });
    const preview = run(root, env, ["agent", "install", "--source", designerRoot, "--dry-run"]);
    assert.equal(preview.outcome, "pending");
    assert.equal((preview.proof as Record<string, unknown>).durable, false);
    assert.equal((preview.proof as Record<string, unknown>).canonicalVisible, false);
    assert.equal(existsSync(path.join(root, "harness", "agents", "meta-designer.json")), false);
    const installed = run(root, env, ["agent", "install", "--source", designerRoot]);
    writeSquad(squadRoot, {
      schema: "squad-declaration/v1",
      id: "designer-squad",
      name: "Designer Squad",
      leader: "meta-designer",
      workers: ["meta-designer"],
      leaderTurnBudget: 8,
      roster: "# Designer Squad",
    });
    const squadInstalled = run(root, env, ["squad", "install", "--source", squadRoot]);
    writeSquad(ontologySquadRoot, ontologySquad);
    const ontologyInstalled = run(root, env, ["squad", "install", "--source", ontologySquadRoot]),
      ontologyReinstalled = run(root, env, ["squad", "install", "--source", ontologySquadRoot]);
    for (const receipt of [installed, squadInstalled, ontologyInstalled, ontologyReinstalled]) {
      assert.equal(receipt.outcome, "applied");
      assert.equal((receipt.proof as Record<string, unknown>).durable, true);
      assert.equal((receipt.proof as Record<string, unknown>).canonicalVisible, true);
      const evidence = JSON.parse(String(receipt.evidence)) as {
        event: { schema: string; opId: string; path: string };
      };
      assert.equal(evidence.event.schema, "entity-event/v1");
      assert.equal(evidence.event.opId, receipt.opId);
      assert.match(evidence.event.path, /^(?:agents|squads)\/.+\.json$/u);
      assert.equal((receipt.detail as Record<string, unknown>).kind, "entity_upsert");
    }
    assert.equal(
      (JSON.parse(String(ontologyInstalled.evidence)) as { report: { changed: boolean } }).report.changed,
      true,
    );
    assert.equal(
      (JSON.parse(String(ontologyReinstalled.evidence)) as { report: { changed: boolean } }).report.changed,
      false,
    );
    const replayedInstall = run(root, env, ["receipt", "show", String(installed.opId)]);
    assert.deepEqual(replayedInstall.detail, installed.detail);
    assert.equal(existsSync(path.join(root, "harness", "agents", "meta-designer.json")), true);
    assert.equal(existsSync(path.join(root, "harness", "squads", "designer-squad.json")), true);
    assert.equal(existsSync(path.join(root, ".harness", "agents")), false);
    assert.equal(existsSync(path.join(root, ".harness", "squads")), false);
    run(root, env, ["daemon", "stop"]);
    assert.equal(run(root, env, ["daemon", "start", "--service"]).ok, true);
    const agentList = JSON.parse(String(run(root, env, ["agent", "list"]).evidence)) as {
        agents: Array<{ id: string }>;
      },
      squadList = JSON.parse(String(run(root, env, ["squad", "list"]).evidence)) as { squads: Array<{ id: string }> };
    assert.equal(
      agentList.agents.some(({ id }) => id === "meta-designer"),
      true,
    );
    assert.equal(
      squadList.squads.some(({ id }) => id === "designer-squad"),
      true,
    );
    const entityList = JSON.parse(String(run(root, env, ["entity", "list", "agent"]).evidence)) as {
        entities: Array<{ id: string }>;
      },
      entityGet = JSON.parse(String(run(root, env, ["entity", "get", "agent", "--id", "meta-designer"]).evidence)) as {
        entity: { value: { id: string } };
      },
      ontologyGet = JSON.parse(
        String(run(root, env, ["entity", "get", "squad", "--id", ontologySquad.id]).evidence),
      ) as { entity: { value: unknown } },
      agentExplanation = JSON.parse(String(run(root, env, ["entity", "explain", "agent"]).evidence)) as Record<
        string,
        unknown
      >,
      squadExplanation = JSON.parse(String(run(root, env, ["entity", "explain", "squad"]).evidence)) as Record<
        string,
        unknown
      >;
    assert.equal(
      entityList.entities.some(({ id }) => id === "meta-designer"),
      true,
    );
    assert.equal(entityGet.entity.value.id, "meta-designer");
    assert.deepEqual(ontologyGet.entity.value, ontologySquad);
    assert.deepEqual(Object.keys(agentExplanation).sort(), Object.keys(squadExplanation).sort());
    const inventory = run(root, env, ["runtime", "instance", "list"]),
      installation = (inventory.installations as Array<Record<string, unknown>>).find(
        (row) => row.version === "codex agent-create-fixture",
      );
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
    run(root, env, ["task", "start", "agent-create-task", "--execution-id", "agent-create-execution"]);
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
    const requests = readFileSync(path.join(root, ".harness", "requests", "requests.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(
      requests.some((row) => row.command === "agent-validate"),
      true,
    );
    const inspected = JSON.parse(String(run(root, env, ["agent", "inspect", "mechanic-agent"]).evidence)) as Record<
      string,
      unknown
    >;
    assert.deepEqual((inspected.agent as Record<string, unknown>).instructions, generated.instructions);
    run(root, env, ["task", "start", "agent-create-task", "--execution-id", "agent-create-execution"]);
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
    assert.match(String(duplicate.receipt.nextAction), /ha agent inspect mechanic-agent.*ha agent create/u);
    run(root, env, ["task", "start", "agent-create-task", "--execution-id", "agent-create-execution"]);
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
    assert.match(String(unavailable.receipt.nextAction), /ha runtime instance list.*retry ha agent create/u);
    run(root, env, ["task", "start", "agent-create-task", "--execution-id", "agent-create-execution"]);
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
    assert.equal(readFileSync(path.join(root, "created-by-agent.txt"), "utf8"), "created by mechanic-agent\n");
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
    const mission = readFileSync(path.join(root, "harness", String(dispatch.missionRef)), "utf8");
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

function run(root: string, env: NodeJS.ProcessEnv, args: readonly string[]): Record<string, unknown> {
  const result = runMaybe(root, env, args);
  assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.receipt)}`);
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
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], { encoding: "utf8", env });
  return {
    status: result.status,
    receipt: result.stdout.trim() ? (JSON.parse(result.stdout) as Record<string, unknown>) : {},
    stderr: result.stderr,
  };
}
function writeAgent(root: string, declaration: Record<string, unknown>): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "agent.json"), `${JSON.stringify(declaration, null, 2)}\n`);
}
function writeSquad(root: string, declaration: Record<string, unknown>): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "squad.json"), `${JSON.stringify(declaration, null, 2)}\n`);
}
function writeProvider(target: string): void {
  writeProviderExecutable(
    target,
    `const fs = require("node:fs");\nconst prompt = fs.readFileSync(0, "utf8"), args = process.argv.slice(2);\nif (args[0] === "--version") { console.log("codex agent-create-fixture"); process.exit(0); }\nif (args[0] === "login" && args[1] === "status") process.exit(0);\nconst declaration = prompt.includes("UNKNOWN_RUNTIME") ? ${JSON.stringify({ schema: "agent-declaration/v1", id: "unavailable-agent", name: "Unavailable", instructions: "Unavailable instructions.", runtime_type: "opencode" })} : ${JSON.stringify({ schema: "agent-declaration/v1", id: "mechanic-agent", name: "Mechanical Repair", instructions: "MECHANIC_INSTRUCTIONS_WITNESS", runtime_type: "codex" })};\nconst session = "agent-create-provider-session";\nconsole.log(JSON.stringify({ type: "thread.started", thread_id: session }));\nif (prompt.includes("# Agent declaration protocol") && prompt.includes('schema exactly "agent-declaration/v1"')) console.log(JSON.stringify({ type: "item.completed", item: { id: "declaration", type: "agent_message", text: JSON.stringify(declaration) } }));\nelse { if (prompt.includes("WRITE_WITNESS")) fs.writeFileSync("created-by-agent.txt", "created by mechanic-agent\\n"); console.log(JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", changes: [{ path: "created-by-agent.txt", kind: "add" }], status: "completed" } })); console.log(JSON.stringify({ type: "item.completed", item: { id: "final", type: "agent_message", text: "mechanic result" } })); }\nconsole.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));\n`,
  );
}

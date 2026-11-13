// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("parseThinCommand forwards --mcp-policy on runtime instance, dispatch, agent, and squad commands", () => {
  const createParsed = parseThinCommand([
    "runtime",
    "instance",
    "create",
    "--id",
    "rti-codex",
    "--name",
    "RTI Codex",
    "--kind",
    "codex",
    "--provider",
    "openai",
    "--model",
    "gpt-5.6-sol",
    "--auth",
    "subscription",
    "--mcp-policy",
    "inherit",
  ]);
  assert.equal(createParsed.ok, true);
  if (createParsed.ok) {
    assert.equal(createParsed.command.method, "daemon.runtimeInstance.create");
    assert.equal(createParsed.command.action.mcpPolicy, "inherit");
  }

  const updateParsed = parseThinCommand(["runtime", "instance", "update", "rti-codex", "--mcp-policy", "inherit"]);
  assert.equal(updateParsed.ok, true);
  if (updateParsed.ok) {
    assert.equal(updateParsed.command.method, "daemon.runtimeInstance.update");
    assert.equal(updateParsed.command.action.mcpPolicy, "inherit");
  }

  const updateDisabledParsed = parseThinCommand([
    "runtime",
    "instance",
    "update",
    "rti-codex",
    "--mcp-policy",
    "disabled",
  ]);
  assert.equal(updateDisabledParsed.ok, true);
  if (updateDisabledParsed.ok) {
    assert.equal(updateDisabledParsed.command.method, "daemon.runtimeInstance.update");
    assert.equal(updateDisabledParsed.command.action.mcpPolicy, "disabled");
  }

  const clearInstanceParsed = parseThinCommand(["runtime", "instance", "update", "rti-codex", "--clear-mcp-policy"]);
  assert.equal(clearInstanceParsed.ok, true);
  if (clearInstanceParsed.ok) {
    assert.equal(clearInstanceParsed.command.method, "daemon.runtimeInstance.update");
    assert.equal(clearInstanceParsed.command.action.mcpPolicy, "");
  }
  assert.equal(
    parseThinCommand(["runtime", "instance", "update", "rti-codex", "--mcp-policy", "inherit", "--clear-mcp-policy"])
      .ok,
    false,
  );

  const agentInstallSourceSet = parseThinCommand([
    "agent",
    "install",
    "--source",
    "agents/terra.json",
    "--mcp-policy",
    "inherit",
  ]);
  assert.equal(agentInstallSourceSet.ok, true);
  if (agentInstallSourceSet.ok) {
    assert.equal(agentInstallSourceSet.command.method, "repo.task.run");
    assert.equal(agentInstallSourceSet.command.action.kind, "agent-install");
    assert.equal(agentInstallSourceSet.command.action.mcpPolicy, "inherit");
  }

  const agentInstallIdSet = parseThinCommand([
    "agent",
    "install",
    "--id",
    "terra",
    "--mcp-policy",
    "inherit",
    "--expected-version",
    "2",
  ]);
  assert.equal(agentInstallIdSet.ok, true);
  if (agentInstallIdSet.ok) {
    assert.equal(agentInstallIdSet.command.method, "repo.task.run");
    assert.equal(agentInstallIdSet.command.action.kind, "agent-install");
    assert.equal(agentInstallIdSet.command.action.agentId, "terra");
    assert.equal(agentInstallIdSet.command.action.mcpPolicy, "inherit");
    assert.equal(agentInstallIdSet.command.action.expectedVersion, 2);
  }

  const agentInstallIdClear = parseThinCommand(["agent", "install", "--id", "terra", "--clear-mcp-policy"]);
  assert.equal(agentInstallIdClear.ok, true);
  if (agentInstallIdClear.ok) {
    assert.equal(agentInstallIdClear.command.method, "repo.task.run");
    assert.equal(agentInstallIdClear.command.action.kind, "agent-install");
    assert.equal(agentInstallIdClear.command.action.agentId, "terra");
    assert.equal(agentInstallIdClear.command.action.clearMcpPolicy, true);
  }

  assert.equal(parseThinCommand(["agent", "install"]).ok, false);
  assert.equal(parseThinCommand(["agent", "install", "--id", "terra"]).ok, false);
  assert.equal(parseThinCommand(["agent", "install", "--id", "terra", "--mcp-policy", "bogus"]).ok, false);
  assert.equal(
    parseThinCommand(["agent", "install", "--id", "terra", "--mcp-policy", "inherit", "--clear-mcp-policy"]).ok,
    false,
  );
  assert.equal(
    parseThinCommand(["agent", "install", "--source", "agents/terra.json", "--id", "terra", "--mcp-policy", "inherit"])
      .ok,
    false,
  );

  const runtimeRunParsed = parseThinCommand([
    "runtime",
    "run",
    "rti-codex",
    "--prompt",
    "inspect",
    "--mcp-policy",
    "inherit",
  ]);
  assert.equal(runtimeRunParsed.ok, true);
  if (runtimeRunParsed.ok) {
    assert.equal(runtimeRunParsed.command.method, "repo.agentRuntime.spawn");
    assert.equal(runtimeRunParsed.command.action.mcpPolicy, "inherit");
  }

  const resumeParsed = parseThinCommand([
    "runtime",
    "run",
    "--resume-dispatch",
    "disp_0123456789abcdef01234567",
    "--prompt",
    "continue",
    "--mcp-policy",
    "disabled",
  ]);
  assert.equal(resumeParsed.ok, true);
  if (resumeParsed.ok) {
    assert.equal(resumeParsed.command.method, "repo.agentRuntime.spawn");
    assert.equal(resumeParsed.command.action.mcpPolicy, "disabled");
  }

  const agentRunParsed = parseThinCommand(["agent", "run", "worker", "--task", "task_01", "--mcp-policy", "inherit"]);
  assert.equal(agentRunParsed.ok, true);
  if (agentRunParsed.ok) {
    assert.equal(agentRunParsed.command.method, "repo.agentRuntime.spawn");
    assert.equal(agentRunParsed.command.action.mcpPolicy, "inherit");
  }

  const squadRunParsed = parseThinCommand([
    "squad",
    "run",
    "core-squad",
    "--instance",
    "rti-codex",
    "--task",
    "task_01",
    "--mcp-policy",
    "inherit",
  ]);
  assert.equal(squadRunParsed.ok, true);
  if (squadRunParsed.ok) {
    assert.equal(squadRunParsed.command.method, "repo.task.run");
    assert.equal(squadRunParsed.command.action.mcpPolicy, "inherit");
  }
});

test("renderCliReceipt formats mcp policy line on runtime spawn and instance receipts", () => {
  const spawnRendered = renderCliReceipt({
    ok: true,
    command: "runtime-run",
    dispatchId: "disp_0123456789abcdef01234567",
    runtimeSessionId: "rts_0123456789abcdef01234567",
    summary: "spawned codex",
    mcpPolicy: "inherit",
  });
  assert.equal(spawnRendered.stream, "stdout");
  assert.match(spawnRendered.text, /^mcp policy: inherit$/m);

  const instanceRendered = renderCliReceipt({
    ok: true,
    command: "runtime-instance-show",
    summary: "rti-codex",
    instance: {
      instanceId: "rti-codex",
      kindId: "codex",
      mcpPolicy: "disabled",
    },
  });
  assert.equal(instanceRendered.stream, "stdout");
  assert.match(instanceRendered.text, /^mcp policy: disabled$/m);
});

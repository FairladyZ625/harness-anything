// harness-test-tier: integration
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalGuiServiceBridge } from "../src/main/local-composition-root.ts";

const cli = path.resolve("packages/cli/src/index.ts");

test("GUI and CLI write the same canonical through one resident daemon", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-cli-writer-lock-"));
  const root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    sourceRoot = path.join(parent, "cli-agent"),
    daemonId = "gui-cli-writer-lock",
    repoId = "gui-cli-writer-lock";
  mkdirSync(root, { recursive: true });
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(
    path.join(sourceRoot, "agent.json"),
    `${JSON.stringify(
      {
        schema: "agent-declaration/v1",
        id: "cli-agent",
        name: "CLI Agent",
        instructions: "Written by the CLI path.",
        runtime_type: "any",
      },
      null,
      2,
    )}\n`,
  );
  const env = {
    ...process.env,
    HOME: path.join(parent, "home"),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--experimental-strip-types"].filter(Boolean).join(" "),
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: daemonId,
    HARNESS_DAEMON_REPO_ID: repoId,
  };
  delete env.HARNESS_DAEMON_ENDPOINT;
  const previousEnv = {
    userRoot: process.env.HARNESS_DAEMON_USER_ROOT,
    daemonId: process.env.HARNESS_DAEMON_ID,
    endpoint: process.env.HARNESS_DAEMON_ENDPOINT,
  };
  Object.assign(process.env, {
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: daemonId,
  });
  delete process.env.HARNESS_DAEMON_ENDPOINT;
  try {
    const daemonStart = runCli(root, env, ["daemon", "start", "--service"]);
    assert.equal(daemonStart.status, 0, `${daemonStart.stderr}\n${JSON.stringify(daemonStart.receipt)}`);
    const initialized = runCli(root, env, [
      "init",
      "--repo-id",
      repoId,
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
    ]);
    assert.equal(initialized.status, 0, `${initialized.stderr}\n${JSON.stringify(initialized.receipt)}`);

    const bridge = createLocalGuiServiceBridge(root),
      guiWrite = bridge.invoke("saveAgent", {
        repoId,
        declaration: {
          schema: "agent-declaration/v1",
          id: "gui-agent",
          name: "GUI Agent",
          instructions: "Written by the GUI path.",
          runtime_type: "any",
        },
      }),
      cliSourceWrite = runCliAsync(root, env, ["agent", "install", "--source", sourceRoot]);
    const [guiResult, cliResult] = await Promise.all([guiWrite, cliSourceWrite]);
    assert.equal((guiResult as { readonly ok?: boolean }).ok, true, JSON.stringify(guiResult));
    assert.equal((guiResult as { readonly outcome?: string }).outcome, "applied", JSON.stringify(guiResult));
    assert.equal(cliResult.status, 0, `${cliResult.stderr}\n${JSON.stringify(cliResult.receipt)}`);
    assert.equal(cliResult.receipt.outcome, "applied", JSON.stringify(cliResult.receipt));
    assert.doesNotMatch(cliResult.stderr, /writer lock|EEXIST/iu);

    const listed = await bridge.invoke("listAgents", { repoId });
    const agents = (listed as { readonly agents?: readonly { readonly id: string }[] }).agents ?? [];
    assert.deepEqual(agents.map(({ id }) => id).sort(), ["cli-agent", "gui-agent"]);
    assert.match(readFileSync(path.join(root, "harness/agents/gui-agent.json"), "utf8"), /GUI Agent/u);
    assert.match(readFileSync(path.join(root, "harness/agents/cli-agent.json"), "utf8"), /CLI Agent/u);
  } finally {
    runCli(root, env, ["daemon", "stop"]);
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previousEnv.userRoot);
    restoreEnv("HARNESS_DAEMON_ID", previousEnv.daemonId);
    restoreEnv("HARNESS_DAEMON_ENDPOINT", previousEnv.endpoint);
    rmSync(parent, { recursive: true, force: true });
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function runCli(root: string, env: NodeJS.ProcessEnv, args: readonly string[]) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, "--root", root, "--json", ...args], {
    encoding: "utf8",
    env,
  });
  return {
    status: result.status,
    receipt: result.stdout.trim() ? (JSON.parse(result.stdout) as Record<string, unknown>) : {},
    stderr: result.stderr,
  };
}

async function runCliAsync(root: string, env: NodeJS.ProcessEnv, args: readonly string[]) {
  const child = spawn(process.execPath, ["--experimental-strip-types", cli, "--root", root, "--json", ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const [status] = (await once(child, "close")) as [number | null];
  return {
    status,
    receipt: stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : {},
    stderr,
  };
}

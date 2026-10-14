// harness-test-tier: fast
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { openDispatchStream, readDispatchStream } from "../src/dispatch-stream.ts";
import { launchNative } from "../src/runtime-spawn-process.ts";
import { runtimeWorkerProviderEnvironment } from "../src/runtime-worker-host.ts";

test("provider environment excludes host Git and SSH credentials", () => {
  const source: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: "/operator/home",
    CODEX_HOME: "/runtime/codex",
    OPENAI_API_KEY: "provider-api-key",
    GH_TOKEN: "github-token",
    HARNESS_GITHUB_TOKEN: "harness-github-token",
    GIT_ASKPASS: "/operator/askpass",
    GIT_ASKPASS_REQUIRE: "force",
    GIT_SSH: "/operator/ssh",
    GIT_SSH_COMMAND: "ssh -i /operator/.ssh/id_ed25519",
    GIT_SSH_VARIANT: "ssh",
    SSH_AGENT_PID: "1234",
    SSH_ASKPASS: "/operator/askpass",
    SSH_ASKPASS_REQUIRE: "force",
    SSH_AUTH_SOCK: "/operator/agent.sock",
    GIT_CONFIG_GLOBAL: "/operator/.gitconfig",
    GIT_CONFIG_SYSTEM: "/operator/gitconfig",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_PARAMETERS: "credential.helper=osxkeychain",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "osxkeychain",
  };

  const environment = runtimeWorkerProviderEnvironment(source, process.platform);
  assert.equal(environment.HOME, source.HOME);
  assert.equal(environment.CODEX_HOME, source.CODEX_HOME);
  assert.equal(environment.OPENAI_API_KEY, source.OPENAI_API_KEY);
  for (const name of [
    "GH_TOKEN",
    "HARNESS_GITHUB_TOKEN",
    "GIT_ASKPASS",
    "GIT_ASKPASS_REQUIRE",
    "GIT_SSH",
    "GIT_SSH_VARIANT",
    "SSH_AGENT_PID",
    "SSH_ASKPASS",
    "SSH_ASKPASS_REQUIRE",
    "SSH_AUTH_SOCK",
    "GIT_CONFIG_PARAMETERS",
  ])
    assert.equal(environment[name], undefined, `${name} must not reach the provider`);
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  assert.equal(environment.GIT_CONFIG_GLOBAL, nullDevice);
  assert.equal(environment.GIT_CONFIG_SYSTEM, nullDevice);
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(environment.GIT_CONFIG_COUNT, "1");
  assert.equal(environment.GIT_CONFIG_KEY_0, "credential.helper");
  assert.equal(environment.GIT_CONFIG_VALUE_0, "");
  assert.match(environment.GIT_SSH_COMMAND ?? "", /BatchMode=yes/u);
  assert.match(environment.GIT_SSH_COMMAND ?? "", /IdentityAgent=none/u);
  assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
});

test(
  "Git SSH cannot use host credentials in the provider environment",
  { skip: process.platform === "win32" ? "requires POSIX executable SSH fixture semantics" : false },
  () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-worker-host-")),
      bin = path.join(parent, "bin"),
      sshStub = path.join(bin, "ssh"),
      logPath = path.join(parent, "ssh-log.json");
    try {
      mkdirSync(bin);
      writeFileSync(
        sshStub,
        "#!/usr/bin/env node\n" +
          "const fs = require('node:fs');\n" +
          "fs.writeFileSync(process.env.SSH_STUB_LOG, JSON.stringify({ args: process.argv.slice(2), agent: process.env.SSH_AUTH_SOCK ?? null }));\n",
      );
      chmodSync(sshStub, 0o755);

      const baseEnvironment = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        SSH_STUB_LOG: logPath,
        SSH_AUTH_SOCK: "/operator/agent.sock",
        GIT_SSH_COMMAND: sshStub,
      };
      const before = spawnSync("git", ["ls-remote", "ssh://git@example.invalid/repo"], {
        env: baseEnvironment,
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.notEqual(before.status, 0, before.stderr);
      const beforeLog = JSON.parse(readFileSync(logPath, "utf8")) as { args: string[]; agent: string | null };
      assert.equal(beforeLog.agent, "/operator/agent.sock");
      assert.equal(beforeLog.args.includes("IdentityAgent=none"), false);

      const environment = runtimeWorkerProviderEnvironment(baseEnvironment);
      environment.GIT_SSH_COMMAND = environment.GIT_SSH_COMMAND?.replace(/^ssh/u, sshStub);
      const after = spawnSync("git", ["ls-remote", "ssh://git@example.invalid/repo"], {
        env: environment,
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.notEqual(after.status, 0, after.stderr);
      const afterLog = JSON.parse(readFileSync(logPath, "utf8")) as { args: string[]; agent: string | null };
      assert.equal(afterLog.agent, null);
      assert.deepEqual(
        new Set(afterLog.args.filter((arg) => arg.startsWith("Identity") || arg.startsWith("Identities"))),
        new Set(["IdentityAgent=none", "IdentityFile=/dev/null", "IdentitiesOnly=yes"]),
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "steer resumes a live Codex worker with the same provider session and final-only exit",
  { timeout: 15_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-worker-steer-")),
      rootDir = path.join(parent, "repo"),
      executablePath = path.join(parent, "provider.mjs"),
      tracePath = path.join(parent, "provider-trace.jsonl"),
      dispatchId = "dispatch_123456789012345678901234",
      runtimeSessionId = "runtime_123456789012345678901234";
    mkdirSync(rootDir);
    writeFileSync(
      executablePath,
      `#!/usr/bin/env node\n` +
        `import fs from "node:fs";\n` +
        `let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;\n` +
        `fs.appendFileSync(process.env.STEER_TRACE, JSON.stringify({ args: process.argv.slice(2), prompt }) + "\\n");\n` +
        `const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");\n` +
        `emit({ type: "thread.started", thread_id: "provider-thread-stable" });\n` +
        `if (process.argv.includes("resume")) { process.exit(0); }\n` +
        `process.on("SIGINT", () => process.exit(130));\n` +
        `emit({ type: "item.started", item: { id: "tool-1", type: "command_execution" } });\n` +
        `setTimeout(() => { emit({ type: "item.completed", item: { id: "tool-1", type: "command_execution" } }); setInterval(() => undefined, 1000); }, 100);\n`,
    );
    chmodSync(executablePath, 0o755);
    const dispatchStream = openDispatchStream(rootDir, {
      dispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId,
      instanceId: "codex-test",
      startedAt: new Date().toISOString(),
      dispatchOpId: "dispatch-op-steer-test",
      kindId: "codex",
      permissionMode: null,
      binding: { actor: { principal: { personId: "operator" }, executor: null }, source: "local" },
      cwd: rootDir,
      prompt: "initial prompt",
      model: "test-model",
      reasoningEffort: null,
      fast: false,
    });
    void dispatchStream;
    const runtimeProcess = launchNative(
      {
        executablePath,
        args: ["exec", "--json", "--model", "test-model", "-"],
        env: { ...runtimeWorkerProviderEnvironment(process.env), STEER_TRACE: tracePath },
        cwd: rootDir,
        prompt: "initial prompt",
        installation: { kindId: "codex" },
        protocolFamily: "codex",
      } as never,
      { rootDir, dispatchId },
    );
    t.after(async () => {
      await runtimeProcess.terminateTree?.();
      rmSync(parent, { recursive: true, force: true });
    });
    await eventually(
      () =>
        readDispatchStream(rootDir, dispatchId)?.records.some(
          (record) => record.kind === "provider_event" && (record.event as { type?: string }).type === "item.started",
        ) === true,
    );
    runtimeProcess.steer!("follow-up prompt");
    await new Promise<void>((resolve, reject) => {
      runtimeProcess.onExit((code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
    });
    const invocations = readFileSync(tracePath, "utf8")
      .trim()
      .split(/\r?\n/u)
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            prompt: string;
          },
      );
    assert.equal(invocations.length, 2);
    assert.equal(invocations[0]!.prompt, "initial prompt");
    assert.equal(invocations[1]!.prompt, "follow-up prompt");
    assert.deepEqual(invocations[1]!.args, [
      "exec",
      "resume",
      "--json",
      "--model",
      "test-model",
      "provider-thread-stable",
      "-",
    ]);
    const records = readDispatchStream(rootDir, dispatchId)!.records;
    assert.equal(records.filter((record) => record.kind === "steer_resumed").length, 1);
    assert.equal(records.filter((record) => record.kind === "process_exit").length, 1);
  },
);

test("queued steer is discarded when cancellation reaches the worker host", { timeout: 15_000 }, async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-worker-steer-cancel-")),
    rootDir = path.join(parent, "repo"),
    executablePath = path.join(parent, "provider.mjs"),
    tracePath = path.join(parent, "provider-trace.jsonl"),
    dispatchId = "dispatch_123456789012345679901234",
    runtimeSessionId = "runtime_123456789012345679901234";
  mkdirSync(rootDir);
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node\n` +
      `import fs from "node:fs";\n` +
      `let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;\n` +
      `fs.appendFileSync(process.env.STEER_TRACE, JSON.stringify({ args: process.argv.slice(2), prompt }) + "\\n");\n` +
      `const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");\n` +
      `emit({ type: "thread.started", thread_id: "provider-thread-cancel" });\n` +
      `emit({ type: "item.started", item: { id: "tool-cancel", type: "command_execution" } });\n` +
      `setInterval(() => undefined, 1000);\n`,
  );
  chmodSync(executablePath, 0o755);
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: null,
    executionId: null,
    runtimeSessionId,
    instanceId: "codex-test",
    startedAt: new Date().toISOString(),
    dispatchOpId: "dispatch-op-steer-cancel-test",
    kindId: "codex",
    permissionMode: null,
    binding: { actor: { principal: { personId: "operator" }, executor: null }, source: "local" },
    cwd: rootDir,
    prompt: "initial prompt",
    model: "test-model",
    reasoningEffort: null,
    fast: false,
  });
  const runtimeProcess = launchNative(
    {
      executablePath,
      args: ["exec", "--json", "--model", "test-model", "-"],
      env: { ...runtimeWorkerProviderEnvironment(process.env), STEER_TRACE: tracePath },
      cwd: rootDir,
      prompt: "initial prompt",
      installation: { kindId: "codex" },
      protocolFamily: "codex",
    } as never,
    { rootDir, dispatchId },
  );
  t.after(async () => {
    await runtimeProcess.terminateTree?.();
    rmSync(parent, { recursive: true, force: true });
  });
  await eventually(
    () =>
      readDispatchStream(rootDir, dispatchId)?.records.some(
        (record) => record.kind === "provider_event" && (record.event as { type?: string }).type === "item.started",
      ) === true,
  );
  runtimeProcess.steer!("queued follow-up");
  const exited = new Promise<void>((resolve, reject) =>
    runtimeProcess.onExit((code) => (code === null ? resolve() : reject(new Error(`worker exited ${code}`)))),
  );
  process.kill(runtimeProcess.pid, "SIGTERM");
  await exited;
  await eventually(() => existsSync(tracePath) && readFileSync(tracePath, "utf8").trim().length > 0);
  const invocations = readFileSync(tracePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as { args: string[]; prompt: string });
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]!.prompt, "initial prompt");
  const records = readDispatchStream(rootDir, dispatchId)!.records;
  assert.equal(records.filter((record) => record.kind === "steer_resumed").length, 0);
});

async function eventually(check: () => boolean): Promise<void> {
  while (!check()) await new Promise<void>((resolve) => setImmediate(resolve));
}

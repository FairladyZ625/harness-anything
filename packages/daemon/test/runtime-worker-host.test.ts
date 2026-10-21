// harness-test-tier: fast
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { openDispatchStream, readDispatchStream } from "../src/dispatch-stream.ts";
import { steerRuntime } from "../src/runtime-spawn-control.ts";
import { launchNative } from "../src/runtime-spawn-process.ts";
import { runtimeWorkerProviderEnvironment } from "../src/runtime-worker-host.ts";
import { writeAcpProviderStub } from "./fixtures/acp-stub.ts";

const operatorBinding = { actor: { principal: { personId: "operator" }, executor: null }, source: "local" as const };

function steerContext(rootDir: string, runtimeSessionId: string, active: unknown) {
  return {
    input: { rootDir, repoId: "worker-host-steer-test", now: () => new Date().toISOString() },
    processes: new Map([[runtimeSessionId, active]]),
  };
}

test("restricted provider environment excludes host Git and SSH credentials", () => {
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

  const environment = runtimeWorkerProviderEnvironment(source, process.platform, "restricted");
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

test("full provider environment inherits operator hosting credentials", () => {
  const source: NodeJS.ProcessEnv = {
    GH_TOKEN: "github-token",
    GITLAB_TOKEN: "gitlab-token",
    GIT_ASKPASS: "/operator/askpass",
    SSH_AUTH_SOCK: "/operator/agent.sock",
  };
  const environment = runtimeWorkerProviderEnvironment(source, process.platform);
  assert.equal(environment.GH_TOKEN, source.GH_TOKEN);
  assert.equal(environment.GITLAB_TOKEN, source.GITLAB_TOKEN);
  assert.equal(environment.GIT_ASKPASS, source.GIT_ASKPASS);
  assert.equal(environment.SSH_AUTH_SOCK, source.SSH_AUTH_SOCK);
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

      const environment = runtimeWorkerProviderEnvironment(baseEnvironment, process.platform, "restricted");
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
    const receipt = await steerRuntime(
      steerContext(rootDir, runtimeSessionId, {
        dispatchId,
        runtimeSessionId,
        kindId: "codex",
        providerSessionId: "provider-thread-stable",
        process: runtimeProcess,
      }) as never,
      { dispatchId, prompt: "follow-up prompt" },
      operatorBinding,
    );
    assert.equal(receipt.outcome, "applied");
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
  const receipt = await steerRuntime(
    steerContext(rootDir, runtimeSessionId, {
      dispatchId,
      runtimeSessionId,
      kindId: "codex",
      providerSessionId: "provider-thread-cancel",
      process: runtimeProcess,
    }) as never,
    { runtimeSessionId, prompt: "queued follow-up" },
    operatorBinding,
  );
  assert.equal(receipt.outcome, "applied");
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

test(
  "steer reaches a live ACP worker through the dispatch stream and redirects the session in place",
  { timeout: 20_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-worker-steer-acp-")),
      rootDir = path.join(parent, "repo"),
      capture = path.join(parent, "provider-trace.jsonl"),
      executablePath = writeAcpProviderStub(path.join(parent, "codex-acp-stub"), capture, {
        steerSemantics: true,
      }),
      dispatchId = "dispatch_123456789012345680901234",
      runtimeSessionId = "runtime_123456789012345680901234";
    mkdirSync(rootDir);
    writeFileSync(capture, "");
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId,
      instanceId: "codex-acp-test",
      startedAt: new Date().toISOString(),
      dispatchOpId: "dispatch-op-steer-acp-test",
      kindId: "codex-acp",
      permissionMode: null,
      binding: operatorBinding,
      cwd: rootDir,
      prompt: "hang",
      model: "test-model",
      reasoningEffort: null,
      fast: false,
    });
    const runtimeProcess = launchNative(
      {
        executablePath,
        args: ["acp"],
        env: runtimeWorkerProviderEnvironment(process.env),
        cwd: rootDir,
        prompt: "hang",
        installation: { kindId: "codex-acp" },
        protocolFamily: "acp",
        acpApiKey: "test-manifest-key",
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
          (record) => record.kind === "provider_event" && (record.event as { type?: string }).type === "acp.session",
        ) === true,
    );
    // Steering rides the dispatch stream: nothing on the active entry carries a control pipe,
    // which is the shape an adopted host has after a daemon restart.
    const receipt = await steerRuntime(
      steerContext(rootDir, runtimeSessionId, {
        dispatchId,
        runtimeSessionId,
        kindId: "codex-acp",
        providerSessionId: "devin-acp-session",
        process: runtimeProcess,
      }) as never,
      { dispatchId, prompt: "Focus on the failing test." },
      operatorBinding,
    );
    assert.equal(receipt.outcome, "applied");
    assert.equal(receipt.command, "runtime-steer");
    // Wait for the steered turn's own result, not just the cancel: the second prompt is
    // answered asynchronously, so asserting on the first frame that appears would race it.
    await eventually(() => steeredTurnResults(rootDir, dispatchId).length === 2);
    // The provider must have received the steering prompt as the steered turn's input.
    await eventually(() => {
      const captured = readFileSync(capture, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      return captured.some((entry) => entry.prompt === "Focus on the failing test.");
    });
    const records = readDispatchStream(rootDir, dispatchId)!.records;
    assert.deepEqual(steeredTurnResults(rootDir, dispatchId), ["cancelled", "end_turn"]);
    assert.equal(records.filter((record) => record.kind === "steer_requested").length, 1);
  },
);

/** The stop reasons of every acp.result recorded so far; the steer test's turn boundary. */
function steeredTurnResults(rootDir: string, dispatchId: string): (string | undefined)[] {
  return (readDispatchStream(rootDir, dispatchId)?.records ?? [])
    .filter((record) => record.kind === "provider_event" && (record.event as { type?: string }).type === "acp.result")
    .map((record) => (record.event as { stopReason?: string }).stopReason);
}

// The exact warning Codex 0.163.0 emits right after it replaces history with a compaction
// summary (codex-rs/core/src/compact.rs), recorded verbatim in the incident's dispatch stream
// as item.completed with item.type "error". exec never forwards the ContextCompaction item, so
// this frame plus the absence of a later agent message is the whole observable signature.
const codexCompactionWarning =
  "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.";

/** Runs one Codex-shaped dispatch to completion and returns the provider invocations and the
 * records the worker host appended. `frames` decides what each invocation emits. */
async function driveCodexWorker(
  name: string,
  frames: (invocation: number) => Record<string, unknown>[],
): Promise<{
  readonly invocations: { readonly args: string[]; readonly prompt: string }[];
  readonly records: Record<string, unknown>[];
  readonly cleanup: () => void;
}> {
  const parent = mkdtempSync(path.join(tmpdir(), `ha-runtime-worker-${name}-`)),
    rootDir = path.join(parent, "repo"),
    executablePath = path.join(parent, "provider.mjs"),
    tracePath = path.join(parent, "provider-trace.jsonl"),
    // Dispatch ids are pinned to dispatch_<24 hex>; derive one per fixture so parallel tests differ.
    dispatchId = `dispatch_${createHash("sha256").update(name).digest("hex").slice(0, 24)}`,
    runtimeSessionId = `runtime_${createHash("sha256").update(`runtime:${name}`).digest("hex").slice(0, 24)}`;
  mkdirSync(rootDir);
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node\n` +
      `import fs from "node:fs";\n` +
      `let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;\n` +
      `fs.appendFileSync(process.env.STEER_TRACE, JSON.stringify({ args: process.argv.slice(2), prompt }) + "\\n");\n` +
      `const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");\n` +
      `const invocation = fs.readFileSync(process.env.STEER_TRACE, "utf8").trim().split("\\n").length;\n` +
      `emit({ type: "thread.started", thread_id: "provider-thread-compaction" });\n` +
      `for (const frame of JSON.parse(process.env.STEER_FRAMES)[invocation - 1] ?? []) emit(frame);\n` +
      `process.exit(0);\n`,
  );
  chmodSync(executablePath, 0o755);
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: null,
    executionId: null,
    runtimeSessionId,
    instanceId: "codex-test",
    startedAt: new Date().toISOString(),
    dispatchOpId: `dispatch-op-${name}`,
    kindId: "codex",
    permissionMode: null,
    binding: operatorBinding,
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
      env: {
        ...runtimeWorkerProviderEnvironment(process.env),
        STEER_TRACE: tracePath,
        // One entry per invocation the fixture may see; the host's own bound decides how many run.
        STEER_FRAMES: JSON.stringify(Array.from({ length: 8 }, (_, index) => frames(index))),
      },
      cwd: rootDir,
      prompt: "initial prompt",
      installation: { kindId: "codex" },
      protocolFamily: "codex",
    } as never,
    { rootDir, dispatchId },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker host did not settle")), 15_000);
    runtimeProcess.onExit((code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`worker exited ${String(code)}`));
    });
  });
  return {
    invocations: readFileSync(tracePath, "utf8")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as { args: string[]; prompt: string }),
    records: readDispatchStream(rootDir, dispatchId)!.records,
    cleanup: () => rmSync(parent, { recursive: true, force: true }),
  };
}

/** The tool call the incident dispatch completed right before its compaction. */
const codexToolCompleted = {
  type: "item.completed",
  item: { id: "tool-1", type: "command_execution", command: "npm test", status: "completed" },
} as const;

test(
  "a Codex turn that ended right after a compaction with no agent message resumes the same thread",
  { timeout: 20_000 },
  async () => {
    const read = await driveCodexWorker("compaction-empty-end", (invocation) =>
      invocation === 0
        ? [
            codexToolCompleted,
            { type: "item.completed", item: { id: "warning-1", type: "error", message: codexCompactionWarning } },
            { type: "turn.completed", usage: { input_tokens: 1323364, output_tokens: 13568 } },
          ]
        : [
            { type: "item.completed", item: { id: "message-1", type: "agent_message", text: "resumed and delivered" } },
            { type: "turn.completed", usage: { input_tokens: 1400000, output_tokens: 13800 } },
          ],
    );
    try {
      // The compaction ended the first turn; the worker keeps going in the same thread instead
      // of the dispatch settling as a stop.
      assert.equal(read.invocations.length, 2);
      assert.equal(read.invocations[0]!.prompt, "initial prompt");
      assert.match(read.invocations[1]!.prompt, /Continue the current task/u);
      assert.deepEqual(read.invocations[1]!.args, [
        "exec",
        "resume",
        "--json",
        "--model",
        "test-model",
        "provider-thread-compaction",
        "-",
      ]);
      assert.equal(read.records.filter((record) => record.kind === "compaction_continued").length, 1);
      assert.equal(read.records.filter((record) => record.kind === "process_exit").length, 1);
      // The resumed turn's own frames reach the daemon unchanged: no synthetic outcome.
      assert.ok(
        read.records.some(
          (record) =>
            record.kind === "provider_event" && JSON.stringify(record.event).includes("resumed and delivered"),
        ),
      );
    } finally {
      read.cleanup();
    }
  },
);

test("a Codex turn that answered after a compaction is never resumed", { timeout: 20_000 }, async () => {
  const read = await driveCodexWorker("compaction-answered", () => [
    codexToolCompleted,
    { type: "item.completed", item: { id: "warning-1", type: "error", message: codexCompactionWarning } },
    { type: "item.completed", item: { id: "message-1", type: "agent_message", text: "still working" } },
    { type: "turn.completed", usage: { input_tokens: 1323364, output_tokens: 13568 } },
  ]);
  try {
    assert.equal(read.invocations.length, 1);
    assert.equal(read.records.filter((record) => record.kind === "compaction_continued").length, 0);
    assert.equal(read.records.filter((record) => record.kind === "process_exit").length, 1);
  } finally {
    read.cleanup();
  }
});

test("a turn-end compaction after a final answer is not an empty turn", { timeout: 20_000 }, async () => {
  // Post-turn compaction: the answer was delivered, then Codex compacted history and emitted
  // the same warning. Nothing is pending, so resuming would be a retry on a finished turn.
  const read = await driveCodexWorker("compaction-after-answer", () => [
    codexToolCompleted,
    { type: "item.completed", item: { id: "message-1", type: "agent_message", text: "delivered" } },
    { type: "item.completed", item: { id: "warning-1", type: "error", message: codexCompactionWarning } },
    { type: "turn.completed", usage: { input_tokens: 900000, output_tokens: 9000 } },
  ]);
  try {
    assert.equal(read.invocations.length, 1);
    assert.equal(read.records.filter((record) => record.kind === "compaction_continued").length, 0);
    assert.equal(read.records.filter((record) => record.kind === "process_exit").length, 1);
  } finally {
    read.cleanup();
  }
});

test("an empty Codex turn without a compaction stays a stop: no retry loop", { timeout: 20_000 }, async () => {
  const read = await driveCodexWorker("empty-without-compaction", () => [
    codexToolCompleted,
    { type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 0 } },
  ]);
  try {
    assert.equal(read.invocations.length, 1);
    assert.equal(read.records.filter((record) => record.kind === "compaction_continued").length, 0);
    assert.equal(read.records.filter((record) => record.kind === "process_exit").length, 1);
  } finally {
    read.cleanup();
  }
});

test("compaction continuations are bounded per dispatch, one compaction each", { timeout: 20_000 }, async () => {
  // A session that always answers a compaction with nothing: the third continuation is the last,
  // so the dispatch still settles instead of looping.
  const read = await driveCodexWorker("compaction-bounded", () => [
    codexToolCompleted,
    { type: "item.completed", item: { id: "warning-1", type: "error", message: codexCompactionWarning } },
    { type: "turn.completed", usage: { input_tokens: 2000, output_tokens: 0 } },
  ]);
  try {
    assert.equal(read.invocations.length, 4);
    assert.equal(read.records.filter((record) => record.kind === "compaction_continued").length, 3);
    assert.equal(read.records.filter((record) => record.kind === "process_exit").length, 1);
  } finally {
    read.cleanup();
  }
});

async function eventually(check: () => boolean): Promise<void> {
  while (!check()) await new Promise<void>((resolve) => setImmediate(resolve));
}

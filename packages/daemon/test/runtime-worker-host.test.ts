// harness-test-tier: fast
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  attachActiveRuntime,
  createActiveRuntime,
  disposeActiveRuntimeObservations,
} from "../src/runtime-spawn-active.ts";
import { openDispatchStream, readDispatchStream } from "../src/dispatch-stream.ts";
import { launchArgs } from "../src/agent-runtime-launch-config.ts";
import { steerRuntime } from "../src/runtime-spawn-control.ts";
import { launchNative } from "../src/runtime-spawn-process.ts";
import { consumeProviderChunk, consumeProviderLine } from "../src/runtime-spawn-provider-stream.ts";
import { parseProviderFrame } from "../src/runtime-spawn-provider-frames.ts";
import { runtimeWorkerProviderEnvironment } from "../src/runtime-worker-host.ts";
import { applyGithubLaunchCredential } from "../src/runtime-github-credentials.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import { writeAcpProviderStub } from "./fixtures/acp-stub.ts";

const operatorBinding = { actor: { principal: { personId: "operator" }, executor: null }, source: "local" as const };

test(
  "persisted provider events keep the native worker watchdog alive without workspace writes",
  { timeout: 20_000 },
  async () => {
    const originalNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let nowMs = 0;
    const timerCallbacks: Array<{ readonly callback: () => void; readonly unref: () => void }> = [];
    const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-worker-stall-progress-")),
      rootDir = path.join(parent, "repo"),
      controlPath = path.join(parent, "provider-progress"),
      executablePath = path.join(parent, "provider.mjs"),
      dispatchId = "dispatch_123456789012345681901234",
      runtimeSessionId = "runtime_123456789012345681901234";
    mkdirSync(rootDir);
    writeFileSync(
      executablePath,
      `#!/usr/bin/env node\n` +
        `import fs from "node:fs";\n` +
        `const control = process.env.PROVIDER_PROGRESS_CONTROL;\n` +
        `let seen = "";\n` +
        `const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");\n` +
        `emit({ type: "thread.started", thread_id: "provider-stall-progress" });\n` +
        `setInterval(() => { const next = fs.existsSync(control) ? fs.readFileSync(control, "utf8") : ""; if (next !== seen) { seen = next; emit({ type: "thread.started", thread_id: "provider-stall-progress" }); } }, 5);\n`,
    );
    chmodSync(executablePath, 0o755);
    const stream = openDispatchStream(rootDir, {
      dispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId,
      instanceId: "codex-stall-progress",
      startedAt: new Date().toISOString(),
      dispatchOpId: "dispatch-op-stall-progress",
      kindId: "codex",
      permissionMode: "workspace-write",
      binding: operatorBinding,
      cwd: rootDir,
      prompt: "keep emitting provider progress",
      model: "test-model",
      reasoningEffort: null,
      fast: false,
      stallTimeoutMs: 10_000,
    });
    let runtime: ReturnType<typeof createActiveRuntime> | undefined;
    let nativeProcess: ReturnType<typeof launchNative> | null = null;
    try {
      const launchedProcess = launchNative(
        {
          executablePath,
          args: ["exec", "--json", "--model", "test-model", "-"],
          env: {
            ...runtimeWorkerProviderEnvironment(process.env),
            PROVIDER_PROGRESS_CONTROL: controlPath,
          },
          cwd: rootDir,
          prompt: "keep emitting provider progress",
          installation: { kindId: "codex" },
          protocolFamily: "codex",
          permissionMode: "workspace-write",
        } as never,
        { rootDir, dispatchId },
      );
      nativeProcess = launchedProcess;
      globalThis.setTimeout = ((callback: () => void) => {
        const timer = { callback, unref: () => undefined };
        timerCallbacks.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;
      globalThis.clearTimeout = ((timer) => {
        const index = timerCallbacks.indexOf(timer as (typeof timerCallbacks)[number]);
        if (index >= 0) timerCallbacks.splice(index, 1);
      }) as typeof clearTimeout;
      const scheduled: Promise<void>[] = [];
      runtime = createActiveRuntime({
        runtimeSessionId,
        dispatchId,
        dispatchOpId: "dispatch-op-stall-progress",
        instanceId: "codex-stall-progress",
        kindId: "codex",
        resolvedProviderDirectory: null,
        permissionMode: "workspace-write",
        agent: null,
        role: null,
        delegatedBy: null,
        squadId: null,
        publicationOwner: "runtime",
        parentRuntimeSessionId: null,
        binding: operatorBinding,
        task: null,
        decisionReviewTarget: null,
        schedule: null,
        cwd: rootDir,
        prompt: "keep emitting provider progress",
        onExitCommand: null,
        model: "test-model",
        reasoningEffort: null,
        fast: false,
        startedAt: new Date().toISOString(),
        stream: stream,
        stallTimeoutMs: 10_000,
        process: launchedProcess,
      });
      const runtimeContext: RuntimeSpawnerContext = {
        input: {
          rootDir,
          repoId: "worker-host-stall-progress",
          now: () => new Date().toISOString(),
          stream: { publish: () => undefined },
          schedule: (work: () => void | Promise<void>) => {
            scheduled.push(Promise.resolve(work()));
          },
        },
        processes: new Map([[runtimeSessionId, runtime]]),
        exiting: new Set<string>(),
        consumeChunk: (active: typeof runtime, chunk: string, flush: boolean, persisted?: boolean) =>
          consumeProviderChunk(runtimeContext, active!, chunk, flush, persisted),
        consumeLine: (active: typeof runtime, line: string, persisted?: boolean) =>
          consumeProviderLine(runtimeContext, active!, line, persisted),
        parseProviderFrame,
        markProtocolError: () => undefined,
        bindProvider: async () => undefined,
        isStructuredSuccessResult: () => false,
        captureErrorOutput: () => undefined,
        publishExit: async () => undefined,
      } as never;
      attachActiveRuntime(runtimeContext, runtime);
      await waitForProviderEvents(rootDir, dispatchId, 1);
      await waitForRuntimeOutput(runtime, 1);
      await Promise.all(scheduled.splice(0));
      nowMs = runtime.lastProgressAtMs;
      const startedAtMs = nowMs;
      Date.now = () => nowMs;

      assert.equal(runtime.stalledAt, null);
      nowMs += 9_999;
      writeFileSync(controlPath, "1");
      await waitForProviderEvents(rootDir, dispatchId, 2);
      await waitForRuntimeOutput(runtime, 2);
      await Promise.all(scheduled.splice(0));
      assert.equal(runtime.stalledAt, null, "a persisted provider event must renew the watchdog");
      assert.equal(runtime.lastProgressAtMs, nowMs, "the persisted provider event must advance the progress clock");

      nowMs += 9_999;
      const renewedTimer = timerCallbacks.shift();
      assert.ok(renewedTimer, "the provider event must leave an armed watchdog timer");
      renewedTimer.callback();
      await Promise.all(scheduled.splice(0));
      assert.equal(runtime.stalledAt, null, "the renewed deadline must still be ahead");

      writeFileSync(controlPath, "2");
      await waitForProviderEvents(rootDir, dispatchId, 3);
      await waitForRuntimeOutput(runtime, 3);
      await Promise.all(scheduled.splice(0));
      assert.ok(nowMs - startedAtMs >= 19_998, "the provider stream crossed repeated idle deadlines");
      assert.equal(runtime.stalledAt, null, "continuous provider events must survive repeated deadlines");
      assert.equal(
        readDispatchStream(rootDir, dispatchId)?.records.some((record) => record.kind === "dispatch_stalled"),
        false,
        "provider progress alone must not append dispatch_stalled",
      );
    } finally {
      if (runtime) disposeActiveRuntimeObservations(runtime);
      Date.now = originalNow;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      await nativeProcess?.terminateTree?.();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

function steerContext(rootDir: string, runtimeSessionId: string, active: unknown) {
  return {
    input: { rootDir, repoId: "worker-host-steer-test", now: () => new Date().toISOString() },
    processes: new Map([[runtimeSessionId, active]]),
  };
}

async function waitForProviderEvents(rootDir: string, dispatchId: string, count: number): Promise<void> {
  await eventually(
    () =>
      (readDispatchStream(rootDir, dispatchId)?.records.filter((record) => record.kind === "provider_event").length ??
        0) >= count,
  );
}

async function waitForRuntimeOutput(runtime: ReturnType<typeof createActiveRuntime>, count: number): Promise<void> {
  await eventually(() => runtime.durableOutputCount >= count);
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

test("DeepSeek drops shell-side Git credentials before its environment scrub", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-dsh-git-credential-")),
    home = path.join(parent, "home"),
    repository = path.join(parent, "repository"),
    staleHelper = path.join(parent, "stale-helper"),
    staleMarker = path.join(parent, "stale-helper-called"),
    nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  mkdirSync(home);
  mkdirSync(repository);
  const init = spawnSync("git", ["init", "--quiet", repository], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  writeFileSync(
    staleHelper,
    `#!/bin/sh\nprintf 'called\\n' >> '${staleMarker}'\ncat >/dev/null\nprintf 'username=fixture-user\\npassword=fixture-password\\n'\n`,
  );
  chmodSync(staleHelper, 0o755);
  const localHelper = spawnSync(
    "git",
    ["-C", repository, "config", "credential.https://github.com.helper", `!${staleHelper}`],
    { encoding: "utf8" },
  );
  assert.equal(localHelper.status, 0, localHelper.stderr);
  const source: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  applyGithubLaunchCredential(source, "github-token");

  try {
    for (const permissionMode of ["full", "restricted"] as const) {
      const providerEnvironment = runtimeWorkerProviderEnvironment(
          source,
          process.platform,
          permissionMode,
          "deepseek-harness",
        ),
        toolShellEnvironment = Object.fromEntries(
          Object.entries(providerEnvironment).filter(([name]) => !/(?:KEY|PASSWORD|SECRET|TOKEN)/iu.test(name)),
        ),
        result = spawnSync("git", ["config", "--list"], {
          env: toolShellEnvironment,
          encoding: "utf8",
        });

      assert.equal(providerEnvironment.GH_TOKEN, undefined, permissionMode);
      assert.equal(providerEnvironment.GIT_CONFIG_COUNT, undefined, permissionMode);
      assert.equal(
        providerEnvironment.GIT_CONFIG_PARAMETERS,
        permissionMode === "restricted" ? "'credential.helper'=''" : undefined,
        permissionMode,
      );
      assert.equal(
        Object.keys(providerEnvironment).some((name) => /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name)),
        false,
        permissionMode,
      );
      assert.equal(result.status, 0, `${permissionMode}: ${result.stderr}`);
    }

    if (process.platform !== "win32") {
      // Prove a repository-local helper can return credentials even when global config is disabled.
      const staleLocalControl = spawnSync("git", ["-C", repository, "credential", "fill"], {
        env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_SYSTEM: nullDevice, GIT_CONFIG_NOSYSTEM: "1" },
        input: "protocol=https\nhost=github.com\n\n",
        encoding: "utf8",
      });
      assert.equal(staleLocalControl.status, 0, staleLocalControl.stderr);
      assert.match(staleLocalControl.stdout, /password=fixture-password/u);
      assert.equal(existsSync(staleMarker), true);
      rmSync(staleMarker);

      const restrictedEnvironment = runtimeWorkerProviderEnvironment(
          source,
          process.platform,
          "restricted",
          "deepseek-harness",
        ),
        filteredRestrictedEnvironment = Object.fromEntries(
          Object.entries(restrictedEnvironment).filter(([name]) => !/(?:KEY|PASSWORD|SECRET|TOKEN)/iu.test(name)),
        ),
        fill = spawnSync("git", ["-C", repository, "credential", "fill"], {
          env: filteredRestrictedEnvironment,
          input: "protocol=https\nhost=github.com\n\n",
          encoding: "utf8",
        });
      assert.equal(filteredRestrictedEnvironment.GIT_CONFIG_PARAMETERS, "'credential.helper'=''");
      assert.equal(fill.status, 128);
      assert.match(fill.stderr, /could not read Username.*terminal prompts disabled/u);
      assert.doesNotMatch(fill.stdout, /password=/u);
      assert.equal(existsSync(staleMarker), false, "restricted DSH must not call the repository's local helper");
    }

    // The same complete source environment still reproduces the failure for a provider that does not scrub names.
    const otherProvider = runtimeWorkerProviderEnvironment(source, process.platform, "full", "codex"),
      filteredOtherProvider = Object.fromEntries(
        Object.entries(otherProvider).filter(([name]) => !/(?:KEY|PASSWORD|SECRET|TOKEN)/iu.test(name)),
      ),
      before = spawnSync("git", ["config", "--list"], { env: filteredOtherProvider, encoding: "utf8" });
    assert.equal(before.status, 128);
    assert.match(before.stderr, /missing config key GIT_CONFIG_KEY_0/u);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
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
        // Production fresh-exec argv: the steer resume path must be proven against the argv a
        // dispatch really launches with, which carries the fresh `--sandbox` block.
        args: codexHostLaunchArgs("read-only"),
        env: { ...runtimeWorkerProviderEnvironment(process.env), STEER_TRACE: tracePath },
        cwd: rootDir,
        prompt: "initial prompt",
        installation: { kindId: "codex" },
        protocolFamily: "codex",
        permissionMode: "read-only",
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
      "--config",
      'sandbox_mode="read-only"',
      "--model",
      "test-model",
      "provider-thread-stable",
      "-",
    ]);
    // The pre-existing steer path had the same defect the compaction continuation was built on:
    // its resume argv carried the fresh `--sandbox` block and the real CLI exited 2.
    assert.equal(invocations[1]!.args.includes("--sandbox"), false);
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

/** Production fresh-launch argv for a codex dispatch, from the same builder `prepareLaunch` uses.
 * A hand-written argv here is what hid the fresh `--sandbox` block from the first iteration's
 * fixture: the host only ever sees production argv, so the test must see it too. */
function codexHostLaunchArgs(mode: "bypass" | "workspace-write" | "read-only"): string[] {
  return launchArgs(
    {
      schemaVersion: 2,
      instanceId: "codex-host-test",
      name: "Codex Host Test",
      kindId: "codex",
      installationId: "codex-installation",
      providerId: "openai",
      models: ["test-model"],
      defaultModel: "test-model",
      enabled: true,
      isolationState: "enforced",
      auth: { mode: "subscription" },
      codex: {},
    },
    "test-model",
    "initial prompt",
    undefined,
    null,
    mode,
    false,
  );
}

/** The exact warning Codex 0.163.0 emits right after it replaces history with a compaction
 * summary (codex-rs/core/src/compact.rs), recorded verbatim in the incident's dispatch stream
 * as item.completed with item.type "error". exec never forwards the ContextCompaction item, so
 * this frame plus the absence of a later agent message is the whole observable signature. */
const codexCompactionWarning =
  "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.";

/** Runs one Codex-shaped dispatch to completion and returns the provider invocations and the
 * records the worker host appended. `frames` decides what each invocation emits. `identity`
 * decides whether the dispatch owes a settle action: the header's own task/squad fields are what
 * the host reads to judge a turn end. */
async function driveCodexWorker(
  name: string,
  frames: (invocation: number) => Record<string, unknown>[],
  identity: {
    readonly taskId?: string | null;
    readonly squadId?: string;
    readonly role?: string;
    /** Provider argv; production fresh `exec` argv by default. */
    readonly args?: readonly string[];
  } = {},
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
    taskId: identity.taskId ?? null,
    executionId: null,
    ...(identity.squadId === undefined ? {} : { squadId: identity.squadId }),
    ...(identity.role === undefined ? {} : { role: identity.role }),
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
      // Production fresh-exec argv, built by the same `launchArgs` the daemon uses: the first
      // iteration's fixture hand-wrote `exec --json --model … -`, which no launch ever produces, so
      // it could not observe the fresh `--sandbox` block leaking into the resume argv. A case that
      // owns a hand-written argv passes it explicitly to prove the host settles instead of crashing.
      args: [...(identity.args ?? codexHostLaunchArgs("bypass"))],
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
      permissionMode: "bypass",
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
        // The resume subcommand parser rejects the fresh `--sandbox` block, so the continuation
        // must carry the mode's declared resume form. This assertion is the one the first
        // iteration lacked: its fixture argv had no permission block at all.
        "--dangerously-bypass-approvals-and-sandbox",
        "--model",
        "test-model",
        "provider-thread-compaction",
        "-",
      ]);
      assert.equal(read.invocations[1]!.args.includes("--sandbox"), false);
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

test(
  "an empty Codex turn without a compaction on a taskless dispatch stays a stop: no retry loop",
  {
    timeout: 20_000,
  },
  async () => {
    // No settle action is owed here: a taskless run delivers its final text, so there is nothing to
    // continue for. The task-bound counterpart of this shape is bounded by the turn-continuation test.
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
  },
);

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

/** The progress note dispatch_2ae120ca ended its turn with, then kept working after it. */
const codexProgressNote = "现在需要定位 unix_sockets 没有生效的环节——先看 daemon 上报与真实 session 的 sandbox 命令。";

/** The reconnect frame the same dispatch carried before the turn completed with no answer. */
const codexReconnectFrame = {
  type: "error",
  message:
    "Reconnecting... 1/5 (stream disconnected before completion: Our servers are currently overloaded. Please try again later.)",
} as const;

const codexAgentMessage = (id: string, text: string) =>
  ({ type: "item.completed", item: { id, type: "agent_message", text } }) as const;

const codexDeliveredSettle = {
  type: "item.completed",
  item: {
    id: "settle-1",
    type: "command_execution",
    command: "/bin/zsh -c 'ha task submit task_074ecb459989ae394b77c7cf70'",
    status: "completed",
    exit_code: 1,
  },
} as const;

test("a task-bound Codex turn that ends on a progress note resumes the same thread", { timeout: 20_000 }, async () => {
  // The incident shape (dispatch_2ae120ca): a progress note, a reconnect, more tool work, then
  // turn.completed with exit 0 and nothing delivered. Settlement used to read this as a worker
  // stop and spend an automatic disposition on it.
  const read = await driveCodexWorker(
    "progress-note-end",
    (invocation) =>
      invocation === 0
        ? [
            codexToolCompleted,
            codexAgentMessage("message-1", codexProgressNote),
            codexReconnectFrame,
            { type: "item.completed", item: { id: "tool-2", type: "command_execution", command: "sed -n '1,80p' x" } },
            { type: "turn.completed", usage: { input_tokens: 1159924, output_tokens: 7277 } },
          ]
        : [
            {
              type: "item.completed",
              item: {
                id: "settle-1",
                type: "command_execution",
                command: "/bin/zsh -c 'ha task submit task_074ecb459989ae394b77c7cf70'",
                status: "completed",
                exit_code: 0,
              },
            },
            codexAgentMessage("message-2", "submitted the delivery"),
            { type: "turn.completed", usage: { input_tokens: 1200000, output_tokens: 7400 } },
          ],
    { taskId: "task_074ecb459989ae394b77c7cf70" },
  );
  try {
    assert.equal(read.invocations.length, 2);
    assert.match(read.invocations[1]!.prompt, /Continue the current task/u);
    assert.deepEqual(read.invocations[1]!.args, [
      "exec",
      "resume",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "test-model",
      "provider-thread-compaction",
      "-",
    ]);
    assert.equal(read.records.filter((record) => record.kind === "turn_continued").length, 1);
    assert.equal(read.records.filter((record) => record.kind === "process_exit").length, 1);
  } finally {
    read.cleanup();
  }
});

test("a turn that already attempted the delivery is never resumed", { timeout: 20_000 }, async () => {
  // The rejected-submit shape: the worker performed its settle action and reported why the task
  // is not delivered. The host must not nag it into another turn; settlement owns that reason.
  const read = await driveCodexWorker(
    "settle-attempted",
    () => [
      codexToolCompleted,
      codexDeliveredSettle,
      codexAgentMessage("message-1", "submit 被拒：CI 还是红的，先报告原因。"),
      { type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 100 } },
    ],
    { taskId: "task_074ecb459989ae394b77c7cf70" },
  );
  try {
    assert.equal(read.invocations.length, 1);
    assert.equal(read.records.filter((record) => record.kind === "turn_continued").length, 0);
  } finally {
    read.cleanup();
  }
});

test("a task-bound turn whose only work is a file edit is not resumed", { timeout: 20_000 }, async () => {
  // Integration fixtures and early exits: a turn that wrote one file and stopped never ran the
  // commands a dispatched worker spends its provider time on, so it is settled, not continued.
  const read = await driveCodexWorker(
    "file-edit-only",
    () => [
      {
        type: "item.completed",
        item: { id: "write", type: "file_change", changes: [{ path: "result.txt", kind: "add" }], status: "completed" },
      },
      codexAgentMessage("message-1", codexProgressNote),
      { type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 100 } },
    ],
    { taskId: "task_074ecb459989ae394b77c7cf70" },
  );
  try {
    assert.equal(read.invocations.length, 1);
    assert.equal(read.records.filter((record) => record.kind === "turn_continued").length, 0);
  } finally {
    read.cleanup();
  }
});

test("a dispatch whose argv has no resume shape settles instead of crashing", { timeout: 20_000 }, async () => {
  // A provider launched with an argv the resume subcommand cannot express (no declared permission
  // block) must not take the dispatch down with it: the host records the refusal and exits, so the
  // daemon still settles the attempt from the evidence it has.
  const read = await driveCodexWorker(
    "argv-without-resume-shape",
    () => [codexToolCompleted, { type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 100 } }],
    { taskId: "task_074ecb459989ae394b77c7cf70", args: ["exec", "--json", "-"] },
  );
  try {
    assert.equal(read.invocations.length, 1);
    assert.equal(read.records.filter((record) => record.kind === "turn_continued").length, 0);
    assert.equal(read.records.filter((record) => record.kind === "continuation_refused").length, 1);
    assert.equal(read.records.filter((record) => record.kind === "process_exit").length, 1);
  } finally {
    read.cleanup();
  }
});

test("a turn that wrote the ruling artifact is a real stop", { timeout: 20_000 }, async () => {
  // A blocked unattended turn writes its ruling and stops; prose is irrelevant, the artifact is
  // the exit the mission contract declares.
  const read = await driveCodexWorker(
    "ruling-written",
    () => [
      codexToolCompleted,
      {
        type: "item.completed",
        item: {
          id: "file-1",
          type: "file_change",
          changes: [
            {
              path: "/tmp/repo/harness/tasks/task_074ecb459989ae394b77c7cf70-x/artifacts/rulings/dispatch_x.md",
              kind: "add",
            },
          ],
        },
      },
      codexAgentMessage("message-1", "裁决请求已写入，按约定停下。"),
      { type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 100 } },
    ],
    { taskId: "task_074ecb459989ae394b77c7cf70" },
  );
  try {
    assert.equal(read.invocations.length, 1);
    assert.equal(read.records.filter((record) => record.kind === "turn_continued").length, 0);
  } finally {
    read.cleanup();
  }
});

test("a squad or taskless turn delivers without a settle action and is not resumed", { timeout: 20_000 }, async () => {
  const narration = () => [
    codexToolCompleted,
    codexAgentMessage("message-1", codexProgressNote),
    { type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 100 } },
  ];
  for (const [name, identity] of [
    ["squad-leader-turn", { taskId: "task_074ecb459989ae394b77c7cf70", squadId: "debug-squad" }],
    ["taskless-turn", {}],
    ["read-only-attach", { taskId: "task_074ecb459989ae394b77c7cf70", role: "read-only" }],
  ] as const) {
    const read = await driveCodexWorker(name, narration, identity);
    try {
      assert.equal(read.invocations.length, 1, name);
      assert.equal(read.records.filter((record) => record.kind === "turn_continued").length, 0, name);
    } finally {
      read.cleanup();
    }
  }
});

test("turn continuations are bounded per dispatch, one settle attempt each", { timeout: 20_000 }, async () => {
  // A session that ends every turn the same way: the third continuation is the last, so the
  // dispatch still settles instead of looping.
  const read = await driveCodexWorker(
    "turn-continuation-bounded",
    () => [
      codexToolCompleted,
      codexAgentMessage("message-1", codexProgressNote),
      { type: "turn.completed", usage: { input_tokens: 2000, output_tokens: 0 } },
    ],
    { taskId: "task_074ecb459989ae394b77c7cf70" },
  );
  try {
    assert.equal(read.invocations.length, 4);
    assert.equal(read.records.filter((record) => record.kind === "turn_continued").length, 3);
    assert.equal(read.records.filter((record) => record.kind === "process_exit").length, 1);
  } finally {
    read.cleanup();
  }
});

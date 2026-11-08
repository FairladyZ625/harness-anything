// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { readSettingsFacet } from "@harness-anything/kernel";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instances.ts";
import { openDispatchStream } from "../src/dispatch-stream.ts";
import { launchNative } from "../src/runtime-spawn-process.ts";

const cli = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => path.join(dir, process.platform === "win32" ? "claude.exe" : "claude"))
    .find(existsSync),
  version = cli ? spawnSync(cli, ["--version"], { encoding: "utf8" }).stdout.trim() : "";

function claudeScenario(approved: boolean) {
  return async (t: TestContext) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-claude-interception-")),
      cwd = path.join(root, "repo"),
      bridge = path.join(cwd, "bridge.cjs"),
      bridgePrefix = `"${process.execPath}" "${bridge}"`,
      allowedCommand = approved
        ? `${bridgePrefix} task-create '${JSON.stringify({ title: "bounded fixture ".repeat(128) })}' --instance-snapshot '{"id":"fixture"}'`
        : "printf allowed > allowed.txt",
      deniedCommand = approved ? `${bridgePrefix} unapproved` : "printf denied > denied.txt",
      permissionMode = approved ? ("workspace-write" as const) : ("bypass" as const),
      outputs: { content: string; is_error?: boolean }[] = [],
      model = createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        if (request.url?.includes("count_tokens")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ input_tokens: 10 }));
          return;
        }
        const body = JSON.parse(raw) as {
          stream?: boolean;
          messages?: { content: { type: string; content: string; is_error?: boolean }[] | string }[];
        };
        for (const message of body.messages ?? [])
          if (Array.isArray(message.content))
            for (const block of message.content) if (block.type === "tool_result") outputs.push(block);
        const content = outputs.length
            ? [{ type: "text", text: "fixture complete" }]
            : [
                { type: "tool_use", id: "tool_denied", name: "Bash", input: { command: deniedCommand } },
                {
                  type: "tool_use",
                  id: "tool_allowed",
                  name: "Bash",
                  input: { command: allowedCommand },
                },
              ],
          message = {
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            model: "claude-fable-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        if (!body.stream) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ...message, content, stop_reason: outputs.length ? "end_turn" : "tool_use" }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const send = (event: { type: string; [key: string]: unknown }) =>
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        send({ type: "message_start", message });
        content.forEach((block, index) => {
          send({
            type: "content_block_start",
            index,
            content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" },
          });
          send({
            type: "content_block_delta",
            index,
            delta:
              block.type === "tool_use"
                ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
                : { type: "text_delta", text: block.text },
          });
          send({ type: "content_block_stop", index });
        });
        send({
          type: "message_delta",
          delta: { stop_reason: outputs.length ? "end_turn" : "tool_use", stop_sequence: null },
          usage: { output_tokens: 1 },
        });
        send({ type: "message_stop" });
        response.end();
      });
    mkdirSync(cwd);
    if (approved)
      writeFileSync(
        bridge,
        'const fs = require("node:fs"); fs.writeFileSync(process.argv[2] === "task-create" ? "allowed.txt" : "denied.txt", "allowed");',
      );
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      model.closeAllConnections();
      await new Promise<void>((resolve, reject) => model.close((error) => (error ? reject(error) : resolve())));
    });
    const address = model.address();
    assert.ok(address && typeof address !== "string");
    const installation = {
        installationId: "claude-fixture",
        kindId: "claude" as const,
        executablePath: realpathSync(cli!),
        version,
        observedAt: new Date().toISOString(),
      },
      store = openRuntimeInstanceStore({
        userRoot: path.join(root, "state"),
        discover: () => [installation],
        resolveCredential: () => "fixture-key",
      });
    store.create({
      schemaVersion: 2,
      instanceId: "claude-fixture",
      name: "Claude Fixture",
      kindId: "claude",
      installationId: installation.installationId,
      providerId: "anthropic",
      models: ["claude-fable-5"],
      defaultModel: "claude-fable-5",
      enabled: true,
      permissionMode,
      isolationState: "enforced",
      claude: { baseUrl: `http://127.0.0.1:${address.port}` },
      auth: { mode: "api-key", credentialRef: "credential:v1:claude-fixture" },
    });
    const rules = approved
        ? [
            { id: "reviewed-bridge", approvedCommand: allowedCommand },
            { id: "no-denied-file", pattern: " unapproved(?: |$)" },
          ]
        : readSettingsFacet(
            "settings:\n  runtime:\n    commandInterceptions:\n      - id: no-denied-file\n        pattern: 'denied\\.txt'\n",
          ).runtime.commandInterceptions,
      prepared = await store.prepareLaunch("claude-fixture", {
        cwd,
        prompt: "Execute the two fixture commands.",
        commandInterceptions: rules,
      }),
      dispatchId = "dispatch_123456789012345678901234",
      stream = openDispatchStream(root, {
        dispatchId,
        taskId: null,
        executionId: null,
        runtimeSessionId: "runtime_123456789012345678901234",
        instanceId: "claude-fixture",
        startedAt: new Date().toISOString(),
        dispatchOpId: "fixture",
        kindId: "claude",
        permissionMode,
        binding: { actor: { principal: { personId: "fixture" }, executor: null }, source: "local" },
        cwd,
        prompt: prepared.prompt,
        model: "claude-fable-5",
        reasoningEffort: null,
        fast: false,
        stallTimeoutMs: 60_000,
      }),
      worker = launchNative(
        {
          ...prepared,
          env: {
            ...prepared.env,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_TELEMETRY: "1",
            DISABLE_ERROR_REPORTING: "1",
          },
        },
        { rootDir: root, dispatchId },
      );
    t.after(async () => {
      await worker.terminateTree?.();
      worker.release?.();
      rmSync(root, { recursive: true, force: true });
    });
    assert.ok(stream.ref);
    let stdout = "",
      stderr = "";
    worker.onOutput((chunk) => {
      stdout += chunk;
    });
    worker.onErrorOutput((chunk) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve) => worker.onExit(resolve));
    t.diagnostic(JSON.stringify({ version, code, outputs }));
    assert.equal(
      code,
      0,
      stderr +
        stdout
          .split("\n")
          .filter((line) => !line.includes('"subtype":"init"'))
          .join("\n"),
    );
    assert.equal(existsSync(path.join(cwd, "denied.txt")), false, "matching command must never execute");
    assert.equal(readFileSync(path.join(cwd, "allowed.txt"), "utf8"), "allowed");
    assert.ok(
      outputs.some((output) => output.is_error && JSON.stringify(output.content).includes("no-denied-file")),
      JSON.stringify(outputs),
    );
  };
}

for (const approved of [false, true])
  test(
    approved
      ? "real Claude workspace-write admits a reviewed bridge and denies a same-prefix unapproved command"
      : "real Claude launched through the runtime store and worker host refuses declared commands and executes others",
    {
      timeout: 90_000,
      skip: !cli
        ? "requires installed Claude Code CLI"
        : approved && !["darwin", "linux"].includes(process.platform)
          ? "requires Claude native Bash sandbox on macOS/Linux"
          : false,
    },
    claudeScenario(approved),
  );

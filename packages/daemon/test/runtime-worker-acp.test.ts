// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runAcpProviderSession } from "../src/runtime-worker-acp.ts";
import { writeAcpProviderStub } from "./fixtures/acp-stub.ts";

function fixture() {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-worker-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "devin-stub"), capture);
  writeFileSync(capture, "");
  return { parent, capture, executablePath };
}

function collect() {
  const records: Record<string, unknown>[] = [];
  return {
    records,
    append: (value: Readonly<Record<string, unknown>>) => records.push({ ...value }),
  };
}

function launch(executablePath: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  return spawn(executablePath, [...args], {
    cwd: "/tmp",
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function closed(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => child.once("close", (code) => resolve(code)));
}

test("acp worker session drives initialize/authenticate/new/prompt and emits canonical frames", async () => {
  const { parent, capture, executablePath } = fixture();
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp", "--model", "swe"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "devin",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "do work",
          permissionMode: "bypass",
          acpApiKey: "test-manifest-key",
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    const frames = records
        .filter((record) => record.kind === "provider_event")
        .map((record) => record.event as Record<string, unknown>),
      kinds = frames.map((frame) => frame.type);
    assert.deepEqual(kinds, [
      "acp.session",
      "acp.mode",
      "acp.update",
      "acp.update",
      "acp.update",
      "acp.update",
      "acp.update",
      "acp.update",
      "acp.update",
      "acp.result",
    ]);
    assert.deepEqual(frames[0], {
      sessionId: "devin-acp-session",
      type: "acp.session",
      modes: ["accept-edits", "plan", "bypass"],
      currentMode: "accept-edits",
      models: ["swe-2-medium", "swe-2-high"],
      currentModelId: "swe-2-medium",
    });
    assert.deepEqual(frames[1], {
      sessionId: "devin-acp-session",
      type: "acp.mode",
      requested: "bypass",
      applied: "bypass",
    });
    assert.ok(
      frames.every((frame) => frame.sessionId === "devin-acp-session"),
      "every canonical frame carries the session id",
    );
    const updates = frames
      .filter((frame) => frame.type === "acp.update")
      .map((frame) => (frame.update as Record<string, unknown>).sessionUpdate);
    assert.deepEqual(updates, [
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "plan",
      "agent_message_chunk",
      "agent_message_chunk",
      "usage_update",
    ]);
    const result = frames.at(-1)!;
    assert.equal(result.type, "acp.result");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.finalText, "devin live content");
    // Usage keys arrive under scrub-safe names; the daemon maps them back.
    assert.deepEqual(result.usage, { input: 80, output: 20, total: 100 });
    const captured = readFileSync(capture, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(captured, [{ apiKey: "test-manifest-key", methodId: "devin-browser" }, { mode: "bypass" }]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker session/load keeps replayed history out of finalText and tags it with the session id", async () => {
  const { parent, executablePath } = fixture();
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "devin",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "do work",
          providerSessionId: "prior-session",
          acpApiKey: "test-manifest-key",
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    const frames = records
        .filter((record) => record.kind === "provider_event")
        .map((record) => record.event as Record<string, unknown>),
      replay = frames.find(
        (frame) =>
          frame.type === "acp.update" &&
          (frame.update as Record<string, unknown>).sessionUpdate === "agent_message_chunk" &&
          String(((frame.update as Record<string, unknown>).content as Record<string, unknown>).text).includes(
            "history",
          ),
      );
    assert.equal(replay?.sessionId, "prior-session");
    const result = frames.at(-1)!;
    assert.equal(result.type, "acp.result");
    assert.equal(result.finalText, "devin live content");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker session answers request_permission from the permission mode", async () => {
  const { parent, capture, executablePath } = fixture();
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "devin",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "permission-probe",
          permissionMode: "workspace-write",
          acpApiKey: "test-manifest-key",
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    const captured = readFileSync(capture, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      captured.find((entry) => entry.permission !== undefined),
      {
        permission: { outcome: "selected", optionId: "allow" },
      },
    );
    const result = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>)
      .at(-1)!;
    assert.equal(result.type, "acp.result");
    assert.equal(result.stopReason, "end_turn");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker session reads the provider credential file for subscription instances", async () => {
  const { parent, capture, executablePath } = fixture();
  try {
    mkdirSync(path.join(parent, ".local/share/devin"), { recursive: true });
    writeFileSync(
      path.join(parent, ".local/share/devin/credentials.toml"),
      'windsurf_api_key = "test-subscription-key"\napi_server_url = "https://example.invalid"\n',
    );
    const { append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        { kindId: "devin", cwd: "/tmp", env: { HOME: parent }, prompt: "do work" },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    const captured = readFileSync(capture, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      captured.find((entry) => entry.apiKey !== undefined),
      {
        apiKey: "test-subscription-key",
        methodId: "devin-browser",
      },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker session sends session/cancel before terminating the child", async () => {
  const { parent, capture, executablePath } = fixture();
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "devin",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "hang",
          acpApiKey: "test-manifest-key",
        },
        append,
      );
    // Wait until the prompt is in flight (session frame seen) before cancelling.
    const seenSession = () =>
      records.some(
        (record) =>
          record.kind === "provider_event" &&
          (record.event as Record<string, unknown> | undefined)?.type === "acp.session",
      );
    for (let waited = 0; !seenSession() && waited < 10_000; waited += 10)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(seenSession(), "acp.session frame must precede cancel");
    session.cancel();
    assert.notEqual(await closed(child), 0);
    const captured = readFileSync(capture, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      captured.find((entry) => entry.cancel !== undefined),
      { cancel: "devin-acp-session" },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker session selects the declared auth method and authenticates without a key", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-worker-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "codex-stub"), capture, {
      authMethods: [
        { id: "api-key", name: "API Key" },
        { id: "chat-gpt", name: "ChatGPT" },
      ],
    });
  writeFileSync(capture, "");
  try {
    const { append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        { kindId: "codex-acp", cwd: "/tmp", env: { HOME: parent }, prompt: "do work" },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    const captured = readFileSync(capture, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      captured.find((entry) => entry.methodId !== undefined),
      {
        apiKey: "",
        methodId: "chat-gpt",
      },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker session maps the permission mode onto the agent's mode vocabulary", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-worker-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "codex-stub"), capture, {
      modes: {
        currentModeId: "agent",
        availableModes: [
          { id: "read-only", name: "Ask" },
          { id: "agent", name: "Approve" },
          { id: "agent-full-access", name: "Full access" },
        ],
      },
    });
  writeFileSync(capture, "");
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "devin",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "do work",
          permissionMode: "bypass",
          acpApiKey: "test-manifest-key",
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    const captured = readFileSync(capture, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      captured.find((entry) => entry.mode !== undefined),
      { mode: "agent-full-access" },
    );
    const modeFrame = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>)
      .find((frame) => frame.type === "acp.mode");
    assert.deepEqual(modeFrame, {
      sessionId: "devin-acp-session",
      type: "acp.mode",
      requested: "bypass",
      applied: "agent-full-access",
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// devin and opencode advertise the catalog as a configOptions select instead of
// the spec models block; the session frame flattens both shapes the same way.
test("acp worker session reads the model catalog from a configOptions selector", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-worker-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "opencode-stub"), capture, {
      session: {
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "opencode/big-pickle",
            options: [{ value: "opencode/big-pickle" }, { value: "minimax/MiniMax-M3" }],
          },
        ],
      },
    });
  writeFileSync(capture, "");
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "devin",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "do work",
          acpApiKey: "test-manifest-key",
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    const sessionFrame = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>)
      .find((frame) => frame.type === "acp.session");
    assert.deepEqual(sessionFrame, {
      sessionId: "devin-acp-session",
      type: "acp.session",
      modes: ["accept-edits", "plan", "bypass"],
      currentMode: "accept-edits",
      models: ["opencode/big-pickle", "minimax/MiniMax-M3"],
      currentModelId: "opencode/big-pickle",
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// A session/new that advertises no catalog (the spec allows omission) must not
// produce a misleading empty model list on the frame.
test("acp worker session omits model fields when the agent advertises none", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-worker-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "devin-stub"), capture, { session: {} });
  writeFileSync(capture, "");
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "devin",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "do work",
          acpApiKey: "test-manifest-key",
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    const sessionFrame = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>)
      .find((frame) => frame.type === "acp.session");
    assert.deepEqual(sessionFrame, {
      sessionId: "devin-acp-session",
      type: "acp.session",
      modes: ["accept-edits", "plan", "bypass"],
      currentMode: "accept-edits",
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker session fails closed when the agent rejects the offered credential", async () => {
  const { parent, executablePath } = fixture();
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        { kindId: "devin", cwd: "/tmp", env: { HOME: parent }, prompt: "do work" },
        append,
      );
    await session.done;
    await closed(child);
    const frames = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>);
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.type, "acp.error");
    assert.match(String(frames[0]!.message), /api key required/i);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker session fails when the provider exits 0 before the session exists", async () => {
  const { parent, executablePath } = fixture();
  try {
    const { records, append } = collect(),
      // devin shuts its ACP server down with exit 0 once this pid is gone.
      editorHostPid = spawnSync(process.execPath, ["-e", ""]).pid,
      child = launch(executablePath, ["acp"], {
        HOME: parent,
        PATH: process.env.PATH,
        WINDSURF_EXT_HOST_PID: String(editorHostPid),
      }),
      session = runAcpProviderSession(
        child,
        { kindId: "devin", cwd: "/tmp", env: { HOME: parent }, prompt: "do work", acpApiKey: "test-manifest-key" },
        append,
      );
    const exit = closed(child);
    await session.done;
    assert.equal(await exit, 0);
    const frames = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>);
    assert.deepEqual(frames, [
      { type: "acp.error", message: "ACP provider exited before the session completed (exit 0, signal null)" },
    ]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker session fails when the provider exits 0 in the middle of the prompt", async () => {
  const { parent, executablePath } = fixture();
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "devin",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "exit-mid-prompt",
          permissionMode: "bypass",
          acpApiKey: "test-manifest-key",
        },
        append,
      );
    const exit = closed(child);
    await session.done;
    assert.equal(await exit, 0);
    const frames = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>);
    assert.deepEqual(
      frames.map((frame) => frame.type),
      ["acp.session", "acp.mode", "acp.update", "acp.error"],
    );
    assert.deepEqual(frames.at(-1), {
      sessionId: "devin-acp-session",
      type: "acp.error",
      message: "ACP provider exited before the session completed (exit 0, signal null)",
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

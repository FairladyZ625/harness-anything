// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runAcpProviderSession } from "../src/runtime-worker-acp.ts";
import { writeAcpProviderStub } from "./fixtures/acp-stub.ts";
function collect() {
  const records: Record<string, unknown>[] = [];
  return { records, append: (value: Readonly<Record<string, unknown>>) => records.push({ ...value }) };
}
function launch(executablePath: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  return spawn(executablePath, [...args], { cwd: "/tmp", env, stdio: ["pipe", "pipe", "pipe"] });
}
async function closed(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => child.once("close", (code) => resolve(code)));
}
function capturedEntries(capture: string): Record<string, unknown>[] {
  return readFileSync(capture, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const groupedModelSelector = {
  configOptions: [
    {
      id: "reasoning_effort",
      category: "thought_level",
      type: "select",
      currentValue: "low",
      options: [{ value: "off" }, { value: "low" }, { value: "high" }],
    },
  ],
};
function groupedFixture(options: Parameters<typeof writeAcpProviderStub>[2] = {}, session = groupedModelSelector) {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-hardening-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "provider-stub"), capture, { ...options, session });
  writeFileSync(capture, "");
  return { parent, capture, executablePath };
}
function fixture() {
  return groupedFixture({}, { configOptions: [] });
}
async function continuationForRulingTool(
  rulingTool: NonNullable<Parameters<typeof writeAcpProviderStub>[2]>["rulingTool"],
): Promise<boolean> {
  const { parent, executablePath } = groupedFixture({ unsettledTurn: true, rulingTool }, { configOptions: [] });
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "codex-acp",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "do work",
          acpApiKey: "test-manifest-key",
          unsettledTurnContinuation: { maxContinuations: 1 },
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0, JSON.stringify(records));
    return records.some((record) => (record.event as Record<string, unknown> | undefined)?.type === "acp.continuation");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}
test("acp worker selects the declaration's api-key auth method when the instance route is api-key", async () => {
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
        {
          kindId: "codex-acp",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "do work",
          authMode: "api-key",
          acpApiKey: "api-key-test",
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    assert.deepEqual(
      capturedEntries(capture).find((entry) => entry.methodId !== undefined),
      { apiKey: "api-key-test", methodId: "api-key" },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker fails closed when the declared auth method is not advertised", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-worker-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "codex-stub"), capture, {
      authMethods: [{ id: "chat-gpt", name: "ChatGPT" }],
    });
  writeFileSync(capture, "");
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        { kindId: "codex-acp", cwd: "/tmp", env: { HOME: parent }, prompt: "do work", authMode: "api-key" },
        append,
      );
    await session.done;
    await closed(child);
    const frames = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>);
    assert.equal(frames.at(-1)!.type, "acp.error");
    assert.match(String(frames.at(-1)!.message), /does not advertise the declared authenticate method api-key/u);
    assert.equal(
      capturedEntries(capture).some((entry) => entry.methodId !== undefined),
      false,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker applies a thought_level effort selector and preserves extended result usage", async () => {
  const { parent, executablePath } = groupedFixture({
    usage: { cachedReadTokens: 3, cachedWriteTokens: 2, thoughtTokens: 5 },
  });
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
          effort: "high",
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    const frames = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>);
    assert.deepEqual(
      frames.find((frame) => frame.type === "acp.effort"),
      {
        sessionId: "devin-acp-session",
        type: "acp.effort",
        requested: "high",
        applied: "high",
      },
    );
    assert.deepEqual(frames.at(-1)!.usage, {
      input: 80,
      output: 20,
      total: 100,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      thoughtTokens: 5,
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker fails closed when the effort selector does not offer the requested value", async () => {
  const { parent, capture, executablePath } = groupedFixture();
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
          effort: "max",
        },
        append,
      );
    await session.done;
    await closed(child);
    const frames = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>);
    assert.equal(frames[0]!.type, "acp.session");
    assert.equal(frames.at(-1)!.type, "acp.error");
    assert.match(String(frames[1]!.message), /does not offer effort max; offered: off, low, high/u);
    assert.equal(
      capturedEntries(capture).some((entry) => entry.configOption !== undefined),
      false,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker leaves an effort request alone when no effort selector is advertised", async () => {
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
          prompt: "do work",
          acpApiKey: "test-manifest-key",
          effort: "high",
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    const frames = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>);
    assert.equal(
      frames.some((frame) => frame.type === "acp.effort"),
      false,
    );
    assert.equal(frames.at(-1)!.type, "acp.result");
    assert.equal(
      capturedEntries(capture).some((entry) => entry.configOption !== undefined),
      false,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker does not send an effort RPC when the selector is already current", async () => {
  const effortOptions = (groupedModelSelector.configOptions as readonly Record<string, unknown>[]).map((option) =>
    option.id === "reasoning_effort" ? { ...option, currentValue: "high" } : option,
  );
  const { parent, capture, executablePath } = groupedFixture({}, { configOptions: effortOptions });
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
          effort: "high",
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    const frames = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>);
    assert.deepEqual(
      frames.find((frame) => frame.type === "acp.effort"),
      {
        sessionId: "devin-acp-session",
        type: "acp.effort",
        requested: "high",
        applied: "high",
      },
    );
    assert.equal(
      capturedEntries(capture).some((entry) => entry.configOption?.configId === "reasoning_effort"),
      false,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker negotiates effort against the options returned by model selection", async () => {
  const initialOptions = [
      {
        id: "model",
        category: "model",
        currentValue: "model-a",
        options: [{ value: "model-a" }, { value: "model-b" }],
      },
      { id: "reasoning_effort", category: "thought_level", currentValue: "high", options: [{ value: "high" }] },
    ],
    changedOptions = [
      {
        id: "model",
        category: "model",
        currentValue: "model-b",
        options: [{ value: "model-a" }, { value: "model-b" }],
      },
      {
        id: "reasoning_effort",
        category: "thought_level",
        currentValue: "low",
        options: [{ value: "low" }, { value: "max" }],
      },
    ],
    { parent, capture, executablePath } = groupedFixture(
      { modelConfigOptions: { "model-b": changedOptions } },
      { configOptions: initialOptions },
    );
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "codex-acp",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "work",
          acpApiKey: "test-manifest-key",
          model: "model-b",
          effort: "max",
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    assert.deepEqual(
      capturedEntries(capture)
        .filter((entry) => entry.configOption !== undefined)
        .map((entry) => entry.configOption),
      [
        { configId: "model", value: "model-b" },
        { configId: "reasoning_effort", value: "max" },
      ],
    );
    assert.equal(
      (
        records.find((record) => (record.event as Record<string, unknown> | undefined)?.type === "acp.effort")
          ?.event as Record<string, unknown>
      ).applied,
      "max",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker follows the model response when its effort selector disappears", async () => {
  const initialOptions = [
      {
        id: "model",
        category: "model",
        currentValue: "model-a",
        options: [{ value: "model-a" }, { value: "model-b" }],
      },
      { id: "reasoning_effort", category: "thought_level", currentValue: "high", options: [{ value: "high" }] },
    ],
    changedOptions = [
      {
        id: "model",
        category: "model",
        currentValue: "model-b",
        options: [{ value: "model-a" }, { value: "model-b" }],
      },
    ],
    { parent, capture, executablePath } = groupedFixture(
      { modelConfigOptions: { "model-b": changedOptions } },
      { configOptions: initialOptions },
    );
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "codex-acp",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "work",
          acpApiKey: "test-manifest-key",
          model: "model-b",
          effort: "high",
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    assert.deepEqual(
      capturedEntries(capture)
        .filter((entry) => entry.configOption !== undefined)
        .map((entry) => entry.configOption),
      [{ configId: "model", value: "model-b" }],
    );
    assert.equal(
      records.some((record) => (record.event as Record<string, unknown> | undefined)?.type === "acp.effort"),
      false,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker observes an effort selector first advertised after model selection", async () => {
  const initialOptions = [
      {
        id: "model",
        category: "model",
        currentValue: "model-a",
        options: [{ value: "model-a" }, { value: "model-b" }],
      },
    ],
    changedOptions = [
      {
        id: "model",
        category: "model",
        currentValue: "model-b",
        options: [{ value: "model-a" }, { value: "model-b" }],
      },
      {
        id: "reasoning_effort",
        category: "thought_level",
        currentValue: "low",
        options: [{ value: "low" }, { value: "high" }],
      },
    ],
    { parent, capture, executablePath } = groupedFixture(
      { modelConfigOptions: { "model-b": changedOptions } },
      { configOptions: initialOptions },
    );
  try {
    const { append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "codex-acp",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "work",
          acpApiKey: "test-manifest-key",
          model: "model-b",
          effort: "high",
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    assert.deepEqual(
      capturedEntries(capture)
        .filter((entry) => entry.configOption !== undefined)
        .map((entry) => entry.configOption),
      [
        { configId: "model", value: "model-b" },
        { configId: "reasoning_effort", value: "high" },
      ],
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker rejects an effort value removed by the selected model", async () => {
  const initialOptions = [
      {
        id: "model",
        category: "model",
        currentValue: "model-a",
        options: [{ value: "model-a" }, { value: "model-b" }],
      },
      { id: "reasoning_effort", category: "thought_level", currentValue: "high", options: [{ value: "high" }] },
    ],
    changedOptions = [
      {
        id: "model",
        category: "model",
        currentValue: "model-b",
        options: [{ value: "model-a" }, { value: "model-b" }],
      },
      { id: "reasoning_effort", category: "thought_level", currentValue: "low", options: [{ value: "low" }] },
    ],
    { parent, capture, executablePath } = groupedFixture(
      { modelConfigOptions: { "model-b": changedOptions } },
      { configOptions: initialOptions },
    );
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "codex-acp",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "work",
          acpApiKey: "test-manifest-key",
          model: "model-b",
          effort: "high",
        },
        append,
      );
    await session.done;
    await closed(child);
    const error = records.find((record) => (record.event as Record<string, unknown> | undefined)?.type === "acp.error")
      ?.event as Record<string, unknown> | undefined;
    assert.match(String(error?.message), /does not offer effort high; offered: low/u);
    assert.deepEqual(
      capturedEntries(capture)
        .filter((entry) => entry.configOption !== undefined)
        .map((entry) => entry.configOption),
      [{ configId: "model", value: "model-b" }],
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker applies catalog effort value mappings to the advertised selector", async () => {
  const { parent, capture, executablePath } = groupedFixture(
    {},
    {
      configOptions: [
        {
          id: "reasoning_effort",
          category: "thought_level",
          type: "select",
          currentValue: "low",
          options: [{ value: "off" }, { value: "low" }, { value: "high" }, { value: "max" }],
        },
      ],
    },
  );
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "deepseek-harness",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "do work",
          acpApiKey: "test-manifest-key",
          effort: "minimal",
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    assert.deepEqual(capturedEntries(capture).find((entry) => entry.configOption !== undefined)?.configOption, {
      configId: "reasoning_effort",
      value: "off",
    });
    const frames = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>);
    assert.deepEqual(
      frames.find((frame) => frame.type === "acp.effort"),
      {
        sessionId: "devin-acp-session",
        type: "acp.effort",
        requested: "minimal",
        applied: "off",
      },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker continues a declared task turn after command work ends without settlement", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-worker-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "codex-stub"), capture, { unsettledTurn: true });
  writeFileSync(capture, "");
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "codex-acp",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "do work",
          acpApiKey: "test-manifest-key",
          unsettledTurnContinuation: { maxContinuations: 1, prompt: "Continue now" },
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0, JSON.stringify(records));
    const types = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => (record.event as Record<string, unknown>).type);
    assert.ok(types.includes("acp.continuation"));
    assert.equal(types.filter((type) => type === "acp.result").length, 2);
    assert.deepEqual(
      capturedEntries(capture).filter((entry) => entry.prompt !== undefined),
      [],
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker ignores settlement and ruling mentions in completed command output", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-worker-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "codex-stub"), capture, {
      unsettledTurn: true,
      unsettledOutputMentions: true,
    });
  writeFileSync(capture, "");
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "codex-acp",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "do work",
          acpApiKey: "test-manifest-key",
          unsettledTurnContinuation: { maxContinuations: 1 },
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0, JSON.stringify(records));
    assert.ok(
      records.some((record) => (record.event as Record<string, unknown> | undefined)?.type === "acp.continuation"),
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker treats a completed write to a ruling artifact as settlement evidence", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-worker-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "codex-stub"), capture, {
      unsettledTurn: true,
      rulingTool: { kind: "edit", input: { path: "artifacts/rulings/request.md" } },
    });
  writeFileSync(capture, "");
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "codex-acp",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "do work",
          acpApiKey: "test-manifest-key",
          unsettledTurnContinuation: { maxContinuations: 2 },
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    assert.equal(
      records.some((record) => (record.event as Record<string, unknown> | undefined)?.type === "acp.continuation"),
      false,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker does not treat deleting a ruling artifact as settlement evidence", async () => {
  assert.equal(
    await continuationForRulingTool({ kind: "delete", input: { path: "artifacts/rulings/request.md" } }),
    true,
  );
});

test("acp worker ignores a ruling artifact used only as a move source", async () => {
  assert.equal(
    await continuationForRulingTool({
      kind: "move",
      input: { path: "artifacts/rulings/request.md", destination: "notes/request.md" },
    }),
    true,
  );
});

test("acp worker recognizes a ruling artifact used as a move destination", async () => {
  assert.equal(
    await continuationForRulingTool({
      kind: "move",
      input: { path: "notes/request.md", destination: "artifacts/rulings/request.md" },
    }),
    false,
  );
});

test("acp worker does not continue command work that never completed", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-worker-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "codex-stub"), capture, {
      unsettledTurn: true,
      unsettledCommandStatus: "in_progress",
    });
  writeFileSync(capture, "");
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "codex-acp",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "do work",
          acpApiKey: "test-manifest-key",
          unsettledTurnContinuation: { maxContinuations: 2 },
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    const frames = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>);
    assert.equal(frames.filter((frame) => frame.type === "acp.result").length, 1);
    assert.equal(
      frames.some((frame) => frame.type === "acp.continuation"),
      false,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker does not continue a command turn that already attempted settlement", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-worker-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "codex-stub"), capture, { settledCommand: true });
  writeFileSync(capture, "");
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "codex-acp",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "do work",
          acpApiKey: "test-manifest-key",
          unsettledTurnContinuation: { maxContinuations: 2 },
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    const frames = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>);
    assert.equal(frames.filter((frame) => frame.type === "acp.result").length, 1);
    assert.equal(
      frames.some((frame) => frame.type === "acp.continuation"),
      false,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker does not continue a turn with only non-command tool work", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-worker-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "codex-stub"), capture);
  writeFileSync(capture, "");
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "codex-acp",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "do work",
          acpApiKey: "test-manifest-key",
          unsettledTurnContinuation: { maxContinuations: 2 },
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    const frames = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>);
    assert.equal(frames.filter((frame) => frame.type === "acp.result").length, 1);
    assert.equal(
      frames.some((frame) => frame.type === "acp.continuation"),
      false,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker stops after the declared continuation limit", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-worker-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "codex-stub"), capture, { unsettledTurnAlways: true });
  writeFileSync(capture, "");
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "codex-acp",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "do work",
          acpApiKey: "test-manifest-key",
          unsettledTurnContinuation: { maxContinuations: 2, prompt: "continue" },
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    const frames = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>);
    assert.equal(frames.filter((frame) => frame.type === "acp.result").length, 3);
    assert.deepEqual(
      frames.filter((frame) => frame.type === "acp.continuation").map((frame) => frame.continuation),
      [1, 2],
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp result usage normalizes cache-exclusive input while retaining provider provenance", async () => {
  const { parent, capture, executablePath } = groupedFixture(
    { usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100, cachedReadTokens: 3, cachedWriteTokens: 2 } },
    { configOptions: [] },
  );
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        { kindId: "codex-acp", cwd: "/tmp", env: { HOME: parent }, prompt: "work", acpApiKey: "test-manifest-key" },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    assert.deepEqual(
      (
        records.find((record) => (record.event as Record<string, unknown> | undefined)?.type === "acp.result")
          ?.event as Record<string, unknown>
      ).usage,
      {
        input: 85,
        providerInputTokens: 80,
        output: 20,
        total: 100,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
      },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker does not continue an ACP kind without a continuation declaration", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-worker-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "devin-stub"), capture, { unsettledTurn: true });
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
    const frames = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>);
    assert.equal(frames.filter((frame) => frame.type === "acp.result").length, 1);
    assert.equal(
      frames.some((frame) => frame.type === "acp.continuation"),
      false,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker rejects a structured upstream error disguised as end_turn", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-worker-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "codex-stub"), capture, {
      upstreamError: JSON.stringify({ error: { code: "model_not_found", message: "missing" } }),
    });
  writeFileSync(capture, "");
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        { kindId: "devin", cwd: "/tmp", env: { HOME: parent }, prompt: "do work", acpApiKey: "test-manifest-key" },
        append,
      );
    await session.done;
    const error = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>)
      .find((frame) => frame.type === "acp.error");
    assert.match(String(error?.message), /model_not_found/u);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker preserves end_turn when an upstream error payload follows a tool call", async () => {
  const { parent, executablePath } = groupedFixture({
    upstreamError: JSON.stringify({ error: { code: "model_not_found", message: "missing" } }),
    upstreamErrorAfterToolCall: true,
  });
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        {
          kindId: "codex-acp",
          cwd: "/tmp",
          env: { HOME: parent },
          prompt: "do work",
          acpApiKey: "test-manifest-key",
        },
        append,
      );
    await session.done;
    assert.equal(await closed(child), 0);
    const frames = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>);
    assert.equal(
      frames.some((frame) => frame.type === "acp.error"),
      false,
    );
    assert.equal(frames.at(-1)!.type, "acp.result");
    assert.equal(frames.at(-1)!.stopReason, "end_turn");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker rejects an explicit ACP protocol error update", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-acp-worker-")),
    capture = path.join(parent, "capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "devin-stub"), capture, {
      protocolError: { code: "provider_protocol_error", message: "bad session update" },
    });
  writeFileSync(capture, "");
  try {
    const { records, append } = collect(),
      child = launch(executablePath, ["acp"], { HOME: parent, PATH: process.env.PATH }),
      session = runAcpProviderSession(
        child,
        { kindId: "devin", cwd: "/tmp", env: { HOME: parent }, prompt: "do work", acpApiKey: "test-manifest-key" },
        append,
      );
    await session.done;
    const frames = records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>);
    assert.equal(frames[0]!.type, "acp.session");
    assert.equal(frames.at(-1)!.type, "acp.error");
    assert.match(String(frames.at(-1)!.message), /provider_protocol_error/u);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

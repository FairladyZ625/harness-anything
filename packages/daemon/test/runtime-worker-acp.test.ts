// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
    assert.deepEqual(captured, [{ apiKey: "test-manifest-key" }, { mode: "bypass" }]);
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
      { apiKey: "test-subscription-key" },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("acp worker session sends session/cancel before terminating the child", async () => {
  const { parent, capture, executablePath } = fixture();
  try {
    const { append } = collect(),
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
    await new Promise((resolve) => setTimeout(resolve, 500));
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

test("acp worker session fails closed when the agent requires auth and no credential exists", async () => {
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
    assert.match(String(frames[0]!.message), /authentication/i);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

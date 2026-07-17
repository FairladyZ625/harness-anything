// harness-test-tier: contract
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createClaudeCodeRuntimeAdapter,
  createCodexRuntimeAdapter,
  type RuntimeChildProcess,
  type RuntimeChildSpawner
} from "../src/agent-runtime/protocol-adapters.ts";
import type { RuntimeAdapterProcessEvent } from "../src/agent-runtime/session-service.ts";

test("Claude adapter consumes stream-json and binds the provider session without reading terminal text", async () => {
  const fixture = childFixture();
  const spawnChild: RuntimeChildSpawner = (command, args, options) => {
    assert.equal(command, "/verified/claude");
    assert.deepEqual(args.slice(0, 5), ["--print", "--verbose", "--output-format", "stream-json", "inspect"]);
    assert.equal(options.cwd, "/workspace");
    return fixture.child;
  };
  const adapter = createClaudeCodeRuntimeAdapter({ executablePath: "/verified/claude", spawnChild });
  const process = await adapter.spawn(spawnPayload("claude-code", "subscription-account"));
  const events: RuntimeAdapterProcessEvent[] = [];
  process.onEvent((event) => events.push(event));

  fixture.stdout.emit("data", Buffer.from('{"type":"system","subtype":"init","session_id":"claude-session"}\n'));
  fixture.stdout.emit("data", Buffer.from('{"type":"result","subtype":"success","session_id":"claude-session"}\n'));
  fixture.process.emit("exit", 0, null);

  assert.deepEqual(events.map((event) => event.kind), ["heartbeat", "provider-session", "heartbeat", "completed", "exit"]);
  assert.equal(events.find((event) => event.kind === "provider-session")?.providerSessionId, "claude-session");
});

test("Codex adapter negotiates app-server JSON-RPC and resumes before starting a turn", async () => {
  const fixture = childFixture();
  const writes: string[] = [];
  fixture.stdin.write = (chunk: string) => { writes.push(chunk); return true; };
  const adapter = createCodexRuntimeAdapter({
    executablePath: "/verified/codex",
    spawnChild: (command, args) => {
      assert.equal(command, "/verified/codex");
      assert.deepEqual(args, ["app-server", "--listen", "stdio://"]);
      return fixture.child;
    }
  });
  const process = await adapter.spawn({
    ...spawnPayload("codex", "chatgpt-account"),
    resumeProviderSessionId: "codex-thread-old"
  });
  const events: RuntimeAdapterProcessEvent[] = [];
  process.onEvent((event) => events.push(event));

  assert.equal(JSON.parse(writes[0] ?? "{}").method, "initialize");
  fixture.stdout.emit("data", Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'));
  assert.equal(JSON.parse(writes.at(-1) ?? "{}").method, "thread/resume");
  fixture.stdout.emit("data", Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"codex-thread-old"}}}\n'));
  assert.equal(JSON.parse(writes.at(-1) ?? "{}").method, "turn/start");
  assert.equal(events.find((event) => event.kind === "provider-session")?.providerSessionId, "codex-thread-old");
});

function spawnPayload(kindId: "claude-code" | "codex", authenticationProfileKind: string) {
  return { kindId, prompt: "inspect", cwd: "/workspace", authenticationProfileKind } as const;
}

function childFixture() {
  const process = new EventEmitter() as EventEmitter & { pid: number };
  process.pid = 777;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = { write: (_chunk: string) => true };
  const child: RuntimeChildProcess = {
    pid: 777,
    stdout,
    stderr,
    stdin,
    on: (event, listener) => { process.on(event, listener); return child; },
    kill: () => true
  };
  return { child, process, stdout, stderr, stdin };
}

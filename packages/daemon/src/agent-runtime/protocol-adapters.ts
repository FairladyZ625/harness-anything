import { spawn } from "node:child_process";
import type {
  RuntimeAdapterProcess,
  RuntimeAdapterProcessEvent,
  RuntimeProtocolAdapter
} from "./session-service.ts";

interface DataSource {
  readonly on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
}

interface InputSink {
  readonly write: (chunk: string) => unknown;
}

export interface RuntimeChildProcess {
  readonly pid?: number;
  readonly stdout: DataSource;
  readonly stderr: DataSource;
  readonly stdin: InputSink;
  readonly on: (event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) => RuntimeChildProcess;
  readonly kill: () => boolean;
}

export type RuntimeChildSpawner = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly stdio: ["pipe", "pipe", "pipe"] }
) => RuntimeChildProcess;

interface AdapterOptions {
  readonly executablePath: string | (() => Promise<string>);
  readonly spawnChild?: RuntimeChildSpawner;
  readonly env?: NodeJS.ProcessEnv;
}

export function createClaudeCodeRuntimeAdapter(options: AdapterOptions): RuntimeProtocolAdapter {
  return {
    kindId: "claude-code",
    capabilities: {
      discover: true,
      spawn: true,
      attach: false,
      resume: true,
      interactive: false,
      resize: false,
      events: true
    },
    spawn: async (payload) => {
      const executablePath = await resolveExecutablePath(options.executablePath);
      const args = [
        "--print",
        "--verbose",
        "--output-format",
        "stream-json",
        ...(payload.resumeProviderSessionId ? ["--resume", payload.resumeProviderSessionId] : []),
        payload.prompt
      ];
      const child = spawnRuntimeChild(options, executablePath, args, payload.cwd);
      const events = eventChannel();
      let providerSessionId = payload.resumeProviderSessionId;
      readJsonLines(child.stdout, (message) => {
        events.emit({ kind: "heartbeat" });
        const candidate = stringField(message, "session_id");
        if (candidate && candidate !== providerSessionId) {
          providerSessionId = candidate;
          events.emit({ kind: "provider-session", providerSessionId: candidate });
        }
        if (message.type === "result") events.emit({ kind: message.is_error === true || message.subtype === "error" ? "failed" : "completed" });
      });
      child.on("exit", (code) => events.emit({ kind: "exit", exitCode: code }));
      return processHandle(child, events);
    }
  };
}

export function createCodexRuntimeAdapter(options: AdapterOptions): RuntimeProtocolAdapter {
  return {
    kindId: "codex",
    capabilities: {
      discover: true,
      spawn: true,
      attach: true,
      resume: true,
      interactive: true,
      resize: false,
      events: true
    },
    spawn: async (payload) => {
      const executablePath = await resolveExecutablePath(options.executablePath);
      const child = spawnRuntimeChild(options, executablePath, ["app-server", "--listen", "stdio://"], payload.cwd);
      const events = eventChannel();
      const write = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
      readJsonLines(child.stdout, (message) => {
        events.emit({ kind: "heartbeat" });
        if (message.id === 1 && "result" in message) {
          write({ jsonrpc: "2.0", method: "initialized", params: {} });
          write({
            jsonrpc: "2.0",
            id: 2,
            method: payload.resumeProviderSessionId ? "thread/resume" : "thread/start",
            params: payload.resumeProviderSessionId
              ? { threadId: payload.resumeProviderSessionId, cwd: payload.cwd }
              : { cwd: payload.cwd, approvalPolicy: "never", sandbox: "workspace-write" }
          });
          return;
        }
        if (message.id === 2) {
          const providerSessionId = nestedString(message, ["result", "thread", "id"]);
          if (!providerSessionId) {
            events.emit({ kind: "failed" });
            return;
          }
          events.emit({ kind: "provider-session", providerSessionId });
          write({
            jsonrpc: "2.0",
            id: 3,
            method: "turn/start",
            params: {
              threadId: providerSessionId,
              cwd: payload.cwd,
              input: [{ type: "text", text: payload.prompt }]
            }
          });
          return;
        }
        if (message.method === "turn/completed") events.emit({ kind: "completed" });
        if ("error" in message || message.method === "error") events.emit({ kind: "failed" });
      });
      child.on("exit", (code) => events.emit({ kind: "exit", exitCode: code }));
      write({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "harness-anything", title: "Harness Anything", version: "0.1.0" },
          capabilities: { experimentalApi: false }
        }
      });
      return processHandle(child, events);
    }
  };
}

function spawnRuntimeChild(options: AdapterOptions, executablePath: string, args: ReadonlyArray<string>, cwd: string): RuntimeChildProcess {
  const spawnChild = options.spawnChild ?? defaultSpawnChild;
  return spawnChild(executablePath, args, {
    cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

async function resolveExecutablePath(value: AdapterOptions["executablePath"]): Promise<string> {
  return typeof value === "string" ? value : value();
}

function defaultSpawnChild(command: string, args: ReadonlyArray<string>, options: Parameters<RuntimeChildSpawner>[2]): RuntimeChildProcess {
  return spawn(command, [...args], options) as RuntimeChildProcess;
}

function processHandle(child: RuntimeChildProcess, events: ReturnType<typeof eventChannel>): RuntimeAdapterProcess {
  if (!child.pid) throw new Error("Runtime adapter child did not expose a PID.");
  return {
    pid: child.pid,
    onEvent: events.subscribe,
    close: () => { child.kill(); }
  };
}

function eventChannel() {
  let listener: ((event: RuntimeAdapterProcessEvent) => void) | undefined;
  const pending: RuntimeAdapterProcessEvent[] = [];
  return {
    emit: (event: RuntimeAdapterProcessEvent) => listener ? listener(event) : pending.push(event),
    subscribe: (next: (event: RuntimeAdapterProcessEvent) => void) => {
      listener = next;
      for (const event of pending.splice(0, pending.length)) next(event);
    }
  };
}

function readJsonLines(source: DataSource, consume: (message: Record<string, unknown>) => void): void {
  let buffer = "";
  source.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isRuntimeProtocolRecord(value)) consume(value);
      } catch {
        // Protocol adapters only consume complete structured messages.
      }
    }
  });
}

function nestedString(record: Record<string, unknown>, path: ReadonlyArray<string>): string | undefined {
  let value: unknown = record;
  for (const key of path) {
    if (!isRuntimeProtocolRecord(value)) return undefined;
    value = value[key];
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRuntimeProtocolRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

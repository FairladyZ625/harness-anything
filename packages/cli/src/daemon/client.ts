import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  currentDaemonProtocolVersion,
  defaultUnixSocketPath,
  encodeJsonLineFrame,
  type JsonObject,
  type JsonRpcRequest,
  type JsonRpcResponse
} from "../../../daemon/src/index.ts";
import { CliErrorCode, cliError } from "../cli/error-codes.ts";
import type { CommandFailureReceipt, CommandReceipt } from "../cli/receipt.ts";
import { toCommandReceipt } from "../cli/receipt.ts";
import type { ParsedCommand } from "../cli/types.ts";
import { isPlainRecord, parsePositiveIntegerOr } from "../cli/value-utils.ts";

const defaultAutostartTimeoutMs = 6_000;
const defaultIdleExitMs = 750;

export type DaemonClientMode = "direct" | "local" | "remote";

export interface DaemonClientConfig {
  readonly mode: DaemonClientMode;
  readonly idleExitMs: number;
  readonly autostartTimeoutMs: number;
  readonly remote?: RemoteDaemonConfig;
}

export interface RemoteDaemonConfig {
  readonly host: string;
  readonly remoteHaPath: string;
  readonly remoteRoot: string;
  readonly repoId: string;
}

export function readDaemonClientConfig(env: NodeJS.ProcessEnv = process.env): DaemonClientConfig {
  const mode = readMode(env.HARNESS_DAEMON_MODE);
  return {
    mode,
    idleExitMs: parsePositiveIntegerOr(env.HARNESS_DAEMON_IDLE_MS, defaultIdleExitMs),
    autostartTimeoutMs: parsePositiveIntegerOr(env.HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS, defaultAutostartTimeoutMs),
    ...(mode === "remote" ? { remote: readRemoteConfig(env) } : {})
  };
}

export async function runCommandThroughDaemon(
  command: ParsedCommand,
  config: DaemonClientConfig = readDaemonClientConfig()
): Promise<CommandReceipt | CommandFailureReceipt | undefined> {
  if (config.mode === "direct") return undefined;
  try {
    return config.mode === "remote" && config.remote
      ? await runRemoteCommand(command, config.remote)
      : await runLocalCommand(command, config);
  } catch (error) {
    return daemonUnavailableReceipt(command, error);
  }
}

export function daemonIdForRoot(rootDir: string): string {
  return `repo-${createHash("sha256").update(rootDir).digest("hex").slice(0, 16)}`;
}

export function localDaemonSocketPath(rootDir: string): string {
  return defaultUnixSocketPath(daemonIdForRoot(rootDir));
}

async function runLocalCommand(command: ParsedCommand, config: DaemonClientConfig): Promise<CommandReceipt | CommandFailureReceipt> {
  const endpoint = localDaemonSocketPath(command.rootDir);
  const deadline = Date.now() + config.autostartTimeoutMs;
  let nextSpawnAt = 0;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      const socket = await connectUnixSocket(endpoint, 200);
      return await runWithLineClient(new JsonRpcLineClient(socket, socket), command, "canonical");
    } catch (error) {
      lastError = error;
      if (Date.now() >= nextSpawnAt) {
        spawnLocalDaemon(command, endpoint, config.idleExitMs);
        nextSpawnAt = Date.now() + 500;
      }
      await delay(100);
    }
  }
  throw lastError ?? new Error("local daemon did not become reachable");
}

async function runRemoteCommand(command: ParsedCommand, remote: RemoteDaemonConfig): Promise<CommandReceipt | CommandFailureReceipt> {
  const child = spawn("ssh", [
    remote.host,
    remote.remoteHaPath,
    "daemon",
    "serve",
    "--stdio",
    "--repo",
    remote.repoId,
    "--root",
    remote.remoteRoot
  ], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const remoteCommand = {
    ...command,
    rootDir: remote.remoteRoot
  } satisfies ParsedCommand;
  return runWithLineClient(new JsonRpcLineClient(child.stdout, child.stdin, child), remoteCommand, remote.repoId);
}

async function runWithLineClient(
  client: JsonRpcLineClient,
  command: ParsedCommand,
  repoId: string
): Promise<CommandReceipt | CommandFailureReceipt> {
  try {
    await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion });
    const response = await client.request("repo.command.run", {
      repo: { repoId },
      payload: { command: command as unknown as JsonObject }
    });
    if (isCommandReceipt(response)) return response as unknown as CommandReceipt | CommandFailureReceipt;
    throw new Error("daemon command.run did not return command-receipt/v2");
  } finally {
    client.close();
  }
}

function spawnLocalDaemon(command: ParsedCommand, socketPath: string, idleExitMs: number): void {
  const child = spawn(process.execPath, [
    ...process.execArgv,
    fileURLToPath(import.meta.url).replace(/\/daemon\/client\.(ts|js)$/u, "/index.$1"),
    "--root",
    command.rootDir,
    ...(command.layoutOverrides?.authoredRoot ? ["--authored-root", command.layoutOverrides.authoredRoot] : []),
    "daemon",
    "serve",
    "--socket",
    socketPath,
    "--idle-ms",
    String(idleExitMs)
  ], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HARNESS_DAEMON_MODE: "direct"
    }
  });
  child.unref();
}

function connectUnixSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to daemon socket: ${socketPath}`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

class JsonRpcLineClient {
  private nextId = 1;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly owner?: ChildProcessWithoutNullStreams;

  constructor(input: Readable, output: Writable, owner?: ChildProcessWithoutNullStreams) {
    this.input = input;
    this.output = output;
    this.owner = owner;
  }

  async request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.nextId++;
    const responsePromise = this.readResponse(id);
    const request = { jsonrpc: "2.0", id, method, params } satisfies JsonRpcRequest;
    this.output.write(encodeJsonLineFrame(request));
    const response = await responsePromise;
    if ("error" in response) throw new Error(response.error.message);
    if (!isPlainRecord(response.result)) throw new Error(`daemon returned non-object result for ${method}`);
    return response.result as JsonObject;
  }

  close(): void {
    this.output.end();
    this.owner?.kill("SIGTERM");
  }

  private async readResponse(id: number): Promise<JsonRpcResponse> {
    const lines = createInterface({ input: this.input });
    const iterator = lines[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      if (next.done) throw new Error(`daemon closed before JSON-RPC response ${id}`);
      const response = JSON.parse(next.value) as JsonRpcResponse;
      if (response.id === id) return response;
    }
  }
}

function daemonUnavailableReceipt(command: ParsedCommand, error: unknown): CommandFailureReceipt {
  const receipt = toCommandReceipt({
    ok: false,
    command: command.action.kind,
    error: cliError(
      CliErrorCode.JournalUnavailable,
      `Daemon unavailable. Use HARNESS_DAEMON_MODE=direct to bypass local client mode, or check 'ha daemon status'. Cause: ${error instanceof Error ? error.message : String(error)}`
    )
  });
  if (receipt.ok) throw new Error("daemon unavailable receipt unexpectedly succeeded");
  return receipt;
}

function readMode(value: string | undefined): DaemonClientMode {
  if (value === "direct" || value === "local" || value === "remote") return value;
  return "direct";
}

function readRemoteConfig(env: NodeJS.ProcessEnv): RemoteDaemonConfig {
  return {
    host: requiredEnv(env, "HARNESS_DAEMON_SSH_HOST"),
    remoteHaPath: env.HARNESS_DAEMON_REMOTE_HA ?? "ha",
    remoteRoot: requiredEnv(env, "HARNESS_DAEMON_REMOTE_ROOT"),
    repoId: env.HARNESS_DAEMON_REPO_ID ?? "canonical"
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${name} is required when HARNESS_DAEMON_MODE=remote`);
}

function isCommandReceipt(value: JsonObject): boolean {
  return value.schema === "command-receipt/v2" && typeof value.ok === "boolean" && typeof value.command === "string";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

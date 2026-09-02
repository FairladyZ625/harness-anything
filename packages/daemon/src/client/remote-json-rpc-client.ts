import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Duplex, type Readable } from "node:stream";
import { isContractVersionCompatible } from "../../../kernel/src/domain/contract-version.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import { currentDaemonProtocolVersion } from "../protocol/version.ts";
import { JsonRpcLineClient } from "./local-json-rpc-client.ts";

export type RemoteDaemonTransportErrorCode =
  | "ssh_not_found"
  | "ssh_spawn_failed"
  | "ssh_auth_failed"
  | "ssh_host_key_failed"
  | "ssh_connection_failed"
  | "remote_daemon_closed"
  | "remote_daemon_timeout"
  | "remote_daemon_protocol_mismatch"
  | "remote_daemon_unavailable";

export interface RemoteDaemonSshOptions {
  /** The local endpoint exposed by any user-managed tunnel service. */
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly identityFile?: string;
  readonly hostKeyAlias?: string;
  /** Use an existing OpenSSH config host when credentials are configured there. */
  readonly sshConfigHost?: string;
  readonly sshCommand?: string;
  readonly remoteCommand?: readonly string[];
  readonly connectTimeoutMs?: number;
  readonly serverAliveIntervalSeconds?: number;
  readonly serverAliveCountMax?: number;
}

export interface RemoteDaemonConnection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly request: (method: string, params: JsonObject, timeoutMs?: number) => Promise<JsonObject>;
  readonly close: () => Promise<void>;
}

export async function requestRemoteDaemonJsonRpc(
  options: RemoteDaemonSshOptions,
  method: string,
  params: JsonObject,
  timeoutMs?: number,
): Promise<JsonObject> {
  const connection = await openRemoteDaemonConnection(options);
  try {
    return await connection.request(method, params, timeoutMs);
  } finally {
    await connection.close();
  }
}

/** Open an SSH-backed byte stream for long-lived daemon facets. JSON-RPC framing
 * remains owned by the shared stream client; this is only a Duplex adapter over
 * ssh stdin/stdout.
 */
export async function openRemoteDaemonStream(options: RemoteDaemonSshOptions): Promise<Duplex> {
  const child = spawn(options.sshCommand ?? "ssh", buildSshArgs(options), {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr = captureStderr(child.stderr);
  let spawned = false;
  child.once("spawn", () => {
    spawned = true;
  });
  const stream = new Duplex({
    read: () => undefined,
    write: (chunk, encoding, callback) => {
      if (child.stdin.destroyed) {
        callback(new Error("SSH stdin is closed."));
        return;
      }
      const accepted = child.stdin.write(chunk, encoding);
      if (accepted) callback();
      else child.stdin.once("drain", callback);
    },
    final: (callback) => {
      child.stdin.end();
      callback();
    },
    destroy: (error, callback) => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      callback(error);
    },
  });
  child.stdout.on("data", (chunk: Buffer) => stream.push(chunk));
  child.stdout.once("end", () => stream.push(null));
  child.once("close", (code) => {
    if (stream.destroyed) return;
    if (code !== 0 && spawned) {
      const failure = new RemoteDaemonTransportError(
        "ssh_connection_failed",
        withStderr(`SSH exited with code ${code}.`, stderr()),
      );
      // Let the stream consumer install its error/close listeners first.
      setImmediate(() => {
        if (!stream.destroyed) stream.destroy(failure);
      });
      return;
    }
    stream.push(null);
    stream.destroy();
  });
  try {
    await waitForSpawn(child);
  } catch (error) {
    stream.destroy();
    throw classifySpawnError(error);
  }
  // `streamDaemonFacetAt` installs its listeners after this promise resolves.
  // A microtask here would run first and lose the synthetic connect event; a
  // macrotask gives the consumer a chance to attach its handshake listener.
  setImmediate(() => {
    if (!stream.destroyed && child.exitCode === null && child.signalCode === null) stream.emit("connect");
  });
  return stream;
}

export class RemoteDaemonTransportError extends Error {
  readonly code: RemoteDaemonTransportErrorCode;

  constructor(code: RemoteDaemonTransportErrorCode, message: string) {
    super(message);
    this.name = "RemoteDaemonTransportError";
    this.code = code;
  }
}

export async function openRemoteDaemonConnection(options: RemoteDaemonSshOptions): Promise<RemoteDaemonConnection> {
  const child = spawn(options.sshCommand ?? "ssh", buildSshArgs(options), {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const readStderr = captureStderr(child.stderr);
  try {
    await waitForSpawn(child);
  } catch (error) {
    await terminate(child);
    throw classifySpawnError(error);
  }

  const rpc = new JsonRpcLineClient(child.stdout, child.stdin);
  try {
    const hello = await requestWithTimeout(
      rpc,
      "protocol.hello",
      { protocolVersion: currentDaemonProtocolVersion },
      options.connectTimeoutMs ?? 10_000,
    );
    if (hello.ok !== true || !isContractVersionCompatible(hello.protocolVersion, currentDaemonProtocolVersion)) {
      const code =
        hello.code === "incompatible_protocol_version" || hello.ok === true
          ? "remote_daemon_protocol_mismatch"
          : "remote_daemon_unavailable";
      throw new RemoteDaemonTransportError(
        code,
        String(
          hello.hint ??
            hello.nextAction ??
            (hello.ok === true
              ? "Remote daemon reported an incompatible protocol version."
              : "Remote daemon rejected protocol.hello."),
        ),
      );
    }
    return {
      child,
      request: (method, params, timeoutMs) =>
        timeoutMs === undefined ? rpc.request(method, params) : requestWithTimeout(rpc, method, params, timeoutMs),
      close: async () => {
        rpc.close();
        await terminate(child);
      },
    };
  } catch (error) {
    rpc.close();
    await terminate(child);
    if (error instanceof RemoteDaemonTransportError) throw error;
    throw classifyRemoteError(error, readStderr());
  }
}

function captureStderr(stderr: Readable): () => string {
  let value = "";
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    value = `${value}${chunk}`.slice(-4_096);
  });
  return () => value;
}

function requestWithTimeout(
  rpc: JsonRpcLineClient,
  method: string,
  params: JsonObject,
  timeoutMs: number,
): Promise<JsonObject> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error(`the remote daemon did not answer ${method} within ${timeoutMs}ms`), {
            code: "daemon_response_timeout",
          }),
        ),
      timeoutMs,
    );
  });
  return Promise.race([rpc.request(method, params), deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function buildSshArgs(options: RemoteDaemonSshOptions): string[] {
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `ConnectTimeout=${Math.max(1, Math.ceil((options.connectTimeoutMs ?? 10_000) / 1_000))}`,
    "-o",
    `ServerAliveInterval=${Math.max(1, options.serverAliveIntervalSeconds ?? 30)}`,
    "-o",
    `ServerAliveCountMax=${Math.max(1, options.serverAliveCountMax ?? 3)}`,
  ];
  if (options.hostKeyAlias) args.push("-o", `HostKeyAlias=${options.hostKeyAlias}`);
  if (options.identityFile) args.push("-o", "IdentitiesOnly=yes", "-i", options.identityFile);
  if ((options.port ?? 0) > 0) args.push("-p", String(options.port));
  const target = options.sshConfigHost ?? `${options.user ? `${options.user}@` : ""}${options.host ?? ""}`;
  if (!target) throw new Error("SSH transport requires a config alias or host.");
  args.push(target);
  args.push(...(options.remoteCommand ?? ["ha", "daemon", "connect", "--stdio"]));
  return args;
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    timer.unref?.();
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function classifySpawnError(error: unknown): RemoteDaemonTransportError {
  if (isCode(error, "ENOENT")) return new RemoteDaemonTransportError("ssh_not_found", "OpenSSH client was not found.");
  return new RemoteDaemonTransportError("ssh_spawn_failed", errorMessage(error));
}

export function classifyRemoteError(error: unknown, stderr: string): RemoteDaemonTransportError {
  if (isCode(error, "daemon_response_timeout"))
    return new RemoteDaemonTransportError("remote_daemon_timeout", errorMessage(error));

  // SSH commonly reports transport failures by closing stdout before the JSON-RPC
  // handshake completes. Inspect stderr before treating that EOF as a clean daemon
  // close, otherwise host-key, auth, and network failures all collapse to one code.
  const message = withStderr(errorMessage(error), stderr);
  if (/host key|known_hosts|authenticity/iu.test(message))
    return new RemoteDaemonTransportError("ssh_host_key_failed", message);
  if (/permission denied|authentication failed|no such identity file|identity file .* type -1/iu.test(message))
    return new RemoteDaemonTransportError("ssh_auth_failed", message);
  if (/connection timed out|connection refused|could not resolve|no route|banner exchange/iu.test(message))
    return new RemoteDaemonTransportError("ssh_connection_failed", message);
  if (/daemon stdio bridge could not connect|command not found|no such file or directory/iu.test(message))
    return new RemoteDaemonTransportError("remote_daemon_unavailable", message);
  if (isCode(error, "daemon_closed")) return new RemoteDaemonTransportError("remote_daemon_closed", message);
  return new RemoteDaemonTransportError("remote_daemon_unavailable", message);
}

function withStderr(message: string, stderr: string): string {
  const detail = stderr.trim();
  return detail.length > 0 ? `${message} ${detail}` : message;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

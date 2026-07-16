import { spawn, type ChildProcess } from "node:child_process";
import type net from "node:net";
import { createAcceptedConnectionEvidence } from "./accepted-connection-evidence.ts";
import type {
  AcceptedConnectionEvidenceAdapter,
  DaemonTransportKind,
  OsPeerCredentialEvidence
} from "./auth-context.ts";

const darwinRubyProgram = [
  "uid, gid = Socket.for_fd(3).getpeereid",
  "STDOUT.write(uid.to_s)",
  "STDOUT.write(\"\\n\")",
  "STDOUT.write(gid.to_s)",
  "STDOUT.write(\"\\n\")"
].join("; ");

export interface NodeSocketAcceptedConnectionEvidenceAdapterOptions {
  readonly platform?: NodeJS.Platform;
  readonly transportKind?: Extract<DaemonTransportKind, "unix-socket" | "named-pipe">;
  readonly darwinRubyPath?: string;
  readonly observationTimeoutMs?: number;
  readonly serverRandom?: () => Uint8Array;
}

export function createNodeSocketAcceptedConnectionEvidenceAdapter(
  options: NodeSocketAcceptedConnectionEvidenceAdapterOptions = {}
): AcceptedConnectionEvidenceAdapter<net.Socket> {
  const platform = options.platform ?? process.platform;
  const transportKind = options.transportKind ?? "unix-socket";
  return {
    observeAcceptedConnection: async (input) => createAcceptedConnectionEvidence({
      connectionId: input.connectionId,
      connectionGeneration: input.connectionGeneration,
      daemonInstanceId: input.daemonInstanceId,
      transportKind,
      peerCredential: await observeNodeSocketPeerCredential(input.socket, {
        platform,
        darwinRubyPath: options.darwinRubyPath,
        observationTimeoutMs: options.observationTimeoutMs
      }),
      ...(input.compatibilityBoundary ? { compatibilityBoundary: input.compatibilityBoundary } : {}),
      ...(options.serverRandom ? { serverRandom: options.serverRandom() } : {})
    })
  };
}

export async function observeNodeSocketPeerCredential(
  socket: net.Socket,
  options: Pick<
    NodeSocketAcceptedConnectionEvidenceAdapterOptions,
    "platform" | "darwinRubyPath" | "observationTimeoutMs"
  > = {}
): Promise<OsPeerCredentialEvidence> {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return observeDarwinGetpeereid(
      socket,
      options.darwinRubyPath ?? "/usr/bin/ruby",
      options.observationTimeoutMs ?? 2_000
    );
  }
  return unavailablePeerCredential(platform === "linux" ? "observation_failed" : "platform_unsupported");
}

async function observeDarwinGetpeereid(
  socket: net.Socket,
  rubyPath: string,
  timeout: number
): Promise<OsPeerCredentialEvidence> {
  try {
    // Node's Pipe handle has no peer-credential API. Passing this accepted
    // socket as fd 3 lets the Darwin system Ruby call getpeereid(2) on the
    // same socket without a shell, client payload, addon, or package dependency.
    const child = spawn(rubyPath, ["-rsocket", "-e", darwinRubyProgram], {
      env: { LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe", socket],
      timeout
    });
    const output = await readCredentialOutput(child);
    // Child stdio marks the parent stream paused; let child cleanup finish.
    // The JSON-RPC stream installs its listeners and resumes it afterwards.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!output) return unavailablePeerCredential("observation_failed");
    const [uid, gid] = output;
    return {
      available: true,
      value: {
        schema: "os-observed-peer-credential/v1",
        platform: "darwin",
        source: "getpeereid",
        uid,
        gid
      }
    };
  } catch {
    return unavailablePeerCredential("observation_failed");
  }
}

async function readCredentialOutput(child: ChildProcess): Promise<readonly [number, number] | undefined> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const settle = (value: readonly [number, number] | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 128) child.kill();
    });
    child.once("error", () => settle(undefined));
    child.once("close", (code) => {
      if (code !== 0) return settle(undefined);
      const lines = stdout.trim().split("\n");
      if (lines.length !== 2) return settle(undefined);
      const uid = Number(lines[0]);
      const gid = Number(lines[1]);
      settle(isNonNegativeSafeInteger(uid) && isNonNegativeSafeInteger(gid) ? [uid, gid] : undefined);
    });
  });
}

function unavailablePeerCredential(
  code: "platform_unsupported" | "observation_failed"
): OsPeerCredentialEvidence {
  return { available: false, code, source: "os-peer-credential-adapter" };
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

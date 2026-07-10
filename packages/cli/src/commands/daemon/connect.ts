import net from "node:net";
import type { Readable, Writable } from "node:stream";
import {
  daemonIdFromEnv,
  daemonUserRoot,
  localUserDaemonEndpoint
} from "../../../../daemon/src/index.ts";
import { readOption } from "../../cli/parse-options.ts";

export interface DaemonConnectStreams {
  readonly input: Readable;
  readonly output: Writable;
  readonly error: Writable;
}

export async function runDaemonConnect(
  args: ReadonlyArray<string>,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly streams?: DaemonConnectStreams;
  } = {}
): Promise<number> {
  const streams = options.streams ?? { input: process.stdin, output: process.stdout, error: process.stderr };
  if (args.includes("--help") || args.includes("-h")) {
    streams.output.write(`${renderDaemonConnectHelp()}\n`);
    return 0;
  }
  if (!args.includes("--stdio")) {
    streams.error.write("daemon connect requires --stdio; stdout is reserved for relayed daemon bytes.\n");
    return 2;
  }

  const env = options.env ?? process.env;
  const userRoot = readOption(args, "--user-root") ?? daemonUserRoot(env);
  const endpoint = readOption(args, "--socket")
    ?? localUserDaemonEndpoint(userRoot, daemonIdFromEnv(env), options.platform ?? process.platform);
  try {
    await connectDaemonStdio(endpoint, streams.input, streams.output);
    return 0;
  } catch (error) {
    streams.error.write(
      `No persistent daemon is listening at ${endpoint}. Start it with 'ha daemon start --service' and verify 'ha daemon status'. Cause: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
}

export async function connectDaemonStdio(endpoint: string, input: Readable, output: Writable): Promise<void> {
  const socket = await openDaemonEndpoint(endpoint);
  await relayDaemonStreams(socket, input, output);
}

function openDaemonEndpoint(endpoint: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const fail = (error: Error) => reject(error);
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.off("error", fail);
      resolve(socket);
    });
  });
}

function relayDaemonStreams(socket: net.Socket, input: Readable, output: Writable): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", fail);
    input.once("error", fail);
    output.once("error", fail);
    socket.once("close", () => resolve());
    input.pipe(socket);
    socket.pipe(output, { end: false });
  }).finally(() => {
    input.unpipe(socket);
    socket.unpipe(output);
  });
}

function renderDaemonConnectHelp(): string {
  return [
    "Usage: ha daemon connect --stdio [--socket <endpoint>] [--user-root <path>]",
    "",
    "Relay stdin/stdout to an already-running local daemon without creating a runtime."
  ].join("\n");
}

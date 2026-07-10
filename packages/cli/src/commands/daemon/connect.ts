import net from "node:net";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  daemonIdFromEnv,
  daemonUserRoot,
  encodeJsonLineFrame,
  localUserDaemonEndpoint,
  sshForcedCommandBootstrapFrame,
  type SshForcedCommandBootstrapInput
} from "../../../../daemon/src/index.ts";
import { readOption } from "../../cli/parse-options.ts";
import { verifyCurrentProcessHasPrivilegedSshdAncestor } from "./sshd-witness.ts";

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
    readonly rootDir?: string;
    readonly streams?: DaemonConnectStreams;
    readonly verifySshdContext?: () => boolean;
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
  let authentication: SshForcedCommandBootstrapInput | undefined;
  try {
    authentication = resolveSshForcedCommandAuthentication({
      args,
      rootDir: options.rootDir,
      env,
      verifySshdContext: options.verifySshdContext
    });
  } catch (error) {
    streams.error.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const userRoot = readOption(args, "--user-root") ?? daemonUserRoot(env);
  const endpoint = readOption(args, "--socket")
    ?? localUserDaemonEndpoint(userRoot, daemonIdFromEnv(env), options.platform ?? process.platform);
  try {
    await connectDaemonStdio(endpoint, streams.input, streams.output, authentication);
    return 0;
  } catch (error) {
    streams.error.write(
      `No persistent daemon is listening at ${endpoint}. Start it with 'ha daemon start --service' and verify 'ha daemon status'. Cause: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
}

export async function connectDaemonStdio(
  endpoint: string,
  input: Readable,
  output: Writable,
  authentication?: SshForcedCommandBootstrapInput
): Promise<void> {
  const socket = await openDaemonEndpoint(endpoint);
  if (authentication) socket.write(encodeJsonLineFrame(sshForcedCommandBootstrapFrame(authentication)));
  await relayDaemonStreams(socket, input, output);
}

export function resolveSshForcedCommandAuthentication(input: {
  readonly args: ReadonlyArray<string>;
  readonly rootDir?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly verifySshdContext?: () => boolean;
}): SshForcedCommandBootstrapInput | undefined {
  const personId = readOption(input.args, "--principal");
  const expectedOriginalCommand = readOption(input.args, "--expect-original-command");
  const originalCommand = nonEmpty(input.env.SSH_ORIGINAL_COMMAND);
  const hasForcedOptions = input.args.includes("--principal") || input.args.includes("--expect-original-command");

  if (!hasForcedOptions && !originalCommand) return undefined;
  if (!personId || personId.startsWith("--") || !expectedOriginalCommand || expectedOriginalCommand.startsWith("--") || !input.rootDir) {
    throw forcedCommandConfigurationError();
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(personId)) {
    throw new Error("SSH forced-command principal must use a stable personId containing only letters, digits, dot, underscore, colon, or dash.");
  }
  if (/(?:^|\s)--(?:principal|root|expect-original-command)(?:\s|=|$)/u.test(expectedOriginalCommand)) {
    throw new Error("SSH forced-command expected original command must not contain --principal, --root, or --expect-original-command.");
  }
  if (originalCommand !== expectedOriginalCommand) {
    throw new Error(`SSH_ORIGINAL_COMMAND does not match the authorized_keys forced-command expectation. Expected ${JSON.stringify(expectedOriginalCommand)}.`);
  }
  if (!(input.verifySshdContext ?? verifyCurrentProcessHasPrivilegedSshdAncestor)()) {
    throw new Error("SSH forced-command principal rejected: the process does not have a root-owned sshd ancestor.");
  }
  return { personId, canonicalRoot: path.resolve(input.rootDir) };
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

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function forcedCommandConfigurationError(): Error {
  return new Error([
    "Remote SSH daemon connections require a principal and canonical root proven by an authorized_keys forced command.",
    "Configure each key with restrict and a static command such as:",
    "command=\"ha --root /srv/harness/team daemon connect --stdio --principal person_alice --expect-original-command 'ha daemon connect --stdio'\",restrict"
  ].join(" "));
}

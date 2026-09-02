import type { Duplex, Readable, Writable } from "node:stream";
import { connectSocket } from "../../../daemon/src/client/local-json-rpc-client.ts";

export interface DaemonStdioBridgeOptions {
  readonly socketPath: string;
  readonly timeoutMs?: number;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly connect?: (socketPath: string, timeoutMs: number) => Promise<Duplex>;
  readonly reportError?: (message: string) => void;
}

/**
 * Keep the remote transport deliberately byte-oriented. The daemon already owns
 * JSON-RPC framing and handshake semantics; this process only crosses the local
 * filesystem socket boundary and exposes the same stream over SSH stdio.
 */
export async function runDaemonStdioBridge(options: DaemonStdioBridgeOptions): Promise<number> {
  const input = options.input ?? process.stdin,
    output = options.output ?? process.stdout,
    connect = options.connect ?? connectSocket,
    reportError = options.reportError ?? ((message) => process.stderr.write(`${message}\n`));
  let socket: Duplex;
  try {
    socket = await connect(options.socketPath, options.timeoutMs ?? 10_000);
  } catch (error) {
    reportError(`daemon stdio bridge could not connect: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  let settled = false,
    inputEnded = false;
  const result = new Promise<number>((resolve) => {
    const complete = (code: number): void => {
      if (settled) return;
      settled = true;
      input.pause();
      if (output !== process.stdout && !output.destroyed && !output.writableEnded) output.end();
      if (!socket.destroyed) socket.destroy();
      resolve(code);
    };
    input.on("data", (chunk: Buffer | string) => {
      if (!socket.write(chunk)) input.pause();
    });
    input.on("end", () => {
      inputEnded = true;
      socket.end();
    });
    input.on("error", (error) => {
      reportError(`daemon stdio bridge input failed: ${error.message}`);
      complete(1);
    });
    socket.on("drain", () => input.resume());
    socket.on("data", (chunk: Buffer | string) => {
      if (!output.write(chunk)) socket.pause();
    });
    output.on("drain", () => socket.resume());
    socket.on("end", () => {
      if (!inputEnded) reportError("daemon stdio bridge remote socket ended unexpectedly.");
    });
    socket.on("close", () => complete(inputEnded ? 0 : 1));
    socket.on("error", (error) => {
      reportError(`daemon stdio bridge socket failed: ${error.message}`);
      complete(1);
    });
  });
  return result;
}

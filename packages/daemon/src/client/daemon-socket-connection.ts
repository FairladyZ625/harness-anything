import net from "node:net";
import { daemonSocketNamespaceError } from "../transport/daemon-socket-namespace.ts";

export function connectUnixSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
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

export async function connectUnixSocketWithLegacyFallback(
  socketPath: string,
  legacySocketPath: string | undefined,
  timeoutMs: number
): Promise<net.Socket> {
  try {
    return await connectUnixSocket(socketPath, timeoutMs);
  } catch (error) {
    if (!legacySocketPath || legacySocketPath === socketPath) throw daemonSocketNamespaceError(socketPath, error);
    try {
      return await connectUnixSocket(legacySocketPath, timeoutMs);
    } catch (legacyError) {
      throw daemonSocketNamespaceError(legacySocketPath, legacyError);
    }
  }
}

export async function connectUnixSocketWithNamespaceDiagnostic(
  socketPath: string,
  timeoutMs: number
): Promise<net.Socket> {
  try {
    return await connectUnixSocket(socketPath, timeoutMs);
  } catch (error) {
    throw daemonSocketNamespaceError(socketPath, error);
  }
}

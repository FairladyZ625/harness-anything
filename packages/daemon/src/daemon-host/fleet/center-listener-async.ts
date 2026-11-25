import type { AddressInfo } from "node:net";
import type { Server, TLSSocket } from "node:tls";

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function bindTlsServer(server: Server, port: number, hostname: string): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fleet TLS server did not bind a TCP port");
  return address;
}

export async function closeFleetListenerResources(input: {
  readonly server: Server;
  readonly closing: AbortController;
  readonly backupBuildQueue: { readonly close: () => Promise<void> };
  readonly connections: ReadonlySet<TLSSocket>;
  readonly sessions: Map<string, Set<TLSSocket>>;
  readonly drainAndCloseWriterEpochs: () => Promise<void>;
  readonly replicationSlots: { readonly close: () => void };
}): Promise<void> {
  input.closing.abort();
  const backupsClosed = input.backupBuildQueue.close();
  // `server.close` only resolves once every accepted socket is gone, and an edge keeps replica
  // sessions open between pulls, so none of them ends on its own. Cut every socket this listener
  // accepted — not just the hello-registered ones — or a peer that never reached its hello holds
  // close() open for as long as it stays connected.
  const drained = input.server.listening
    ? new Promise<void>((resolve, reject) => input.server.close((error) => (error ? reject(error) : resolve())))
    : Promise.resolve();
  for (const socket of input.connections) socket.destroy();
  input.sessions.clear();
  await Promise.all([drained, backupsClosed]);
  try {
    await input.drainAndCloseWriterEpochs();
  } finally {
    input.replicationSlots.close();
  }
}

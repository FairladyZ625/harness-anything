import net from "node:net";

const socketShutdownGraceMs = 1_000;

export async function gracefullyCloseSocketServer(
  server: net.Server,
  sockets: ReadonlySet<net.Socket>
): Promise<void> {
  const serverClosed = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const openSockets = [...sockets].filter((socket) => !socket.destroyed);
  const socketsClosed = Promise.all(openSockets.map(waitForSocketClose));

  for (const socket of openSockets) socket.end();
  const closedWithinGrace = await settlesWithin(socketsClosed, socketShutdownGraceMs);
  if (!closedWithinGrace) {
    for (const socket of openSockets) {
      if (!socket.destroyed) socket.destroy();
    }
  }
  await serverClosed;
}

function waitForSocketClose(socket: net.Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", resolve));
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

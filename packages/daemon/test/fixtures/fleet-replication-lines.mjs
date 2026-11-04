/** The test edge can be writing an object when close arrives, with no read waiting yet. */
export function replicationSocketLines(socket) {
  let buffer = "",
    closed = null;
  const lines = [],
    waiters = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line);
      else lines.push(line);
    }
  });
  socket.once("close", () => {
    closed = new Error("replication socket closed");
    for (const waiter of waiters.splice(0)) waiter.reject(closed);
  });
  return () => {
    if (lines.length) return Promise.resolve(lines.shift());
    if (closed) return Promise.reject(closed);
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
}

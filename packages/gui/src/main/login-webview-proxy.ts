import { connect, createServer, type Server } from "node:net";

/**
 * Keeps the browser origin separate from the loopback SSH reverse-forward target. CONNECT is the
 * only supported proxy operation and the upstream target is fixed from signed edge configuration.
 */
export async function openLoginProxy(targetUrl: string, browserOrigin: string): Promise<Server> {
  const target = new URL(targetUrl),
    targetPort = Number(target.port || 443),
    targetHost = target.hostname,
    browser = new URL(browserOrigin);
  if (browser.protocol !== "https:") throw new Error("The login browser origin must use HTTPS.");
  const expectedAuthority = browser.host;
  const proxy = createServer((client) => {
    let header = Buffer.alloc(0);
    const reject = () => {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    };
    const onData = (chunk: Buffer): void => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) {
        if (header.length > 16 * 1024) reject();
        return;
      }
      client.off("data", onData);
      const first = header.subarray(0, end).toString("latin1").split("\r\n", 1)[0] ?? "",
        match = /^CONNECT\s+([^\s]+)\s+HTTP\/1\.[01]$/u.exec(first);
      if (!match || match[1] !== expectedAuthority) {
        reject();
        return;
      }
      const upstream = connect(targetPort, targetHost);
      upstream.once("error", () => client.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream).pipe(client);
      });
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => resolve());
  });
  return proxy;
}

export async function closeLoginProxy(proxy: Server | null): Promise<void> {
  if (!proxy) return;
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}

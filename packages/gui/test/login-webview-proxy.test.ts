// harness-test-tier: fast
import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import test from "node:test";
import { closeLoginProxy, openLoginProxy } from "../src/main/login-webview-proxy.ts";

test("the login proxy accepts only the issuer CONNECT authority and forwards to its loopback target", async () => {
  let upstreamConnections = 0;
  const upstream = createServer(() => {
      upstreamConnections += 1;
    }),
    listening = new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
  await listening;
  const target = upstream.address();
  assert.ok(target && typeof target !== "string");
  const proxy = await openLoginProxy(`https://127.0.0.1:${target.port}`, "https://center.example:8443"),
    address = proxy.address();
  assert.ok(address && typeof address !== "string");
  try {
    assert.match(await connectThrough(address.port, "center.example:8443"), /^HTTP\/1\.1 200 /u);
    assert.equal(upstreamConnections, 1);
    assert.match(await connectThrough(address.port, "other.example:8443"), /^HTTP\/1\.1 403 /u);
    assert.equal(upstreamConnections, 1);
  } finally {
    await closeLoginProxy(proxy);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

function connectThrough(proxyPort: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = connect(proxyPort, "127.0.0.1");
    let response = Buffer.alloc(0);
    client.once("error", reject);
    client.once("connect", () => client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    client.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      const end = response.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.destroy();
      resolve(response.subarray(0, end).toString("latin1"));
    });
  });
}

// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startBrowserGuiBroker } from "../src/cli/gui-browser-broker.ts";

test("browser GUI broker opens on exact loopback and rejects cross-origin RPC", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-browser-broker-"));
  mkdirSync(path.join(root, "packages/gui/dist"), { recursive: true });
  writeFileSync(path.join(root, "packages/gui/dist/index.html"), "<!doctype html><title>GUI</title>");
  const broker = await startBrowserGuiBroker(root, root);
  try {
    const url = new URL(broker.url),
      token = new URLSearchParams(url.hash.slice(1)).get("access_token");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(Buffer.from(token!, "base64url").length, 32);
    assert.equal((await call(url, "/")).headers["content-security-policy"]?.includes("default-src 'self'"), true);
    assert.equal((await call(url, "/rpc", { method: "POST" })).status, 403);
    assert.equal(
      (await call(url, "/rpc", { method: "POST", token: token!, origin: "http://example.test" })).status,
      403,
    );
    assert.equal(
      (await call(url, "/rpc", { method: "POST", token: token!, host: `localhost:${url.port}` })).status,
      403,
    );
    const admitted = await call(url, "/rpc", { method: "POST", token: token!, origin: url.origin });
    assert.equal(admitted.status, 502, "valid auth reaches the isolated missing-daemon boundary");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function call(
  url: URL,
  pathname: string,
  options: { method?: string; token?: string; origin?: string; host?: string } = {},
) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const body = JSON.stringify({ method: "repo.tasks.list", params: { repo: { repoId: "canonical" } } });
    const outgoing = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: pathname,
        method: options.method ?? "GET",
        headers: {
          Host: options.host ?? url.host,
          ...(options.origin ? { Origin: options.origin } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" } : {}),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers }));
      },
    );
    outgoing.on("error", reject);
    if (options.method === "POST") outgoing.write(body);
    outgoing.end();
  });
}

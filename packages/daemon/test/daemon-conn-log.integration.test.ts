// harness-test-tier: integration
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { daemonConnLogFileStem } from "../src/conn-log.ts";
import { startDaemon } from "../src/runtime.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";

interface ConnRecord { readonly event: string; readonly conn?: string; readonly method?: string | null; readonly ok?: boolean; readonly code?: string | null; readonly active?: number; readonly requests?: number }

function tempRoot(): string { return mkdtempSync(path.join(os.tmpdir(), "harness-daemon-conn-")); }

// One socket, several frames, half-closed as soon as every response arrived — the same shape a
// short-lived CLI client produces (connect, hello, command, close).
async function session(endpoint: string, frames: readonly string[]): Promise<readonly string[]> {
  return await new Promise((resolve, reject) => {
    const socket = net.connect(endpoint), lines: string[] = [];
    socket.on("connect", () => { for (const frame of frames) socket.write(`${frame}\n`); });
    socket.on("data", (chunk: Buffer) => {
      lines.push(...chunk.toString().split("\n").filter((line) => line.length > 0));
      if (lines.length >= frames.length) socket.end();
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(lines));
  });
}

test("a live daemon logs hello, dispatched requests, rejections, and connection open/close per socket", async () => {
  const userRoot = tempRoot(), daemon = await startDaemon({ daemonId: "connlog", userRoot });
  assert.ok(!("pid" in daemon), "no incumbent daemon can hold a claim over a fresh temp user root");
  try {
    const hello = { jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } };
    const first = await session(daemon.endpoint, [JSON.stringify(hello), JSON.stringify({ jsonrpc: "2.0", id: 2, method: "daemon.status" }), JSON.stringify({ jsonrpc: "2.0", id: 3, method: "no.such.method" })]);
    assert.equal(first.length, 3);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await session(daemon.endpoint, [JSON.stringify(hello)]);
    assert.equal(second.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await daemon.stop();
    const dir = path.join(userRoot, "logs"), day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const file = readdirSync(dir).find((name) => name === `${daemonConnLogFileStem("connlog")}${day}.jsonl`);
    assert.ok(file, `conn log file for today exists among ${readdirSync(dir).join(", ")}`);
    const records = readFileSync(path.join(dir, file!), "utf8").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as ConnRecord);
    assert.deepEqual(records.filter((record) => record.event === "conn_open").map((record) => record.conn), ["c-1", "c-2"]);
    const firstRequests = records.filter((record) => record.event === "request" && record.conn === "c-1");
    assert.deepEqual(firstRequests.map((record) => record.method), ["protocol.hello", "daemon.status", "no.such.method"]);
    assert.deepEqual(firstRequests.map((record) => record.ok), [true, true, false]);
    assert.equal((firstRequests.at(-1) as ConnRecord).code, "-32601");
    const closes = records.filter((record) => record.event === "conn_close");
    assert.deepEqual(closes.map((record) => record.conn), ["c-1", "c-2"]);
    // Sequential sessions: each socket is fully closed before the next dials in, so the count
    // drains to zero at every close; the unit suite covers the overlapping-connection shape.
    assert.equal((closes[0] as ConnRecord).requests, 3); assert.equal((closes[0] as ConnRecord).active, 0);
    assert.equal((closes[1] as ConnRecord).requests, 1); assert.equal((closes[1] as ConnRecord).active, 0);
  } finally {
    await daemon.stop();
    rmSync(userRoot, { recursive: true, force: true });
  }
});

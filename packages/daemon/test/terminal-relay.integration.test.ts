// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { relayDaemonTerminal } from "../src/client/terminal-relay.ts";

test("terminal relay shares one control connection for resize, input, and exit lookup", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-terminal-relay-")),
    socketPath = path.join(parent, "daemon.sock"),
    stdin = new PassThrough() as PassThrough & { setRawMode: (mode: boolean) => void };
  let connections = 0,
    hellos = 0,
    streamSocket: net.Socket | undefined,
    inputSeen!: () => void;
  const input = new Promise<void>((resolve) => {
      inputSeen = resolve;
    }),
    server = net.createServer((socket) => {
      connections += 1;
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += String(chunk);
        for (;;) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) break;
          const request = JSON.parse(buffered.slice(0, newline)) as { id: number; method: string };
          buffered = buffered.slice(newline + 1);
          if (request.method === "protocol.hello") {
            hellos += 1;
            reply(socket, request.id, { ok: true });
          } else if (request.method === "repo.terminal.attach") {
            streamSocket = socket;
            reply(socket, request.id, {
              schema: "terminal-attach/v1",
              ok: true,
              sessionId: "session-1",
              attachmentId: "attachment-1",
              daemonGeneration: 1,
              status: "attached",
              replayFromSeq: 1,
              outputSeq: 0,
            });
          } else if (request.method === "repo.terminal.input") {
            reply(socket, request.id, { ok: true });
            inputSeen();
          } else if (request.method === "repo.terminal.sessions.list")
            reply(socket, request.id, { sessions: [{ sessionId: "session-1", exitCode: 0 }] });
          else reply(socket, request.id, { ok: true });
        }
      });
    });
  stdin.setRawMode = () => undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const relay = relayDaemonTerminal({
      socketPath,
      repoId: "repo-1",
      sessionId: "session-1",
      write: () => undefined,
      stdin,
    });
    await waitFor(() => streamSocket !== undefined);
    stdin.write("x");
    await input;
    streamSocket!.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "repo.terminal.attach.frame",
        params: {
          schema: "terminal-attach-event/v1",
          sessionId: "session-1",
          seq: 1,
          kind: "exit",
          utf8: "",
          droppedThrough: null,
          occurredAt: "2026-09-12T00:00:00.000Z",
        },
      })}\n`,
    );
    assert.equal(await relay, 0);
    assert.equal(connections, 2, "the stream and all control calls must use one socket each");
    assert.equal(hellos, 2, "the relay must send one hello for its stream and one for its control connection");
  } finally {
    stdin.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(parent, { recursive: true, force: true });
  }
});

function reply(socket: net.Socket, id: number, result: Record<string, unknown>): void {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (const deadline = Date.now() + 2_000; Date.now() < deadline; ) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("terminal relay did not attach");
}

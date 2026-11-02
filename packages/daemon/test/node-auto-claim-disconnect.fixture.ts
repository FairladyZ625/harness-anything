// Drive close/drain from the ready write, never from a wall-clock delay.
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { setImmediate } from "node:timers/promises";
import type { TLSSocket } from "node:tls";
import { serve } from "../src/fleet/center-transport.ts";
import { currentFleetProtocolVersion, parseFleetFrame, serializeFleetFrame } from "../src/fleet/command-protocol.ts";
import type { FleetCenterOptions } from "../src/fleet/center-types.ts";

const mode = process.argv[2];
assert.ok(mode === "drain" || mode === "close" || mode === "error-close" || mode === "error-write");

class Socket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  bytesWritten = 0;
  remoteAddress = "127.0.0.1";
  writes = 0;
  readonly written = Promise.withResolvers<void>();
  setKeepAlive() {}
  write(line: string) {
    const frame = parseFleetFrame(line);
    assert.equal(frame.schema, mode.startsWith("error-") ? "fleet.error/v1" : "fleet.session.ready/v1");
    if (frame.schema === "fleet.error/v1") assert.equal(frame.code, "authentication_failed");
    this.writes += 1;
    this.written.resolve();
    if (mode === "error-write") throw new Error("fixture error reply failure");
    globalThis.setImmediate(() => {
      if (mode === "drain") this.emit("drain");
      else this.destroy();
    });
    return false;
  }
  end() {
    this.destroy();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

const errors: Parameters<NonNullable<FleetCenterOptions["onError"]>>[0][] = [];
for (let round = 0; round < 30; round += 1) {
  const socket = new Socket(),
    sessions = new Map<string, Set<TLSSocket>>();
  await serve(
    socket as unknown as TLSSocket,
    {
      authenticate: () => !mode.startsWith("error-"),
      nodeOwner: () => "person-one",
      onError: (entry) => errors.push(entry),
    } as FleetCenterOptions,
    async () => {
      throw new Error("hello must not dispatch work");
    },
    sessions,
    new Map(),
  );
  socket.emit(
    "data",
    Buffer.from(
      serializeFleetFrame({
        schema: "fleet.session.hello/v1",
        messageId: `hello-${round}`,
        protocolVersion: currentFleetProtocolVersion,
        nodeId: "node-one",
        credential: "secret-node-one",
      }),
    ),
  );
  await socket.written.promise;
  if (mode !== "error-write") await once(socket, mode === "drain" ? "drain" : "close");
  // Cross Node's unhandled-rejection checkpoint after the controlled event. The parent runs
  // this child in strict mode, so any escaped rejection fails instead of being filtered.
  await setImmediate();
  assert.equal(socket.writes, 1, "the reply must neither retry nor dispatch a command");
  assert.equal(errors.length, mode === "close" || mode === "error-write" ? round + 1 : 0);
  if (mode === "error-write") {
    // A live peer whose error reply fails is a center fault: the dispatch boundary reports it
    // once through onError instead of crashing the process or dropping it silently.
    const entry = errors[round]!;
    assert.equal(entry.nodeId, null);
    assert.equal(entry.messageId, null);
    assert.ok(entry.error instanceof Error);
    assert.equal(entry.error.message, "fixture error reply failure");
  }
  if (mode === "close") {
    const entry = errors[round]!;
    assert.equal(entry.nodeId, "node-one");
    assert.equal(entry.messageId, `hello-${round}`);
    assert.ok(entry.error instanceof Error);
    assert.equal((entry.error as NodeJS.ErrnoException).code, "ABORT_ERR");
  }
  socket.destroy();
  assert.equal(sessions.size, 0, "closed peers must leave the live session registry");
}
console.log(JSON.stringify({ mode, rounds: 30, handlerErrors: errors.length, unhandledRejections: 0 }));

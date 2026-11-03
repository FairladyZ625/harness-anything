// harness-test-tier: contract
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { serializeFleetFrame, type FleetFrameV1 } from "../src/fleet/command-protocol.ts";
import { serve } from "../src/fleet/center-transport.ts";

/** A socket stand-in whose error reply waits for drain while the peer closes. */
class BackpressuredSocket extends EventEmitter {
  remoteAddress = "127.0.0.1";
  destroyed = false;
  bytesWritten = 0;
  writableLength = 0;
  readonly writes: string[] = [];
  setKeepAlive(): void {}
  write(line: string): boolean {
    this.writes.push(line);
    this.bytesWritten += Buffer.byteLength(line);
    this.writableLength += Buffer.byteLength(line);
    this.emit("written");
    return this.writes.length === 1;
  }
  end(): void {
    this.destroy();
  }
  destroy(error?: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (error) this.emit("error", error);
    this.emit("close");
  }
  nextWrite(): Promise<void> {
    return new Promise((resolve) => this.once("written", () => resolve()));
  }
}

const hello: FleetFrameV1 = {
    schema: "fleet.session.hello/v1",
    messageId: "hello",
    protocolVersion: { major: 1, minor: 0 },
    nodeId: "node-one",
    credential: "machine-secret",
  },
  command: FleetFrameV1 = {
    schema: "fleet.repo.metadata.get/v1",
    messageId: "metadata",
    repoId: "repo",
  };

test(
  "a handler error the peer cannot receive leaves no unhandled dispatch rejection",
  { timeout: 10_000 },
  async () => {
    const socket = new BackpressuredSocket(),
      errors: unknown[] = [],
      options = {
        authenticate: async () => true,
        loginAuthority: () => null,
        onError: (entry: { readonly error: unknown }) => errors.push(entry.error),
      } as unknown as Parameters<typeof serve>[1],
      handle: Parameters<typeof serve>[2] = async () => {
        throw Object.assign(new Error("The connection that parked this wait closed."), {
          code: "client_disconnected",
        });
      },
      readyWritten = socket.nextWrite();
    void serve(socket as never, options, handle, new Map(), new Map(), { hello() {}, online() {}, failure() {} });
    socket.emit("data", Buffer.from(serializeFleetFrame(hello)));
    await readyWritten;
    const errorWritten = socket.nextWrite();
    socket.emit("data", Buffer.from(serializeFleetFrame(command)));
    await errorWritten;
    socket.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(errors.length, 1, "only the handler failure is reported, not the peer's abort");
    assert.equal((errors[0] as { readonly code?: unknown }).code, "client_disconnected");
    assert.equal(socket.writes.length, 2, "the center attempted the error frame after the reply");
    assert.equal((JSON.parse(socket.writes[0]!) as { readonly schema?: unknown }).schema, "fleet.session.ready/v1");
    assert.deepEqual(
      {
        schema: (JSON.parse(socket.writes[1]!) as { readonly schema?: unknown }).schema,
        code: (JSON.parse(socket.writes[1]!) as { readonly code?: unknown }).code,
      },
      { schema: "fleet.error/v1", code: "handler_failed" },
    );
  },
);

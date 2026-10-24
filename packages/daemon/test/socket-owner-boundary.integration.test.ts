// harness-test-tier: integration
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { consumeKnownError } from "@harness-anything/kernel";
import { connectSocket } from "../src/client/local-json-rpc-client.ts";
import type { JsonRpcRequest } from "../src/protocol/json-rpc-types.ts";
import { createUnixSocketTransportServer, type UnixSocketTransportServer } from "../src/transport/unix-socket.ts";

// The per-user socket root lives under sticky /tmp, so any local user can pre-create the
// directory name before the daemon does. A real foreign owner needs root to arrange for, so
// the ownership mismatch is simulated at the exact comparison point the boundary reads:
// process.getuid is mocked to another uid while the directory keeps its real owner — the same
// predicate as lstat reporting a directory another local user created. The symlink shapes need
// no simulation at all.
const foreignUid = 4242;

function plantedSocketRoot(prefix: string): { readonly parent: string; readonly socketRoot: string } {
  // Socket addresses bind directly under sticky /tmp: the isolated runner's TMPDIR exceeds the
  // 104-byte unix-socket address limit, and /tmp is exactly the environment under test. The
  // caller creates the directories it needs; every test removes the parent again in finally.
  const parent = path.join("/tmp", `${prefix}${randomBytes(6).toString("hex")}`);
  return { parent, socketRoot: path.join(parent, "socket-root") };
}

function echoTransport(endpoint: string): UnixSocketTransportServer {
  return createUnixSocketTransportServer({
    daemonId: "socket-owner-boundary",
    socketPath: endpoint,
    createProtocolServer: () => ({
      handle: async (message: JsonRpcRequest | readonly JsonRpcRequest[]) => {
        const request = Array.isArray(message) ? message[0] : message;
        return { jsonrpc: "2.0", id: request.id ?? null, result: { echoed: request.method } };
      },
      close: () => {},
    }),
  });
}

/** stop() on a server that never bound rejects with ERR_SERVER_NOT_RUNNING; the refused-start
 * tests call it defensively so a regression that DID bind cannot hold the test process open. */
async function stopIfBound(transport: UnixSocketTransportServer): Promise<void> {
  try {
    await transport.stop();
  } catch (error) {
    if ((error as { readonly code?: string }).code !== "ERR_SERVER_NOT_RUNNING") throw error;
    consumeKnownError(error);
  }
}

test(
  "daemon transport start refuses a socket parent that is a symbolic link",
  {
    skip: process.platform === "win32" ? "requires POSIX Unix-domain sockets" : false,
    timeout: 5_000,
  },
  async () => {
    const { parent, socketRoot: link } = plantedSocketRoot("ha-sob-link-");
    mkdirSync(parent, { recursive: true });
    const planted = path.join(parent, "planted");
    mkdirSync(planted);
    symlinkSync(planted, link);
    const transport = echoTransport(path.join(link, "daemon.sock"));
    try {
      await assert.rejects(transport.start(), /socket directory is unsafe/u);
      assert.equal(existsSync(path.join(link, "daemon.sock")), false);
    } finally {
      await stopIfBound(transport);
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "daemon transport start refuses a socket parent pre-created by another user",
  {
    skip: process.platform === "win32" ? "requires POSIX Unix-domain sockets" : false,
    timeout: 5_000,
  },
  async (context) => {
    const { parent, socketRoot } = plantedSocketRoot("ha-sob-foreign-");
    mkdirSync(socketRoot, { recursive: true, mode: 0o700 });
    context.mock.method(process, "getuid", () => foreignUid);
    const transport = echoTransport(path.join(socketRoot, "daemon.sock"));
    try {
      await assert.rejects(transport.start(), /socket directory is unsafe/u);
      assert.equal(existsSync(transport.endpoint), false);
    } finally {
      await stopIfBound(transport);
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "daemon transport start accepts an existing socket parent owned by this user",
  {
    skip: process.platform === "win32" ? "requires POSIX Unix-domain sockets" : false,
    timeout: 5_000,
  },
  async () => {
    const { parent, socketRoot } = plantedSocketRoot("ha-sob-accept-");
    mkdirSync(socketRoot, { recursive: true, mode: 0o700 });
    const transport = echoTransport(path.join(socketRoot, "daemon.sock"));
    await transport.start();
    try {
      assert.equal(statSync(socketRoot).mode & 0o777, 0o700);
      assert.deepEqual(await roundtrip(transport.endpoint), {
        jsonrpc: "2.0",
        id: 1,
        result: { echoed: "daemon.ping" },
      });
    } finally {
      await transport.stop();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "client connection refuses a socket under a parent directory another user owns",
  {
    skip: process.platform === "win32" ? "requires POSIX Unix-domain sockets" : false,
    timeout: 5_000,
  },
  async (context) => {
    const { parent, socketRoot } = plantedSocketRoot("ha-sob-client-foreign-");
    mkdirSync(socketRoot, { recursive: true, mode: 0o700 });
    context.mock.method(process, "getuid", () => foreignUid);
    try {
      await assert.rejects(connectSocket(path.join(socketRoot, "daemon.sock"), 75), /socket directory is unsafe/u);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "client connection refuses a socket under a symbolic-link parent directory",
  {
    skip: process.platform === "win32" ? "requires POSIX Unix-domain sockets" : false,
    timeout: 5_000,
  },
  async () => {
    const { parent, socketRoot: link } = plantedSocketRoot("ha-sob-client-link-");
    mkdirSync(parent, { recursive: true });
    const planted = path.join(parent, "planted");
    mkdirSync(planted);
    symlinkSync(planted, link);
    try {
      await assert.rejects(connectSocket(path.join(link, "daemon.sock"), 75), /socket directory is unsafe/u);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "client connection accepts a socket in a parent directory this user owns",
  {
    skip: process.platform === "win32" ? "requires POSIX Unix-domain sockets" : false,
    timeout: 5_000,
  },
  async () => {
    const { parent, socketRoot } = plantedSocketRoot("ha-sob-client-accept-");
    mkdirSync(socketRoot, { recursive: true, mode: 0o700 });
    const server = await echoServer(path.join(socketRoot, "daemon.sock"));
    let client: Awaited<ReturnType<typeof connectSocket>> | undefined;
    try {
      client = await connectSocket(path.join(socketRoot, "daemon.sock"), 2_000);
      const [data] = await once(client, "data");
      assert.equal(data.toString(), "owner-ok");
    } finally {
      client?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "a missing socket parent still reports the native connection error",
  {
    skip: process.platform === "win32" ? "requires POSIX Unix-domain sockets" : false,
    timeout: 5_000,
  },
  async () => {
    const { parent } = plantedSocketRoot("ha-sob-missing-");
    mkdirSync(parent, { recursive: true });
    try {
      await assert.rejects(connectSocket(path.join(parent, "absent", "daemon.sock"), 75), { code: "ENOENT" });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

async function roundtrip(endpoint: string): Promise<Record<string, unknown>> {
  const client = await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
  try {
    const line = new Promise<string>((resolve, reject) => {
      client.once("error", reject);
      let buffer = "";
      client.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\n")) resolve(buffer.slice(0, buffer.indexOf("\n")));
      });
    });
    client.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemon.ping", params: {} })}\n`);
    return JSON.parse(await line) as Record<string, unknown>;
  } finally {
    client.destroy();
  }
}

async function echoServer(endpoint: string): Promise<net.Server> {
  const server = net.createServer((socket) => socket.end("owner-ok"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

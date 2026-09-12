// harness-test-tier: integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { defaultUnixSocketPath } from "../src/transport/unix-socket.ts";

test(
  "Unix daemon endpoints connect independently of long process TMPDIR values",
  {
    skip: process.platform === "win32" ? "requires POSIX Unix-domain sockets" : false,
    timeout: 5000,
  },
  async () => {
    const original = process.env.TMPDIR;
    const id = randomUUID();
    const userRoot = `/tmp/${id}`;
    let endpoints: string[];
    try {
      process.env.TMPDIR = `/tmp/${"packaged-app-temp-".repeat(12)}`;
      endpoints = [localUserDaemonEndpoint(userRoot, id), defaultUnixSocketPath(id)];
      process.env.TMPDIR = "/tmp/another-runtime";
      assert.deepEqual([localUserDaemonEndpoint(userRoot, id), defaultUnixSocketPath(id)], endpoints);
      assert.notEqual(localUserDaemonEndpoint(`${userRoot}-other`, id), endpoints[0]);
      assert.notEqual(localUserDaemonEndpoint(userRoot, `${id}-other`), endpoints[0]);
      assert.notEqual(defaultUnixSocketPath(id, 1001), defaultUnixSocketPath(id, 1002));
    } finally {
      if (original === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = original;
    }
    for (const endpoint of endpoints) {
      assert.ok(Buffer.byteLength(endpoint) < 104, endpoint);
      mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
      assert.equal(statSync(path.dirname(endpoint)).uid, process.getuid!());
      const server = net.createServer((socket) => socket.end("connected"));
      let client: net.Socket | undefined;
      try {
        server.listen(endpoint);
        await once(server, "listening");
        client = net.createConnection(endpoint);
        const [data] = await once(client, "data");
        assert.equal(data.toString(), "connected");
      } finally {
        client?.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  },
);

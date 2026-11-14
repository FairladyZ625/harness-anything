// harness-test-tier: fast
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fixtureDaemonHello } from "../../daemon/test/fixtures/daemon-hello.ts";
import { writeDaemonRegistryRepo } from "@harness-anything/kernel/daemon-registry";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/client";
import { createLocalGuiServiceBridge } from "../src/main/local-composition-root.ts";

const previous = {
  root: process.env.HARNESS_DAEMON_USER_ROOT,
  id: process.env.HARNESS_DAEMON_ID,
  endpoint: process.env.HARNESS_DAEMON_ENDPOINT,
};
afterEach(() => {
  vi.useRealTimers();
  if (previous.root === undefined) delete process.env.HARNESS_DAEMON_USER_ROOT;
  else process.env.HARNESS_DAEMON_USER_ROOT = previous.root;
  if (previous.id === undefined) delete process.env.HARNESS_DAEMON_ID;
  else process.env.HARNESS_DAEMON_ID = previous.id;
  if (previous.endpoint === undefined) delete process.env.HARNESS_DAEMON_ENDPOINT;
  else process.env.HARNESS_DAEMON_ENDPOINT = previous.endpoint;
});

it.each(["signInRuntimeInstance", "signOutRuntimeInstance"])(
  "%s uses the 20s instance-operation budget, including a 2.5s installation refresh",
  async (method) => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "gui-auth-deadline-"));
    const daemonId = "auth-deadline",
      endpoint = localUserDaemonEndpoint(userRoot, daemonId);
    const rpcMethod = `repo.runtimeInstance.auth.${method === "signInRuntimeInstance" ? "login" : "logout"}`;
    let arrived!: () => void, reply!: () => void;
    let requests = 0;
    let received = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      const lines = createInterface({ input: socket });
      lines.on("line", (line) => {
        const request = JSON.parse(line) as { id: number; method: string };
        const respond = (result: unknown) =>
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        if (request.method === "protocol.hello")
          respond({ ...fixtureDaemonHello(), methods: ["protocol.hello", rpcMethod] });
        else {
          requests += 1;
          expect(request.method).toBe(rpcMethod);
          reply = () =>
            respond({ schema: "terminal-control-receipt/v1", ok: true, outcome: "applied", sessionId: "term_auth_1" });
          arrived();
        }
      });
    });
    try {
      mkdirSync(path.dirname(endpoint), { recursive: true });
      await new Promise<void>((resolve) => server.listen(endpoint, resolve));
      mkdirSync(path.join(userRoot, "harness"), { recursive: true });
      writeFileSync(path.join(userRoot, "harness/harness.yaml"), "schema: harness-config/v1\n");
      writeDaemonRegistryRepo({
        userRoot,
        canonicalRoot: userRoot,
        repoId: "fixture-auth-repo",
        displayName: "Fixture",
        authoredBranch: "main",
      });
      process.env.HARNESS_DAEMON_USER_ROOT = userRoot;
      process.env.HARNESS_DAEMON_ID = daemonId;
      delete process.env.HARNESS_DAEMON_ENDPOINT;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const bridge = createLocalGuiServiceBridge();
      const pending = bridge.invoke(method, { repoId: "fixture-auth-repo", instanceId: "fixture-auth-instance" });
      await Promise.race([
        received,
        Promise.resolve(pending).then((receipt) => {
          throw new Error(JSON.stringify(receipt));
        }),
      ]);
      vi.advanceTimersByTime(2_500);
      reply();
      expect(await pending).toMatchObject({ ok: true, outcome: "applied", sessionId: "term_auth_1" });
      received = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const timedOut = bridge.invoke(method, { repoId: "fixture-auth-repo", instanceId: "fixture-auth-instance" });
      await Promise.race([
        received,
        Promise.resolve(timedOut).then((receipt) => {
          throw new Error(JSON.stringify(receipt));
        }),
      ]);
      vi.advanceTimersByTime(20_001);
      expect(await timedOut).toMatchObject({
        ok: false,
        error: { code: "daemon_response_timeout", hint: expect.stringContaining("within 20s") },
      });
      expect(requests).toBe(2);
    } finally {
      vi.useRealTimers();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(userRoot, { recursive: true, force: true });
    }
  },
);

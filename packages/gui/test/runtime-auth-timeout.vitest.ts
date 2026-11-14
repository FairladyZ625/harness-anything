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

it.each([
  { method: "signInRuntimeInstance", rpcMethod: "repo.runtimeInstance.auth.login", elapsed: 2_500, deadline: 20_000 },
  { method: "signOutRuntimeInstance", rpcMethod: "repo.runtimeInstance.auth.logout", elapsed: 2_500, deadline: 20_000 },
  { method: "showRuntimeInstance", rpcMethod: "daemon.runtimeInstance.show", elapsed: 122_500, deadline: 140_000 },
])(
  "$method permits its bounded process work and retains a finite deadline",
  async ({ method, rpcMethod, elapsed, deadline }) => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "gui-auth-deadline-"));
    const daemonId = "auth-deadline",
      endpoint = localUserDaemonEndpoint(userRoot, daemonId);
    const payload = {
      repoId: "fixture-auth-repo",
      instanceId: "fixture-auth-instance",
      ...(method === "showRuntimeInstance" ? { probe: true } : {}),
    };
    let arrived!: () => void, reply!: (error?: boolean) => void;
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
          reply = (error = false) => {
            if (error)
              socket.write(
                `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "fixture probe failed" } })}\n`,
              );
            else
              respond(
                method === "showRuntimeInstance"
                  ? { ok: true, instance: { instanceId: "fixture-auth-instance" } }
                  : { schema: "terminal-control-receipt/v1", ok: true, outcome: "applied", sessionId: "term_auth_1" },
              );
          };
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
      const pending = bridge.invoke(method, payload);
      await Promise.race([
        received,
        Promise.resolve(pending).then((receipt) => {
          throw new Error(JSON.stringify(receipt));
        }),
      ]);
      vi.advanceTimersByTime(elapsed);
      reply();
      expect(await pending).toMatchObject(
        method === "showRuntimeInstance"
          ? { ok: true, instance: { instanceId: "fixture-auth-instance" } }
          : { ok: true, outcome: "applied", sessionId: "term_auth_1" },
      );
      received = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const timedOut = bridge.invoke(method, payload);
      await Promise.race([
        received,
        Promise.resolve(timedOut).then((receipt) => {
          throw new Error(JSON.stringify(receipt));
        }),
      ]);
      vi.advanceTimersByTime(deadline + 1);
      expect(await timedOut).toMatchObject({
        ok: false,
        error: { code: "daemon_response_timeout", hint: expect.stringContaining(`within ${deadline / 1_000}s`) },
      });
      if (method === "showRuntimeInstance") {
        received = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        const failed = bridge.invoke(method, payload);
        await received;
        vi.advanceTimersByTime(25_000);
        reply(true);
        expect(await failed).toMatchObject({
          ok: false,
          error: { code: "json_rpc_-32001", hint: expect.stringContaining("fixture probe failed") },
        });
      }
      expect(requests).toBe(method === "showRuntimeInstance" ? 3 : 2);
    } finally {
      vi.useRealTimers();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(userRoot, { recursive: true, force: true });
    }
  },
);

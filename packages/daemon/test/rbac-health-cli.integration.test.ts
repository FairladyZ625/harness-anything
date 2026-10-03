// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { ManagedRbacService, managedRbacVersions } from "../src/managed-rbac-service.ts";

for (const mode of ["managed", "external"] as const) {
  for (const status of [200, 503, "rpc-error"] as const) {
    test(`bootstrap health CLI exits correctly for ${mode} ${status}`, async (t) => {
      const root = mkdtempSync(path.join(tmpdir(), "ha-health-rpc-")),
        userRoot = path.join(root, "user"),
        endpoint = localUserDaemonEndpoint(userRoot, "default"),
        requests: Array<{ method: string; params: Record<string, unknown> }> = [];
      t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
      mkdirSync(path.join(userRoot, "rbac"), { recursive: true });
      writeFileSync(
        path.join(userRoot, "rbac", "config.json"),
        JSON.stringify({
          schema: "harness-managed-rbac/v1",
          mode,
          url: "https://identity.example.test",
          realm: "fleet",
          clientId: "center",
          versions: managedRbacVersions,
        }),
      );
      const service = new ManagedRbacService(userRoot, {
        fetch: async () => new Response(null, { status: typeof status === "number" ? status : 200 }),
      });
      const receipt = await service.run({ operation: "health" });
      const server = createServer((socket) => {
        const lines = createInterface({ input: socket });
        lines.on("line", (line) => {
          const request = JSON.parse(line);
          requests.push(request);
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              ...(request.method === "protocol.hello"
                ? { result: { protocolVersion: { major: 1, minor: 0 } } }
                : status === "rpc-error"
                  ? { error: { code: -32603, message: "fixture RPC failure" } }
                  : { result: receipt }),
            })}\n`,
          );
        });
        socket.on("close", () => lines.close());
      });
      mkdirSync(path.dirname(endpoint), { recursive: true });
      server.listen(endpoint);
      await once(server, "listening");
      t.after(async () => {
        const closed = once(server, "close", { signal: AbortSignal.timeout(5_000) });
        server.close();
        await closed;
      });
      const child = spawn(
        process.execPath,
        [path.resolve("packages/cli/src/index.ts"), "--root", root, "bootstrap", "--operation", "health", "--json"],
        {
          env: { ...process.env, HOME: path.join(root, "home"), HARNESS_DAEMON_USER_ROOT: userRoot },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += String(chunk);
      });
      try {
        const [exitCode] = await once(child, "close", { signal: AbortSignal.timeout(10_000) });
        t.diagnostic(`exit=${String(exitCode)} stdout=${stdout.trim()} stderr=${stderr.trim()}`);
        assert.equal(exitCode, status === 200 ? 0 : 1, stdout + stderr);
        assert.deepEqual(
          requests.map(({ method }) => method),
          ["protocol.hello", "daemon.rbac.manage"],
        );
        assert.deepEqual(requests[1]!.params, { operation: "health", rootDir: root });
        if (status !== "rpc-error") {
          const output = JSON.parse(stdout);
          assert.equal(output.ready, status === 200);
          assert.equal(output.status, status);
          assert.equal(output.mode, mode);
        } else assert.match(stdout + stderr, /fixture RPC failure/u);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, "close", { signal: AbortSignal.timeout(5_000) });
          child.kill("SIGKILL");
          await closed;
        }
      }
    });
  }
}

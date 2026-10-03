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
import { localUserDaemonEndpoint } from "@harness-anything/daemon/internal/client/local-daemon-target";

test("bootstrap CLI sends the password file contents only in transient local RPC params", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-bootstrap-rpc-")),
    userRoot = path.join(root, "user"),
    endpoint = localUserDaemonEndpoint(userRoot, "default"),
    passwordFile = path.join(root, "password"),
    password = "test-only administrator password",
    requests: Array<{ method: string; params: Record<string, unknown> }> = [],
    server = createServer((socket) => {
      const lines = createInterface({ input: socket });
      lines.on("line", (line) => {
        const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
        requests.push(request);
        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result:
              request.method === "protocol.hello"
                ? { protocolVersion: { major: 1, minor: 0 } }
                : { ok: true, command: "rbac-bootstrap", outcome: "applied", summary: "Administrator created." },
          })}\n`,
        );
      });
      socket.on("close", () => lines.close());
    });
  try {
    mkdirSync(path.dirname(endpoint), { recursive: true });
    writeFileSync(passwordFile, `${password}\r\n`, { mode: 0o600 });
    server.listen(endpoint);
    await once(server, "listening");
    const argv = [
        path.resolve("packages/cli/src/index.ts"),
        "--root",
        root,
        "--json",
        "bootstrap",
        "--operation",
        "bootstrap-admin",
        "--username",
        "owner",
        "--email",
        "owner@example.invalid",
        "--display-name",
        "Owner",
        "--person-id",
        "person-owner",
        "--password-file",
        passwordFile,
      ],
      child = spawn(process.execPath, argv, {
        env: { ...process.env, HOME: path.join(root, "home"), HARNESS_DAEMON_USER_ROOT: userRoot },
        stdio: ["ignore", "pipe", "pipe"],
      });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += String(chunk);
    });
    try {
      const [status] = await once(child, "close", { signal: AbortSignal.timeout(10_000) });
      assert.equal(status, 0, output);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close", { signal: AbortSignal.timeout(5_000) });
        child.kill("SIGKILL");
        await closed;
      }
    }
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["protocol.hello", "daemon.rbac.manage"],
    );
    assert.deepEqual(requests[1]!.params, {
      operation: "bootstrap-admin",
      username: "owner",
      email: "owner@example.invalid",
      displayName: "Owner",
      personId: "person-owner",
      password,
    });
    assert.equal(argv.includes(password), false, "credentials stay off argv");
    assert.equal(output.includes(password), false, "credentials stay out of CLI receipts and diagnostics");
    assert.equal(output.includes(passwordFile), false, "the file path is local input, not a receipt field");
  } finally {
    if (server.listening) {
      const closed = once(server, "close", { signal: AbortSignal.timeout(5_000) });
      server.close();
      await closed;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

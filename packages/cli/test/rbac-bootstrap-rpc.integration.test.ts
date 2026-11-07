// harness-test-tier: integration
import { fixtureDaemonHello } from "../../daemon/test/fixtures/daemon-hello.ts";
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
                ? fixtureDaemonHello()
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
    const retirement = spawn(
      process.execPath,
      [
        path.resolve("packages/cli/src/index.ts"),
        "--root",
        root,
        "--json",
        "access",
        "node",
        "unregister",
        "--node-id",
        "retired-node",
        "--confirm",
        "--force",
        "--expected-version",
        "1",
      ],
      {
        env: { ...process.env, HOME: path.join(root, "home"), HARNESS_DAEMON_USER_ROOT: userRoot },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let retirementOutput = "";
    retirement.stdout.on("data", (chunk: Buffer) => {
      retirementOutput += String(chunk);
    });
    retirement.stderr.on("data", (chunk: Buffer) => {
      retirementOutput += String(chunk);
    });
    try {
      const [status] = await once(retirement, "close", { signal: AbortSignal.timeout(10_000) });
      assert.equal(status, 0, retirementOutput);
    } finally {
      if (retirement.exitCode === null && retirement.signalCode === null) {
        const closed = once(retirement, "close", { signal: AbortSignal.timeout(5_000) });
        retirement.kill("SIGKILL");
        await closed;
      }
    }
    assert.equal(requests.at(-1)?.method, "daemon.rbac.manage");
    assert.deepEqual(requests.at(-1)?.params, {
      operation: "node-unregister",
      nodeId: "retired-node",
      expectedVersion: "1",
      confirm: true,
      force: true,
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

test("access password CLI sends file and stdin contents only in transient local RPC params", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-access-password-rpc-")),
    userRoot = path.join(root, "user"),
    endpoint = localUserDaemonEndpoint(userRoot, "default"),
    passwordFile = path.join(root, "password"),
    filePassword = "test-only file password",
    stdinPassword = "test-only stdin password",
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
                ? fixtureDaemonHello()
                : { ok: true, command: request.params.operation, changed: true },
          })}\n`,
        );
      });
      socket.on("close", () => lines.close());
    });

  const run = async (
    args: string[],
    input: string | undefined,
  ): Promise<{ readonly output: string; readonly argv: string[] }> => {
    const argv = [path.resolve("packages/cli/src/index.ts"), "--root", root, "--json", ...args],
      child = spawn(process.execPath, argv, {
        env: { ...process.env, HOME: path.join(root, "home"), HARNESS_DAEMON_USER_ROOT: userRoot },
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += String(chunk);
    });
    if (input !== undefined) child.stdin?.end(input);
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
    return { output, argv };
  };

  try {
    mkdirSync(path.dirname(endpoint), { recursive: true });
    writeFileSync(passwordFile, `${filePassword}\n`, { mode: 0o600 });
    server.listen(endpoint);
    await once(server, "listening");
    const fromFile = await run(["access", "password", "change", "--password-file", passwordFile], undefined),
      fromStdin = await run(
        ["access", "password", "reset", "--person-id", "person-target", "--password-stdin"],
        `${stdinPassword}\n`,
      );

    assert.deepEqual(
      requests.filter(({ method }) => method === "daemon.rbac.manage").map(({ params }) => params),
      [
        { operation: "password-change", password: filePassword },
        { operation: "password-reset", personId: "person-target", password: stdinPassword },
      ],
    );
    for (const { output, argv } of [fromFile, fromStdin]) {
      assert.equal(argv.includes(filePassword), false);
      assert.equal(argv.includes(stdinPassword), false);
      assert.equal(output.includes(filePassword), false);
      assert.equal(output.includes(stdinPassword), false);
      assert.equal(output.includes(passwordFile), false);
    }
  } finally {
    if (server.listening) {
      const closed = once(server, "close", { signal: AbortSignal.timeout(5_000) });
      server.close();
      await closed;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

for (const memberDevice of [false, true])
  test(`bootstrap CLI preserves the daemon-issued ${memberDevice ? "member device" : "invitation"} link as a string`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-edge-bootstrap-rpc-")),
      userRoot = path.join(root, "user"),
      endpoint = localUserDaemonEndpoint(userRoot, "default"),
      link = "harness-edge://join/eyJ2ZXJzaW9uIjoxLCJqb2luSWQiOiJqb2luLTEifQ",
      requests: Array<{ method: string; params: Record<string, unknown> }> = [],
      server = createServer((socket) => {
        const lines = createInterface({ input: socket });
        lines.on("line", (line) => {
          const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
          requests.push(request);
          const result =
            request.method === "protocol.hello"
              ? fixtureDaemonHello()
              : {
                  ok: true,
                  command: "rbac-bootstrap",
                  outcome: "applied",
                  link,
                  joinId: "join-1",
                  state: "pending",
                };
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        });
        socket.on("close", () => lines.close());
      });
    try {
      mkdirSync(path.dirname(endpoint), { recursive: true });
      server.listen(endpoint);
      await once(server, "listening");
      const child = spawn(
        process.execPath,
        [
          path.resolve("packages/cli/src/index.ts"),
          "--root",
          root,
          "--json",
          "bootstrap",
          "--operation",
          "edge-join-create",
          ...(memberDevice
            ? ["--join-mode", "member-device"]
            : [
                "--username",
                "edge.operator",
                "--email",
                "edge@example.invalid",
                "--display-name",
                "Edge Operator",
                "--person-id",
                "person-edge",
              ]),
          "--join-repo",
          "repo-a",
          ...(memberDevice ? [] : ["--join-group", "viewer"]),
        ],
        {
          env: { ...process.env, HOME: path.join(root, "home"), HARNESS_DAEMON_USER_ROOT: userRoot },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += String(chunk);
      });
      const [status] = await once(child, "close", { signal: AbortSignal.timeout(10_000) });
      assert.equal(status, 0, output);
      const receipt = JSON.parse(output.trim()) as Record<string, unknown>;
      assert.equal(typeof receipt.link, "string");
      assert.match(String(receipt.link), /^harness-edge:\/\/join\/[A-Za-z0-9_-]+$/u);
      assert.equal(receipt.link, link);
      assert.equal(requests[1]?.params.operation, "edge-join-create");
      if (memberDevice) {
        assert.equal(requests[1]?.params.joinMode, "member-device");
        assert.equal(requests[1]?.params.rootDir, root);
        assert.equal(Object.hasOwn(requests[1]!.params, "personId"), false);
      }
    } finally {
      if (server.listening) {
        const closed = once(server, "close", { signal: AbortSignal.timeout(5_000) });
        server.close();
        await closed;
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

test("edge join CLI sends its quota and exits with the daemon's initial sync failure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-join-quota-rpc-")),
    userRoot = path.join(root, "user"),
    endpoint = localUserDaemonEndpoint(userRoot, "default"),
    link = "harness-edge://join/eyJ2ZXJzaW9uIjoxLCJqb2luSWQiOiJqb2luLTEifQ",
    workspaceRoot = path.join(root, "edge-repo"),
    quotaBytes = 4_000_000_000,
    requests: Array<{ method: string; params: Record<string, unknown> }> = [],
    server = createServer((socket) => {
      const lines = createInterface({ input: socket });
      lines.on("line", (line) => {
        const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
        requests.push(request);
        const result =
          request.method === "protocol.hello"
            ? fixtureDaemonHello()
            : {
                ok: false,
                command: "edge-join",
                code: "edge_join_sync_failed",
                error: { code: "replica_sync_failed", hint: "base backup exceeds disk quota" },
              };
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      });
      socket.on("close", () => lines.close());
    });
  try {
    mkdirSync(path.dirname(endpoint), { recursive: true });
    server.listen(endpoint);
    await once(server, "listening");
    const child = spawn(
      process.execPath,
      [
        path.resolve("packages/cli/src/index.ts"),
        "--root",
        root,
        "--json",
        "edge",
        "join",
        link,
        "--root",
        workspaceRoot,
        "--quota-bytes",
        String(quotaBytes),
      ],
      {
        env: { ...process.env, HOME: path.join(root, "home"), HARNESS_DAEMON_USER_ROOT: userRoot },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += String(chunk);
    });
    const [status] = await once(child, "close", { signal: AbortSignal.timeout(10_000) });
    assert.equal(status, 1, output);
    assert.match(output, /base backup exceeds disk quota/u);
    assert.deepEqual(requests[1]?.params, {
      operation: "edge-join",
      link,
      workspaceRoot,
      quotaBytes,
    });
  } finally {
    if (server.listening) {
      const closed = once(server, "close", { signal: AbortSignal.timeout(5_000) });
      server.close();
      await closed;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "../../daemon/src/client/local-daemon-target.ts";
import { seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";
import { registerDaemonRepo } from "../../kernel/src/index.ts";

const cli = path.resolve("packages/cli/src/index.ts");

test("a CLI write returns its daemon receipt after one command round trip and keeps its exit code", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-write-round-trip-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "write-round-trip",
    socketPath = localUserDaemonEndpoint(userRoot, "default");
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n", "utf8");
  for (const args of [
    ["init", "--quiet"],
    ["add", "harness"],
    ["commit", "--quiet", "-m", "fixture"],
  ])
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args]);
  seedSettingsEvent({ rootDir: root, repoId });
  registerDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
  const accepted = {
      schema: "command-receipt/v2",
      ok: true,
      command: "task-create",
      outcome: "applied",
      status: "accepted_durable",
      opId: "op-accepted",
      summary: "task-create: applied",
      git: { state: "pending", cut: null, commitSha: null },
      worktree: { state: "pending", cut: null },
    },
    rejected = {
      schema: "command-receipt/v2",
      ok: false,
      command: "task-create",
      outcome: "op_rejected",
      status: "rejected",
      opId: "op-rejected",
      code: "invalid_field",
      nextAction: "Fix the title.",
    };
  const methods: string[] = [];
  let reply: Record<string, unknown> = accepted;
  const server = createServer((socket) => {
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += String(chunk);
      for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
        const request = JSON.parse(buffered.slice(0, newline)) as { readonly id: number; readonly method: string };
        buffered = buffered.slice(newline + 1);
        if (request.method !== "protocol.hello") methods.push(request.method);
        const result = request.method === "protocol.hello" ? { protocolVersion: { major: 1, minor: 0 } } : reply;
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      }
    });
  });
  try {
    mkdirSync(path.dirname(socketPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const written = await spawnCli(root, userRoot, ["task", "create", "--title", "One round trip"]);
    assert.equal(written.status, 0, `${written.stderr}\n${written.stdout}`);
    assert.deepEqual(JSON.parse(written.stdout), accepted);
    assert.deepEqual(methods, ["repo.task.create"]);

    methods.length = 0;
    reply = rejected;
    const refused = await spawnCli(root, userRoot, ["task", "create", "--title", "Refused"]);
    assert.equal(refused.status, 1, `${refused.stderr}\n${refused.stdout}`);
    assert.equal((JSON.parse(refused.stdout) as { readonly code?: unknown }).code, "invalid_field");
    assert.deepEqual(methods, ["repo.task.create"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(parent, { recursive: true, force: true });
  }
});

function spawnCli(
  root: string,
  userRoot: string,
  args: readonly string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const {
    HARNESS_ACTOR: _actor,
    HARNESS_DAEMON_ENDPOINT: _endpoint,
    HARNESS_DAEMON_REPO_ID: _repoId,
    HARNESS_DAEMON_ID: _daemonId,
    ...base
  } = process.env;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "--root", root, "--json", ...args], {
      env: { ...base, HOME: path.join(root, ".home"), HARNESS_DAEMON_USER_ROOT: userRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

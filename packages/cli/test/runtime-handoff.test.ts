// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { registerDaemonRepo } from "@harness-anything/storage";
import { runCommandThroughDaemon } from "../src/daemon/client.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("handoff CLI routes explicit export, claim and revoke through the shared RPC", () => {
  const dispatchId = `dispatch_${"a".repeat(24)}`;
  for (const operation of ["export", "claim", "revoke"]) {
    const parsed = parseThinCommand([
      "runtime",
      "handoff",
      operation,
      dispatchId,
      ...(operation === "claim" ? ["--instance", "target-codex", "--prompt", "Continue"] : []),
    ]);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) throw new Error(parsed.nextAction);
    assert.equal(parsed.command.method, "repo.agentRuntime.handoff");
    assert.equal(parsed.command.action.operation, operation);
    assert.equal(parsed.command.action.dispatchId, dispatchId);
  }
  assert.equal(parseThinCommand(["runtime", "handoff", "claim", dispatchId]).ok, false);
});

test("handoff RPC preserves orchestration inputs until the daemon builds its Fleet action", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-handoff-rpc-")),
    userRoot = path.join(parent, "user"),
    rootDir = path.join(parent, "repo"),
    dispatchId = `dispatch_${"b".repeat(24)}`;
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: handoff-repo\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  execFileSync("git", ["-C", rootDir, "init", "--quiet"]);
  execFileSync("git", [
    "-C",
    rootDir,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "add",
    "harness",
  ]);
  execFileSync("git", [
    "-C",
    rootDir,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  registerDaemonRepo({
    canonicalRoot: rootDir,
    repoId: "handoff-repo",
    mode: "remote-edge",
    userRoot,
    createConvenienceLinks: false,
  });
  try {
    for (const [operation, options, expected] of [
      ["export", [], { operation: "export", dispatchId }],
      [
        "claim",
        ["--instance", "target-codex", "--prompt", "Continue", "--idempotency-key", "claim-once"],
        {
          operation: "claim",
          dispatchId,
          runtimeInstanceId: "target-codex",
          prompt: "Continue",
          dispatchKey: "claim-once",
        },
      ],
    ] as const) {
      const parsed = parseThinCommand(
        ["--repo", "handoff-repo", "runtime", "handoff", operation, dispatchId, ...options],
        rootDir,
      );
      assert.equal(parsed.ok, true, JSON.stringify(parsed));
      if (!parsed.ok) throw new Error(parsed.nextAction);
      let sent: { readonly method: string; readonly params: Record<string, unknown> } | undefined;
      const fakeTimer = ((request: (...args: unknown[]) => Promise<unknown>) => {
        void request;
        return async (...args: unknown[]) => {
          sent = { method: String(args[1]), params: args[2] as Record<string, unknown> };
          return { schema: "command-receipt/v2", ok: true, outcome: "applied" };
        };
      }) as typeof import("../src/cli/timing.ts").timedDaemonRequest;
      await runCommandThroughDaemon(
        parsed.command,
        undefined,
        { autostart: false, env: { HARNESS_DAEMON_USER_ROOT: userRoot } },
        fakeTimer,
      );
      assert.equal(sent?.method, "repo.agentRuntime.handoff");
      assert.deepEqual(sent?.params.payload as Record<string, unknown>, expected);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("new task-bound agent sessions explicitly opt into handoff", () => {
  const parsed = parseThinCommand(["agent", "run", "astra", "--task", "task-one", "--enable-handoff"]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error(parsed.nextAction);
  assert.equal(parsed.command.action.handoffEnabled, true);
});

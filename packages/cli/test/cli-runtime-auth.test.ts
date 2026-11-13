// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import { runRuntimeAuthCommand } from "../src/cli-runtime-auth.ts";
import type { ThinCommand } from "../src/cli/thin-command.ts";

test("successful AGY and AGY-ACP logins probe their account after the terminal exits", async (t) => {
  for (const kindId of ["agy", "agy-acp"] as const)
    await t.test(kindId, async () => {
      const calls: ThinCommand[] = [];
      const result = await runRuntimeAuthCommand(loginCommand(), () => undefined, {
        runCommandThroughDaemon: async (command) => {
          calls.push(command);
          if (command.action.kind === "runtime-instance-login")
            return { ok: true, sessionId: "terminal_login" } as JsonObject;
          if (command.action.probe === true)
            return {
              ok: true,
              summary: "availableModels: gemini-4-hydrogen-low",
              instance: { kindId, availableModels: ["gemini-4-hydrogen-low"] },
            } as JsonObject;
          return { ok: true, instance: { kindId } } as JsonObject;
        },
        relayRuntimeAuthTerminal: async (_command, sessionId) => {
          assert.equal(sessionId, "terminal_login");
          return 0;
        },
      });

      assert.equal(result.exitCode, 0);
      assert.equal(calls.length, 3);
      assert.equal(calls[0]?.action.kind, "runtime-instance-login");
      assert.equal(calls[1]?.method, "daemon.runtimeInstance.show");
      assert.equal(calls[1]?.action.probe, undefined);
      assert.equal(calls[2]?.action.probe, true);
      assert.deepEqual((result.accountProbe as Record<string, unknown>).instance, {
        kindId,
        availableModels: ["gemini-4-hydrogen-low"],
      });
      assert.match(String(result.summary), /availableModels: gemini-4-hydrogen-low/u);
    });
});

test("successful non-AGY login does not start the AGY account probe", async () => {
  const calls: ThinCommand[] = [];
  const result = await runRuntimeAuthCommand(loginCommand(), () => undefined, {
    runCommandThroughDaemon: async (command) => {
      calls.push(command);
      return command.action.kind === "runtime-instance-login"
        ? ({ ok: true, sessionId: "terminal_login" } as JsonObject)
        : ({ ok: true, instance: { kindId: "codex" } } as JsonObject);
    },
    relayRuntimeAuthTerminal: async () => 0,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 2);
  assert.equal(
    calls.some((command) => command.action.probe === true),
    false,
  );
});

test("failed login does not run an account probe", async () => {
  const calls: ThinCommand[] = [];
  const result = await runRuntimeAuthCommand(loginCommand(), () => undefined, {
    runCommandThroughDaemon: async (command) => {
      calls.push(command);
      return { ok: true, sessionId: "terminal_login" } as JsonObject;
    },
    relayRuntimeAuthTerminal: async () => 1,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(calls.length, 1);
});

function loginCommand(): ThinCommand {
  return {
    id: "runtime-instance-login",
    rootDir: "/tmp/runtime-auth-test" as ThinCommand["rootDir"],
    repoId: "runtime-auth-test",
    json: true,
    method: "repo.runtimeInstance.auth.login",
    action: { kind: "runtime-instance-login", instanceId: "agy-worker" },
  };
}

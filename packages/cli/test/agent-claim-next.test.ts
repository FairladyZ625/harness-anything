// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { runRuntimeFacadeCommand } from "../src/cli-runtime-command.ts";
import type { ThinCommand } from "../src/cli/thin-command.ts";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";

function claimCommand(): ThinCommand {
  const parsed = parseThinCommand(["agent", "run", "sol", "--claim-next"]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error(parsed.nextAction);
  return parsed.command;
}

const candidates = (ids: string[]): JsonObject => ({
  schema: "task-claimable/v1",
  scope: "startable",
  tasks: ids.map((taskId) => ({ taskId, title: taskId, assignment: null })),
});

test("claim-next is exclusive with explicit task, resume, preview, and cwd", () => {
  assert.equal(claimCommand().action.claimNext, true);
  for (const flags of [["--task", "task-1"], ["--resume-dispatch", "dispatch-1"], ["--dry-run"], ["--cwd", "."]]) {
    const parsed = parseThinCommand(["agent", "run", "sol", "--claim-next", ...flags]);
    assert.equal(parsed.ok, false, JSON.stringify(flags));
  }
});

test("one candidate snapshot, CAS conflict advances, and only the winner spawns", async () => {
  const calls: ThinCommand[] = [];
  const result = await runRuntimeFacadeCommand(
    claimCommand(),
    () => {},
    async (command) => {
      calls.push(command);
      if (command.method === "repo.tasks.claimable") return candidates(["taken", "free"]);
      if (command.action.kind === "task-start")
        return command.action.taskId === "taken"
          ? { ok: false, outcome: "op_rejected", code: "lease_conflict" }
          : { ok: true, outcome: "applied" };
      assert.equal(command.action.taskId, "free");
      assert.equal(command.action.claimNext, undefined);
      return { ok: true, runtimeSessionId: "runtime-one", dispatchId: "dispatch-one" };
    },
  );
  assert.equal(result.outcome, "running");
  assert.deepEqual(
    calls.map((c) => [c.method, c.action.taskId]),
    [
      ["repo.tasks.claimable", undefined],
      ["repo.task.run", "taken"],
      ["repo.task.run", "free"],
      ["repo.agentRuntime.spawn", "free"],
    ],
  );
});

test("empty pool and all CAS conflicts terminate without a spawn", async () => {
  for (const ids of [[], ["a", "b"]]) {
    let reads = 0,
      starts = 0;
    const result = await runRuntimeFacadeCommand(
      claimCommand(),
      () => {},
      async (command) => {
        if (command.method === "repo.tasks.claimable") {
          reads++;
          return candidates(ids);
        }
        assert.equal(command.action.kind, "task-start");
        starts++;
        return { ok: false, outcome: "op_rejected", error: { code: "lease_conflict" } };
      },
    );
    assert.equal(result.outcome, "empty");
    assert.equal(reads, 1);
    assert.equal(starts, ids.length);
  }
});

test("read/start/spawn failures return immediately without selecting another task", async () => {
  for (const failureAt of ["repo.tasks.claimable", "repo.task.run", "repo.agentRuntime.spawn"]) {
    const failure = { ok: false, code: "authorization_denied" },
      calls: string[] = [];
    const result = await runRuntimeFacadeCommand(
      claimCommand(),
      () => {},
      async (command) => {
        calls.push(command.method);
        if (command.method === failureAt) return failure;
        if (command.method === "repo.tasks.claimable") return candidates(["a", "b"]);
        return { ok: true, outcome: "applied" };
      },
    );
    assert.equal(result, failure);
    assert.equal(
      calls.length,
      ["repo.tasks.claimable", "repo.task.run", "repo.agentRuntime.spawn"].indexOf(failureAt) + 1,
    );
  }
});

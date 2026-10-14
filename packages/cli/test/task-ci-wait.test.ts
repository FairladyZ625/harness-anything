// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { runRuntimeFacadeCommand } from "../src/cli-runtime-command.ts";
import { taskCiWaitDefaults, waitForTaskCi } from "../src/cli-runtime-wait.ts";
import type { ThinCommand } from "../src/cli/thin-command.ts";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";

function waitCommand(argv: readonly string[] = ["task", "ci", "task-1", "--wait"]): ThinCommand {
  const parsed = parseThinCommand([...argv]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error(parsed.nextAction);
  return parsed.command;
}

test("plain task-ci reads have no wait marker", () => {
  const command = waitCommand(["task", "ci", "task-1"]);
  assert.deepEqual(command.action, { kind: "task-ci", taskId: "task-1" });
});

const report = (conclusion: string, notStarted?: JsonObject): JsonObject => ({
  ok: true,
  command: "task-ci",
  ci: {
    taskId: "task-1",
    headSha: "a".repeat(40),
    conclusion,
    ...(notStarted ? { notStarted } : {}),
    checks: [],
    runs: [],
  },
});

/** A fake clock: sleeping advances time by the slept interval, so no wall time passes. */
function fakeClock() {
  const slept: number[] = [];
  let now = 0;
  return {
    slept,
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        slept.push(ms);
        now += ms;
      },
    },
  };
}

test("the facade strips the wait flags before the daemon read and returns a first-read verdict", async () => {
  for (const [conclusion, exitCode] of [
    ["success", undefined],
    ["failure", 1],
  ] as const) {
    const seen: ThinCommand[] = [];
    const result = await runRuntimeFacadeCommand(
      waitCommand(),
      () => {},
      async (command) => {
        seen.push(command);
        return report(conclusion);
      },
    );
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]!.action, { kind: "task-ci", taskId: "task-1", wait: true });
    assert.equal(result.ci.conclusion, conclusion);
    assert.equal(result.exitCode, exitCode);
  }
});

test("an actionable not_started reason returns immediately: waiting cannot settle it", async () => {
  for (const reason of ["no_pull_request", "pull_request_conflict"]) {
    let reads = 0;
    const result = await runRuntimeFacadeCommand(
      waitCommand(),
      () => {},
      async () => {
        reads++;
        return report("not_started", { reason, detail: "act instead of waiting" });
      },
    );
    assert.equal(reads, 1);
    assert.equal(result.exitCode, 1);
    assert.equal(result.ci.notStarted.reason, reason);
  }
});

test("a failed read propagates its own code instead of being retried", async () => {
  const failure = { ok: false, code: "runtime_credential_unavailable" };
  const result = await runRuntimeFacadeCommand(
    waitCommand(),
    () => {},
    async () => failure,
  );
  assert.equal(result, failure);
});

test("pending then success: the loop re-reads on the poll interval until the verdict", async () => {
  const { clock, slept } = fakeClock(),
    conclusions = ["pending", "pending", "success"],
    requests: string[] = [];
  const result = await waitForTaskCi(
    waitCommand(),
    async () => {
      const conclusion = conclusions[requests.length]!;
      requests.push(conclusion);
      return report(conclusion);
    },
    clock,
  );
  assert.deepEqual(requests, ["pending", "pending", "success"]);
  assert.deepEqual(slept, [taskCiWaitDefaults.pollIntervalMs, taskCiWaitDefaults.pollIntervalMs]);
  assert.equal(result.ci.conclusion, "success");
  assert.equal(result.exitCode, undefined);
});

test("not_started with the queued reason keeps waiting like pending does", async () => {
  const { clock, slept } = fakeClock(),
    reports = [
      report("not_started", { reason: "queued", detail: "still queuing" }),
      report("pending"),
      report("success"),
    ];
  let reads = 0;
  const result = await waitForTaskCi(waitCommand(), async () => reports[reads++]!, clock);
  assert.equal(reads, 3);
  assert.equal(slept.length, 2);
  assert.equal(result.ci.conclusion, "success");
});

test("an exhausted budget returns the last report with wait: timeout", async () => {
  const { clock } = fakeClock();
  // --timeout 2 gives a 2s budget; the first sleep advances the fake clock by a full 30s poll interval.
  const command = waitCommand(["task", "ci", "task-1", "--wait", "--timeout", "2"]);
  let reads = 0;
  const result = await waitForTaskCi(
    command,
    async () => {
      reads++;
      return report("pending");
    },
    clock,
  );
  assert.equal(reads, 2);
  assert.equal(result.exitCode, 1);
  assert.equal(result.ci.conclusion, "pending");
  assert.equal(result.wait.state, "timeout");
  assert.equal(result.wait.waitedSeconds, 30);
});

test("without --timeout the budget is the default bound, not unbounded", async () => {
  const { clock, slept } = fakeClock();
  let reads = 0;
  const result = await waitForTaskCi(
    waitCommand(),
    async () => {
      reads++;
      return report("pending");
    },
    clock,
  );
  assert.equal(result.wait.state, "timeout");
  assert.equal(result.wait.waitedSeconds, taskCiWaitDefaults.timeoutMs / 1000);
  assert.equal(reads, slept.length + 1);
});

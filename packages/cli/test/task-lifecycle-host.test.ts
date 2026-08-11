// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeJournaledWriteCoordinator } from "../../kernel/src/index.ts";
import type { CommandRunnerContext } from "../src/cli/runner-registry.ts";
import { makeTaskLifecycleHost } from "../src/commands/core/task-lifecycle-host.ts";
import { parseTaskLifecycleArgs, runTaskLifecycleFacade } from "../src/commands/core/task-lifecycle.ts";

const actor = {
  principal: { personId: "person_host" },
  executor: { kind: "agent" as const, id: "executor-host" }
};

test("host issues a start credential once and persists neither plaintext channel nor proof", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-host-"));
  try {
    const host = makeTaskLifecycleHost({
      rootDir,
      layoutInput: rootDir,
      makeWriteCoordinator: () => makeJournaledWriteCoordinator({ rootDir }),
      actorAttribution: () => ({
        actor: { kind: "agent", id: "executor-host" },
        commitAuthor: { name: "Host Test", email: "host@example.test" },
        source: "env"
      })
    } as CommandRunnerContext);

    const create = parsed(["task", "create", "--task-id", "task_HOST", "--title", "Host task"]);
    assert.equal((await runTaskLifecycleFacade(create, { actor, service: host })).outcome, "applied");

    const start = parsed(["task", "start", "task_HOST", "--execution-id", "execution_HOST"]);
    const first = await runTaskLifecycleFacade(start, { actor, service: host });
    assert.equal(first.outcome, "applied");
    assert.match(first.leaseCredential ?? "", /^[A-Za-z0-9_-]+$/u);
    assert.match(first.nextAction ?? "", /Save.*shown once.*submit.*requires/iu);

    const streamPath = path.join(rootDir, "harness/task-events.ndjson");
    assert.equal(readFileSync(streamPath, "utf8").includes(first.leaseCredential!), false);
    const projectionBytes = readFileSync(path.join(rootDir, ".harness/cache/task.sqlite")).toString("latin1");
    assert.equal(projectionBytes.includes(first.leaseCredential!), false);

    const retried = await runTaskLifecycleFacade(start, { actor, service: host });
    assert.equal(retried.outcome, "applied");
    assert.equal(retried.leaseCredential, undefined);
    assert.match(retried.nextAction ?? "", /not reissued.*saved/iu);

    const submit = parsed([
      "task", "submit", "task_HOST", "--execution-id", "execution_HOST",
      "--lease-credential", first.leaseCredential!, "--claim", "ready", "--commit-sha", "a".repeat(40)
    ]);
    assert.equal((await runTaskLifecycleFacade(submit, { actor, service: host })).outcome, "applied");
    assert.equal(readFileSync(streamPath, "utf8").includes(first.leaseCredential!), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function parsed(args: readonly string[]) {
  const result = parseTaskLifecycleArgs(args);
  assert.equal(result.ok, true, args.join(" "));
  if (!result.ok) throw new Error(result.error.nextAction);
  return result.value;
}

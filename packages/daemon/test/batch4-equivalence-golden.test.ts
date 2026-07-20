// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Effect } from "effect";
import { drainDaemonRuntime, createAuthorityWireIngressHandler, makeDaemonQueuedWriteCoordinator } from "../src/index.ts";

const golden = JSON.parse(readFileSync(new URL("./fixtures/batch4-equivalence-golden.json", import.meta.url), "utf8")) as Record<string, string>;

test("authority wire errors retain origin/main bytes", async () => {
  const errors: string[] = [];
  for (const handler of [
    createAuthorityWireIngressHandler({ repoBindings: () => [] }),
    createAuthorityWireIngressHandler({ authorityLifecycle: {} as never, repoBindings: () => [] })
  ]) {
    try {
      await handler({} as never);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  assert.equal(JSON.stringify(errors), golden.authorityWireErrors);
});

test("daemon drain timeout retains origin/main bytes", async () => {
  let failure: unknown;
  try {
    await drainDaemonRuntime({
      authorityLifecycle: undefined,
      runtime: { stop: async () => new Promise<void>(() => undefined) },
      drainTimeoutMs: 1
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.equal(JSON.stringify({ name: failure.name, message: failure.message }), golden.daemonDrainTimeout);
});

test("queued coordinator preserves typed write errors byte-for-byte", async () => {
  const expected = JSON.parse(golden.queuedCoordinatorError) as {
    readonly _tag: "WriteRejected";
    readonly reason: string;
    readonly code: string;
    readonly retryable: true;
  };
  const coordinator = makeDaemonQueuedWriteCoordinator({
    enqueueInteractiveWrite: async () => { throw expected; },
    status: () => ({}),
    enqueueMaterializerBatch: async () => ({ dryRun: false, merged: 0, considered: 0, branches: [], warnings: [] })
  }, "golden-command", {
    attribution: {
      actor: { principal: { kind: "person", personId: "person-golden" }, executor: null },
      principalSource: { kind: "local-configured", authority: "persons.yaml", authoritySha256: "sha256:golden" },
      executorSource: "none"
    }
  });
  await runEffect(coordinator.enqueue({ opId: "op-golden", entityId: "task/task_GOLDEN", kind: "progress_append" }));
  const failure = await runEffect(Effect.flip(coordinator.flush("explicit")));
  assert.equal(JSON.stringify(failure), golden.queuedCoordinatorError);
});

function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return new Promise((resolve, reject) => {
    Effect.runCallback(effect, {
      onExit: (exit) => exit._tag === "Success" ? resolve(exit.value) : reject(new Error(String(exit.cause)))
    });
  });
}

// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  RepoMaterializerWorker,
  type RepoMaterializerWorkerPort
} from "../../src/runtime/repo-materializer-worker.ts";

const emptyReport = {
  dryRun: false,
  merged: 0,
  considered: 0,
  branches: [],
  warnings: [],
  projectionRebuilt: false,
  attributionEventsProjected: 0
} as const;

test("live materialization overtakes timed-out recovery work still queued in the worker", async () => {
  const port = new ControlledMaterializerWorkerPort();
  const worker = new RepoMaterializerWorker(() => port);

  const activeRecovery = worker.run("/fixture", {}, {}, "recovery");
  const queuedRecovery = worker.run("/fixture", {}, {}, "recovery");
  const liveSettlement = worker.run("/fixture", {}, {}, "foreground");

  assert.deepEqual(port.startedJobIds(), [1]);
  port.complete(1);
  await activeRecovery;
  assert.deepEqual(port.startedJobIds(), [1, 3]);

  port.complete(3);
  await liveSettlement;
  assert.deepEqual(port.startedJobIds(), [1, 3, 2]);

  port.complete(2);
  await queuedRecovery;
  await worker.stop();
});

class ControlledMaterializerWorkerPort implements RepoMaterializerWorkerPort {
  private readonly listeners = new Map<string, Array<(value: unknown) => void>>();
  private readonly posted: unknown[] = [];

  readonly postMessage = (value: unknown): void => {
    this.posted.push(value);
  };

  readonly terminate = async (): Promise<number> => 0;

  readonly on = (event: "message" | "error" | "exit", listener: (value: unknown) => void): this => {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  };

  startedJobIds(): number[] {
    return this.posted.map((message) => Number(
      typeof message === "object" && message !== null && "jobId" in message
        ? message.jobId
        : Number.NaN
    ));
  }

  complete(jobId: number): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ kind: "complete", jobId, report: emptyReport });
    }
  }
}

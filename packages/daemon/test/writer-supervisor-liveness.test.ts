// harness-test-tier: contract
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Worker } from "node:worker_threads";
import type { RepoCellOpenInput } from "../src/repo-cell-open.ts";
import type { RepoCellStatus } from "../src/repo-cell-types.ts";
import {
  REPO_WRITER_PROTOCOL_VERSION,
  type RepoWriterControlV1,
  type RepoWriterStatusV1,
} from "../src/repo-writer-protocol.ts";
import { openWriterSupervisor } from "../src/writer-supervisor.ts";

const supervisorInput = {
  repoId: "writer-liveness",
  rootDir: "/tmp/writer-liveness",
  ownerId: "writer-liveness-test",
} as RepoCellOpenInput;

test("a writer may open beyond 30 seconds when attach progress advances the ready watchdog", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new FakeWriter(),
    published: RepoCellStatus[] = [],
    opening = openWriterSupervisor(supervisorInput, {
      createWorker: () => writer as unknown as Worker,
      onAttachStatus: (status) => published.push(status),
    });

  context.mock.timers.tick(29_999);
  writer.publish(
    writerStatus(
      "attach-progress",
      warmingStatus({ phase: "catching-up", applied: 4_096, total: 8_192, watermark: 4_096 }),
    ),
  );
  context.mock.timers.tick(29_999);
  assert.equal(writer.terminateCalls, 0);
  writer.publish(writerStatus("ready", attachedStatus()));
  writer.publish(
    writerStatus(
      "attach-progress",
      warmingStatus({ phase: "catching-up", applied: 8_192, total: 8_192, watermark: 8_192 }),
    ),
  );

  const supervisor = await opening;
  assert.equal(supervisor.status().state, "attached");
  assert.equal(supervisor.status().generation, 1);
  assert.equal(supervisor.status().attach, undefined);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0]?.attach, {
    phase: "catching-up",
    applied: 4_096,
    total: 8_192,
    watermark: 4_096,
  });
  await supervisor.close();
});

test("a writer with no messages is terminated after 30 seconds of ready inactivity", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new FakeWriter(),
    opening = openWriterSupervisor(supervisorInput, {
      createWorker: () => writer as unknown as Worker,
    }),
    rejected = assert.rejects(opening, /RepoWriterCell did not publish ready/u);

  context.mock.timers.tick(29_999);
  assert.equal(writer.terminateCalls, 0);
  context.mock.timers.tick(1);
  await rejected;
  assert.equal(writer.terminateCalls, 1);
});

class FakeWriter extends EventEmitter {
  terminateCalls = 0;

  postMessage(message: unknown): void {
    if (!isControl(message)) return;
    this.emit("message", {
      schema: "harness-repo-writer-receipt/v1",
      protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
      requestId: message.requestId,
      outcome: "ok",
    });
  }

  publish(message: RepoWriterStatusV1): void {
    this.emit("message", message);
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1;
    return Promise.resolve(0);
  }
}

function writerStatus(kind: RepoWriterStatusV1["kind"], status: RepoCellStatus): RepoWriterStatusV1 {
  return {
    schema: "harness-repo-writer-status/v1",
    protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
    kind,
    status,
  };
}

function warmingStatus(attach: NonNullable<RepoCellStatus["attach"]>): RepoCellStatus {
  return {
    repoId: supervisorInput.repoId,
    rootDir: supervisorInput.rootDir,
    mode: "local",
    state: "warming",
    generation: null,
    queueDepth: 0,
    lastError: null,
    causeClass: null,
    recoveryMs: null,
    attach,
  };
}

function attachedStatus(): RepoCellStatus {
  return {
    repoId: supervisorInput.repoId,
    rootDir: supervisorInput.rootDir,
    mode: "local",
    state: "attached",
    generation: 1,
    queueDepth: 0,
    lastError: null,
    causeClass: null,
    recoveryMs: 1,
  };
}

function isControl(value: unknown): value is RepoWriterControlV1 {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { readonly schema?: unknown }).schema === "harness-repo-writer-control/v1"
  );
}

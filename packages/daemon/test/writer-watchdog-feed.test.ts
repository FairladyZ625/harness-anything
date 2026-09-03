// harness-test-tier: contract
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Worker } from "node:worker_threads";
import type { RepoCellOpenInput } from "../src/repo-cell-open.ts";
import type { RepoCellAttachProgress, RepoCellStatus } from "../src/repo-cell-types.ts";
import type { DaemonStatusResult } from "../src/protocol/daemon-protocol.contract.ts";
import {
  REPO_WRITER_PROTOCOL_VERSION,
  type RepoWriterControlV1,
  type RepoWriterStatusV1,
} from "../src/repo-writer-protocol.ts";
import { openWriterSupervisor } from "../src/writer-supervisor.ts";

const supervisorInput = {
  repoId: "writer-watchdog-feed",
  rootDir: "/tmp/writer-watchdog-feed",
  ownerId: "writer-watchdog-feed-test",
} as RepoCellOpenInput;

test("the daemon status contract carries repository attach progress", () => {
  const attach = { phase: "catching-up", applied: 256, total: 512, watermark: 256 } as const,
    row = warmingStatus(attach) satisfies DaemonStatusResult["repos"][number];
  assert.deepEqual(row.attach, attach);
});

test("an unchanged catch-up watermark does not feed the ready watchdog", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new FakeWriter(),
    opening = openWriterSupervisor(supervisorInput, { createWorker: () => writer as unknown as Worker }),
    rejected = assert.rejects(opening, /30000ms without progress/u),
    progress = { phase: "catching-up", applied: 256, total: 512, watermark: 256 } as const;

  writer.publish(writerStatus("attach-progress", progress));
  context.mock.timers.tick(29_999);
  writer.publish(writerStatus("attach-progress", progress));
  context.mock.timers.tick(1);

  await rejected;
  assert.equal(writer.terminateCalls, 1);
});

test("segmented recovery progress keeps a writer alive beyond the ready threshold", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new FakeWriter(),
    opening = openWriterSupervisor(supervisorInput, { createWorker: () => writer as unknown as Worker });

  for (const applied of [256, 512, 768]) {
    context.mock.timers.tick(29_999);
    writer.publish(
      writerStatus("attach-progress", {
        phase: "recovering",
        applied,
        total: 768,
        watermark: applied,
      }),
    );
    assert.equal(writer.terminateCalls, 0);
  }
  writer.publish(writerStatus("ready", undefined, attachedStatus()));

  const supervisor = await opening;
  assert.equal(supervisor.status().state, "attached");
  assert.equal(writer.terminateCalls, 0);
  await supervisor.close();
});

test("a warming status carrying attach data is not itself a watchdog feed", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new FakeWriter(),
    opening = openWriterSupervisor(supervisorInput, { createWorker: () => writer as unknown as Worker }),
    rejected = assert.rejects(opening, /30000ms without progress/u);

  context.mock.timers.tick(29_999);
  writer.publish(
    writerStatus("status", {
      phase: "recovering",
      applied: 256,
      total: 512,
      watermark: 256,
    }),
  );
  context.mock.timers.tick(1);

  await rejected;
  assert.equal(writer.terminateCalls, 1);
});

test("a regressing attach phase does not feed the ready watchdog", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new FakeWriter(),
    opening = openWriterSupervisor(supervisorInput, { createWorker: () => writer as unknown as Worker }),
    rejected = assert.rejects(opening, /30000ms without progress/u);

  writer.publish(
    writerStatus("attach-progress", {
      phase: "catching-up",
      applied: 256,
      total: 512,
      watermark: 256,
    }),
  );
  context.mock.timers.tick(29_999);
  writer.publish(
    writerStatus("attach-progress", {
      phase: "recovering",
      applied: 512,
      total: 512,
      watermark: 512,
    }),
  );
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

function writerStatus(
  kind: RepoWriterStatusV1["kind"],
  attach?: RepoCellAttachProgress,
  status = warmingStatus(attach),
): RepoWriterStatusV1 {
  return {
    schema: "harness-repo-writer-status/v1",
    protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
    kind,
    status,
  };
}

function warmingStatus(attach?: RepoCellAttachProgress): RepoCellStatus {
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
    materialization: null,
    ...(attach ? { attach } : {}),
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
    materialization: null,
  };
}

function isControl(value: unknown): value is RepoWriterControlV1 {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { readonly schema?: unknown }).schema === "harness-repo-writer-control/v1"
  );
}

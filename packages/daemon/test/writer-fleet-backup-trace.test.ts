// harness-test-tier: contract
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import type { Worker } from "node:worker_threads";
import { fleetBaseBackupTrace } from "@harness-anything/storage";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type {
  RepoWriterControlV1,
  RepoWriterFleetBaseBackupTraceV1,
  RepoWriterRequestV1,
} from "../src/repo-writer-protocol.ts";
import { openWriterSupervisor } from "../src/writer-supervisor.ts";

const context = new AsyncLocalStorage<string>();

test("backup phases retain each request's context and span beyond its receipt", async (t) => {
  const { writer, supervisor, events } = await fixture(t),
    firstArrived = once(writer, "request"),
    first = context.run("first caller", () => supervisor.request("fleetBackup", {})),
    [firstRequest] = (await firstArrived) as [RepoWriterRequestV1],
    secondArrived = once(writer, "request"),
    second = context.run("second caller", () => supervisor.request("fleetBackup", {})),
    [secondRequest] = (await secondArrived) as [RepoWriterRequestV1];

  writer.trace(firstRequest, "start", null);
  writer.trace(secondRequest, "start", null);
  writer.trace(secondRequest, "asyncStart", "second-repo");
  writer.receipt(secondRequest);
  await second;
  writer.trace(firstRequest, "asyncStart", "first-repo");
  writer.receipt(firstRequest);
  await first;
  assert.equal(events.length, 4, "receipt completion does not prematurely end the storage span");
  writer.trace(secondRequest, "end", "second-repo");
  writer.trace(firstRequest, "end", "first-repo");
  writer.trace(firstRequest, "end", "first-repo");

  assert.deepEqual(
    events.map(({ phase, caller, repoId }) => ({ phase, caller, repoId })),
    [
      { phase: "start", caller: "first caller", repoId: null },
      { phase: "start", caller: "second caller", repoId: null },
      { phase: "asyncStart", caller: "second caller", repoId: "second-repo" },
      { phase: "asyncStart", caller: "first caller", repoId: "first-repo" },
      { phase: "end", caller: "second caller", repoId: "second-repo" },
      { phase: "end", caller: "first caller", repoId: "first-repo" },
    ],
  );
  assert.strictEqual(events[0]!.span, events[3]!.span);
  assert.strictEqual(events[0]!.span, events[5]!.span);
  assert.strictEqual(events[1]!.span, events[2]!.span);
  assert.strictEqual(events[1]!.span, events[4]!.span);
  assert.notStrictEqual(events[0]!.span, events[1]!.span);
});

for (const termination of ["exit", "error", "close", "receipt-error", "post-error"] as const) {
  test(`backup trace ends once in its caller context on ${termination}`, async (t) => {
    const { writer, supervisor, events } = await fixture(t);
    if (termination === "post-error") writer.failPost = true;
    const arrived = once(writer, "request"),
      pending = context.run("backup caller", () => supervisor.request("fleetBackup", {})),
      rejected = assert.rejects(pending, /backup failed|exited|closed/u),
      [request] = (await arrived) as [RepoWriterRequestV1];
    if (termination !== "post-error") writer.trace(request, "start", "backup-repo");
    if (termination === "exit") writer.emit("exit", 1);
    else if (termination === "error") {
      writer.emit("error", new Error("backup failed"));
      writer.emit("exit", 1);
    } else if (termination === "close") await supervisor.close();
    else if (termination === "receipt-error") writer.receipt(request, true);
    await rejected;
    writer.trace(request, "end", "backup-repo");
    assert.deepEqual(
      events.map(({ phase, caller }) => ({ phase, caller })),
      [
        { phase: "start", caller: "backup caller" },
        { phase: "end", caller: "backup caller" },
      ],
    );
    assert.strictEqual(events[0]!.span, events[1]!.span);
  });
}

async function fixture(t: import("node:test").TestContext) {
  const writer = new FakeWriter(),
    events: {
      phase: RepoWriterFleetBaseBackupTraceV1["phase"];
      caller: string | undefined;
      repoId: string | null;
      span: object;
    }[] = [];
  for (const phase of ["start", "asyncStart", "end"] as const) {
    const listener = (message: unknown) => {
      const span = message as { repoId: string | null };
      events.push({ phase, caller: context.getStore(), repoId: span.repoId, span });
    };
    fleetBaseBackupTrace[phase].subscribe(listener);
    t.after(() => fleetBaseBackupTrace[phase].unsubscribe(listener));
  }
  // Supervisor and its worker message listener predate the caller's observation context.
  const opening = openWriterSupervisor(
    { repoId: workspaceId("backup-trace"), rootDir: canonicalRoot(process.cwd()), ownerId: "test" },
    { createWorker: () => writer as unknown as Worker },
  );
  writer.emit("message", { schema: "harness-repo-writer-status/v1", protocolVersion: 1, kind: "ready" });
  const supervisor = await opening;
  t.after(() => supervisor.close());
  return { writer, supervisor, events };
}

class FakeWriter extends EventEmitter {
  failPost = false;

  postMessage(message: RepoWriterRequestV1 | RepoWriterControlV1): void {
    if (message.schema === "harness-repo-writer-control/v1") this.receipt(message);
    else {
      this.emit("request", message);
      if (this.failPost) {
        this.trace(message, "start", "backup-repo");
        throw new Error("backup failed");
      }
    }
  }

  trace(request: RepoWriterRequestV1, phase: RepoWriterFleetBaseBackupTraceV1["phase"], repoId: string | null) {
    this.emit("message", {
      schema: "harness-repo-writer-capability-call/v1",
      callId: "trace-notification",
      capability: "fleetBaseBackupTrace",
      payload: { requestId: request.requestId, phase, repoId } satisfies RepoWriterFleetBaseBackupTraceV1,
    });
  }

  receipt(request: { readonly requestId: string }, failed = false): void {
    this.emit("message", {
      schema: "harness-repo-writer-receipt/v1",
      protocolVersion: 1,
      requestId: request.requestId,
      outcome: failed ? "error" : "ok",
      ...(failed ? { error: { name: "Error", message: "backup failed", stack: null, code: null, data: null } } : {}),
    });
  }

  terminate(): Promise<number> {
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

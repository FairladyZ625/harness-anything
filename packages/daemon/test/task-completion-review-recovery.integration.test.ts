// harness-test-tier: integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { readDispatchStream, readDispatchStreamHeaders } from "../src/dispatch-stream.ts";
import { binding as transportBinding } from "../src/daemon-host-binding.ts";
import { listenFleetTls, type FleetAssignmentRecord, type FleetCenterOptions } from "../src/fleet/center.ts";
import { runFleetTaskCommandClient } from "../src/fleet/edge.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";

test(
  "completion provider fallback keeps reviewer role; each exhausted attempt is replaced by the next complete",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(true);
    try {
      await f.install();
      const first = (await f.complete()) as Record<string, unknown>;
      assert.equal(first.code, "review_missing", JSON.stringify(first));
      const exhaustedCount = () =>
        readDispatchStreamHeaders(f.root).filter(
          (header) => readDispatchStream(f.root, header.dispatchId)?.fallbackState === "exhausted",
        ).length;
      for (let attempt = 0; attempt < 500 && exhaustedCount() < 1; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(exhaustedCount(), 1, "fallback must durably settle exhaustion");
      assert.equal(f.launches.length, 2);
      const second = (await f.complete()) as Record<string, unknown>;
      assert.equal(second.code, "review_missing", JSON.stringify(second));
      assert.notEqual(second.dispatchId, first.dispatchId);
      for (let attempt = 0; attempt < 500 && exhaustedCount() < 2; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(exhaustedCount(), 2, "the replacement attempt must also settle its fallback chain");
      assert.equal(f.launches.length, 4);
      const dispatches = f.events().filter((event) => event.type === "runtime_dispatch_requested");
      assert.equal(dispatches.length, 4);
      assert.deepEqual(
        readDispatchStreamHeaders(f.root).map((header) => header.role),
        ["reviewer", "reviewer", "reviewer", "reviewer"],
      );
      assert.equal(dispatches.filter((event) => !event.payload.idempotencyKey.includes(":fallback:")).length, 2);
      assert.equal(f.events().filter((event) => event.type === "review_recorded").length, 0);
      assert.equal(f.events().filter((event) => event.type === "review_consent_recorded").length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "a live fallback continuation still owns the cut; only full exhaustion lets complete re-dispatch",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(1);
    try {
      await f.install();
      const first = (await f.complete()) as Record<string, unknown>;
      assert.equal(first.code, "review_missing", JSON.stringify(first));
      // The root attempt failed; its fallback continuation launched and is still live.
      await f.waitForLaunches(2);
      const during = (await f.complete()) as Record<string, unknown>;
      assert.equal(during.code, "review_missing", JSON.stringify(during));
      assert.equal(f.launches.length, 2, "a live continuation must keep owning the cut");
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 2);
      f.failPending();
      const exhausted = () =>
        readDispatchStreamHeaders(f.root).some(
          (header) => readDispatchStream(f.root, header.dispatchId)?.fallbackState === "exhausted",
        );
      for (let attempt = 0; attempt < 500 && !exhausted(); attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(exhausted(), true, "the continuation chain must settle exhaustion");
      const second = (await f.complete()) as Record<string, unknown>;
      assert.equal(second.code, "review_missing", JSON.stringify(second));
      assert.notEqual(second.dispatchId, first.dispatchId);
      assert.equal(f.launches.length, 3);
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 3);
      // The replacement stays pending (failure budget spent): completion is idempotent against it.
      const stable = (await f.complete()) as Record<string, unknown>;
      assert.equal(stable.dispatchId, second.dispatchId);
      assert.equal(f.launches.length, 3);
    } finally {
      await f.close();
    }
  },
);

test(
  "fleet TLS completions share one reviewer dispatch per attempt, including the exhausted retry",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(1);
    let center: Awaited<ReturnType<typeof listenFleetTls>> | undefined;
    try {
      await f.install();
      const keyFile = path.join(f.root, "tls.key"),
        certFile = path.join(f.root, "tls.crt");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyFile,
          "-out",
          certFile,
          "-subj",
          "/CN=localhost",
          "-days",
          "1",
          "-addext",
          "subjectAltName=DNS:localhost",
        ],
        { stdio: "ignore" },
      );
      const cert = readFileSync(certFile),
        writerEpochStateRoot = path.join(f.root, ".harness", "fixture-writer-epochs"),
        authority = openPersistentWriterEpoch({ stateRoot: writerEpochStateRoot });
      const lease = authority.current("completion-review");
      authority.close();
      assert.ok(lease);
      const assignments: FleetAssignmentRecord[] = ["edge-one", "edge-two"].map((nodeId) => ({
        nodeId,
        assignmentId: `assignment-${nodeId}`,
        repoId: "completion-review",
        viewId: `view-${nodeId}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
        actor: owner.actor,
        scope: { kind: "task", taskId, executionId, paths: [f.packagePath] },
      }));
      const host: FleetCenterOptions["host"] = {
        run: async (repoId, action, auth) => {
          assert.equal(repoId, "completion-review");
          return f.cell().run(action, await transportBinding(f.root, auth));
        },
        read: async () => {
          throw new Error("Unexpected read route");
        },
        runtimeIngress: async () => {
          throw new Error("Unexpected runtime ingress route");
        },
        replica: () => f.cell().replica,
        settleMaterialization: async (_repoId, context) => f.cell().settlePendingMaterialization(context),
        status: () => ({ repos: [f.cell().status()] }) as ReturnType<FleetCenterOptions["host"]["status"]>,
      };
      center = await listenFleetTls({
        host,
        stateRoot: path.join(f.root, "fleet-center"),
        writerEpochStateRoot,
        writerEpochLease: () => lease,
        key: readFileSync(keyFile),
        cert,
        authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
        resolveAssignment: (id) => assignments.find((assignment) => assignment.assignmentId === id) ?? null,
      });
      const results = await Promise.all(
        assignments.map((assignment) =>
          runFleetTaskCommandClient({
            port: center!.port,
            ca: cert,
            servername: "localhost",
            nodeId: assignment.nodeId,
            credential: `secret-${assignment.nodeId}`,
            assignmentId: assignment.assignmentId,
            opId: randomUUID(),
            repoId: assignment.repoId,
            taskId,
            action: { kind: "task-complete", taskId, executionId },
            waitMs: 5_000,
          }),
        ),
      );
      for (const result of results) assert.equal(result.code, "review_missing", JSON.stringify(result));
      assert.equal(results[0]!.receipt?.dispatchId, results[1]!.receipt?.dispatchId);
      assert.equal(typeof results[0]!.receipt?.dispatchId, "string");
      // The root attempt failed its one provider; its fallback continuation is live.
      await f.waitForLaunches(2);
      assert.equal(f.launches.length, 2);
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 2);
      // Once the whole attempt chain is exhausted, concurrent completions still share one replacement.
      f.failPending();
      const exhausted = () =>
        readDispatchStreamHeaders(f.root).some(
          (header) => readDispatchStream(f.root, header.dispatchId)?.fallbackState === "exhausted",
        );
      for (let attempt = 0; attempt < 500 && !exhausted(); attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(exhausted(), true, "the first attempt chain must settle exhaustion");
      const retried = await Promise.all(
        assignments.map((assignment) =>
          runFleetTaskCommandClient({
            port: center!.port,
            ca: cert,
            servername: "localhost",
            nodeId: assignment.nodeId,
            credential: `secret-${assignment.nodeId}`,
            assignmentId: assignment.assignmentId,
            opId: randomUUID(),
            repoId: assignment.repoId,
            taskId,
            action: { kind: "task-complete", taskId, executionId },
            waitMs: 5_000,
          }),
        ),
      );
      for (const result of retried) assert.equal(result.code, "review_missing", JSON.stringify(result));
      assert.equal(retried[0]!.receipt?.dispatchId, retried[1]!.receipt?.dispatchId);
      assert.notEqual(retried[0]!.receipt?.dispatchId, results[0]!.receipt?.dispatchId);
      assert.equal(f.launches.length, 3);
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 3);
      assert.equal(
        f
          .events()
          .filter(
            (event) =>
              event.type === "runtime_dispatch_requested" && !event.payload.idempotencyKey.includes(":fallback:"),
          ).length,
        2,
      );
    } finally {
      await center?.close();
      await f.close();
    }
  },
);

test(
  "a cancelled reviewer dispatch is replaced on the next complete and the replacement review completes the task",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    try {
      await f.install();
      const first = (await f.complete()) as Record<string, unknown>;
      assert.equal(first.code, "review_missing", JSON.stringify(first));
      assert.equal(f.launches.length, 1);
      // Bind the reviewer's provider session first, as a real reviewer has by the time it is cancelled.
      f.bindPending();
      await f.cancel(String(first.runtimeSessionId));
      assert.equal(await f.awaitOutcome(String(first.runtimeSessionId)), "cancelled");
      const second = (await f.complete()) as Record<string, unknown>;
      assert.equal(second.code, "review_missing", JSON.stringify(second));
      assert.notEqual(second.dispatchId, first.dispatchId);
      assert.notEqual(second.runtimeSessionId, first.runtimeSessionId);
      assert.equal(f.launches.length, 2);
      // The replacement now owns the cut: retrying completion must not dispatch yet another reviewer.
      const third = (await f.complete()) as Record<string, unknown>;
      assert.equal(third.dispatchId, second.dispatchId);
      assert.equal(f.launches.length, 2);
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 2);
      const reviewed = await f.review(String(second.runtimeSessionId), "review-replacement");
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const completed = await f.complete(true);
      assert.equal(completed.outcome, "applied", JSON.stringify(completed));
      assert.equal(f.events().filter((event) => event.type === "task_completed").length, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "a changes_requested review returns the task to implementation instead of re-dispatching a reviewer",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    try {
      await f.install();
      const dispatched = (await f.complete()) as Record<string, unknown>;
      assert.equal(dispatched.code, "review_missing", JSON.stringify(dispatched));
      const packet = `${f.packagePath}/artifacts/reports/review-changes.json`;
      mkdirSync(path.dirname(path.join(f.root, "harness", packet)), { recursive: true });
      writeFileSync(
        path.join(f.root, "harness", packet),
        JSON.stringify({
          verdict: "changes_requested",
          reason: "The delivery needs another pass.",
          evidenceChecked: ["closeout.md"],
        }),
      );
      const reviewed = await f.cell().run(
        {
          kind: "task-review-execution",
          taskId,
          executionId,
          reviewId: "review-changes",
          fromFile: `harness/${packet}`,
        },
        {
          actor: {
            principal: owner.actor.principal,
            executor: { kind: "agent", id: `runtime-session:${String(dispatched.runtimeSessionId)}` },
          },
          source: "local",
        },
      );
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const after = (await f.complete()) as Record<string, unknown>;
      assert.equal(after.code, "not_in_review", JSON.stringify(after));
      assert.equal(f.launches.length, 1, "a recorded review verdict must not be replaced by a fresh dispatch");
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 1);
    } finally {
      await f.close();
    }
  },
);

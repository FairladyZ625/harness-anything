// harness-test-tier: integration
import assert from "node:assert/strict";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { appendRuntimeWorkerRecord, readDispatchStream } from "../src/dispatch-stream.ts";
import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";
import { listenFleetTls } from "../src/fleet/center.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { withEdgeReadModel } from "../src/fleet-edge-task-read.ts";
import { readScheduleRuns } from "../src/schedule-runs-read.ts";
import { readEdgeRuntimeResultBytes } from "../src/runtime-result-read.ts";
import { fleetFixture, localAuthFixture } from "./fleet-runtime-recovery.fixtures.ts";
import { definition, eventually, initHarnessRepo, scheduleRuntimePorts } from "./schedule-actions.fixtures.ts";

for (const restart of [false, true])
  test(`Schedule terminal settlement recovers on its claim (restart=${restart})`, { timeout: 60_000 }, async (t) => {
    const installation = {
      installationId: definition.installationId,
      kindId: definition.kindId,
      executablePath: process.execPath,
      version: "fixture",
      observedAt: "2026-09-12T00:00:00.000Z",
    };
    const fixture = await fleetFixture(t, ["agents", "schedules"], [installation], "remote-center");
    t.after(() => fixture.close());
    const instance = await fixture.host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        kind: "runtime-instance-create",
        instanceId: definition.instanceId,
        name: "Schedule test",
        kindId: definition.kindId,
        installationId: definition.installationId,
        providerId: definition.providerId,
        models: [definition.model],
        authMode: "subscription",
      },
      localAuthFixture(),
    );
    assert.equal(instance.outcome, "applied", JSON.stringify(instance));
    const packageSource = path.join(fixture.repo, "source/schedule-agent");
    mkdirSync(packageSource, { recursive: true });
    writeFileSync(
      path.join(packageSource, "agent.json"),
      JSON.stringify({
        schema: "agent-declaration/v1",
        id: "recovery-agent",
        name: "Recovery Agent",
        instructions: "Check state.",
        runtimes: [{ type: "codex" }],
        role: "worker",
      }),
    );
    const installed = await fixture.host.run(
      fixture.subject.repoId,
      { kind: "agent-install", packageSource, expectedVersion: 0, idempotencyKey: "recovery-agent" },
      localAuthFixture(),
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    const scheduleId = "recovery-schedule";
    const subject = { nodeId: fixture.subject.nodeId, repoId: fixture.subject.repoId };
    const outcomeArrived = Promise.withResolvers<void>(),
      releaseOutcome = Promise.withResolvers<void>();
    t.after(() => releaseOutcome.resolve());
    const startCenter = (port?: number) =>
      fixture.hold(
        listenFleetTls({
          host: {
            ...fixture.host,
            runtimeIngress: async (...args) => {
              if (args[1].kind === "event" && args[1].type === "runtime_session_outcome_observed") {
                outcomeArrived.resolve();
                await releaseOutcome.promise;
              }
              return fixture.host.runtimeIngress(...args);
            },
          },
          stateRoot: fixture.stateRoot,
          ...fixture.writerOptions,
          key: fixture.key,
          cert: fixture.cert,
          port,
          replicaDiskQuotaBytes: 64 * 1024 * 1024,
          authenticate: (nodeId, credential) =>
            [subject.nodeId, "node-two"].includes(nodeId) && credential === "machine-secret",
          nodeOwner: fixture.owners.nodeOwner,

          nodeSubject: fixture.owners.nodeSubject,
          onError: ({ error }) => t.diagnostic(`center publication: ${String(error)}`),
        }),
      );
    const center = await startCenter();
    const workspaceRoot = path.join(fixture.root, "schedule-edge");
    initHarnessRepo(workspaceRoot, "fleet");
    const reportBody = "完整 schedule result\n".repeat(6000) + "HARNESS-OUTCOME: succeeded";
    let terminal: (() => void) | undefined;
    const createRuntime = () =>
      openFleetEdgeRuntime({
        request: {
          host: "127.0.0.1",
          port: center.port,
          caPath: fixture.certFile,
          servername: "localhost",
          nodeId: subject.nodeId,
          credential: "machine-secret",
          repoId: subject.repoId,
          viewRoot: path.join(fixture.root, "schedule-view"),
          quotaBytes: 64 * 1024 * 1024,
          workspaceRoot,
          method: "repo.schedule.run",
          action: {},
        },
        daemonGeneration: 1,
        daemonRoute: {
          userRoot: path.join(fixture.root, "schedule-user"),
          daemonId: "schedule-edge",
          endpoint: path.join(fixture.root, "schedule.sock"),
        },
        ports: scheduleRuntimePorts(),
        launch: () => {
          let output: ((chunk: string, persisted?: boolean) => void) | undefined;
          return {
            pid: 81235,
            onOutput: (listener) => {
              output = listener;
            },
            onErrorOutput: () => undefined,
            onExit: (listener) => {
              terminal = () => {
                const frames = [
                  { type: "thread.started", thread_id: "schedule-recovery-provider" },
                  {
                    type: "item.completed",
                    item: { id: "final", type: "agent_message", text: reportBody },
                  },
                  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
                ];
                // Match runtime-worker-host: raw provider output and exit are durable before callbacks.
                for (const event of frames)
                  appendRuntimeWorkerRecord(workspaceRoot, String(launched.dispatchId), {
                    kind: "provider_event",
                    occurredAt: new Date().toISOString(),
                    event,
                  });
                appendRuntimeWorkerRecord(workspaceRoot, String(launched.dispatchId), {
                  kind: "process_exit",
                  occurredAt: new Date().toISOString(),
                  exitCode: 0,
                  signal: null,
                });
                for (const frame of frames) output?.(JSON.stringify(frame) + "\n", true);
                listener(0);
              };
            },
            terminate: () => undefined,
          };
        },
      });
    let runtime = createRuntime();
    fixture.track(() => runtime.close());
    const created = await runtime.run("repo.schedule.run", {
      kind: "schedule-create",
      scheduleId,
      name: "Recovery",
      mode: "detect",
      everyMs: 300_000,
      agentId: "recovery-agent",
      mission: "Check state.",
      idempotencyKey: "create-recovery",
    });
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const launched = await runtime
      .run("repo.schedule.run", { kind: "schedule-run-now", scheduleId, idempotencyKey: "run-recovery" })
      .catch(async (error: unknown) => {
        t.diagnostic(
          JSON.stringify(
            await fixture.host.run(subject.repoId, { kind: "schedule-show", scheduleId }, localAuthFixture()),
          ),
        );
        throw error;
      });
    assert.equal(launched.outcome, "applied", JSON.stringify(launched));
    assert.ok(terminal);
    appendRuntimeWorkerRecord(workspaceRoot, String(launched.dispatchId), {
      kind: "process_started",
      occurredAt: new Date().toISOString(),
      pid: 81235,
    });
    let reportFailure!: () => void;
    const failure = new Promise<void>((resolve) => {
      reportFailure = resolve;
    });
    t.mock.method(console, "error", (...args: unknown[]) => {
      if (String(args[0]).includes("[fleet-edge-runtime]")) reportFailure();
    });
    await center.close();
    terminal();
    await failure;
    if (restart) {
      runtime.close();
      runtime = createRuntime();
    }
    const restoredCenter = await startCenter(center.port);
    const recovery = runtime.reconcile();
    const recovered = Promise.allSettled([recovery]);
    const observerRoot = path.join(fixture.root, "schedule-reader-view");
    await outcomeArrived.promise;
    try {
      // Settlement has reached the center, but the outcome's claim and bytes cannot
      // append until this barrier opens. A second node must still receive a complete cut.
      const events = makeTaskEventReader({ repoId: subject.repoId, rootDir: fixture.repo }).read().events;
      assert.ok(events.some((event) => event.type === "schedule_run_settled"));
      assert.equal(
        events.some((event) => event.type === "runtime_session_outcome_observed"),
        false,
      );
      await runFleetReplicaPullClient({
        host: "127.0.0.1",
        port: restoredCenter.port,
        ca: fixture.cert,
        servername: "localhost",
        nodeId: "node-two",
        credential: "machine-secret",
        repoId: subject.repoId,
        viewRoot: observerRoot,
        diskQuotaBytes: 64 * 1024 * 1024,
      });
      const pending = withEdgeReadModel(
        {
          viewRoot: observerRoot,
          repoId: subject.repoId,
          nodeId: "node-two",
          principalId: `machine:node-two:${await fixture.owners.nodeSubject("node-two")}`,
        },
        (projection) => readScheduleRuns({ projection }, scheduleId),
      );
      assert.equal(pending.runs[0]?.outcome, "succeeded");
      assert.equal(pending.runs[0]?.reportRef, null);
      assert.equal(pending.runs[0]?.reportText, null);
      t.diagnostic(
        `barrier cut revision=${events.at(-1)?.workspaceRevision}: settled schedule, no outcome, no dangling result`,
      );
    } finally {
      releaseOutcome.resolve();
      await recovered;
    }
    await recovery;
    let shown = await runtime.run("repo.schedule.run", { kind: "schedule-show", scheduleId });
    assert.equal(
      await eventually(async () => {
        await runtime.reconcile();
        // This fixture owns no background sync loop. Refresh the completed cut explicitly;
        // schedule-show itself must never pull or trigger terminal publication.
        await fixture.host.replica(subject.repoId).waitForCut(fixture.eventCount());
        await runFleetReplicaPullClient({
          port: restoredCenter.port,
          ca: fixture.cert,
          servername: "localhost",
          nodeId: subject.nodeId,
          credential: "machine-secret",
          repoId: subject.repoId,
          viewRoot: path.join(fixture.root, "schedule-view"),
          diskQuotaBytes: 64 * 1024 * 1024,
        });
        shown = await runtime.run("repo.schedule.run", { kind: "schedule-show", scheduleId });
        return (shown.schedule as { status: { activeRun: unknown } }).status.activeRun === null;
      }),
      true,
      `terminal settlement becomes visible locally: ${JSON.stringify(shown)}`,
    );
    assert.equal((shown.schedule as { status: { activeRun: unknown } }).status.activeRun, null, JSON.stringify(shown));
    assert.equal(
      (shown.schedule as { status: { lastRun: { claimFence: string } } }).status.lastRun.claimFence,
      launched.claimFence,
    );
    const observed = readDispatchStream(workspaceRoot, String(launched.dispatchId));
    t.diagnostic(
      JSON.stringify({
        process: observed?.process,
        outcome: observed?.attemptOutcome,
        provider: observed?.providerSessionId,
      }),
    );
    assert.equal(
      (shown.schedule as { status: { lastRun: { outcome: string } } }).status.lastRun.outcome,
      "succeeded",
      JSON.stringify(shown),
    );
    const outcomes = () =>
      makeTaskEventReader({ repoId: subject.repoId, rootDir: fixture.repo })
        .read()
        .events.filter(
          (event) =>
            event.type === "runtime_session_outcome_observed" &&
            event.payload.runtimeSessionId === launched.runtimeSessionId,
        );
    // Schedule settlement precedes the runtime terminal events. Observe the whole
    // recovery before measuring whether a subsequent read adds another event.
    assert.equal(await eventually(async () => outcomes().length > 0), true);
    assert.equal(outcomes().length, 1, "recovery publishes one runtime outcome");
    const revision = fixture.eventCount();
    const again = await runtime.run("repo.schedule.run", { kind: "schedule-show", scheduleId });
    assert.deepEqual(
      again.schedule,
      shown.schedule,
      "recovery and subsequent reads do not replace or duplicate settlement",
    );
    assert.equal(fixture.eventCount(), revision, "a recovered claim must not settle again");
    await fixture.host.replica(subject.repoId).waitForCut(fixture.eventCount());
    await runFleetReplicaPullClient({
      host: "127.0.0.1",
      port: restoredCenter.port,
      ca: fixture.cert,
      servername: "localhost",
      nodeId: "node-two",
      credential: "machine-secret",
      repoId: subject.repoId,
      viewRoot: observerRoot,
      diskQuotaBytes: 64 * 1024 * 1024,
    });
    await restoredCenter.close();
    const result = withEdgeReadModel(
      {
        viewRoot: observerRoot,
        repoId: subject.repoId,
        nodeId: "node-two",
        principalId: `machine:node-two:${await fixture.owners.nodeSubject("node-two")}`,
      },
      (projection) =>
        readScheduleRuns(
          {
            projection,
            store: {
              readContentBlob: (sha) => readEdgeRuntimeResultBytes(observerRoot, subject.repoId, "node-two", sha),
            },
          },
          scheduleId,
        ),
    );
    assert.equal(
      result.runs[0]?.reportText,
      reportBody,
      "a reader node without owner stream reads the full uploaded schedule result while offline",
    );
    t.diagnostic(`B offline schedule report bytes=${Buffer.byteLength(reportBody)} from the accepted result cut`);
  });

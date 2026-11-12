import { readTaskDispatchRow } from "../../src/dispatch-read.ts";
import assert from "node:assert/strict";
import { createReadFixtureRuntime } from "./g38-read-runtime.mjs";
import { adoptRuntimes, sweepSettledRuntimeTempDirectories } from "../../src/runtime-spawn-adoption.ts";
import { HOST_READ_PROBES } from "./g38-read-host-probes.mjs";
import { METHOD_READ_PROBES, PROJECTION_READ_PROBES } from "./g38-read-method-probes.mjs";
import { COMMAND_READ_PROBES, ACTION_METHOD_READ_PROBES } from "./g38-read-command-probes.mjs";
import { openReadBackend } from "./g38-read-backend.mjs";
import { READ_SESSION_ID, READ_ACTIVE_SESSION_ID, READ_TASK_ID, HISTORY_OUTPUT_TASK_ID } from "./g38-read-ledger.mjs";
import { prepareLegacyAudit, runLegacyAudit } from "./g38-read-legacy.mjs";

const now = () => "2026-11-05T00:00:00Z";
export const READ_PROBES = Object.freeze({
  ...HOST_READ_PROBES,
  ...COMMAND_READ_PROBES,
  ...ACTION_METHOD_READ_PROBES,
  ...METHOD_READ_PROBES,
  ...PROJECTION_READ_PROBES,
  "projection-recovery": {
    reads: ["background:projection-recovery"],
    sourceAudit: {
      inputCollection: "canonical replay events",
      maxPerInput: {
        sqliteVmSteps: 4096,
        sqliteScanPages: 256,
        sqlRowsRead: 32,
        sqlResultBytes: 32768,
        sha256Calls: 32,
        sha256Bytes: 32768,
        gitProcesses: 4,
        fileReadBytes: 16384,
        directoryEntries: 8,
      },
    },
    run: ({ projection }) => projection.rebuild(),
    size: () => 1,
  },
  "ledger-reconcile": {
    reads: ["command:ledger-reconcile"],
    prepare: prepareLegacyAudit,
    run: runLegacyAudit,
    sourceAudit: {
      inputCollection: "immutable generation-1 source events",
      // The full audit compares each source event, outcome and content claim. Ceilings
      // bound these visits and encoded event bytes; they do not apply to projection reads.
      maxPerInput: {
        sqliteVmSteps: 4096,
        sqliteScanPages: 256,
        sqlRowsRead: 16,
        sqlResultBytes: 16384,
        sha256Calls: 32,
        sha256Bytes: 32768,
        gitProcesses: 4,
        fileReadBytes: 16384,
        directoryEntries: 8,
      },
    },
    size: () => 1,
  },
  "runtime-overview-default": {
    reads: ["command:runtime-status", "method:repo.agentRuntime.overview"],
    run: ({ runtime }) => runtime.read("repo.agentRuntime.overview", {}),
    size: (result) => result.sessions.length,
  },
  "runtime-overview-page": {
    reads: ["command:runtime-status", "method:repo.agentRuntime.overview"],
    run: ({ runtime }) => runtime.read("repo.agentRuntime.overview", { limit: 1 }),
    size: (result) => result.sessions.length,
  },
  "runtime-overview": {
    reads: ["command:runtime-status", "method:repo.agentRuntime.overview"],
    run: ({ runtime }) => runtime.read("repo.agentRuntime.overview", { taskId: "task-parity" }),
    size: (value) => value.sessions.length,
  },
  "runtime-attach": {
    reads: ["method:repo.agentRuntime.attach"],
    run: async ({ runtime }) => {
      const subscription = await runtime.attach(READ_ACTIVE_SESSION_ID, "stream:0");
      try {
        assert.equal(subscription.initial.ok, true);
        return subscription.initial;
      } finally {
        subscription.detach();
      }
    },
    size: () => 1,
  },
  "runtime-session": {
    reads: ["method:repo.agentRuntime.sessions.read"],
    run: ({ runtime }) => runtime.read("repo.agentRuntime.sessions.read", { runtimeSessionId: READ_SESSION_ID }),
    size: (value) => Number(value.session !== null),
  },
  "runtime-events": {
    reads: ["method:repo.agentRuntime.events.read"],
    run: ({ runtime }) =>
      runtime.read("repo.agentRuntime.events.read", { runtimeSessionId: READ_SESSION_ID, afterCursor: "lifecycle:0" }),
    size: (value) => value.events.length,
  },
  "dispatch-point": {
    reads: ["command:task-dispatches", "method:repo.task.dispatches"],
    run: ({ projection }) => {
      const event = projection.readRuntimeDispatch(READ_SESSION_ID);
      assert.ok(event, "point read fixture must contain a dispatch");
      return { ok: true, dispatch: readTaskDispatchRow(projection, event) };
    },
    size: () => 1,
  },
  "task-dispatches-page": {
    reads: ["command:task-dispatches", "method:repo.task.dispatches"],
    run: ({ runtime }) => runtime.read("repo.task.dispatches", { taskIds: ["task-parity"], limit: 1 }),
    size: (value) => value.dispatches.length,
  },
  "task-dispatches": {
    reads: ["command:task-dispatches", "method:repo.task.dispatches"],
    run: ({ runtime }) => runtime.read("repo.task.dispatches", { taskId: "task-parity" }),
    size: (value) => value.dispatches.length,
  },
  "task-list": {
    reads: ["method:repo.tasks.list"],
    run: ({ runtime }) => runtime.read("repo.tasks.list", { limit: 1 }),
    size: (value) => value.rows.length,
  },
  agenda: {
    reads: ["command:agenda", "method:repo.agenda.read"],
    run: ({ runtime }) => runtime.read("repo.agenda.read", { limit: 1 }),
    size: (value) => value.attentionItems.length,
  },
  "workspace-summary": {
    reads: ["method:repo.workspace.summary.read"],
    run: ({ runtime }) => runtime.read("repo.workspace.summary.read"),
    size: () => 1,
  },
  "document-point": {
    reads: ["method:repo.tasks.document.read"],
    run: ({ runtime }) =>
      runtime.read("repo.tasks.document.read", { taskId: READ_TASK_ID, path: "artifacts/selected.md" }),
    size: (value) => {
      assert.equal(value.body, "Selected output\n");
      return 1;
    },
  },
  "output-point-same-task": {
    reads: ["method:repo.tasks.document.read"],
    run: ({ runtime }) =>
      runtime.read("repo.tasks.document.read", { taskId: HISTORY_OUTPUT_TASK_ID, path: "artifacts/selected.md" }),
    size: (value) => {
      assert.equal(value.body, "Selected historical task output\n");
      return 1;
    },
  },
  "document-prefix": {
    reads: ["method:repo.tasks.documents.list"],
    run: ({ runtime }) => runtime.read("repo.tasks.documents.list", { taskId: READ_TASK_ID }),
    size: (value) => value.documents.length,
  },
  "relation-page": {
    reads: ["command:relation-list", "method:repo.triadic.relationGraph"],
    run: ({ runtime }) =>
      runtime.read("repo.triadic.relationGraph", {
        facet: "edges",
        relationType: "assigned-to",
        state: "active",
        limit: 1,
      }),
    size: (value) => value.edges.length,
  },
  "relation-page-all-visible": {
    reads: ["command:relation-list", "method:repo.triadic.relationGraph"],
    dimensions: ["relations"],
    backends: ["pglite"],
    run: ({ runtime }) =>
      runtime.read("repo.triadic.relationGraph", {
        facet: "edges",
        relationType: "depends-on",
        state: "active",
        limit: 1,
      }),
    size: (value) => value.edges.length,
  },
  "relation-page-low-visibility": {
    reads: ["command:relation-list", "method:repo.triadic.relationGraph"],
    dimensions: ["relation-visibility"],
    backends: ["pglite"],
    run: ({ runtime }) =>
      runtime.read("repo.triadic.relationGraph", {
        facet: "edges",
        relationType: "depends-on",
        state: "active",
        limit: 1,
      }),
    size: (value) => value.edges.length,
  },
  "relation-freshness-page": {
    // Freshness derives permission-scoped witnesses before filtering and paging.
    // The unfiltered relation-page probe does not exercise that scan.
    reads: ["command:relation-list"],
    run: ({ runtime }) =>
      runtime.run(
        { kind: "relation-list", relationType: "depends-on", state: "active", freshness: "suspect", limit: 1 },
        runtime.binding,
      ),
    size: (value) => JSON.parse(value.evidence).rows.length,
  },
  "startup-adopt": {
    reads: ["background:startup-adopt"],
    run: ({ recovery }) => adoptRuntimes(recovery),
    size: (value) => value.filter(({ outcome }) => outcome === "ready").length,
  },
  "startup-temp-sweep": {
    reads: ["background:startup-temp-sweep"],
    run: ({ recovery }) => sweepSettledRuntimeTempDirectories(recovery),
    size: () => 0,
  },
});

export async function measureReadScale(
  backend,
  dimension,
  size,
  { probeIds = Object.keys(READ_PROBES), wholeClassControl = false, quadraticArchiveControl = false } = {},
) {
  const started = performance.now();
  const fixture = await openReadBackend(backend, dimension, size, {
    lowVisibility: dimension === "relation-visibility",
    allVisible: dimension === "relations",
  });
  const seededAt = performance.now();
  console.log(JSON.stringify({ g38Seed: { backend, dimension, size, durationMs: seededAt - started } }));
  // Both backends run exactly the same read business logic. The reader injection replaces
  // only the connection owner, so a PG query cannot accidentally be measured on SQLite.
  let runtime;
  try {
    runtime = await createReadFixtureRuntime(fixture, now);
  } catch (error) {
    await fixture.close();
    throw error;
  }
  const context = {
    ...fixture,
    ...(quadraticArchiveControl ? { archiveReadRepeats: size / 100 } : {}),
    runtime,
    recovery: {
      input: {
        rootDir: fixture.rootDir,
        runtimeInstances: () => [],
        listRuntimeTempSessionIds: () => [READ_SESSION_ID],
        reclaimSettledRuntimeTempDirectories: () => [],
      },
      requiredRuntimeProjection: () => fixture.projection,
      processes: new Map(),
      exiting: new Map(),
      ownsModelSlot: (id) => id === READ_SESSION_ID || id === READ_ACTIVE_SESSION_ID,
    },
  };
  const measurements = {},
    errors = [];
  try {
    for (const id of probeIds) {
      try {
        const probe = READ_PROBES[id];
        const probeStarted = performance.now();
        if (process.env.FLEET_STRESS_G38_TRACE === "1")
          console.log(JSON.stringify({ g38Probe: { backend, dimension, size, id } }));
        await probe.prepare?.(context, dimension, size);
        const run =
          wholeClassControl && id === "document-point"
            ? () => {
                if (dimension === "runtime-sessions") fixture.projection.readRuntimeSessions();
                else fixture.projection.readDocuments("");
                return probe.run(context);
              }
            : () => probe.run(context);
        // Warm-up matches G1's steady-state contract. Bootstrap/adoption is also tested cold
        // by the firstCall measurement; a warm cache must not hide a startup scan.
        fixture.reset();
        const first = await run(),
          firstCall = fixture.snapshot();
        fixture.reset();
        const result = await run(),
          counts = fixture.snapshot();
        assert.ok(result?.ok !== false, `${id} returned a failed read: ${JSON.stringify(result)}`);
        assert.ok(
          result?.ok === true || !["failed", "op_rejected", "indeterminate"].includes(result?.outcome),
          `${id} did not execute successfully: ${JSON.stringify(result)}`,
        );
        measurements[id] = {
          size,
          ...(probe.sourceAudit ? { inputSize: size } : {}),
          resultSize: probe.size(result),
          counts,
          firstCall,
          firstResultSize: probe.size(first),
          durationMs: performance.now() - probeStarted,
        };
      } catch (error) {
        errors.push(new Error(`${backend}/${dimension}/${id}: ${error.message}`, { cause: error }));
      }
    }
    if (errors.length)
      throw Object.assign(new AggregateError(errors, errors.map((error) => error.message).join("\n")), {
        measurements,
      });
    console.log(
      JSON.stringify({
        g38Timing: {
          backend,
          dimension,
          size,
          seedMs: seededAt - started,
          probeMs: performance.now() - seededAt,
          probes: probeIds.length,
        },
      }),
    );
    return measurements;
  } finally {
    await runtime.close();
    await fixture.close();
  }
}

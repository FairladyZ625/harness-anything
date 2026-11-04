import assert from "node:assert/strict";
import { createReadFixtureRuntime } from "./g38-read-runtime.mjs";
import { adoptRuntimes, sweepSettledRuntimeTempDirectories } from "../../src/runtime-spawn-adoption.ts";
import { HOST_READ_PROBES } from "./g38-read-host-probes.mjs";
import { METHOD_READ_PROBES, PROJECTION_READ_PROBES } from "./g38-read-method-probes.mjs";
import { COMMAND_READ_PROBES, ACTION_METHOD_READ_PROBES } from "./g38-read-command-probes.mjs";
import { openReadBackend } from "./g38-read-backend.mjs";
import { READ_SESSION_ID, READ_TASK_ID } from "./g38-read-ledger.mjs";
import { prepareLegacyAudit } from "./g38-read-legacy.mjs";

const now = () => "2026-11-05T00:00:00Z";
export const READ_PROBES = Object.freeze({
  ...HOST_READ_PROBES,
  ...COMMAND_READ_PROBES,
  ...ACTION_METHOD_READ_PROBES,
  ...METHOD_READ_PROBES,
  ...PROJECTION_READ_PROBES,
  "ledger-reconcile": {
    reads: ["command:ledger-reconcile"],
    prepare: prepareLegacyAudit,
    run: ({ runtime }) => runtime.run({ kind: "ledger-reconcile", generation: 1 }, runtime.binding),
    size: () => 1,
  },
  "runtime-overview-default": {
    reads: ["command:runtime-status", "method:repo.agentRuntime.overview"],
    run: ({ runtime }) => runtime.read("repo.agentRuntime.overview", {}),
    size: (result) => result.sessions.length,
  },
  "runtime-overview": {
    reads: ["command:runtime-status", "method:repo.agentRuntime.overview"],
    run: ({ runtime }) => runtime.read("repo.agentRuntime.overview", { taskId: "task-parity" }),
    size: (value) => value.sessions.length,
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
    size: () => 1,
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
  { probeIds = Object.keys(READ_PROBES), wholeClassControl = false } = {},
) {
  const fixture = await openReadBackend(backend, dimension, size);
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
    runtime,
    recovery: {
      input: { rootDir: fixture.rootDir, reclaimSettledRuntimeTempDirectories: () => [] },
      requiredRuntimeProjection: () => fixture.projection,
      processes: new Map(),
      exiting: new Map(),
      ownsModelSlot: (id) => id === READ_SESSION_ID,
    },
  };
  const measurements = {},
    errors = [];
  try {
    for (const id of probeIds) {
      try {
        const probe = READ_PROBES[id];
        await probe.prepare?.(context, dimension, size);
        const run =
          wholeClassControl && id === "document-point"
            ? () => {
                fixture.projection.readDocuments("");
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
          resultSize: probe.size(result),
          counts,
          firstCall,
          firstResultSize: probe.size(first),
        };
      } catch (error) {
        errors.push(new Error(`${backend}/${dimension}/${id}: ${error.message}`, { cause: error }));
      }
    }
    if (errors.length)
      throw Object.assign(new AggregateError(errors, errors.map((error) => error.message).join("\n")), {
        measurements,
      });
    return measurements;
  } finally {
    await runtime.close();
    await fixture.close();
  }
}

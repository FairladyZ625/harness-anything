import type { TaskProjection } from "@harness-anything/kernel";
import { runtimeSessionOutcomeFromEvidence } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { readDispatchStreamHeaders, readDispatchStreamSummary } from "../src/daemon-host/dispatch-stream.ts";
import { lifecycleReadForSync } from "./dispatch-lifecycle-read.fixtures.ts";

/** Publish the seeded analytics cases as canonical read-port fixtures as well as transcript data. */
export function tokenUsageProjection(
  rootDir: string,
): Pick<TaskProjection, "readRuntimeDispatchPage" | "readDispatchLifecycle"> {
  return {
    readRuntimeDispatchPage: ({ startedAtGte, cursor, limit }) => {
      const sinceMs = Date.parse(startedAtGte),
        afterMs = cursor ? Date.parse(cursor.startedAt) : -Infinity,
        rows = readDispatchStreamHeaders(rootDir, true)
          .filter((header) => {
            const startedMs = Date.parse(header.startedAt);
            if (Number.isFinite(sinceMs) && startedMs < sinceMs) return false;
            if (cursor && (startedMs < afterMs || (startedMs === afterMs && header.dispatchId <= cursor.dispatchId)))
              return false;
            return true;
          })
          .sort(
            (left, right) =>
              Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
              left.dispatchId.localeCompare(right.dispatchId),
          )
          .map((header, index) => {
            const summary = readDispatchStreamSummary(rootDir, header.dispatchId),
              terminal = summary?.terminalOutcome?.payload;
            return {
              event: {
                schema: "agent-runtime-event/v1" as const,
                eventId: header.dispatchId,
                workspaceRevision: index + 1,
                opId: header.dispatchId,
                actor: { principal: { personId: "fixture" }, executor: null },
                source: "local" as const,
                occurredAt: header.startedAt,
                type: "runtime_dispatch_requested" as const,
                payload: {
                  dispatchId: header.dispatchId,
                  runtimeSessionId: header.runtimeSessionId,
                  instanceId: header.instanceId,
                  installationId: "installation-fixture",
                  kindId: header.kindId ?? "",
                  dispatchKey: header.dispatchId,
                  definitionSnapshotRef: "artifact:runtime-definition/fixture",
                  startedAt: header.startedAt,
                  ...(header.taskId === null ? {} : { taskId: header.taskId }),
                  ...(header.executionId === null ? {} : { executionId: header.executionId }),
                  ...(header.agentId ? { agentId: header.agentId } : {}),
                  ...(header.agentName ? { agentName: header.agentName } : {}),
                  ...(header.squadId ? { squadId: header.squadId } : {}),
                  definitionSnapshot: {
                    schema: "agent-definition-snapshot/v1" as const,
                    configVersion: 1,
                    instanceId: header.instanceId,
                    installationId: "installation-fixture",
                    kindId: header.kindId ?? "",
                    providerId: "fixture",
                    model: header.model ?? "",
                    reasoningEffort: null,
                    endpointKind: "official" as const,
                    baseUrlHash: null,
                    authMode: "subscription" as const,
                  },
                },
              },
              metrics: terminal?.runtimeMetrics ?? null,
              endedAt: terminal?.endedAt ?? null,
              outcome: terminal ? runtimeSessionOutcomeFromEvidence(terminal) : null,
            };
          }),
        page = rows.slice(0, limit),
        last = page.at(-1)?.event.payload,
        done = rows.length <= limit;
      return {
        rows: page,
        done,
        nextCursor: !done && last ? { startedAt: last.startedAt ?? "", dispatchId: last.dispatchId } : null,
      };
    },
    readDispatchLifecycle: (query) =>
      lifecycleReadForSync(
        readDispatchStreamHeaders(rootDir, true).map((header) => {
          const summary = readDispatchStreamSummary(rootDir, header.dispatchId),
            terminal = summary?.terminalOutcome?.payload;
          return {
            dispatchId: header.dispatchId,
            runtimeSessionId: header.runtimeSessionId,
            attemptSettled: summary?.process?.exited === true,
            process: summary?.process?.exited ? "exited" : "unknown",
            outcome: terminal ? runtimeSessionOutcomeFromEvidence(terminal) : "unknown",
          };
        }),
      )(query),
  };
}

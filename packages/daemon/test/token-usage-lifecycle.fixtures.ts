import type { TaskProjection } from "@harness-anything/kernel";
import { runtimeSessionOutcomeFromEvidence } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { readDispatchStreamHeaders, readDispatchStreamSummary } from "../src/daemon-host/dispatch-stream.ts";
import { lifecycleReadForSync } from "./dispatch-lifecycle-read.fixtures.ts";

/** Publish the seeded analytics cases as canonical read-port fixtures as well as transcript data. */
export function tokenUsageProjection(
  rootDir: string,
): Pick<TaskProjection, "readRuntimeDispatchPage" | "readDispatchLifecycle"> {
  return {
    readRuntimeDispatchPage: ({
      taskIds,
      agentId,
      squadId,
      personId,
      startedAtGte,
      startedAtLte,
      order = "asc",
      maxRevision,
      cursor,
      limit,
    }) => {
      const sinceMs = Date.parse(startedAtGte),
        untilMs = startedAtLte === undefined ? Infinity : Date.parse(startedAtLte),
        cursorMs = cursor ? Date.parse(cursor.startedAt) : order === "asc" ? -Infinity : Infinity,
        allRows = readDispatchStreamHeaders(rootDir, true).map((header, index) => {
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
        rows = allRows
          .filter((row) => {
            const payload = row.event.payload,
              startedMs = Date.parse(payload.startedAt ?? row.event.occurredAt);
            if (taskIds !== undefined && (!payload.taskId || !taskIds.includes(payload.taskId))) return false;
            if (agentId !== undefined && payload.agentId !== agentId) return false;
            if (squadId !== undefined && payload.squadId !== squadId) return false;
            if (personId !== undefined && row.event.actor.principal.personId !== personId) return false;
            if (maxRevision !== undefined && row.event.workspaceRevision > maxRevision) return false;
            if (Number.isFinite(sinceMs) && startedMs < sinceMs) return false;
            if (Number.isFinite(untilMs) && startedMs > untilMs) return false;
            if (cursor) {
              const cmpId = Buffer.compare(Buffer.from(payload.dispatchId), Buffer.from(cursor.dispatchId));
              if (order === "asc") {
                if (startedMs < cursorMs || (startedMs === cursorMs && cmpId <= 0)) return false;
              } else {
                if (startedMs > cursorMs || (startedMs === cursorMs && cmpId <= 0)) return false;
              }
            }
            return true;
          })
          .sort((left, right) => {
            const leftMs = Date.parse(left.event.payload.startedAt ?? left.event.occurredAt),
              rightMs = Date.parse(right.event.payload.startedAt ?? right.event.occurredAt),
              time = order === "asc" ? leftMs - rightMs : rightMs - leftMs;
            return (
              time ||
              Buffer.compare(Buffer.from(left.event.payload.dispatchId), Buffer.from(right.event.payload.dispatchId))
            );
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

import {
  compareRuntimeDispatchPageKeys,
  runtimeDispatchPageTimeKey,
} from "@harness-anything/kernel/internal/domain/runtime-public-query.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { TaskProjection } from "@harness-anything/kernel";
import {
  matchesCollaboratorScope,
  type CollaboratorScope,
} from "@harness-anything/kernel/internal/domain/collaborator-scope.ts";
import { requireSameProjectionCut } from "./projection-cut.ts";
import { sourceNodeReader } from "./runtime-attribution.ts";

interface TokenUsageTotals {
  dispatches: number;
  usageReportedDispatches: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCallCount: number;
}

const emptyTotals = (): TokenUsageTotals => ({
  dispatches: 0,
  usageReportedDispatches: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  toolCallCount: 0,
});

export function readCollaboratorTokenUsage(
  projection: Pick<TaskProjection, "readRuntimeDispatchPage" | "readCut" | "readRuntimeSessionEventsByType">,
  query: CollaboratorScope & { readonly startedAtGte: string; readonly startedAtLt?: string },
) {
  const { startedAtGte, startedAtLt } = query,
    upper = startedAtLt === undefined ? undefined : runtimeDispatchPageTimeKey(startedAtLt),
    cut = projection.readCut(),
    sourceNode = sourceNodeReader(projection),
    persons = new Map<string | null, TokenUsageTotals>(),
    nodes = new Map<string | null, TokenUsageTotals>(),
    totals = emptyTotals();
  let cursor: NonNullable<ReturnType<TaskProjection["readRuntimeDispatchPage"]>["nextCursor"]> | undefined;
  dispatchPages: for (;;) {
    const page = projection.readRuntimeDispatchPage({
      startedAtGte,
      limit: storageReadPolicy.defaultValue.pageSizes.standard,
      ...(cursor ? { cursor } : {}),
    });
    for (const { event, metrics } of page.rows) {
      if (upper !== undefined && runtimeDispatchPageTimeKey(event.payload.startedAt ?? event.occurredAt) >= upper)
        break dispatchPages;
      const personId = event.actor.principal.personId ?? null,
        nodeId = sourceNode(event.source);
      if (!matchesCollaboratorScope(query, [{ personId, nodeId }])) continue;
      const person = persons.get(personId) ?? emptyTotals(),
        node = nodes.get(nodeId) ?? emptyTotals();
      persons.set(personId, person);
      nodes.set(nodeId, node);
      for (const group of [totals, person, node]) {
        group.dispatches += 1;
        if (metrics === null || metrics.usageUnavailable) continue;
        group.usageReportedDispatches += 1;
        group.inputTokens += metrics.inputTokens;
        group.cacheReadTokens += metrics.cacheReadTokens;
        group.outputTokens += metrics.outputTokens;
        group.totalTokens += metrics.totalTokens;
        group.toolCallCount += metrics.toolCallCount;
      }
    }
    if (page.done) break;
    const next = page.nextCursor;
    if (next === null || (cursor !== undefined && compareRuntimeDispatchPageKeys(next, cursor) <= 0))
      throw new Error("Token usage dispatch page cursor did not advance.");
    cursor = next;
  }
  requireSameProjectionCut("token usage", [cut, projection.readCut()]);
  return {
    ...cut,
    totals,
    byPerson: [...persons].map(([personId, usage]) => ({ personId, ...usage })),
    byNode: [...nodes].map(([nodeId, usage]) => ({ nodeId, ...usage })),
  };
}

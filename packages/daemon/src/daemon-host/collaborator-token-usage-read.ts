import { readCollaboratorTokenUsage } from "@harness-anything/application/internal/queries/collaborator-token-usage.ts";
import { isJsonObject } from "./protocol/json-rpc-types.ts";

type Usage = ReturnType<typeof readCollaboratorTokenUsage>;

export interface CollaboratorTokenUsageResult extends Usage {
  readonly ok: true;
  readonly groupBy: "person" | "node";
}

export function collaboratorTokenUsageResult(
  projection: Parameters<typeof readCollaboratorTokenUsage>[0],
  query: Parameters<typeof readCollaboratorTokenUsage>[1],
  groupBy: CollaboratorTokenUsageResult["groupBy"],
): CollaboratorTokenUsageResult {
  return { ok: true, groupBy, ...readCollaboratorTokenUsage(projection, query) };
}

export function validateCollaboratorTokenUsage(value: Readonly<Record<string, unknown>>): readonly string[] {
  const totalsValid = (totals: unknown) =>
    isJsonObject(totals) &&
    [
      "dispatches",
      "usageReportedDispatches",
      "inputTokens",
      "cacheReadTokens",
      "outputTokens",
      "totalTokens",
      "toolCallCount",
    ].every((key) => typeof totals[key] === "number" && Number.isFinite(totals[key]) && Number(totals[key]) >= 0);
  const groupsValid = (rows: unknown, key: "personId" | "nodeId") =>
    Array.isArray(rows) &&
    rows.every((row) => isJsonObject(row) && (row[key] === null || typeof row[key] === "string") && totalsValid(row));
  return value.ok === true &&
    (value.groupBy === "person" || value.groupBy === "node") &&
    (value.status === "ready" || value.status === "pending") &&
    Number.isSafeInteger(value.watermark) &&
    Number.isSafeInteger(value.sourceRevision) &&
    totalsValid(value.totals) &&
    groupsValid(value.byPerson, "personId") &&
    groupsValid(value.byNode, "nodeId")
    ? []
    : ["collaborator token usage is invalid"];
}

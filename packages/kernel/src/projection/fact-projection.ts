import { parseFactFlowRecords, type FactRecord } from "../domain/index.ts";
import type { ProjectionWarning } from "./types.ts";

export interface TaskFactProjectionRow {
  readonly schema: "task-fact-row/v1";
  readonly ref: string;
  readonly taskId: string;
  readonly factId: string;
  readonly statement: string;
  readonly source: string;
  readonly observedAt: string;
  readonly confidence: FactRecord["confidence"];
  readonly memoryClass: FactRecord["memoryClass"];
  readonly memoryTags: FactRecord["memoryTags"];
  readonly provenance: FactRecord["provenance"];
}

export function projectFactDocument(
  taskId: string,
  portablePath: string,
  body: string
): { readonly records: ReadonlyArray<FactRecord>; readonly rows: ReadonlyArray<TaskFactProjectionRow>; readonly warnings: ReadonlyArray<ProjectionWarning> } {
  const records: FactRecord[] = [];
  const warnings: ProjectionWarning[] = [];
  for (const [index, sourceLine] of body.split(/\r?\n/u).entries()) {
    const line = sourceLine.trim();
    if (!/^\s*-\s*\{/u.test(line) || !/(?:^|[,{}]\s*)fact_id\s*:/u.test(line)) continue;
    const parsed = parseFactFlowRecords(line);
    if (parsed.length === 1) {
      records.push(parsed[0]!);
      continue;
    }
    warnings.push({
      code: "source_malformed",
      source: "source-package",
      severity: "hard-fail",
      message: `Malformed fact record in ${portablePath}:${index + 1}.`,
      repairHint: `Restore a valid FactFlow record for task ${taskId}; malformed facts are not published into the projection.`
    });
  }
  return {
    records,
    rows: records.filter((fact) => fact.migration?.state !== "migrated").map((fact) => toTaskFactProjectionRow(taskId, fact)),
    warnings
  };
}

function toTaskFactProjectionRow(taskId: string, fact: FactRecord): TaskFactProjectionRow {
  return {
    schema: "task-fact-row/v1",
    ref: `fact/${taskId}/${fact.fact_id}`,
    taskId,
    factId: fact.fact_id,
    statement: fact.statement,
    source: fact.source,
    observedAt: fact.observedAt,
    confidence: fact.confidence,
    memoryClass: fact.memoryClass,
    memoryTags: fact.memoryTags,
    provenance: fact.provenance
  };
}

import { consumeKnownError } from "../../kernel/src/index.ts";
import { renderTaskIndexPayload } from "./task-index-query.ts";

export function decodeEvidencePayload(evidence: string): unknown {
  const tag = evidence.indexOf(":");
  for (const candidate of tag > 0 ? [evidence, evidence.slice(tag + 1)] : [evidence]) {
    if (!/^[[{]/u.test(candidate)) continue;
    try {
      return JSON.parse(candidate);
    } catch (error) {
      consumeKnownError(error);
    }
  }
  return undefined;
}

export function renderEvidencePayload(payload: unknown): string {
  const taskIndex = renderTaskIndexPayload(payload);
  if (taskIndex !== null) return taskIndex;
  const readSet = renderTaskReadSetPayload(payload);
  if (readSet !== null) return readSet;
  if (Array.isArray(payload)) return renderEvidenceRows(payload);
  if (payload === null || typeof payload !== "object") return String(payload);
  const entries = Object.entries(payload),
    nested = entries.filter(([, value]) => value !== null && typeof value === "object"),
    scalars = entries
      .filter(([, value]) => value === null || typeof value !== "object")
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("  ");
  return (
    [
      ...nested.map(([key, value]) =>
        Array.isArray(value)
          ? value.length === 0
            ? ""
            : `${key}:\n${renderEvidenceRows(value)}`
          : `${key}: ${renderEvidenceRows([value], true)}`,
      ),
      scalars,
    ]
      .filter(Boolean)
      .join("\n") || "(empty)"
  );
}

export function renderEvidenceRows(rows: readonly unknown[], named = false): string {
  return rows.length === 0
    ? "(none)"
    : rows
        .map((row) =>
          row !== null && typeof row === "object" && !Array.isArray(row)
            ? Object.entries(row)
                .filter(([, value]) => value === null || typeof value !== "object")
                .map(([key, value]) => (named ? `${key}=${String(value)}` : String(value)))
                .join(named ? "  " : "\t")
            : String(row),
        )
        .join("\n");
}

/**
 * The read set carries nested per-entry evidence (why it was included, the edge
 * revisions), which the generic row renderer drops. Render it so a reader sees, on one
 * line, what to open, whether it is required, how fresh it is, and which edge said so.
 */
function renderTaskReadSetPayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.schema !== "read-set/v1" || !Array.isArray(record.entries)) return null;
  const entries = record.entries as readonly Record<string, unknown>[],
    reasons = Array.isArray(record.blockedReasons) ? (record.blockedReasons as readonly Record<string, unknown>[]) : [],
    gaps = record.blocked === true ? ["blocked:", ...reasons.map(renderReadSetGap)] : [],
    rows = entries.map(renderReadSetEntry).join("\n");
  return [
    ...gaps,
    "read-set:",
    rows || "(none)",
    `task=${String(record.taskRef)}  count=${entries.length}  blocked=${String(record.blocked)}  ` +
      `status=${String(record.status ?? "unknown")}  watermark=${String(record.watermark ?? "unknown")}  ` +
      `sourceRevision=${String(record.sourceRevision ?? "unknown")}`,
  ].join("\n");
}

function renderReadSetEntry(entry: Record<string, unknown>): string {
  const why = (entry.whyIncluded ?? {}) as Record<string, unknown>;
  return [
    String(entry.entityRef),
    entry.required === true ? "required" : "recommended",
    String(entry.authority),
    String(entry.freshness),
    entry.locator === null || entry.locator === undefined ? "(no locator)" : String(entry.locator),
    `${String(why.type)}: ${String(why.rationale)}`,
  ].join("\t");
}

function renderReadSetGap(reason: Record<string, unknown>): string {
  return `  ${String(reason.code)}\t${String(reason.entityRef)}\t${String(reason.detail)}`;
}

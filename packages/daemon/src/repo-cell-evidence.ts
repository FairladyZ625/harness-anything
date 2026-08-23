import { consumeKnownError } from "../../kernel/src/index.ts";

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

export function taskWriteKind(kind: string): boolean {
  return [
    "task-start",
    "task-transition",
    "task-submit",
    "task-review-execution",
    "task-review-consent",
    "task-code-doc-reconcile",
    "task-complete",
  ].includes(kind);
}

export function taskSurfaceWriteKind(kind: string): boolean {
  return [
    "task-release",
    "task-amend",
    "task-archive",
    "task-supersede",
    "task-delete",
    "task-reopen",
    "task-contract-migrate",
    "task-relate",
  ].includes(kind);
}

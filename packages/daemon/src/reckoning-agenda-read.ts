import { isTerminalStatus, type TaskProjection } from "@harness-anything/kernel";
import { decodeEvidencePayload } from "./repo-cell-evidence.ts";
import { readScheduleRuns, type ScheduleRunsResult } from "./schedule-runs-read.ts";

const FENCE = /```harness-reckoning\s*\r?\n([\s\S]*?)\r?\n```/gu;
const FINDING_STATUSES = new Set(["unresolved", "covered", "resolved", "observation"]);
const FINDING_ACTIONS = new Set(["fix-source", "retire-or-merge", "retain", "human-decision"]);
// Two weeks of daily occurrences cover the two-window short streak and the
// latest weekly long-window report while keeping agenda blob reads bounded.
const AGENDA_RUN_LIMIT = 16;

interface ReckoningFinding {
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly action: string;
  readonly evidenceCount: number;
  readonly evidenceRefs: readonly string[];
  readonly ownerTaskRef: string | null;
}

interface ReckoningWindow {
  readonly kind: "short" | "long";
  readonly complete: boolean;
  readonly findings: readonly ReckoningFinding[];
}

interface ReckoningReport {
  readonly schema: "harness-reckoning/v1";
  readonly windows: readonly ReckoningWindow[];
}

export interface ReckoningAgendaItem {
  readonly ref: string;
  readonly title: string;
  readonly since: string;
  readonly workTaskId: null;
}

export interface ReckoningAgendaRead {
  readonly items: readonly ReckoningAgendaItem[];
  readonly reads: readonly ScheduleRunsResult[];
}

/** Derive attention from occurrence-owned reports without writing a finding entity. */
export function readReckoningAgenda(input: {
  readonly projection: TaskProjection;
  readonly store?: { readonly readContentBlob: (sha256: string) => Uint8Array | null };
}): ReckoningAgendaRead {
  if (input.store === undefined || typeof input.projection.listEntities !== "function") return { items: [], reads: [] };
  const reads: ScheduleRunsResult[] = [];
  for (const schedule of input.projection.listEntities("schedule")) {
    const value = schedule.value as { readonly mode?: unknown };
    if (value.mode !== "detect") continue;
    const runs = readScheduleRuns(
      {
        projection: input.projection,
        store: input.store,
      },
      schedule.id,
      AGENDA_RUN_LIMIT,
    );
    reads.push(runs);
  }
  return { items: reads.flatMap((read) => deriveScheduleItems(read, input.projection)), reads };
}

export function deriveScheduleItems(
  read: ScheduleRunsResult,
  projection: TaskProjection,
): readonly ReckoningAgendaItem[] {
  const rows = [...read.runs]
    // Manual success reports are outside the Schedule cadence. A missed row
    // still represents a broken scheduled occurrence and must break the
    // streak even if an upstream projection labels its kind differently.
    .filter((row) => row.kind === "scheduled" || row.outcome !== "succeeded")
    .sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor));
  const shortCounts = new Map<string, number>();
  const shortActive = new Set<string>();
  const longActive = new Set<string>();
  const latest = new Map<string, ReckoningFinding>();
  const since = new Map<string, string>();
  const clearSinceIfInactive = (key: string): void => {
    if (!shortActive.has(key) && !longActive.has(key)) since.delete(key);
  };

  for (const row of rows) {
    const report = row.outcome === "succeeded" ? parseReport(row.reportText) : null;
    const short = report?.windows.find((window) => window.kind === "short");
    if (row.outcome !== "succeeded" || short?.complete !== true) {
      // An incomplete occurrence breaks the current streak but must not erase
      // an item that was already activated by earlier complete windows.
      shortCounts.clear();
    } else {
      const findings = new Map(short.findings.map((finding) => [finding.key, finding] as const));
      const keys = new Set([...shortCounts.keys(), ...shortActive, ...findings.keys()]);
      for (const key of keys) {
        const finding = findings.get(key);
        if (finding === undefined || finding.status === "resolved" || finding.status === "covered") {
          shortCounts.delete(key);
          shortActive.delete(key);
          if (finding !== undefined) {
            longActive.delete(key);
            latest.set(key, finding);
          }
          clearSinceIfInactive(key);
          continue;
        }
        const previousCount = shortCounts.get(key) ?? 0;
        shortCounts.set(key, previousCount + 1);
        latest.set(key, finding);
        if (previousCount === 0) since.set(key, row.scheduledFor);
        if (previousCount + 1 >= 2) shortActive.add(key);
      }
    }

    const long = report?.windows.find((window) => window.kind === "long");
    if (long?.complete === true) {
      const findings = new Map(long.findings.map((finding) => [finding.key, finding] as const));
      const keys = new Set([...longActive, ...findings.keys()]);
      for (const key of keys) {
        const finding = findings.get(key);
        if (finding === undefined || finding.status === "resolved" || finding.status === "covered") {
          longActive.delete(key);
          if (finding !== undefined) latest.set(key, finding);
          clearSinceIfInactive(key);
        } else if (finding.evidenceCount >= 2) {
          const wasActive = longActive.has(key);
          longActive.add(key);
          latest.set(key, finding);
          if (!wasActive) since.set(key, row.scheduledFor);
        } else {
          longActive.delete(key);
        }
      }
    }
  }

  const items: ReckoningAgendaItem[] = [];
  for (const [key, finding] of latest) {
    if (!shortActive.has(key) && !longActive.has(key)) continue;
    if (finding.status === "resolved" || finding.status === "covered") continue;
    if (finding.ownerTaskRef !== null && ownerTaskIsOpen(finding.ownerTaskRef, projection)) continue;
    items.push({
      ref: `audit/${read.scheduleId}/${key}`,
      title: finding.title,
      since: since.get(key) ?? rows.at(-1)?.scheduledFor ?? new Date(0).toISOString(),
      workTaskId: null,
    });
  }
  return items.sort((left, right) => right.since.localeCompare(left.since) || left.ref.localeCompare(right.ref));
}

function ownerTaskIsOpen(ownerTaskRef: string, projection: TaskProjection): boolean {
  const match = /^task\/(.+)$/u.exec(ownerTaskRef);
  if (match === null) return false;
  const task = projection.read(match[1]!).snapshot.task;
  return task !== null && !isTerminalStatus(task.status);
}

function parseReport(reportText: string | null): ReckoningReport | null {
  if (reportText === null) return null;
  let match: RegExpExecArray | null = null;
  for (const candidate of reportText.matchAll(FENCE)) match = candidate;
  if (match === null) return null;
  // Keep malformed report payloads on the shared evidence fallback boundary.
  const value = decodeEvidencePayload(match[1]!);
  if (!isRecord(value) || value.schema !== "harness-reckoning/v1" || !Array.isArray(value.windows)) return null;
  const windows: ReckoningWindow[] = [];
  for (const rawWindow of value.windows) {
    if (
      !isRecord(rawWindow) ||
      (rawWindow.kind !== "short" && rawWindow.kind !== "long") ||
      typeof rawWindow.complete !== "boolean"
    )
      return null;
    if (!Array.isArray(rawWindow.findings)) return null;
    const findings: ReckoningFinding[] = [];
    for (const rawFinding of rawWindow.findings) {
      if (
        !isRecord(rawFinding) ||
        typeof rawFinding.key !== "string" ||
        rawFinding.key.length === 0 ||
        typeof rawFinding.title !== "string" ||
        rawFinding.title.length === 0
      )
        return null;
      if (
        typeof rawFinding.status !== "string" ||
        !FINDING_STATUSES.has(rawFinding.status) ||
        typeof rawFinding.action !== "string" ||
        !FINDING_ACTIONS.has(rawFinding.action)
      )
        return null;
      if (
        !Number.isSafeInteger(rawFinding.evidenceCount) ||
        Number(rawFinding.evidenceCount) < 0 ||
        !Array.isArray(rawFinding.evidenceRefs) ||
        !rawFinding.evidenceRefs.every((ref) => typeof ref === "string" && ref.length > 0)
      )
        return null;
      if (rawFinding.ownerTaskRef !== null && typeof rawFinding.ownerTaskRef !== "string") return null;
      findings.push({
        key: rawFinding.key,
        title: rawFinding.title,
        status: rawFinding.status,
        action: rawFinding.action,
        evidenceCount: Number(rawFinding.evidenceCount),
        evidenceRefs: rawFinding.evidenceRefs,
        ownerTaskRef: rawFinding.ownerTaskRef,
      });
    }
    windows.push({ kind: rawWindow.kind, complete: rawWindow.complete, findings });
  }
  return { schema: "harness-reckoning/v1", windows };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

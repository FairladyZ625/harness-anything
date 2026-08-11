import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout, stablePayloadHash, type HarnessLayoutInput } from "../../../../kernel/src/index.ts";

export interface ExecutionCandidate {
  readonly candidateId: string;
  readonly sessionId: string;
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly confidence: "low" | "medium" | "high";
  readonly disposition: "candidate";
  readonly evidence: {
    readonly eventCount: number;
    readonly firstRecordedAt: string;
    readonly lastRecordedAt: string;
    readonly eventIds: ReadonlyArray<string>;
    readonly observedTaskId?: string;
    readonly observedExecutionId?: string;
  };
}

interface CandidateGroup {
  readonly sessionId: string;
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly observedTaskId?: string;
  readonly observedExecutionId?: string;
  readonly events: Array<{ eventId: string; recordedAt: string }>;
}

export function scanRuntimeExecutionCandidates(rootInput: HarnessLayoutInput): {
  readonly candidates: ReadonlyArray<ExecutionCandidate>;
  readonly warnings: ReadonlyArray<string>;
} {
  const root = resolveHarnessLayout(rootInput).runtimeEventLedgerRoot;
  const groups = new Map<string, CandidateGroup>();
  const warnings: string[] = [];
  for (const fileName of readDirectory(root).filter((entry) => entry.endsWith(".jsonl"))) {
    scanRuntimeEventFile(path.join(root, fileName), fileName, groups, warnings);
  }
  return {
    candidates: [...groups.values()].map(toExecutionCandidate).sort(compareCandidates),
    warnings
  };
}

function scanRuntimeEventFile(
  filePath: string,
  fileName: string,
  groups: Map<string, CandidateGroup>,
  warnings: string[]
): void {
  for (const [index, line] of readFileSync(filePath, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      addRuntimeEventCandidate(JSON.parse(line), groups, `${fileName}:${index + 1}`, warnings);
    } catch (error) {
      warnings.push(`${fileName}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function addRuntimeEventCandidate(value: unknown, groups: Map<string, CandidateGroup>, source: string, warnings: string[]): void {
  const event = value as { readonly eventId?: unknown; readonly recordedAt?: unknown; readonly session?: { readonly sessionId?: unknown; readonly taskId?: unknown; readonly executionId?: unknown } };
  if (typeof event.eventId !== "string" || typeof event.recordedAt !== "string" || typeof event.session?.sessionId !== "string") {
    warnings.push(`${source}: missing Runtime Event identity`);
    return;
  }
  const observedTaskId = typeof event.session.taskId === "string" ? event.session.taskId : undefined;
  const observedExecutionId = typeof event.session.executionId === "string" ? event.session.executionId : undefined;
  const taskId = observedTaskId && /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u.test(observedTaskId) ? observedTaskId : null;
  const executionId = observedExecutionId && /^exe_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u.test(observedExecutionId) ? observedExecutionId : null;
  const key = JSON.stringify([event.session.sessionId, observedTaskId ?? null, observedExecutionId ?? null]);
  const group = groups.get(key) ?? {
    sessionId: event.session.sessionId,
    taskId,
    executionId,
    ...(observedTaskId && !taskId ? { observedTaskId } : {}),
    ...(observedExecutionId && !executionId ? { observedExecutionId } : {}),
    events: []
  };
  group.events.push({ eventId: event.eventId, recordedAt: event.recordedAt });
  groups.set(key, group);
}

function toExecutionCandidate(group: CandidateGroup): ExecutionCandidate {
  const events = [...group.events].sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.eventId.localeCompare(right.eventId));
  return {
    candidateId: `execution-candidate-${stablePayloadHash({
      sessionId: group.sessionId,
      taskId: group.taskId,
      executionId: group.executionId,
      observedTaskId: group.observedTaskId ?? null,
      observedExecutionId: group.observedExecutionId ?? null
    }).slice(0, 16)}`,
    sessionId: group.sessionId,
    taskId: group.taskId,
    executionId: group.executionId,
    confidence: group.executionId ? "high" : group.taskId ? "medium" : "low",
    disposition: "candidate",
    evidence: {
      eventCount: events.length,
      firstRecordedAt: events[0]?.recordedAt ?? "",
      lastRecordedAt: events.at(-1)?.recordedAt ?? "",
      eventIds: events.map((event) => event.eventId),
      ...(group.observedTaskId ? { observedTaskId: group.observedTaskId } : {}),
      ...(group.observedExecutionId ? { observedExecutionId: group.observedExecutionId } : {})
    }
  };
}

function compareCandidates(left: ExecutionCandidate, right: ExecutionCandidate): number {
  return compareNullable(left.taskId, right.taskId) || left.sessionId.localeCompare(right.sessionId) || compareNullable(left.executionId, right.executionId);
}

function compareNullable(left: string | null, right: string | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}

function readDirectory(root: string): ReadonlyArray<string> {
  try {
    return readdirSync(root).sort();
  } catch {
    return [];
  }
}

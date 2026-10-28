import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  decisionEventDescriptor,
  resolveHarnessLayout,
  type AdvisoryDecision,
  type DecisionEventName,
  type DecisionReadSurface,
} from "@harness-anything/kernel";
import { writeFileDurably } from "./durable-file.ts";
import type { TaskDispatchAdvisory } from "./protocol/task-dispatch-contract.ts";

export const decisionAnnotationRetention = 1_000;
const annotationSchema = "decision-annotation-store/v1" as const;

export type DispatchAdvisoryDecision = Omit<TaskDispatchAdvisory, "evaluatedAt">;

export interface DecisionEgressReceipt {
  readonly subjectRef: string;
  readonly dispatchId: string;
  readonly pointId: string;
  readonly fields: readonly string[];
  readonly providerId: string;
  readonly model: string | null;
  readonly sentAt: string;
  readonly inputDigest: string;
}

/** The executed disposition one incident decision produced, appended to its reservation. A
 * `resume`/`rerun` with status `applied` consumes one automatic-disposition budget slot. */
export interface DecisionActionRecord {
  readonly taskId: string;
  readonly dispatchId: string;
  readonly selected: string;
  readonly action: "resume" | "rerun" | "needs_attention" | "no_action";
  /** Why a needs_attention action is owner business: a real question, or a guard refusal. */
  readonly attention: "question" | "guard" | null;
  readonly status: "applied" | "failed";
  readonly reason: string | null;
  readonly successorDispatchId: string | null;
  readonly budget: { readonly used: number; readonly limit: number; readonly source: "task" | "repository" } | null;
  readonly decidedAt: string;
}

/** The record a caller hands to `settleAction`; the store stamps `decidedAt` itself. */
export type DecisionActionDraft = Omit<DecisionActionRecord, "decidedAt">;

export interface DecisionAnnotationEntry {
  readonly key: string;
  readonly pointId: string;
  readonly questionVersion: string;
  readonly bindingDigest: string;
  readonly event: DecisionEventName;
  readonly show: readonly DecisionReadSurface[];
  readonly dispatchIds: readonly string[];
  readonly subjectRef: string;
  readonly status: "pending" | "succeeded" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly egress: DecisionEgressReceipt;
  readonly advisory?: DispatchAdvisoryDecision;
  readonly failureCode?: string;
  readonly action?: DecisionActionRecord;
}

interface AnnotationFile {
  readonly schema: typeof annotationSchema;
  readonly entries: readonly DecisionAnnotationEntry[];
}

export function openDecisionAnnotationStore(rootDir: string) {
  const target = path.join(resolveHarnessLayout(rootDir).localRoot, "decision-annotations.json");
  let tail = Promise.resolve();
  const enqueue = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const read = (): AnnotationFile => {
    if (!existsSync(target)) return { schema: annotationSchema, entries: [] };
    return JSON.parse(readFileSync(target, "utf8")) as AnnotationFile;
  };
  const write = (entries: readonly DecisionAnnotationEntry[]): void => {
    writeFileDurably(target, `${JSON.stringify({ schema: annotationSchema, entries }, null, 2)}\n`, 0o600);
  };

  return {
    reserve(input: {
      readonly key: string;
      readonly pointId: string;
      readonly questionVersion: string;
      readonly bindingDigest: string;
      readonly event: DecisionEventName;
      readonly show: readonly DecisionReadSurface[];
      readonly dispatchId: string;
      readonly subjectRef: string;
      readonly egress: DecisionEgressReceipt;
      readonly now: string;
    }): Promise<{ readonly created: boolean; readonly entry: DecisionAnnotationEntry }> {
      return enqueue(() => {
        const entries = [...read().entries],
          existingIndex = entries.findIndex((entry) => entry.key === input.key);
        if (existingIndex >= 0) {
          const existing = entries[existingIndex]!;
          if (!existing.dispatchIds.includes(input.dispatchId)) {
            const updated = {
              ...existing,
              dispatchIds: [...existing.dispatchIds, input.dispatchId],
            };
            entries[existingIndex] = updated;
            write(entries);
            return { created: false, entry: updated };
          }
          return { created: false, entry: existing };
        }
        const entry: DecisionAnnotationEntry = {
          key: input.key,
          pointId: input.pointId,
          questionVersion: input.questionVersion,
          bindingDigest: input.bindingDigest,
          event: input.event,
          show: input.show,
          dispatchIds: [input.dispatchId],
          subjectRef: input.subjectRef,
          status: "pending",
          createdAt: input.now,
          updatedAt: input.now,
          egress: input.egress,
        };
        write([...entries, entry].slice(-decisionAnnotationRetention));
        return { created: true, entry };
      });
    },
    succeed(key: string, advisory: DispatchAdvisoryDecision, now: string): Promise<void> {
      return enqueue(() => {
        const entries = [...read().entries],
          index = entries.findIndex((entry) => entry.key === key);
        if (index < 0) throw new Error(`Decision annotation reservation ${key} is missing.`);
        entries[index] = { ...entries[index]!, status: "succeeded", advisory, updatedAt: now };
        write(entries);
      });
    },
    fail(key: string, failureCode: string, now: string): Promise<void> {
      return enqueue(() => {
        const entries = [...read().entries],
          index = entries.findIndex((entry) => entry.key === key);
        if (index < 0) throw new Error(`Decision annotation reservation ${key} is missing.`);
        entries[index] = { ...entries[index]!, status: "failed", failureCode, updatedAt: now };
        write(entries);
      });
    },
    /** Appends the executed disposition to the claim that owns it; one claim carries at most one action. */
    settleAction(key: string, action: DecisionActionDraft, now: string): Promise<void> {
      return enqueue(() => {
        const entries = [...read().entries],
          index = entries.findIndex((entry) => entry.key === key);
        if (index < 0) throw new Error(`Decision annotation reservation ${key} is missing.`);
        if (entries[index]!.action) return;
        entries[index] = { ...entries[index]!, action: { ...action, decidedAt: now }, updatedAt: now };
        write(entries);
      });
    },
    export(): Promise<readonly DecisionAnnotationEntry[]> {
      return enqueue(() => read().entries);
    },
    remove(dispatchId: string): Promise<void> {
      return enqueue(() => {
        const entries = read().entries.flatMap((entry) => {
          if (!entry.dispatchIds.includes(dispatchId)) return [entry];
          const dispatchIds = entry.dispatchIds.filter((id) => id !== dispatchId);
          return dispatchIds.length === 0 ? [] : [{ ...entry, dispatchIds }];
        });
        write(entries);
      });
    },
    target,
  };
}

export function readDecisionAnnotationsByDispatch(
  rootDir: string,
  dispatchIds: readonly string[],
  surface: DecisionReadSurface,
): ReadonlyMap<string, readonly DecisionAnnotationEntry[]> {
  const target = path.join(resolveHarnessLayout(rootDir).localRoot, "decision-annotations.json");
  if (!existsSync(target) || dispatchIds.length === 0) return new Map();
  const wanted = new Set(dispatchIds),
    stored = JSON.parse(readFileSync(target, "utf8")) as AnnotationFile;
  const result = new Map<string, DecisionAnnotationEntry[]>();
  for (const entry of stored.entries) {
    if (
      entry.status !== "succeeded" ||
      !entry.advisory ||
      !entry.show.includes(surface) ||
      !decisionEventDescriptor(entry.event)?.readSurfaces.includes(surface)
    )
      continue;
    for (const dispatchId of entry.dispatchIds.filter((id) => wanted.has(id))) {
      const current = result.get(dispatchId) ?? [];
      current.push(entry);
      result.set(dispatchId, current);
    }
  }
  return result;
}

export function decisionAnnotationAdvisory(
  entry: DecisionAnnotationEntry | undefined,
): DispatchAdvisoryDecision | undefined {
  return entry?.status === "succeeded" ? entry.advisory : undefined;
}

export function decisionAdvisoryFromProvider(
  result: AdvisoryDecision,
  input: {
    readonly pointId: string;
    readonly questionVersion: string;
    readonly options: readonly { readonly id: string; readonly text: string }[];
  },
): DispatchAdvisoryDecision {
  return {
    pointId: input.pointId,
    questionVersion: input.questionVersion,
    selected:
      result.result.type === "choice"
        ? result.result.selected
        : result.result.type === "noul"
          ? String(result.result.value)
          : String(result.result.value),
    distribution: result.distribution,
    options: input.options,
    provider: result.provider,
    usage: result.usage,
    latencyMs: result.latencyMs,
  };
}

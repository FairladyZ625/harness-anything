import type { ActorIdentity } from "./actor-identity.ts";

/** A resolved question and its authority, projected from the task's authored ruling records. */
export interface WorkerEscalationContext {
  readonly dispatchId: string;
  readonly question: string;
  readonly answer: string;
  readonly actor: ActorIdentity | null;
  readonly answeredAt: string;
  readonly revision: number;
  readonly questionPath: string;
  readonly resolutionPath: string;
}

/** A later answer to the same trimmed question replaces that question's earlier answer only.
 * Ledger revision, rather than wall-clock ordering, is authoritative across nodes. */
export function currentWorkerEscalations(
  records: readonly WorkerEscalationContext[],
): readonly WorkerEscalationContext[] {
  const byQuestion = new Map<string, WorkerEscalationContext>();
  for (const record of records) {
    const key = record.question.trim(),
      prior = byQuestion.get(key);
    if (prior === undefined || record.revision > prior.revision) byQuestion.set(key, record);
  }
  return [...byQuestion.values()].sort((a, b) => a.revision - b.revision);
}

import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { DECISION_EVENT_CATALOG } from "./decision-event-catalog.ts";

export type DecisionEventName = "dispatch.settled";
/**
 * Structured incident fields are daemon-measured values, not worker free text: the projector
 * formats them from its own reads, so their descriptors only bound length. Only
 * `runtime.lastConclusion` carries worker prose and keeps the report-summary scrub.
 */
export type DecisionInputField =
  | "report.body"
  | "dispatch.reason"
  | "dispatch.classification"
  | "runtime.toolCallCount"
  | "runtime.headStatus"
  | "runtime.lastConclusion"
  | "runtime.exitHead"
  | "runtime.currentHead"
  | "task.roundsUsed"
  | "task.reworkBudget";
export type DecisionReadSurface = "task.dispatches" | "agenda" | "gui.dispatch";

export type DecisionWhenField = "outcome" | "classification";
export type DecisionWhen = Readonly<Partial<Record<DecisionWhenField, readonly (string | null)[]>>>;

export type DecisionQuestionDeclaration =
  | {
      readonly version: string;
      readonly type: "noul";
      readonly prompt: string;
      readonly criteria: { readonly true: string; readonly false: string };
    }
  | {
      readonly version: string;
      readonly type: "choice";
      readonly prompt: string;
      readonly options: readonly { readonly id: string; readonly text: string }[];
      readonly criteria: Readonly<Record<string, string>>;
      readonly abstainOptionId?: string;
    }
  | {
      readonly version: string;
      readonly type: "score";
      readonly prompt: string;
      readonly levels: readonly { readonly id: string; readonly text: string }[];
      readonly criteria: Readonly<Record<string, string>>;
    };

export interface DecisionPointDeclaration {
  readonly revision: string;
  readonly on: DecisionEventName;
  readonly when: DecisionWhen;
  readonly input: readonly DecisionInputField[];
  readonly question: string;
  readonly show: readonly DecisionReadSurface[];
}

export interface VerticalDecisionDeclarations {
  readonly questions: Readonly<Record<string, DecisionQuestionDeclaration>>;
  readonly points: Readonly<Record<string, DecisionPointDeclaration>>;
}

/** Fields in a point's filter are ANDed; values within each field are ORed. */
export function decisionWhenMatches(
  when: DecisionWhen,
  event: Readonly<Record<DecisionWhenField, string | null>>,
): boolean {
  return (Object.entries(when) as [DecisionWhenField, readonly (string | null)[]][]).every(([field, values]) =>
    values.includes(event[field]),
  );
}
export function decisionPointBindingDigest(
  pointId: string,
  point: DecisionPointDeclaration,
  question: DecisionQuestionDeclaration,
): string {
  const event = DECISION_EVENT_CATALOG[point.on];
  return sha256Text(
    stableStringify({
      pointId,
      revision: point.revision,
      event: point.on,
      questionId: point.question,
      question,
      input: point.input.map((field) => ({ field, ...event.inputFields[field] })),
      when: point.when,
    }),
  );
}

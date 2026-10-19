import {
  type DecisionEventName,
  type DecisionInputField,
  type DecisionReadSurface,
  type DecisionWhenField,
} from "./decision-point.ts";

export interface DecisionEventFieldDescriptor {
  readonly maxLength: number;
  readonly redactionRevision: string;
}

export interface DecisionEventDescriptor {
  readonly name: DecisionEventName;
  readonly finalOnly: true;
  readonly inputFields: Readonly<Record<DecisionInputField, DecisionEventFieldDescriptor>>;
  readonly whenFields: readonly DecisionWhenField[];
  readonly readSurfaces: readonly DecisionReadSurface[];
}

export const DECISION_EVENT_CATALOG = Object.freeze({
  "dispatch.settled": Object.freeze({
    name: "dispatch.settled",
    finalOnly: true,
    inputFields: Object.freeze({
      "report.body": Object.freeze({ maxLength: 2_000, redactionRevision: "report-summary-v1" }),
      "dispatch.reason": Object.freeze({ maxLength: 1_024, redactionRevision: "plain-text-v1" }),
      "dispatch.classification": Object.freeze({ maxLength: 64, redactionRevision: "vocabulary-v1" }),
    }),
    whenFields: Object.freeze(["outcome", "classification"] as const),
    readSurfaces: Object.freeze(["task.dispatches", "agenda", "gui.dispatch"] as const),
  }),
}) satisfies Readonly<Record<DecisionEventName, DecisionEventDescriptor>>;

export const decisionEventNames = Object.freeze(Object.keys(DECISION_EVENT_CATALOG) as DecisionEventName[]);
export const decisionInputFields = Object.freeze([
  ...new Set(Object.values(DECISION_EVENT_CATALOG).flatMap((entry) => Object.keys(entry.inputFields))),
] as DecisionInputField[]);
export const decisionReadSurfaces = Object.freeze([
  ...new Set(Object.values(DECISION_EVENT_CATALOG).flatMap((entry) => entry.readSurfaces)),
] as DecisionReadSurface[]);

export function decisionEventDescriptor(name: string): DecisionEventDescriptor | undefined {
  return (decisionEventNames as readonly string[]).includes(name)
    ? DECISION_EVENT_CATALOG[name as DecisionEventName]
    : undefined;
}

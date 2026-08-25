import type { ActorIdentity } from "./actor-identity.ts";
import type { EntityRef } from "./entity-ref.ts";

export type ReceiptJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ReceiptJsonValue[]
  | { readonly [field: string]: ReceiptJsonValue };
export interface AuthorizationDecision {
  readonly policyRef: string;
  readonly actor: ActorIdentity;
  readonly subject: EntityRef;
  readonly bindingsUsed: readonly Readonly<Record<string, ReceiptJsonValue>>[];
  readonly outcome: "allowed" | "denied";
  readonly reasonCodes: readonly string[];
  readonly nextActions: readonly string[];
  readonly evaluatedAtCut: string;
}
export interface TriadicDeltaEntry {
  readonly ref: EntityRef;
  readonly before: ReceiptJsonValue;
  readonly after: ReceiptJsonValue;
}
export interface TriadicDelta {
  readonly fact: readonly TriadicDeltaEntry[];
  readonly decision: readonly TriadicDeltaEntry[];
  readonly task: readonly TriadicDeltaEntry[];
}
export const EMPTY_TRIADIC_DELTA: TriadicDelta = Object.freeze({
  fact: Object.freeze([]),
  decision: Object.freeze([]),
  task: Object.freeze([]),
});

import type { ActorIdentity } from "./actor-identity.ts";

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

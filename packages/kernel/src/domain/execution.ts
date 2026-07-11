export const executionStates = ["active", "submitted", "accepted", "changes_requested", "abandoned"] as const;
export type ExecutionState = (typeof executionStates)[number];

export interface ExecutionActor {
  readonly principal: {
    readonly personId: string;
    readonly displayName?: string;
    readonly primaryEmail?: string;
    readonly providerId?: string;
    readonly credential?: { readonly kind: string; readonly issuer: string; readonly subject: string };
  };
  readonly executor: { readonly kind: "agent"; readonly id: string } | null;
  readonly responsibleHuman: string;
}

export interface ExecutionRecord {
  readonly schema: "execution/v1";
  readonly execution_id: string;
  readonly task_ref: string;
  readonly state: ExecutionState;
  readonly primary_actor: ExecutionActor;
  readonly claimed_at: string;
  readonly submitted_at: string | null;
  readonly closed_at: string | null;
  readonly session_bindings: ReadonlyArray<unknown>;
  readonly outputs: ReadonlyArray<unknown>;
  readonly submission: {
    readonly summary: string;
    readonly verification: ReadonlyArray<string>;
    readonly residual_risks: ReadonlyArray<string>;
  } | null;
}

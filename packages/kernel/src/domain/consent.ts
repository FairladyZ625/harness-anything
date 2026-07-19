import type { ExecutionActor } from "./execution.ts";

export const consentActions = ["approve_execution", "complete_task"] as const;
export type ConsentAction = (typeof consentActions)[number];

export const consentStates = ["open", "consumed", "expired"] as const;
export type ConsentState = (typeof consentStates)[number];

export const consentChannelKinds = ["agent-relayed", "human-cli", "gui-click"] as const;
export type ConsentChannelKind = (typeof consentChannelKinds)[number];

export type ConsentChannel =
  | { readonly kind: "agent-relayed"; readonly assurance: "relayed-assertion" }
  | { readonly kind: "human-cli"; readonly assurance: "principal-bound-command" }
  | { readonly kind: "gui-click"; readonly assurance: "authenticated-interaction" };

export type ConsentResponse =
  | { readonly kind: "utterance"; readonly text: string; readonly session_ref: string }
  | { readonly kind: "authorization-declaration"; readonly source: "standing-policy" | "asserted" }
  | { readonly kind: "interaction"; readonly interaction_ref: string; readonly label: string };

export type ConsentSource =
  | {
      readonly strength: "transcript-verified";
      readonly transcript_anchor: {
        readonly session_ref: string;
        readonly message_index: number;
        readonly role: "user";
        readonly message_sha256: `sha256:${string}`;
        readonly timestamp?: string;
      };
    }
  | { readonly strength: "standing-policy"; readonly decision_ref: string }
  | { readonly strength: "asserted"; readonly rationale: string }
  | { readonly strength: "legacy-unrecorded" };

export interface ConsentScope {
  readonly actions: ReadonlyArray<ConsentAction>;
  readonly content_pin: {
    readonly algorithm: "execution-consent-pin/v1";
    readonly digest: `sha256:${string}`;
  };
}

export interface ConsentDisclosure {
  readonly completion_claim: string;
  readonly known_gaps: ReadonlyArray<string>;
  readonly residual_risks: ReadonlyArray<string>;
}

export interface ConsentRecord {
  readonly schema: "consent/v2";
  readonly consent_id: string;
  readonly task_ref: string;
  readonly execution_ref: string;
  readonly principal: { readonly personId: string };
  readonly scope: ConsentScope;
  readonly disclosure: ConsentDisclosure;
  readonly channel: ConsentChannel;
  readonly response: ConsentResponse;
  readonly source: ConsentSource;
  readonly recorded_by: ExecutionActor;
  readonly granted_at: string;
  readonly expires_at: string;
  readonly state: ConsentState;
  readonly consumed_by: string | null;
  readonly consumed_at: string | null;
}

export type ConsentSnapshot = Pick<ConsentRecord,
  | "principal"
  | "scope"
  | "disclosure"
  | "channel"
  | "response"
  | "source"
  | "recorded_by"
  | "granted_at"
  | "expires_at"
>;

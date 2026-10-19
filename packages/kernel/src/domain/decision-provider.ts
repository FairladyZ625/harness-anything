/** Configuration for the Decisions API plane. It has no runtime or dispatch identity. */
export type DecisionProviderProbe =
  | { readonly state: "unknown" }
  | { readonly state: "ready"; readonly checkedAt: string }
  | { readonly state: "failed"; readonly checkedAt: string; readonly code: string };

export type DecisionProviderRecord = {
  readonly schema: "decision-provider/v1";
  readonly providerId: string;
  readonly name: string;
  readonly providerType: "decisions";
  readonly vendor: "openrouter";
  readonly model: string;
  readonly baseUrl: string | null;
  readonly auth: { readonly mode: "api-key"; readonly credentialRef: string };
  readonly enabled: boolean;
  readonly configurationRevision: number;
  readonly probe: DecisionProviderProbe;
};

export type DecisionOption = { readonly id: string; readonly text: string };
export type DecisionQuestion =
  | {
      readonly type: "noul";
      readonly prompt: string;
      readonly criteria: { readonly true: string; readonly false: string };
    }
  | {
      readonly type: "choice";
      readonly prompt: string;
      readonly options: readonly DecisionOption[];
      readonly criteria: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "score";
      readonly prompt: string;
      readonly levels: readonly DecisionOption[];
      readonly criteria: Readonly<Record<string, string>>;
    };

export type DecisionRequest = {
  readonly subjectRef: string;
  readonly questionSetVersion: string;
  readonly state: readonly [string];
  readonly question: DecisionQuestion;
};

export type DecisionProviderMetadata = {
  readonly providerId: string;
  readonly vendor: "openrouter";
  readonly requestedModel: string;
  readonly resolvedModel: string;
  readonly modelVersion: null;
  readonly providerRoute: string | null;
};

export type DecisionUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reportedCost: number | null;
};

type AdvisoryDecisionBase = {
  readonly disposition: "advisory";
  readonly authoritative: false;
  readonly subjectRef: string;
  readonly questionSetVersion: string;
  readonly provider: DecisionProviderMetadata;
  readonly usage: DecisionUsage;
  readonly latencyMs: number;
  /** Nominal marker separating advisory observations from gate/completion inputs. */
  readonly __advisoryDecisionBrand: unique symbol;
};

/** Branded reference result; it cannot satisfy gate or completion witness contracts. */
export type AdvisoryDecision = AdvisoryDecisionBase &
  (
    | {
        readonly questionType: "noul";
        readonly distribution: Readonly<{ true: number; false: number }>;
        readonly result: { readonly type: "noul"; readonly value: number };
      }
    | {
        readonly questionType: "choice";
        readonly distribution: Readonly<Record<string, number>>;
        readonly result: { readonly type: "choice"; readonly selected: string };
      }
    | {
        readonly questionType: "score";
        readonly distribution: Readonly<Record<string, number>>;
        readonly result: { readonly type: "score"; readonly value: number };
      }
  );

export type DecisionPortFailureCode =
  | "provider_not_found"
  | "provider_exists"
  | "provider_disabled"
  | "provider_credential_unavailable"
  | "invalid_provider"
  | "invalid_provider_type"
  | "invalid_base_url"
  | "invalid_decision_request"
  | "decision_timeout"
  | "decision_rate_limited"
  | "decision_transport"
  | "decision_protocol_invalid";

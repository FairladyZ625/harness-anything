import type { DecisionPortFailureCode, DecisionProviderVendor } from "@harness-anything/kernel";

export type DecisionProviderQuestion =
  | {
      readonly type: "noul";
      readonly instructions: string;
      readonly criteria: { readonly true: string; readonly false: string };
    }
  | {
      readonly type: "choice";
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string | { readonly label: string; readonly criterion: string }>>;
    }
  | {
      readonly type: "score";
      readonly instructions: string;
      readonly criteria: readonly (
        | string
        | { readonly id: string; readonly label: string; readonly criterion: string }
      )[];
    };

export type NormalizedDecisionAnswer =
  | { readonly type: "noul"; readonly noul: number }
  | { readonly type: "choice"; readonly choice: string; readonly probabilities: Readonly<Record<string, number>> }
  | { readonly type: "score"; readonly score: number; readonly probabilities: Readonly<Record<string, number>> };

export type NormalizedDecisionEnvelope = {
  readonly model: string;
  readonly provider?: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cost?: number;
  };
  readonly answers: { readonly decision: NormalizedDecisionAnswer };
};

export type DecisionPostJsonInput = {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly timeoutMs: number;
};

export type DecisionPostJsonResult = {
  readonly status: number;
  readonly rawBody: string;
};

export type DecisionPostJson = (input: DecisionPostJsonInput) => Promise<DecisionPostJsonResult>;

export type DecisionAdapterInvokeInput = {
  readonly apiKey: string;
  /** Validated custom baseUrl if configured by the operator; null means use the adapter's defaultBaseUrl. */
  readonly baseUrl: URL | null;
  readonly model: string;
  readonly state: readonly string[];
  readonly question: DecisionProviderQuestion;
  readonly timeoutMs: number;
  readonly postJson: DecisionPostJson;
};

export type DecisionProviderAdapter = {
  readonly vendor: DecisionProviderVendor;
  readonly label: string;
  readonly defaultBaseUrl: string | null;
  readonly requiresBaseUrl: boolean;
  readonly invoke: (input: DecisionAdapterInvokeInput) => Promise<NormalizedDecisionEnvelope>;
};

export class DecisionAdapterError extends Error {
  readonly code: DecisionPortFailureCode;
  readonly statusCode?: number;
  readonly providerCode?: string | number;
  readonly transient?: boolean;
  readonly modelUnavailable?: boolean;
  /** True when `message` is generated strictly from local controlled templates (never upstream prose/body). */
  readonly localControlledMessage: boolean;

  constructor(
    code: DecisionPortFailureCode,
    message: string,
    details: {
      readonly name?: string;
      readonly statusCode?: number;
      readonly providerCode?: string | number;
      readonly transient?: boolean;
      readonly modelUnavailable?: boolean;
      readonly localControlledMessage?: boolean;
    } = {},
  ) {
    super(message);
    this.code = code;
    this.localControlledMessage = details.localControlledMessage ?? true;
    if (details.name !== undefined) this.name = details.name;
    if (details.statusCode !== undefined) this.statusCode = details.statusCode;
    if (details.providerCode !== undefined) this.providerCode = details.providerCode;
    if (details.transient !== undefined) this.transient = details.transient;
    if (details.modelUnavailable !== undefined) this.modelUnavailable = details.modelUnavailable;
  }
}

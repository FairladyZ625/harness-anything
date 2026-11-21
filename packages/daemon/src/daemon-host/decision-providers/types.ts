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

export type DecisionDiagnosticCode =
  | "http_401"
  | "http_402"
  | "http_403"
  | "http_404"
  | "http_429"
  | "http_4xx"
  | "http_5xx"
  | "http_error"
  | "model_unavailable"
  | "timeout"
  | "redirect_blocked"
  | "connection_error"
  | "protocol_invalid"
  | "invalid_base_url"
  | "credential_unavailable";

export class DecisionAdapterError extends Error {
  readonly code: DecisionPortFailureCode;
  readonly statusCode?: number;
  readonly diagnosticCode?: DecisionDiagnosticCode;
  readonly transient?: boolean;
  readonly modelUnavailable?: boolean;

  constructor(
    code: DecisionPortFailureCode,
    message: string,
    details: {
      readonly name?: string;
      readonly statusCode?: number;
      readonly diagnosticCode?: DecisionDiagnosticCode;
      readonly transient?: boolean;
      readonly modelUnavailable?: boolean;
    } = {},
  ) {
    super(message);
    this.code = code;
    if (details.name !== undefined) this.name = details.name;
    if (details.statusCode !== undefined) this.statusCode = details.statusCode;
    const diagnosticCode =
      details.diagnosticCode ??
      (code === "decision_protocol_invalid"
        ? "protocol_invalid"
        : code === "invalid_base_url"
          ? "invalid_base_url"
          : undefined);
    if (diagnosticCode !== undefined) this.diagnosticCode = diagnosticCode;
    if (details.transient !== undefined) this.transient = details.transient;
    if (details.modelUnavailable !== undefined) this.modelUnavailable = details.modelUnavailable;
  }
}

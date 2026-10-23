import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { OpenRouter } from "@openrouter/sdk";
import type { DecisionsResponse } from "@openrouter/sdk/models";
import type {
  AdvisoryDecision,
  DecisionOption,
  DecisionPortFailureCode,
  DecisionProviderMetadata,
  DecisionProviderRecord,
  DecisionQuestion,
  DecisionRequest,
  DecisionUsage,
} from "@harness-anything/kernel";
import { credentialPort, isCredentialReferenceText, type CredentialPort } from "./agent-runtime-credential-port.ts";
import { writeFileDurably } from "./durable-file.ts";

const fileSchema = "decision-providers/v1" as const;
const providerIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const apiKeyPattern = /^[^\r\n\u0000-\u001f\u007f]{1,1280}$/u;
const requestTimeoutMs = 30_000;
/** Sent through the real Decisions operation so a probe cannot pass on an endpoint decisions never use. */
const probeState = "probe";
const probeQuestion = {
  type: "noul",
  instructions: "Reachability probe. Answer true if you can read this request.",
  criteria: { true: "The request is readable.", false: "The request is not readable." },
} as const satisfies OpenRouterQuestion;

type ProviderFile = { readonly schema: typeof fileSchema; readonly providers: readonly DecisionProviderRecord[] };
type ProviderCommand = Readonly<Record<string, unknown>>;
type OpenRouterQuestion =
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
      readonly criteria: (string | { readonly id: string; readonly label: string; readonly criterion: string })[];
    };
type DecisionInvoker = (input: {
  readonly apiKey: string;
  readonly serverURL: string | undefined;
  readonly model: string;
  readonly state: readonly string[];
  readonly question: OpenRouterQuestion;
}) => Promise<DecisionsResponse>;

export type DecisionPort = {
  readonly decide: (request: DecisionRequest) => Promise<AdvisoryDecision>;
};

export function openDecisionProviderService(input: {
  readonly userRoot: string;
  readonly vault?: CredentialPort;
  readonly invokeDecision?: DecisionInvoker;
  readonly now?: () => string;
  readonly isCredentialInUse?: (reference: string) => boolean;
}) {
  const vault = input.vault ?? credentialPort();
  const invokeDecision = input.invokeDecision ?? openRouterDecision;
  const now = input.now ?? (() => new Date().toISOString());
  const target = path.join(input.userRoot, "decision-providers.json");
  let cached: readonly DecisionProviderRecord[] | null = null;
  let tail = Promise.resolve();

  const enqueue = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const read = (): readonly DecisionProviderRecord[] => {
    if (cached !== null) return cached;
    if (!existsSync(target)) {
      cached = [];
      return cached;
    }
    const parsed = JSON.parse(readFileSync(target, "utf8")) as ProviderFile;
    if (parsed.schema !== fileSchema || !Array.isArray(parsed.providers))
      throw providerError("invalid_provider", "The stored Decisions provider file has an unsupported shape.");
    cached = parsed.providers;
    return cached;
  };
  const persist = (providers: readonly DecisionProviderRecord[]): void => {
    writeFileDurably(target, `${JSON.stringify({ schema: fileSchema, providers }, null, 2)}\n`, 0o600);
    cached = providers;
  };
  const requiredText = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.trim() === "")
      throw providerError("invalid_provider", `${field} is required.`);
    return value.trim();
  };
  const providerId = (value: unknown): string => {
    const id = requiredText(value, "providerId");
    if (!providerIdPattern.test(id)) throw providerError("invalid_provider", "providerId has an invalid format.");
    return id;
  };
  const secureBaseUrl = (value: unknown): string | null => {
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return null;
    if (typeof value !== "string")
      throw providerError("invalid_base_url", "baseUrl must be an absolute HTTPS URL or loopback HTTP URL.");
    const text = value.trim();
    if (!URL.canParse(text))
      throw providerError("invalid_base_url", "baseUrl must be an absolute HTTPS URL or loopback HTTP URL.");
    const url = new URL(text);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))
    )
      throw providerError("invalid_base_url", "baseUrl must use HTTPS or loopback HTTP.");
    if (url.username || url.password || url.search || url.hash)
      throw providerError("invalid_base_url", "baseUrl cannot contain credentials, query parameters, or a fragment.");
    return text.replace(/\/+$/u, "");
  };
  const publicProvider = (value: DecisionProviderRecord): DecisionProviderRecord => ({
    ...value,
    auth: { mode: "api-key", credentialRef: value.auth.credentialRef },
  });
  const summaryLine = (value: DecisionProviderRecord): string =>
    `${value.providerId}\t${value.name}\t${value.model}\t${value.enabled ? "enabled" : "disabled"}\t${value.probe.state}`;
  const command = (action: ProviderCommand): Promise<Record<string, unknown>> => enqueue(() => execute(action));

  async function execute(action: ProviderCommand): Promise<Record<string, unknown>> {
    const kind = String(action.kind ?? ""),
      base = { schema: "command-receipt/v2", ok: true, command: kind, outcome: "applied" } as Record<string, unknown>;
    if (kind === "provider-list") {
      const providers = read().map(publicProvider);
      return {
        ...base,
        providers,
        evidence: JSON.stringify(providers),
        summary: providers.length ? providers.map(summaryLine).join("\n") : "No Decisions providers configured.",
      };
    }
    const id = providerId(action.providerId);
    if (kind === "provider-create") {
      if (action.type !== "decisions")
        throw providerError("invalid_provider_type", "Only --type decisions is supported.");
      if (read().some((entry) => entry.providerId === id))
        throw providerError("provider_exists", `Provider ${id} already exists.`);
      const name = requiredText(action.name, "name"),
        model = requiredText(action.model, "model"),
        baseUrl = secureBaseUrl(action.baseUrl),
        enabled = action.enabled === undefined ? true : requireBoolean(action.enabled, "enabled"),
        auth = await takeCredential(action, vault);
      const record: DecisionProviderRecord = {
        schema: "decision-provider/v1",
        providerId: id,
        name,
        providerType: "decisions",
        vendor: "openrouter",
        model,
        baseUrl,
        auth: { mode: "api-key", credentialRef: auth.reference },
        enabled,
        configurationRevision: 1,
        probe: { state: "unknown" },
      };
      try {
        persist([...read(), record]);
      } catch (error) {
        if (auth.issued) await vault.remove(auth.reference);
        throw error;
      }
      return { ...base, provider: publicProvider(record), providerId: id, summary: `provider-create: ${id}` };
    }
    const current = read().find((entry) => entry.providerId === id);
    if (!current) throw providerError("provider_not_found", `Decisions provider ${id} does not exist.`);
    if (kind === "provider-show")
      return { ...base, provider: publicProvider(current), summary: providerSummary(current) };
    if (kind === "provider-delete") {
      const remaining = read().filter((entry) => entry.providerId !== id);
      persist(remaining);
      const cleanup = await removeUnusedCredential(
        current.auth.credentialRef,
        remaining,
        vault,
        input.isCredentialInUse,
      );
      return {
        ...base,
        deletedProviderId: id,
        credentialCleanup: cleanup,
        summary: `provider-delete: ${id}`,
      };
    }
    if (kind === "provider-update") {
      const name = action.name === undefined ? undefined : requiredText(action.name, "name"),
        model = action.model === undefined ? undefined : requiredText(action.model, "model"),
        baseUrl = action.baseUrl === undefined ? undefined : secureBaseUrl(action.baseUrl),
        enabled = action.enabled === undefined ? undefined : requireBoolean(action.enabled, "enabled");
      if (
        name === undefined &&
        model === undefined &&
        baseUrl === undefined &&
        enabled === undefined &&
        action.apiKey === undefined &&
        action.credentialRef === undefined
      )
        throw providerError("invalid_provider", "Specify at least one provider field to update.");
      const auth = await takeCredential(action, vault, current.auth.credentialRef);
      const updated: DecisionProviderRecord = {
        ...current,
        ...(name === undefined ? {} : { name }),
        ...(model === undefined ? {} : { model }),
        ...(action.baseUrl === undefined ? {} : { baseUrl }),
        ...(enabled === undefined ? {} : { enabled }),
        auth: { mode: "api-key", credentialRef: auth.reference },
        configurationRevision: current.configurationRevision + 1,
        probe: { state: "unknown" },
      };
      try {
        persist(read().map((entry) => (entry.providerId === id ? updated : entry)));
      } catch (error) {
        if (auth.issued) await vault.remove(auth.reference);
        throw error;
      }
      const cleanup =
        auth.reference === current.auth.credentialRef
          ? "not-needed"
          : await removeUnusedCredential(current.auth.credentialRef, read(), vault, input.isCredentialInUse);
      return {
        ...base,
        provider: publicProvider(updated),
        credentialCleanup: cleanup,
        summary: `provider-update: ${id}`,
      };
    }
    if (kind === "provider-probe") {
      let apiKey: string;
      try {
        apiKey = await vault.resolve(current.auth.credentialRef);
      } catch (error) {
        if (!isErrorCode(error, "runtime_credential_unavailable")) throw error;
        const failed = {
          ...current,
          probe: { state: "failed" as const, checkedAt: now(), code: "provider_credential_unavailable" },
        };
        persist(read().map((entry) => (entry.providerId === id ? failed : entry)));
        throw providerError("provider_credential_unavailable", `The credential for ${id} is unavailable.`);
      }
      try {
        await invokeDecision({
          apiKey,
          serverURL: serverUrl(current),
          model: current.model,
          state: [probeState],
          question: probeQuestion,
        });
      } catch (error) {
        const mapped = mapOpenRouterFailure(error),
          failed = {
            ...current,
            probe: { state: "failed" as const, checkedAt: now(), code: decisionFailureCode(mapped) },
          };
        persist(read().map((entry) => (entry.providerId === id ? failed : entry)));
        throw mapped;
      }
      const checkedAt = now(),
        updated = { ...current, probe: { state: "ready" as const, checkedAt } };
      persist(read().map((entry) => (entry.providerId === id ? updated : entry)));
      return {
        ...base,
        provider: publicProvider(updated),
        probe: updated.probe,
        summary: `provider-probe: ${id} ready`,
      };
    }
    throw providerError("invalid_provider", `Unsupported provider command: ${kind}.`);
  }

  const port: DecisionPort = {
    decide: async (request) => {
      validateDecisionRequest(request);
      const selected = await enqueue(async () => {
        const provider = read().find((entry) => entry.providerId === request.providerId);
        if (!provider)
          throw providerError("provider_not_found", `Decisions provider ${request.providerId} does not exist.`);
        if (!provider.enabled)
          throw providerError("provider_disabled", `Decisions provider ${request.providerId} is disabled.`);
        let apiKey: string;
        try {
          apiKey = await vault.resolve(provider.auth.credentialRef);
        } catch (error) {
          if (!isErrorCode(error, "runtime_credential_unavailable")) throw error;
          throw providerError(
            "provider_credential_unavailable",
            `The credential for ${provider.providerId} is unavailable.`,
          );
        }
        return { provider, apiKey };
      });
      const startedAt = Date.now();
      let response: DecisionsResponse;
      try {
        response = await invokeDecision({
          apiKey: selected.apiKey,
          serverURL: serverUrl(selected.provider),
          model: selected.provider.model,
          state: request.state,
          question: toOpenRouterQuestion(request.question),
        });
      } catch (error) {
        throw mapOpenRouterFailure(error);
      }
      return decodeDecision(response, request, selected.provider, Math.max(0, Date.now() - startedAt));
    },
  };
  return { command, list: () => read().map(publicProvider), read, port };
}

function takeCredential(
  action: ProviderCommand,
  vault: CredentialPort,
  currentReference?: string,
): Promise<{ readonly reference: string; readonly issued: boolean }> {
  return (async () => {
    const apiKey = action.apiKey,
      suppliedReference = action.credentialRef;
    if (apiKey !== undefined && suppliedReference !== undefined)
      throw providerError("invalid_provider", "Provide an API key or credential reference, not both.");
    if (apiKey !== undefined) {
      if (typeof apiKey !== "string" || !apiKey.trim() || !apiKeyPattern.test(apiKey))
        throw providerError(
          "invalid_provider",
          "API keys must be nonblank single-line text of at most 1280 characters.",
        );
      const secret = apiKey.trim();
      const reference = vault.issue();
      try {
        await vault.store(reference, secret);
      } catch (error) {
        if (!isErrorCode(error, "runtime_credential_unavailable")) throw error;
        throw providerError(
          "provider_credential_unavailable",
          "The API key could not be stored in the credential vault.",
        );
      }
      return { reference, issued: true };
    }
    if (suppliedReference !== undefined) {
      if (typeof suppliedReference !== "string" || !isCredentialReferenceText(suppliedReference))
        throw providerError("invalid_provider", "credentialRef has an invalid format.");
      return { reference: suppliedReference, issued: false };
    }
    if (currentReference !== undefined) return { reference: currentReference, issued: false };
    throw providerError("invalid_provider", "Provide --api-key-file or --credential-ref.");
  })();
}

async function removeUnusedCredential(
  reference: string,
  providers: readonly DecisionProviderRecord[],
  vault: CredentialPort,
  isCredentialInUse?: (reference: string) => boolean,
): Promise<"removed" | "retained"> {
  if (providers.some((entry) => entry.auth.credentialRef === reference) || isCredentialInUse?.(reference))
    return "retained";
  await vault.remove(reference);
  return "removed";
}

function validateDecisionRequest(request: DecisionRequest): void {
  if (
    !request ||
    typeof request.subjectRef !== "string" ||
    request.subjectRef.trim() === "" ||
    typeof request.providerId !== "string" ||
    request.providerId.trim() === "" ||
    typeof request.questionSetVersion !== "string" ||
    request.questionSetVersion.trim() === "" ||
    !Array.isArray(request.state) ||
    request.state.length !== 1 ||
    typeof request.state[0] !== "string" ||
    request.state[0].trim() === ""
  )
    throw providerError(
      "invalid_decision_request",
      "Decision request requires a subject, provider, question-set version, and one text state.",
    );
  const question = request.question;
  if (!question || typeof question.prompt !== "string" || question.prompt.trim() === "")
    throw providerError("invalid_decision_request", "Decision question requires nonblank instructions.");
  if (question.type === "noul") {
    if (!nonblank(question.criteria.true) || !nonblank(question.criteria.false))
      throw providerError("invalid_decision_request", "Noul questions require true and false criteria.");
    return;
  }
  const options = question.type === "choice" ? question.options : question.type === "score" ? question.levels : null;
  if (!options || options.length < 2 || options.some((option) => !validOption(option)))
    throw providerError("invalid_decision_request", "Choice and score questions require at least two named options.");
  const ids = options.map((option) => option.id);
  if (
    new Set(ids).size !== ids.length ||
    Object.keys(question.criteria).length !== ids.length ||
    ids.some((id) => !nonblank(question.criteria[id]))
  )
    throw providerError("invalid_decision_request", "Question criteria must describe each option exactly once.");
}

function validOption(value: DecisionOption): boolean {
  return Boolean(value && nonblank(value.id) && nonblank(value.text));
}
function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function toOpenRouterQuestion(question: DecisionQuestion): OpenRouterQuestion {
  if (question.type === "noul") return { type: "noul", instructions: question.prompt, criteria: question.criteria };
  if (question.type === "choice")
    return {
      type: "choice",
      instructions: question.prompt,
      criteria: Object.fromEntries(
        question.options.map((option) => [option.id, { label: option.text, criterion: question.criteria[option.id] }]),
      ),
    };
  return {
    type: "score",
    instructions: question.prompt,
    criteria: question.levels.map((level) => ({
      id: level.id,
      label: level.text,
      criterion: question.criteria[level.id],
    })),
  };
}

function serverUrl(provider: DecisionProviderRecord): string | undefined {
  return provider.baseUrl ?? undefined;
}

async function openRouterDecision(input: {
  readonly apiKey: string;
  readonly serverURL: string | undefined;
  readonly model: string;
  readonly state: readonly string[];
  readonly question: OpenRouterQuestion;
}): Promise<DecisionsResponse> {
  const client = openRouterClient(input.apiKey);
  return client.alpha.decisions.create(
    {
      decisionsRequest: {
        model: input.model,
        state: [...input.state],
        questions: { decision: input.question },
      },
    },
    {
      // Omitted when the provider has no base URL: the SDK's own Decisions
      // operation default then applies, so this repository stores no copy of it.
      ...(input.serverURL === undefined ? {} : { serverURL: input.serverURL }),
      timeoutMs: requestTimeoutMs,
      retries: { strategy: "none" },
      retryCodes: [],
    },
  );
}

function openRouterClient(apiKey: string): OpenRouter {
  return new OpenRouter({ apiKey, retryConfig: { strategy: "none" }, timeoutMs: requestTimeoutMs });
}

function decodeDecision(
  response: DecisionsResponse,
  request: DecisionRequest,
  provider: DecisionProviderRecord,
  latencyMs: number,
): AdvisoryDecision {
  const answer = response.answers.decision;
  if (!answer || answer.type !== request.question.type)
    throw providerError(
      "decision_protocol_invalid",
      "The Decisions response did not match the requested question type.",
    );
  const providerMetadata: DecisionProviderMetadata = Object.freeze({
    providerId: provider.providerId,
    vendor: provider.vendor,
    requestedModel: provider.model,
    resolvedModel: response.model,
    modelVersion: null,
    providerRoute: response.provider ?? null,
  });
  const usage: DecisionUsage = Object.freeze({
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    reportedCost: response.usage.cost ?? null,
  });
  const base = Object.freeze({
    disposition: "advisory" as const,
    authoritative: false as const,
    subjectRef: request.subjectRef,
    questionSetVersion: request.questionSetVersion,
    provider: providerMetadata,
    usage,
    latencyMs,
  });
  if (answer.type === "noul") {
    if (!Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
      throw providerError("decision_protocol_invalid", "The Decisions Noul response is outside the [0, 1] range.");
    return Object.freeze({
      ...base,
      questionType: "noul",
      distribution: Object.freeze({ true: answer.noul, false: 1 - answer.noul }),
      result: Object.freeze({ type: "noul", value: answer.noul }),
      __advisoryDecisionBrand: Symbol("advisory-decision") as never,
    });
  }
  if (answer.type === "choice") {
    const optionIds = request.question.type === "choice" ? request.question.options.map(({ id }) => id) : [];
    const distribution = completeDistribution(answer.probabilities, optionIds);
    if (!optionIds.includes(answer.choice))
      throw providerError("decision_protocol_invalid", "The Decisions response selected an unknown option.");
    return Object.freeze({
      ...base,
      questionType: "choice",
      distribution: Object.freeze(distribution),
      result: Object.freeze({ type: "choice", selected: answer.choice }),
      __advisoryDecisionBrand: Symbol("advisory-decision") as never,
    });
  }
  const levelCount = request.question.type === "score" ? request.question.levels.length : 0;
  return Object.freeze({
    ...base,
    questionType: "score",
    distribution: Object.freeze(completeDistributionByCount(answer.probabilities, levelCount)),
    result: Object.freeze({ type: "score", value: answer.score }),
    __advisoryDecisionBrand: Symbol("advisory-decision") as never,
  });
}

function completeDistribution(
  value: Readonly<Record<string, number>> | undefined,
  expectedIds: readonly string[],
): Readonly<Record<string, number>> {
  if (!value || Object.keys(value).length !== expectedIds.length || expectedIds.some((id) => !(id in value)))
    throw providerError(
      "decision_protocol_invalid",
      "The Decisions response did not include a complete option distribution.",
    );
  return Object.fromEntries(
    Object.entries(value).map(([id, probability]) => {
      if (!Number.isFinite(probability) || probability < 0 || probability > 1)
        throw providerError("decision_protocol_invalid", "The Decisions response contains an invalid probability.");
      return [id, probability];
    }),
  );
}

function completeDistributionByCount(
  value: Readonly<Record<string, number>> | undefined,
  expectedCount: number,
): Readonly<Record<string, number>> {
  if (!value || Object.keys(value).length !== expectedCount)
    throw providerError(
      "decision_protocol_invalid",
      "The Decisions response did not include a complete score distribution.",
    );
  return Object.fromEntries(
    Object.entries(value).map(([label, probability]) => {
      if (!Number.isFinite(probability) || probability < 0 || probability > 1)
        throw providerError("decision_protocol_invalid", "The Decisions response contains an invalid probability.");
      return [label, probability];
    }),
  );
}

function mapOpenRouterFailure(error: unknown): Error {
  const code = decisionFailureCode(error);
  if (code === "provider_credential_unavailable")
    return providerError(code, "OpenRouter rejected the configured Decisions API key.");
  if (code === "decision_rate_limited") return providerError(code, "OpenRouter rate limited the Decisions request.");
  if (code === "decision_timeout") return providerError(code, "The Decisions request timed out.");
  if (code === "decision_protocol_invalid")
    return providerError(code, "OpenRouter returned an invalid Decisions response.");
  if (code === "decision_transport")
    return providerError(code, "The OpenRouter Decisions request could not be completed.");
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function decisionFailureCode(error: unknown): DecisionPortFailureCode {
  if (!error || typeof error !== "object") return "decision_transport";
  const row = error as {
      readonly name?: unknown;
      readonly code?: unknown;
      readonly statusCode?: unknown;
      readonly status?: unknown;
    },
    name = typeof row.name === "string" ? row.name : "",
    status = typeof row.statusCode === "number" ? row.statusCode : typeof row.status === "number" ? row.status : null;
  if (status === 401 || status === 403) return "provider_credential_unavailable";
  if (status === 429 || name.includes("TooManyRequests")) return "decision_rate_limited";
  if (status === 408 || status === 524 || name.includes("Timeout") || name.includes("Aborted"))
    return "decision_timeout";
  if (name.includes("Validation")) return "decision_protocol_invalid";
  if (status !== null || name.includes("Connection") || name.includes("Network")) return "decision_transport";
  if (row.code === "provider_credential_unavailable") return "provider_credential_unavailable";
  if (row.code === "decision_timeout") return "decision_timeout";
  if (row.code === "decision_rate_limited") return "decision_rate_limited";
  if (row.code === "decision_protocol_invalid") return "decision_protocol_invalid";
  if (row.code === "decision_transport") return "decision_transport";
  return "decision_transport";
}

function providerSummary(provider: DecisionProviderRecord): string {
  return [
    `provider:${provider.providerId}`,
    `name:${provider.name}`,
    "type:decisions",
    `vendor:${provider.vendor}`,
    `model:${provider.model}`,
    `enabled:${provider.enabled ? "yes" : "no"}`,
    `probe:${provider.probe.state}`,
    "capability:advisory-only (cannot dispatch)",
  ].join("\n");
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw providerError("invalid_provider", `${field} must be boolean.`);
  return value;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function providerError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

export type { DecisionPortFailureCode };

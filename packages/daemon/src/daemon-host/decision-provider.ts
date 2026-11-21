import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, decisionProviderVendors } from "@harness-anything/kernel";
import type {
  AdvisoryDecision,
  DecisionOption,
  DecisionPortFailureCode,
  DecisionProviderMetadata,
  DecisionProviderRecord,
  DecisionProviderVendor,
  DecisionQuestion,
  DecisionRequest,
  DecisionUsage,
} from "@harness-anything/kernel";
import { credentialPort, isCredentialReferenceText, type CredentialPort } from "./agent-runtime-credential-port.ts";
import {
  canonicalBaseUrlString,
  DecisionAdapterError,
  getDecisionProviderAdapter,
  modelUnavailablePattern,
  normalizeChoiceDistribution,
  normalizeNoulValue,
  normalizeScoreDistribution,
  postDecisionJson,
  redactDecisionSecret,
  parseDecisionProviderBaseUrl,
  type DecisionProviderQuestion,
  type NormalizedDecisionEnvelope,
} from "./decision-providers/index.ts";
import { writeFileDurably } from "../../../storage/src/durable-file.ts";

const fileSchema = "decision-providers/v1" as const;
const providerIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const apiKeyPattern = /^[^\r\n\u0000-\u001f\u007f]{1,1280}$/u;
const requestTimeoutMs = 30_000;
const decisionRetryMaxRetries = 3;
const decisionRetryBaseDelayMs = 250;
const decisionRetryMaxDelayMs = 4_000;
/** Sent through the real Decisions operation so a probe cannot pass on an endpoint decisions never use. */
const probeState = "probe";
const probeQuestion = {
  type: "noul",
  instructions: "Reachability probe. Answer true if you can read this request.",
  criteria: { true: "The request is readable.", false: "The request is not readable." },
} as const satisfies DecisionProviderQuestion;

type ProviderFile = { readonly schema: typeof fileSchema; readonly providers: readonly DecisionProviderRecord[] };
type ProviderCommand = Readonly<Record<string, unknown>>;
type DecisionInvoker = (input: {
  readonly apiKey: string;
  readonly serverURL: string | undefined;
  readonly model: string;
  readonly state: readonly string[];
  readonly question: DecisionProviderQuestion;
}) => Promise<NormalizedDecisionEnvelope>;
type DecisionSleep = (delayMs: number) => Promise<void>;

export type DecisionPort = {
  readonly decide: (request: DecisionRequest) => Promise<AdvisoryDecision>;
};

export function openDecisionProviderService(input: {
  readonly userRoot: string;
  readonly vault?: CredentialPort;
  readonly invokeDecision?: DecisionInvoker;
  readonly now?: () => string;
  readonly isCredentialInUse?: (reference: string) => boolean;
  /** Injectable only to make bounded retry timing deterministic in tests. */
  readonly sleep?: DecisionSleep;
  /** Injectable only to make request timeout tests deterministic without waiting 30s. */
  readonly requestTimeoutMs?: number;
}) {
  const vault = input.vault ?? credentialPort();
  const effectiveTimeoutMs = input.requestTimeoutMs ?? requestTimeoutMs;
  const invokeAdapter = (
    vendor: DecisionProviderVendor,
  ): ((req: {
    readonly apiKey: string;
    readonly baseUrl: URL | null;
    readonly model: string;
    readonly state: readonly string[];
    readonly question: DecisionProviderQuestion;
  }) => Promise<NormalizedDecisionEnvelope>) => {
    if (input.invokeDecision) {
      const injected = input.invokeDecision;
      return (request) =>
        injected({
          apiKey: request.apiKey,
          serverURL: request.baseUrl === null ? undefined : canonicalBaseUrlString(request.baseUrl),
          model: request.model,
          state: request.state,
          question: request.question,
        });
    }
    const adapter = getDecisionProviderAdapter(vendor);
    return (request) =>
      adapter.invoke({
        apiKey: request.apiKey,
        baseUrl: request.baseUrl,
        model: request.model,
        state: request.state,
        question: request.question,
        timeoutMs: effectiveTimeoutMs,
        postJson: postDecisionJson,
      });
  };
  const sleep = input.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
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
    cached = parsed.providers.map(normalizeStoredProvider);
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
      const vendor = parseVendor(action.vendor, "openrouter"),
        adapter = getDecisionProviderAdapter(vendor),
        name = requiredText(action.name, "name"),
        model = requiredText(action.model, "model"),
        validatedUrl = parseDecisionProviderBaseUrl(adapter, action.baseUrl),
        enabled = action.enabled === undefined ? true : requireBoolean(action.enabled, "enabled"),
        auth = await takeCredential(action, vault);
      const record: DecisionProviderRecord = {
        schema: "decision-provider/v1",
        providerId: id,
        name,
        providerType: "decisions",
        vendor,
        model,
        baseUrl: validatedUrl.stored,
        auth: { mode: "api-key", credentialRef: auth.reference },
        enabled,
        configurationRevision: 1,
        configurationId: randomUUID(),
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
      const vendor = action.vendor === undefined ? undefined : parseVendor(action.vendor),
        name = action.name === undefined ? undefined : requiredText(action.name, "name"),
        model = action.model === undefined ? undefined : requiredText(action.model, "model"),
        hasBaseUrlUpdate = action.baseUrl !== undefined,
        enabled = action.enabled === undefined ? undefined : requireBoolean(action.enabled, "enabled");
      if (
        vendor === undefined &&
        name === undefined &&
        model === undefined &&
        !hasBaseUrlUpdate &&
        enabled === undefined &&
        action.apiKey === undefined &&
        action.credentialRef === undefined
      )
        throw providerError("invalid_provider", "Specify at least one provider field to update.");
      const nextVendor = vendor ?? current.vendor,
        nextAdapter = getDecisionProviderAdapter(nextVendor),
        candidateBaseUrl = hasBaseUrlUpdate ? action.baseUrl : current.baseUrl,
        validatedUrl = parseDecisionProviderBaseUrl(nextAdapter, candidateBaseUrl);
      const auth = await takeCredential(action, vault, current.auth.credentialRef);
      const updated: DecisionProviderRecord = {
        ...current,
        vendor: nextVendor,
        ...(name === undefined ? {} : { name }),
        ...(model === undefined ? {} : { model }),
        baseUrl: validatedUrl.stored,
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
      const adapter = getDecisionProviderAdapter(current.vendor);
      let validatedUrl: ReturnType<typeof parseDecisionProviderBaseUrl>;
      try {
        validatedUrl = parseDecisionProviderBaseUrl(adapter, current.baseUrl);
      } catch (error) {
        const failed = {
          ...current,
          probe: { state: "failed" as const, checkedAt: now(), code: decisionFailureCode(error) },
        };
        persist(read().map((entry) => (entry.providerId === id ? failed : entry)));
        throw error;
      }
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
        await invokeDecisionWithRetry({
          invokeDecision: invokeAdapter(current.vendor),
          sleep,
          apiKey,
          baseUrl: validatedUrl.parsed,
          model: current.model,
          state: [probeState],
          question: probeQuestion,
          providerId: current.providerId,
          vendor: current.vendor,
        });
      } catch (error) {
        const failed = {
          ...current,
          probe: { state: "failed" as const, checkedAt: now(), code: decisionFailureCode(error) },
        };
        persist(read().map((entry) => (entry.providerId === id ? failed : entry)));
        throw error;
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

  const recordProbeFailure = (
    providerId: string,
    configurationRevision: number,
    configurationId: string,
    code: DecisionPortFailureCode,
  ): void => {
    const current = read().find((entry) => entry.providerId === providerId);
    // A configuration update increments the revision and resets the probe for the new model; a
    // delete/recreate keeps revision 1 but issues a new configuration id. Either way the failure
    // belongs to the configuration the request selected, not to whatever now owns the provider id.
    if (
      !current ||
      current.configurationRevision !== configurationRevision ||
      current.configurationId !== configurationId
    )
      return;
    persist(
      read().map((entry) =>
        entry.providerId === providerId
          ? { ...entry, probe: { state: "failed" as const, checkedAt: now(), code } }
          : entry,
      ),
    );
  };

  const port: DecisionPort = {
    decide: async (request) => {
      validateDecisionRequest(request);
      const selected = await enqueue(async () => {
        const provider = read().find((entry) => entry.providerId === request.providerId);
        if (!provider)
          throw providerError("provider_not_found", `Decisions provider ${request.providerId} does not exist.`);
        if (!provider.enabled)
          throw providerError("provider_disabled", `Decisions provider ${request.providerId} is disabled.`);
        const adapter = getDecisionProviderAdapter(provider.vendor);
        const validatedUrl = parseDecisionProviderBaseUrl(adapter, provider.baseUrl);
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
        return { provider, apiKey, parsedBaseUrl: validatedUrl.parsed };
      });
      const startedAt = Date.now();
      let response: NormalizedDecisionEnvelope;
      try {
        response = await invokeDecisionWithRetry({
          invokeDecision: invokeAdapter(selected.provider.vendor),
          sleep,
          apiKey: selected.apiKey,
          baseUrl: selected.parsedBaseUrl,
          model: selected.provider.model,
          state: request.state,
          question: toProviderQuestion(request.question),
          providerId: selected.provider.providerId,
          vendor: selected.provider.vendor,
        });
      } catch (error) {
        // A provider that cannot serve its configured model or credential stays broken until the
        // operator edits the machine-local provider file; record it so `ha doctor health` shows the
        // same fault instead of only the dispatch receipt that happened to observe it.
        const code = decisionFailureCode(error);
        if (code === "decision_model_unavailable" || code === "provider_credential_unavailable")
          await enqueue(() =>
            recordProbeFailure(
              selected.provider.providerId,
              selected.provider.configurationRevision,
              selected.provider.configurationId,
              code,
            ),
          ).catch(consumeKnownError);
        throw error;
      }
      return decodeDecision(response, request, selected.provider, Math.max(0, Date.now() - startedAt));
    },
  };
  return { command, list: () => read().map(publicProvider), read, port };
}

function invokeDecisionWithRetry(
  input: {
    readonly invokeDecision: (req: {
      readonly apiKey: string;
      readonly baseUrl: URL | null;
      readonly model: string;
      readonly state: readonly string[];
      readonly question: DecisionProviderQuestion;
    }) => Promise<NormalizedDecisionEnvelope>;
    readonly sleep: DecisionSleep;
    readonly apiKey: string;
    readonly baseUrl: URL | null;
    readonly model: string;
    readonly state: readonly string[];
    readonly question: DecisionProviderQuestion;
    readonly providerId: string;
    readonly vendor: DecisionProviderVendor;
  },
  retries = 0,
): Promise<NormalizedDecisionEnvelope> {
  return input
    .invokeDecision({
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      model: input.model,
      state: input.state,
      question: input.question,
    })
    .catch((error: unknown) => {
      const code = decisionFailureCode(error),
        mapped = mapDecisionFailure(error, input.apiKey, input.providerId, input.model, input.vendor),
        retryable = retryableDecisionFailure(error, code);
      if (!retryable || retries >= decisionRetryMaxRetries) {
        if (retryable && retries > 0)
          return Promise.reject(
            providerError(
              code,
              `${mapped.message} Retried ${String(retries)} time(s); ${
                code === "decision_rate_limited"
                  ? `重试 ${String(retries)} 次后仍限流。`
                  : `重试 ${String(retries)} 次后仍为瞬时 ${code} 错误。`
              }`,
              retries,
            ),
          );
        return Promise.reject(mapped);
      }
      const delayMs = Math.min(decisionRetryMaxDelayMs, decisionRetryBaseDelayMs * 2 ** retries);
      return input.sleep(delayMs).then(() => invokeDecisionWithRetry(input, retries + 1));
    });
}

function retryableDecisionFailure(error: unknown, code: DecisionPortFailureCode): boolean {
  if (error instanceof DecisionAdapterError) return error.transient === true;
  if (code === "decision_rate_limited" || code === "decision_timeout") return true;
  if (code !== "decision_transport" || typeof error !== "object" || error === null) return false;
  const row = error as {
      readonly name?: unknown;
      readonly statusCode?: unknown;
      readonly status?: unknown;
      readonly transient?: unknown;
    },
    status = typeof row.statusCode === "number" ? row.statusCode : typeof row.status === "number" ? row.status : null,
    name = typeof row.name === "string" ? row.name : "";
  if (row.transient === false) return false;
  if (status !== null) return status >= 500;
  return name.includes("Connection") || name.includes("Network");
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
    ids.some((id) => !Object.hasOwn(question.criteria, id) || !nonblank(question.criteria[id]))
  )
    throw providerError("invalid_decision_request", "Question criteria must describe each option exactly once.");
}

function validOption(value: DecisionOption): boolean {
  return Boolean(value && nonblank(value.id) && nonblank(value.text));
}
function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function toProviderQuestion(question: DecisionQuestion): DecisionProviderQuestion {
  if (question.type === "noul") return { type: "noul", instructions: question.prompt, criteria: question.criteria };
  if (question.type === "choice") {
    const criteria: Record<string, { readonly label: string; readonly criterion: string }> = {};
    for (const option of question.options) {
      Object.defineProperty(criteria, option.id, {
        value: { label: option.text, criterion: question.criteria[option.id]! },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return {
      type: "choice",
      instructions: question.prompt,
      criteria,
    };
  }
  return {
    type: "score",
    instructions: question.prompt,
    criteria: question.levels.map((level) => ({
      id: level.id,
      label: level.text,
      criterion: question.criteria[level.id]!,
    })),
  };
}

function decodeDecision(
  response: NormalizedDecisionEnvelope,
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
    const noulValue = normalizeNoulValue(answer.noul);
    return Object.freeze({
      ...base,
      questionType: "noul",
      distribution: Object.freeze({ true: noulValue, false: 1 - noulValue }),
      result: Object.freeze({ type: "noul", value: noulValue }),
      __advisoryDecisionBrand: Symbol("advisory-decision") as never,
    });
  }
  if (answer.type === "choice") {
    const optionIds = request.question.type === "choice" ? request.question.options.map(({ id }) => id) : [];
    const distribution = normalizeChoiceDistribution(answer.probabilities, optionIds);
    if (!optionIds.includes(answer.choice))
      throw providerError("decision_protocol_invalid", "The Decisions response selected an unknown option.");
    return Object.freeze({
      ...base,
      questionType: "choice",
      distribution,
      result: Object.freeze({ type: "choice", selected: answer.choice }),
      __advisoryDecisionBrand: Symbol("advisory-decision") as never,
    });
  }
  const levelCount = request.question.type === "score" ? request.question.levels.length : 0;
  return Object.freeze({
    ...base,
    questionType: "score",
    distribution: normalizeScoreDistribution(answer.probabilities, levelCount),
    result: Object.freeze({ type: "score", value: answer.score }),
    __advisoryDecisionBrand: Symbol("advisory-decision") as never,
  });
}

function mapDecisionFailure(
  error: unknown,
  apiKey?: string,
  providerId?: string,
  model?: string,
  vendor: DecisionProviderVendor = "openrouter",
): Error {
  const code = decisionFailureCode(error),
    detail = decisionFailureDetail(error, apiKey),
    withDetail = (summary: string): string => (detail === "" ? summary : `${summary} ${detail}`),
    vendorLabel = getDecisionProviderAdapter(vendor).label,
    provider =
      providerId === undefined || model === undefined
        ? "the configured Decisions provider"
        : `Decisions provider ${providerId} (model ${model})`;
  if (code === "provider_credential_unavailable")
    return providerError(code, withDetail(`${vendorLabel} rejected the configured Decisions API key.`), 0);
  if (code === "decision_rate_limited")
    return providerError(code, withDetail(`${vendorLabel} rate limited the Decisions request.`), 0);
  if (code === "decision_timeout") return providerError(code, withDetail("The Decisions request timed out."), 0);
  if (code === "decision_protocol_invalid")
    return providerError(code, withDetail(`${vendorLabel} returned an invalid Decisions response.`), 0);
  if (code === "decision_model_unavailable")
    return providerError(
      code,
      withDetail(
        `${provider} cannot serve its configured model; update it with: ` +
          `ha provider update ${providerId ?? "<provider-id>"} --model <available-model>, ` +
          `then ha provider probe ${providerId ?? "<provider-id>"}.`,
      ),
      0,
    );
  if (code === "decision_transport")
    return providerError(code, withDetail(`The ${vendorLabel} Decisions request could not be completed.`), 0);
  if (code === "invalid_base_url") return providerError(code, withDetail("Invalid Decisions provider baseUrl."), 0);
  if (error instanceof Error) return error;
  return new Error(String(error));
}

/**
 * One actionable sentence about a provider failure: HTTP status, error class, safe provider
 * error code, and controlled diagnostic text. Raw upstream error bodies are never copied, and
 * credentials of any length are redacted before truncation.
 */
function decisionFailureDetail(error: unknown, apiKey?: string): string {
  if (typeof error === "string") return redactDecisionSecret(error, apiKey);
  if (!error || typeof error !== "object") return redactDecisionSecret(String(error), apiKey);
  if (error instanceof DecisionAdapterError) {
    const head = [
      error.statusCode === undefined ? null : `HTTP ${String(error.statusCode)}`,
      error.name && error.name !== "Error" ? error.name : null,
      error.providerCode === undefined || error.providerCode === error.statusCode
        ? null
        : `code=${String(error.providerCode)}`,
    ]
      .filter((part): part is string => part !== null)
      .join(" ");
    const message = error.message.trim();
    const detail = head === "" ? message : message === "" ? head : `${head}: ${message}`;
    return redactDecisionSecret(detail, apiKey);
  }
  const row = error as {
      readonly name?: unknown;
      readonly message?: unknown;
      readonly statusCode?: unknown;
      readonly status?: unknown;
      readonly code?: unknown;
      readonly error?: unknown;
      readonly data$?: unknown;
    },
    status = typeof row.statusCode === "number" ? row.statusCode : typeof row.status === "number" ? row.status : null,
    name = typeof row.name === "string" && row.name !== "" ? row.name : null,
    providerCode = nestedProviderErrorCode(row),
    message = typeof row.message === "string" ? row.message.trim() : "",
    head = [
      status === null ? null : `HTTP ${String(status)}`,
      name,
      providerCode === null || providerCode === status ? null : `code=${String(providerCode)}`,
    ]
      .filter((part): part is string => part !== null)
      .join(" ");
  const detail = head === "" ? message : message === "" ? head : `${head}: ${message}`;
  return redactDecisionSecret(detail, apiKey);
}

function nestedProviderErrorCode(row: {
  readonly code?: unknown;
  readonly error?: unknown;
  readonly data$?: unknown;
}): string | number | null {
  for (const candidate of [row.code, providerErrorCode(row.error), providerErrorCode(row.data$)]) {
    if (typeof candidate === "string" || typeof candidate === "number") return candidate;
  }
  return null;
}

function providerErrorCode(value: unknown): unknown {
  if (!value || typeof value !== "object") return null;
  const row = value as { readonly code?: unknown; readonly error?: unknown };
  if (typeof row.code === "string" || typeof row.code === "number") return row.code;
  const nested = row.error;
  if (!nested || typeof nested !== "object") return null;
  const nestedCode = (nested as { readonly code?: unknown }).code;
  return typeof nestedCode === "string" || typeof nestedCode === "number" ? nestedCode : null;
}

function nestedProviderMessage(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const row = value as { readonly message?: unknown; readonly error?: unknown };
  if (typeof row.message === "string") return row.message;
  return nestedProviderMessage(row.error);
}

function modelUnavailableMessage(error: object): boolean {
  const row = error as {
      readonly code?: unknown;
      readonly message?: unknown;
      readonly error?: unknown;
      readonly data$?: unknown;
    },
    body = row.data$ && typeof row.data$ === "object" ? (row.data$ as { readonly body$?: unknown }).body$ : null;
  if (nestedProviderErrorCode(row) === "model_not_found") return true;
  return [row.message, nestedProviderMessage(row.error), nestedProviderMessage(row.data$), body].some(
    (message) => typeof message === "string" && modelUnavailablePattern.test(message),
  );
}

function decisionFailureCode(error: unknown): DecisionPortFailureCode {
  if (error instanceof DecisionAdapterError) return error.code;
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
  if (status === 404 && modelUnavailableMessage(error)) return "decision_model_unavailable";
  if (status === 429 || name.includes("TooManyRequests")) return "decision_rate_limited";
  if (status === 408 || status === 524 || name.includes("Timeout") || name.includes("Aborted"))
    return "decision_timeout";
  if (name.includes("Validation")) return "decision_protocol_invalid";
  if (status !== null || name.includes("Connection") || name.includes("Network")) return "decision_transport";
  if (row.code === "invalid_base_url") return "invalid_base_url";
  if (row.code === "provider_credential_unavailable") return "provider_credential_unavailable";
  if (row.code === "decision_timeout") return "decision_timeout";
  if (row.code === "decision_rate_limited") return "decision_rate_limited";
  if (row.code === "decision_model_unavailable") return "decision_model_unavailable";
  if (row.code === "decision_protocol_invalid") return "decision_protocol_invalid";
  if (row.code === "decision_transport") return "decision_transport";
  return "decision_transport";
}

function parseVendor(value: unknown, fallback?: DecisionProviderVendor): DecisionProviderVendor {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw providerError("invalid_provider", `vendor must be one of: ${decisionProviderVendors.join(", ")}.`);
  }
  if (typeof value === "string" && (decisionProviderVendors as readonly string[]).includes(value))
    return value as DecisionProviderVendor;
  throw providerError(
    "invalid_provider",
    `Unsupported provider vendor: ${String(value)}. Supported vendors: ${decisionProviderVendors.join(", ")}.`,
  );
}

function normalizeStoredProvider(entry: DecisionProviderRecord): DecisionProviderRecord {
  const vendor = parseVendor((entry as { readonly vendor?: unknown }).vendor, "openrouter");
  return entry.vendor === vendor ? entry : { ...entry, vendor };
}

function providerSummary(provider: DecisionProviderRecord): string {
  return [
    `provider:${provider.providerId}`,
    `name:${provider.name}`,
    "type:decisions",
    `vendor:${provider.vendor}`,
    `model:${provider.model}`,
    ...(provider.baseUrl ? [`baseUrl:${provider.baseUrl}`] : []),
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

function providerError(
  code: string,
  message: string,
  retries?: number,
): Error & { readonly code: string; readonly retries?: number } {
  return Object.assign(new Error(message), { code, ...(retries === undefined ? {} : { retries }) });
}

export type { DecisionPortFailureCode };

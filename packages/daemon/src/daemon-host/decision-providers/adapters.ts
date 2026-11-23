import type { DecisionProviderVendor } from "@harness-anything/kernel";
import {
  buildAbstainChoiceAnswer,
  buildStructuredDecisionSystemPrompt,
  decodeNativeDecisionsEnvelope,
  decodeStructuredDecisionJson,
  isJsonObject,
  parseDecisionUsage,
  parseJsonObject,
} from "./normalize.ts";
import {
  DecisionAdapterError,
  type DecisionAdapterInvokeInput,
  type DecisionProviderAdapter,
  type NormalizedDecisionEnvelope,
} from "./types.ts";
import { canonicalBaseUrlString, joinEndpointUrl, resolveAdapterBaseUrl } from "./url.ts";

const anthropicApiVersion = "2023-06-01";
const anthropicMaxTokens = 1024;
const normalAnthropicStopReasons = new Set(["end_turn", "stop_sequence"]);

const openRouterAdapter: DecisionProviderAdapter = {
  vendor: "openrouter",
  label: "OpenRouter",
  defaultBaseUrl: "https://openrouter.ai/api/alpha",
  requiresBaseUrl: false,
  invoke: (input) => {
    const base = resolveAdapterBaseUrl(openRouterAdapter, input.baseUrl);
    // Deduplicate only the public OpenRouter default baseUrl (`https://openrouter.ai/api/alpha`);
    // every custom baseUrl (including legacy proxies ending in `/gateway` or `/gateway/api/alpha`)
    // preserves the exact historical `@openrouter/sdk` `api/alpha/decisions` suffix.
    const segment =
      canonicalBaseUrlString(base) === openRouterAdapter.defaultBaseUrl ? "decisions" : "api/alpha/decisions";
    return invokeBearerDecisionsEndpoint(openRouterAdapter, input, segment);
  },
};

const googleAdapter: DecisionProviderAdapter = {
  vendor: "google",
  label: "Google Gemini Decisions API",
  defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  requiresBaseUrl: false,
  invoke: async (input) => {
    const endpoint = joinEndpointUrl(resolveAdapterBaseUrl(googleAdapter, input.baseUrl), "decisions");
    const { rawBody } = await input.postJson({
      url: endpoint,
      headers: { "x-goog-api-key": input.apiKey },
      body: {
        model: input.model,
        input: input.state.join("\n\n"),
        questions: { decision: input.question },
      },
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return decodeNativeDecisionsEnvelope(rawBody, input.model, input.question, googleAdapter.label);
  },
};

const perplexityAdapter: DecisionProviderAdapter = {
  vendor: "perplexity",
  label: "Perplexity Decisions API",
  defaultBaseUrl: "https://api.perplexity.ai/v1",
  requiresBaseUrl: false,
  invoke: (input) => invokeBearerDecisionsEndpoint(perplexityAdapter, input),
};

const decisionsHttpAdapter: DecisionProviderAdapter = {
  vendor: "decisions-http",
  label: "Decisions HTTP endpoint",
  defaultBaseUrl: null,
  requiresBaseUrl: true,
  invoke: (input) => invokeBearerDecisionsEndpoint(decisionsHttpAdapter, input),
};

async function invokeBearerDecisionsEndpoint(
  adapter: DecisionProviderAdapter,
  input: DecisionAdapterInvokeInput,
  endpointSegment = "decisions",
): Promise<NormalizedDecisionEnvelope> {
  const endpoint = joinEndpointUrl(resolveAdapterBaseUrl(adapter, input.baseUrl), endpointSegment);
  const { rawBody } = await input.postJson({
    url: endpoint,
    headers: { authorization: `Bearer ${input.apiKey}` },
    body: {
      model: input.model,
      state: [...input.state],
      questions: {
        decision:
          input.question.type === "score"
            ? { ...input.question, criteria: [...input.question.criteria] }
            : input.question,
      },
    },
    timeoutMs: input.timeoutMs,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return decodeNativeDecisionsEnvelope(rawBody, input.model, input.question, adapter.label);
}

const openAiCompatibleAdapter: DecisionProviderAdapter = {
  vendor: "openai-compatible",
  label: "OpenAI-compatible endpoint",
  defaultBaseUrl: "https://api.openai.com/v1",
  requiresBaseUrl: false,
  invoke: async (input) => {
    const endpoint = joinEndpointUrl(resolveAdapterBaseUrl(openAiCompatibleAdapter, input.baseUrl), "chat/completions");
    const { rawBody } = await input.postJson({
      url: endpoint,
      headers: { authorization: `Bearer ${input.apiKey}` },
      body: {
        model: input.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildStructuredDecisionSystemPrompt(input.question) },
          { role: "user", content: input.state.join("\n\n") },
        ],
      },
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return parseChatCompletionsEnvelope(rawBody, input.model, input.question, openAiCompatibleAdapter.label);
  },
};

const anthropicAdapter: DecisionProviderAdapter = {
  vendor: "anthropic",
  label: "Anthropic Messages API",
  defaultBaseUrl: "https://api.anthropic.com/v1",
  requiresBaseUrl: false,
  invoke: async (input) => {
    const endpoint = joinEndpointUrl(resolveAdapterBaseUrl(anthropicAdapter, input.baseUrl), "messages");
    const { rawBody } = await input.postJson({
      url: endpoint,
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": anthropicApiVersion,
      },
      body: {
        model: input.model,
        max_tokens: anthropicMaxTokens,
        temperature: 0,
        system: buildStructuredDecisionSystemPrompt(input.question),
        messages: [{ role: "user", content: input.state.join("\n\n") }],
      },
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return parseAnthropicMessagesEnvelope(rawBody, input.model, input.question, anthropicAdapter.label);
  },
};

function parseChatCompletionsEnvelope(
  rawBody: string,
  requestedModel: string,
  question: DecisionAdapterInvokeInput["question"],
  vendorLabel: string,
): NormalizedDecisionEnvelope {
  const envelope = parseJsonObject(rawBody, `${vendorLabel} returned malformed JSON.`);
  const choices = envelope.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !isJsonObject(choices[0]))
    throw new DecisionAdapterError("decision_protocol_invalid", `${vendorLabel} response did not include any choices.`);
  const firstChoice = choices[0];
  let answer: NormalizedDecisionEnvelope["answers"]["decision"];
  if (firstChoice.finish_reason === "length") {
    const abstained = buildAbstainChoiceAnswer(question);
    if (abstained === null)
      throw new DecisionAdapterError(
        "decision_protocol_invalid",
        `${vendorLabel} completion did not finish normally (finish_reason must be "stop").`,
      );
    answer = abstained;
  } else if (firstChoice.finish_reason !== "stop") {
    throw new DecisionAdapterError(
      "decision_protocol_invalid",
      `${vendorLabel} completion did not finish normally (finish_reason must be "stop").`,
    );
  } else {
    const message = firstChoice.message;
    if (!isJsonObject(message))
      throw new DecisionAdapterError(
        "decision_protocol_invalid",
        `${vendorLabel} response did not include a message object.`,
      );
    const contentText = extractOpenAiMessageText(message.content);
    if (!contentText) {
      const abstained = buildAbstainChoiceAnswer(question);
      if (abstained === null)
        throw new DecisionAdapterError(
          "decision_protocol_invalid",
          `${vendorLabel} response did not include message content.`,
        );
      answer = abstained;
    } else {
      answer = decodeStructuredDecisionJson(contentText, question, vendorLabel);
    }
  }
  const resolvedModel =
    typeof envelope.model === "string" && envelope.model.trim() !== "" ? envelope.model.trim() : requestedModel;
  const providerRoute =
    typeof envelope.provider === "string" && envelope.provider.trim() !== "" ? envelope.provider.trim() : undefined;
  return {
    model: resolvedModel,
    ...(providerRoute === undefined ? {} : { provider: providerRoute }),
    usage: parseDecisionUsage(envelope.usage),
    answers: { decision: answer },
  };
}

function parseAnthropicMessagesEnvelope(
  rawBody: string,
  requestedModel: string,
  question: DecisionAdapterInvokeInput["question"],
  vendorLabel: string,
): NormalizedDecisionEnvelope {
  const envelope = parseJsonObject(rawBody, `${vendorLabel} returned malformed JSON.`);
  const stopReason = envelope.stop_reason;
  const isNormalStop = typeof stopReason === "string" && normalAnthropicStopReasons.has(stopReason);
  let answer: NormalizedDecisionEnvelope["answers"]["decision"];
  if (stopReason === "max_tokens") {
    const abstained = buildAbstainChoiceAnswer(question);
    if (abstained === null)
      throw new DecisionAdapterError(
        "decision_protocol_invalid",
        `${vendorLabel} completion did not finish normally (stop_reason must be end_turn or stop_sequence).`,
      );
    answer = abstained;
  } else if (!isNormalStop) {
    throw new DecisionAdapterError(
      "decision_protocol_invalid",
      `${vendorLabel} completion did not finish normally (stop_reason must be end_turn or stop_sequence).`,
    );
  } else {
    const contentText = extractAnthropicContentText(envelope.content);
    if (!contentText) {
      const abstained = buildAbstainChoiceAnswer(question);
      if (abstained === null)
        throw new DecisionAdapterError(
          "decision_protocol_invalid",
          `${vendorLabel} response did not include text content.`,
        );
      answer = abstained;
    } else {
      answer = decodeStructuredDecisionJson(contentText, question, vendorLabel);
    }
  }
  const resolvedModel =
    typeof envelope.model === "string" && envelope.model.trim() !== "" ? envelope.model.trim() : requestedModel;
  const providerRoute =
    typeof envelope.provider === "string" && envelope.provider.trim() !== "" ? envelope.provider.trim() : undefined;
  return {
    model: resolvedModel,
    ...(providerRoute === undefined ? {} : { provider: providerRoute }),
    usage: parseDecisionUsage(envelope.usage),
    answers: { decision: answer },
  };
}

function extractOpenAiMessageText(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (isJsonObject(item) && typeof item.text === "string" && item.text.trim() !== "") parts.push(item.text);
  }
  const joined = parts.join("\n").trim();
  return joined === "" ? null : joined;
}

function extractAnthropicContentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (
      isJsonObject(block) &&
      (block.type === undefined || block.type === "text") &&
      typeof block.text === "string" &&
      block.text.trim() !== ""
    )
      parts.push(block.text);
  }
  const joined = parts.join("\n").trim();
  return joined === "" ? null : joined;
}

export const decisionProviderAdapterRegistry: Readonly<Record<DecisionProviderVendor, DecisionProviderAdapter>> =
  Object.freeze({
    openrouter: openRouterAdapter,
    google: googleAdapter,
    perplexity: perplexityAdapter,
    "decisions-http": decisionsHttpAdapter,
    "openai-compatible": openAiCompatibleAdapter,
    anthropic: anthropicAdapter,
  });

export function getDecisionProviderAdapter(vendor: DecisionProviderVendor): DecisionProviderAdapter {
  return decisionProviderAdapterRegistry[vendor];
}

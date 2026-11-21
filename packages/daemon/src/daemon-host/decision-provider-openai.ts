import type { DecisionsResponse } from "@openrouter/sdk/models";

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
      readonly criteria: (string | { readonly id: string; readonly label: string; readonly criterion: string })[];
    };

type OpenAiCompatibleDecisionInput = {
  readonly apiKey: string;
  readonly serverURL: string | undefined;
  readonly model: string;
  readonly state: readonly string[];
  readonly question: DecisionProviderQuestion;
  readonly timeoutMs: number;
};

type JsonObject = Readonly<Record<string, unknown>>;

const maxErrorBodyExcerpt = 400;

export async function openAiCompatibleDecision(input: OpenAiCompatibleDecisionInput): Promise<DecisionsResponse> {
  if (!input.serverURL)
    throw codedError(
      "invalid_base_url",
      "openai-compatible providers require an absolute HTTPS URL or loopback HTTP baseUrl.",
    );
  const endpoint = `${input.serverURL}/chat/completions`,
    controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  let response: Response, rawBody: string;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt(input.question) },
          { role: "user", content: input.state.join("\n\n") },
        ],
      }),
      signal: controller.signal,
    });
    rawBody = await response.text();
  } catch (error) {
    throw classifyTransportError(error, timedOut);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw httpResponseError(response.status, response.statusText, rawBody);
  return parseChatCompletionsResponse(rawBody, input.model, input.question);
}

function buildSystemPrompt(question: DecisionProviderQuestion): string {
  if (question.type === "noul") {
    return [
      "You are an advisory decision evaluator. Respond with a single JSON object and no other text.",
      `Instructions: ${question.instructions}`,
      `Criterion for true: ${question.criteria.true}`,
      `Criterion for false: ${question.criteria.false}`,
      'Return strict JSON matching: {"type":"noul","noul":<number between 0 and 1>}',
    ].join("\n");
  }
  if (question.type === "choice") {
    const entries = Object.entries(question.criteria).map(([id, spec]) =>
      typeof spec === "string" ? `- ${id}: ${spec}` : `- ${id} (${spec.label}): ${spec.criterion}`,
    );
    const ids = Object.keys(question.criteria);
    return [
      "You are an advisory decision evaluator. Respond with a single JSON object and no other text.",
      `Instructions: ${question.instructions}`,
      "Options:",
      ...entries,
      `Allowed choice ids: ${JSON.stringify(ids)}`,
      'Return strict JSON matching: {"type":"choice","choice":"<one allowed option id>","probabilities":{<every allowed option id mapped to a finite probability in [0, 1] summing to 1>}}',
    ].join("\n");
  }
  const entries = question.criteria.map((entry, index) =>
    typeof entry === "string"
      ? `- level_${String(index)}: ${entry}`
      : `- ${entry.id} (${entry.label}): ${entry.criterion}`,
  );
  const ids = question.criteria.map((entry, index) =>
    typeof entry === "string" ? `level_${String(index)}` : entry.id,
  );
  return [
    "You are an advisory decision evaluator. Respond with a single JSON object and no other text.",
    `Instructions: ${question.instructions}`,
    "Score levels:",
    ...entries,
    `Expected probability keys: ${JSON.stringify(ids)}`,
    'Return strict JSON matching: {"type":"score","score":<finite number>,"probabilities":{<every expected key mapped to a finite probability in [0, 1] summing to 1>}}',
  ].join("\n");
}

function parseChatCompletionsResponse(
  rawBody: string,
  requestedModel: string,
  question: DecisionProviderQuestion,
): DecisionsResponse {
  const envelope = parseJsonObject(rawBody, "The OpenAI-compatible endpoint returned malformed JSON.");
  const choices = envelope.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !isJsonObject(choices[0]))
    throw codedError("decision_protocol_invalid", "The OpenAI-compatible response did not include any choices.");
  const message = choices[0].message;
  if (!isJsonObject(message))
    throw codedError("decision_protocol_invalid", "The OpenAI-compatible response did not include a message object.");
  const contentText = extractMessageText(message.content);
  if (!contentText)
    throw codedError("decision_protocol_invalid", "The OpenAI-compatible response did not include message content.");
  const parsedAnswer = parseJsonObject(
    stripSingleJsonFence(contentText),
    "The OpenAI-compatible response content was not valid JSON.",
  );
  const answer = decodeOpenAiAnswer(parsedAnswer, question);
  const resolvedModel =
    typeof envelope.model === "string" && envelope.model.trim() !== "" ? envelope.model.trim() : requestedModel;
  const providerRoute =
    typeof envelope.provider === "string" && envelope.provider.trim() !== "" ? envelope.provider.trim() : undefined;
  const usage = parseUsage(envelope.usage);
  return {
    model: resolvedModel,
    ...(providerRoute === undefined ? {} : { provider: providerRoute }),
    usage,
    answers: { decision: answer },
  };
}

function decodeOpenAiAnswer(
  parsed: JsonObject,
  question: DecisionProviderQuestion,
): DecisionsResponse["answers"]["decision"] {
  if (parsed.type !== undefined && parsed.type !== question.type)
    throw codedError(
      "decision_protocol_invalid",
      "The OpenAI-compatible decision JSON type did not match the requested question type.",
    );
  if (question.type === "noul") {
    if (typeof parsed.noul !== "number" || !Number.isFinite(parsed.noul) || parsed.noul < 0 || parsed.noul > 1)
      throw codedError(
        "decision_protocol_invalid",
        "The OpenAI-compatible noul response must provide a finite number in [0, 1].",
      );
    return { type: "noul", noul: parsed.noul };
  }
  if (question.type === "choice") {
    const expectedIds = Object.keys(question.criteria);
    if (typeof parsed.choice !== "string" || !expectedIds.includes(parsed.choice))
      throw codedError("decision_protocol_invalid", "The OpenAI-compatible response selected an unknown option.");
    const probabilities = parseProbabilityMap(parsed.probabilities, expectedIds);
    return { type: "choice", choice: parsed.choice, probabilities };
  }
  if (typeof parsed.score !== "number" || !Number.isFinite(parsed.score))
    throw codedError("decision_protocol_invalid", "The OpenAI-compatible score response must provide a finite score.");
  const expectedIds = question.criteria.map((entry, index) =>
    typeof entry === "string" ? `level_${String(index)}` : entry.id,
  );
  const expectedLabels = question.criteria.map((entry) => (typeof entry === "string" ? entry : entry.label));
  const probabilities = parseScoreProbabilityMap(parsed.probabilities, expectedIds, expectedLabels);
  return { type: "score", score: parsed.score, probabilities };
}

function parseProbabilityMap(value: unknown, expectedKeys: readonly string[]): Record<string, number> {
  if (!isJsonObject(value))
    throw codedError("decision_protocol_invalid", "The OpenAI-compatible response did not include probabilities.");
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(value, key)))
    throw codedError(
      "decision_protocol_invalid",
      "The OpenAI-compatible response did not include a complete option distribution.",
    );
  const result: Record<string, number> = {};
  for (const key of expectedKeys) {
    const probability = value[key];
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1)
      throw codedError("decision_protocol_invalid", "The OpenAI-compatible response contains an invalid probability.");
    result[key] = probability;
  }
  return result;
}

function parseScoreProbabilityMap(
  value: unknown,
  expectedIds: readonly string[],
  expectedLabels: readonly string[],
): Record<string, number> {
  if (!isJsonObject(value))
    throw codedError(
      "decision_protocol_invalid",
      "The OpenAI-compatible response did not include score probabilities.",
    );
  const matchesIds =
    Object.keys(value).length === expectedIds.length && expectedIds.every((id) => Object.hasOwn(value, id));
  const matchesLabels =
    !matchesIds &&
    new Set(expectedLabels).size === expectedLabels.length &&
    Object.keys(value).length === expectedLabels.length &&
    expectedLabels.every((label) => Object.hasOwn(value, label));
  if (!matchesIds && !matchesLabels)
    throw codedError(
      "decision_protocol_invalid",
      "The OpenAI-compatible response did not include a complete score distribution.",
    );
  const targetKeys = matchesIds ? expectedIds : expectedLabels;
  return parseProbabilityMap(value, targetKeys);
}

function parseUsage(value: unknown): DecisionsResponse["usage"] {
  if (!isJsonObject(value)) return { inputTokens: 0, outputTokens: 0 };
  const inputTokens = nonNegativeInt(value.prompt_tokens) ?? nonNegativeInt(value.input_tokens) ?? 0;
  const outputTokens = nonNegativeInt(value.completion_tokens) ?? nonNegativeInt(value.output_tokens) ?? 0;
  const cost = typeof value.cost === "number" && Number.isFinite(value.cost) ? value.cost : undefined;
  return { inputTokens, outputTokens, ...(cost === undefined ? {} : { cost }) };
}

function extractMessageText(content: unknown): string | null {
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

function stripSingleJsonFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(text.trim());
  return match ? match[1]!.trim() : text.trim();
}

function parseJsonObject(text: string, errorMessage: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw codedError("decision_protocol_invalid", errorMessage);
  }
  if (!isJsonObject(parsed)) throw codedError("decision_protocol_invalid", errorMessage);
  return parsed;
}

function classifyTransportError(error: unknown, timedOut: boolean): Error {
  const cause = isJsonObject(error) && isJsonObject(error.cause) ? error.cause : null,
    causeCode = cause && typeof cause.code === "string" ? cause.code : null,
    errorName = isJsonObject(error) && typeof error.name === "string" ? error.name : "",
    rawMessage = error instanceof Error ? error.message : String(error),
    detail = causeCode && !rawMessage.includes(causeCode) ? `${rawMessage} (${causeCode})` : rawMessage;
  if (
    timedOut ||
    errorName === "TimeoutError" ||
    errorName === "AbortError" ||
    causeCode === "ETIMEDOUT" ||
    causeCode === "UND_ERR_CONNECT_TIMEOUT" ||
    causeCode === "UND_ERR_HEADERS_TIMEOUT" ||
    causeCode === "UND_ERR_BODY_TIMEOUT"
  ) {
    return new OpenAiDecisionError(timedOut ? "Request timed out." : detail, {
      name: "TimeoutError",
      code: "decision_timeout",
    });
  }
  return new OpenAiDecisionError(detail, {
    name: "ConnectionError",
    code: "decision_transport",
  });
}

function httpResponseError(status: number, statusText: string, rawBody: string): Error {
  const parsedResult = tryParseJsonObject(rawBody),
    parsed = parsedResult.ok ? parsedResult.value : null;
  const nestedError = parsed && isJsonObject(parsed.error) ? parsed.error : null,
    providerMessage =
      (nestedError && typeof nestedError.message === "string" && nestedError.message.trim()) ||
      (parsed && typeof parsed.message === "string" && parsed.message.trim()) ||
      rawBody.trim().slice(0, maxErrorBodyExcerpt) ||
      statusText ||
      `HTTP ${String(status)}`,
    providerCode =
      nestedError && (typeof nestedError.code === "string" || typeof nestedError.code === "number")
        ? nestedError.code
        : parsed && (typeof parsed.code === "string" || typeof parsed.code === "number")
          ? parsed.code
          : undefined;
  return new OpenAiDecisionError(providerMessage, {
    name: httpErrorName(status),
    statusCode: status,
    ...(providerCode === undefined ? {} : { code: providerCode }),
    ...(nestedError === null ? {} : { error: nestedError }),
  });
}

function tryParseJsonObject(
  rawBody: string,
): { readonly ok: true; readonly value: JsonObject } | { readonly ok: false } {
  try {
    const candidate = JSON.parse(rawBody) as unknown;
    return isJsonObject(candidate) ? { ok: true, value: candidate } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function httpErrorName(status: number): string {
  if (status === 401) return "UnauthorizedResponseError";
  if (status === 403) return "ForbiddenResponseError";
  if (status === 404) return "NotFoundResponseError";
  if (status === 408 || status === 524) return "RequestTimeoutResponseError";
  if (status === 429) return "TooManyRequestsResponseError";
  if (status === 503) return "ServiceUnavailableResponseError";
  return "HttpResponseError";
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class OpenAiDecisionError extends Error {
  readonly code?: string | number;
  readonly statusCode?: number;
  readonly error?: JsonObject;

  constructor(
    message: string,
    details: {
      readonly name?: string;
      readonly code?: string | number;
      readonly statusCode?: number;
      readonly error?: JsonObject;
    },
  ) {
    super(message);
    if (details.name !== undefined) this.name = details.name;
    if (details.code !== undefined) this.code = details.code;
    if (details.statusCode !== undefined) this.statusCode = details.statusCode;
    if (details.error !== undefined) this.error = details.error;
  }
}

function codedError(code: string, message: string): OpenAiDecisionError {
  return new OpenAiDecisionError(message, { code });
}

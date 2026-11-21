import {
  DecisionAdapterError,
  type DecisionProviderQuestion,
  type NormalizedDecisionAnswer,
  type NormalizedDecisionEnvelope,
} from "./types.ts";

type JsonObject = Readonly<Record<string, unknown>>;

/** Allowed floating-point / rounding tolerance for probability distributions summing to 1. */
export const probabilitySumTolerance = 1e-2;

const normalNativeStopReasons = new Set(["stop", "STOP", "end_turn", "END_TURN", "complete", "COMPLETE"]);

export function normalizeNoulValue(value: unknown, contextLabel = "The Decisions"): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    throw new DecisionAdapterError(
      "decision_protocol_invalid",
      `${contextLabel} Noul response is outside the [0, 1] range.`,
    );
  return value;
}

/**
 * Validates and builds a prototype-free (`Object.create(null)`), frozen choice probability map.
 * Uses `Object.hasOwn` exclusively so keys like `"constructor"` or `"__proto__"` are safely
 * validated and preserved without prototype pollution or lookup collision.
 */
export function normalizeChoiceDistribution(
  value: unknown,
  expectedIds: readonly string[],
  contextLabel = "The Decisions",
): Readonly<Record<string, number>> {
  if (!isJsonObject(value))
    throw new DecisionAdapterError(
      "decision_protocol_invalid",
      `${contextLabel} response did not include a complete option distribution.`,
    );
  const ownKeys = Object.keys(value);
  if (ownKeys.length !== expectedIds.length || expectedIds.some((id) => !Object.hasOwn(value, id)))
    throw new DecisionAdapterError(
      "decision_protocol_invalid",
      `${contextLabel} response did not include a complete option distribution.`,
    );
  return buildValidatedNullProtoDistribution(value, expectedIds, contextLabel);
}

/**
 * Validates and builds a prototype-free (`Object.create(null)`), frozen score probability map.
 * When `expectedIds` / `expectedLabels` are supplied, keys must match either all ids or all unique labels.
 */
export function normalizeScoreDistribution(
  value: unknown,
  expectedCount: number,
  options?: {
    readonly expectedIds?: readonly string[];
    readonly expectedLabels?: readonly string[];
    readonly contextLabel?: string;
  },
): Readonly<Record<string, number>> {
  const contextLabel = options?.contextLabel ?? "The Decisions";
  if (!isJsonObject(value))
    throw new DecisionAdapterError(
      "decision_protocol_invalid",
      `${contextLabel} response did not include a complete score distribution.`,
    );
  const ownKeys = Object.keys(value);
  if (ownKeys.length !== expectedCount)
    throw new DecisionAdapterError(
      "decision_protocol_invalid",
      `${contextLabel} response did not include a complete score distribution.`,
    );
  if (options?.expectedIds !== undefined) {
    const expectedIds = options.expectedIds;
    const expectedLabels = options.expectedLabels ?? [];
    const matchesIds = ownKeys.length === expectedIds.length && expectedIds.every((id) => Object.hasOwn(value, id));
    const matchesLabels =
      !matchesIds &&
      expectedLabels.length === expectedCount &&
      new Set(expectedLabels).size === expectedLabels.length &&
      expectedLabels.every((label) => Object.hasOwn(value, label));
    if (!matchesIds && !matchesLabels)
      throw new DecisionAdapterError(
        "decision_protocol_invalid",
        `${contextLabel} response did not include a complete score distribution.`,
      );
    return buildValidatedNullProtoDistribution(value, matchesIds ? expectedIds : expectedLabels, contextLabel);
  }
  return buildValidatedNullProtoDistribution(value, ownKeys, contextLabel);
}

function buildValidatedNullProtoDistribution(
  source: JsonObject,
  keys: readonly string[],
  contextLabel: string,
): Readonly<Record<string, number>> {
  const result = Object.setPrototypeOf({}, null) as Record<string, number>;
  let sum = 0;
  for (const key of keys) {
    const probability = source[key];
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1)
      throw new DecisionAdapterError(
        "decision_protocol_invalid",
        `${contextLabel} response contains an invalid probability.`,
      );
    sum += probability;
    Object.defineProperty(result, key, {
      value: probability,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  if (!Number.isFinite(sum) || Math.abs(sum - 1) > probabilitySumTolerance)
    throw new DecisionAdapterError(
      "decision_protocol_invalid",
      `${contextLabel} response probabilities must sum to 1 within tolerance.`,
    );
  return Object.freeze(result);
}

export function buildStructuredDecisionSystemPrompt(question: DecisionProviderQuestion): string {
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

export function decodeStructuredDecisionJson(
  rawText: string,
  question: DecisionProviderQuestion,
  vendorLabel: string,
): NormalizedDecisionAnswer {
  const parsed = parseJsonObject(stripSingleJsonFence(rawText), `${vendorLabel} response content was not valid JSON.`);
  return decodeAnswerObject(parsed, question, vendorLabel);
}

/** Shared decoder for native Decisions HTTP protocols (Google Gemini Decisions, Perplexity Decider, decisions-http). */
export function decodeNativeDecisionsEnvelope(
  rawBody: string,
  requestedModel: string,
  question: DecisionProviderQuestion,
  vendorLabel: string,
): NormalizedDecisionEnvelope {
  const envelope = parseJsonObject(rawBody, `${vendorLabel} returned malformed JSON.`);
  const stopReason = envelope.finish_reason ?? envelope.finishReason ?? envelope.stop_reason ?? envelope.stopReason;
  if (stopReason !== undefined && stopReason !== null) {
    const isNormalStop = typeof stopReason === "string" && normalNativeStopReasons.has(stopReason);
    if (!isNormalStop)
      throw new DecisionAdapterError(
        "decision_protocol_invalid",
        `${vendorLabel} returned a truncated or filtered completion.`,
      );
  }
  const answers = envelope.answers;
  if (!isJsonObject(answers) || !isJsonObject(answers.decision))
    throw new DecisionAdapterError(
      "decision_protocol_invalid",
      `${vendorLabel} response did not include answers.decision.`,
    );
  const answer = decodeAnswerObject(answers.decision, question, vendorLabel);
  const resolvedModel =
    typeof envelope.model === "string" && envelope.model.trim() !== "" ? envelope.model.trim() : requestedModel;
  const providerRoute =
    typeof envelope.provider === "string" && envelope.provider.trim() !== "" ? envelope.provider.trim() : undefined;
  const usage = parseDecisionUsage(envelope.usage, envelope.usageMetadata);
  return {
    model: resolvedModel,
    ...(providerRoute === undefined ? {} : { provider: providerRoute }),
    usage,
    answers: { decision: answer },
  };
}

export function decodeAnswerObject(
  parsed: JsonObject,
  question: DecisionProviderQuestion,
  vendorLabel: string,
): NormalizedDecisionAnswer {
  if (parsed.type !== undefined && parsed.type !== question.type)
    throw new DecisionAdapterError(
      "decision_protocol_invalid",
      `${vendorLabel} decision JSON type did not match the requested question type.`,
    );
  if (question.type === "noul") {
    const noul = normalizeNoulValue(parsed.noul, vendorLabel);
    return { type: "noul", noul };
  }
  if (question.type === "choice") {
    const expectedIds = Object.keys(question.criteria);
    if (typeof parsed.choice !== "string" || !expectedIds.includes(parsed.choice))
      throw new DecisionAdapterError(
        "decision_protocol_invalid",
        `${vendorLabel} response selected an unknown option.`,
      );
    const probabilities = normalizeChoiceDistribution(parsed.probabilities, expectedIds, vendorLabel);
    return { type: "choice", choice: parsed.choice, probabilities };
  }
  if (typeof parsed.score !== "number" || !Number.isFinite(parsed.score))
    throw new DecisionAdapterError(
      "decision_protocol_invalid",
      `${vendorLabel} score response must provide a finite score.`,
    );
  const expectedIds = question.criteria.map((entry, index) =>
    typeof entry === "string" ? `level_${String(index)}` : entry.id,
  );
  const expectedLabels = question.criteria.map((entry) => (typeof entry === "string" ? entry : entry.label));
  const probabilities = normalizeScoreDistribution(parsed.probabilities, expectedIds.length, {
    expectedIds,
    expectedLabels,
    contextLabel: vendorLabel,
  });
  return { type: "score", score: parsed.score, probabilities };
}

export function parseDecisionUsage(
  usageValue: unknown,
  usageMetadataValue?: unknown,
): NormalizedDecisionEnvelope["usage"] {
  const usage = isJsonObject(usageValue) ? usageValue : null;
  const meta = isJsonObject(usageMetadataValue) ? usageMetadataValue : null;
  const inputTokens =
    nonNegativeInt(usage?.total_input_tokens) ??
    nonNegativeInt(usage?.input_tokens) ??
    nonNegativeInt(usage?.inputTokens) ??
    nonNegativeInt(usage?.prompt_tokens) ??
    nonNegativeInt(usage?.promptTokenCount) ??
    nonNegativeInt(meta?.promptTokenCount) ??
    nonNegativeInt(meta?.total_input_tokens) ??
    nonNegativeInt(meta?.totalInputTokens) ??
    0;
  const outputTokens =
    nonNegativeInt(usage?.total_output_tokens) ??
    nonNegativeInt(usage?.output_tokens) ??
    nonNegativeInt(usage?.outputTokens) ??
    nonNegativeInt(usage?.completion_tokens) ??
    nonNegativeInt(usage?.candidatesTokenCount) ??
    nonNegativeInt(meta?.candidatesTokenCount) ??
    nonNegativeInt(meta?.total_output_tokens) ??
    nonNegativeInt(meta?.totalOutputTokens) ??
    0;
  const cost =
    typeof usage?.cost === "number" && Number.isFinite(usage.cost)
      ? usage.cost
      : typeof meta?.cost === "number" && Number.isFinite(meta.cost)
        ? meta.cost
        : undefined;
  return { inputTokens, outputTokens, ...(cost === undefined ? {} : { cost }) };
}

export function parseJsonObject(text: string, errorMessage: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DecisionAdapterError("decision_protocol_invalid", errorMessage);
  }
  if (!isJsonObject(parsed)) throw new DecisionAdapterError("decision_protocol_invalid", errorMessage);
  return parsed;
}

function stripSingleJsonFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(text.trim());
  return match ? match[1]!.trim() : text.trim();
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

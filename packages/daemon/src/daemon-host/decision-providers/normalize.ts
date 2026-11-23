import {
  DecisionAdapterError,
  type DecisionProviderQuestion,
  type NormalizedDecisionAnswer,
  type NormalizedDecisionEnvelope,
} from "./types.ts";

type JsonObject = Readonly<Record<string, unknown>>;

/** Allowed floating-point / rounding tolerance for probability distributions summing to 1. */
export const probabilitySumTolerance = 1e-2;
/** Hard upper bound on structured text payload scanned by the weak-model JSON sanitizer. */
export const MAX_STRUCTURED_DECISION_CHARS = 64 * 1024;

const normalNativeStopReasons = new Set(["stop", "STOP", "end_turn", "END_TURN", "complete", "COMPLETE"]);
const reasoningTagPattern = /<\/?(think|thinking|reasoning)\b[^>]*>/giu;
const fenceOpeningPattern = /^```(?:json)?[ \t]*(?:\r?\n|(?=\{))/iu;

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
      ...(question.abstainOptionId !== undefined && Object.hasOwn(question.criteria, question.abstainOptionId)
        ? [`If evidence is insufficient or ambiguous, select "${question.abstainOptionId}".`]
        : []),
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

/**
 * Builds an honest abstain answer when a choice question explicitly declares `abstainOptionId`.
 * Never invents or guesses an option when `abstainOptionId` is absent or not in `criteria`.
 */
export function buildAbstainChoiceAnswer(question: DecisionProviderQuestion): NormalizedDecisionAnswer | null {
  if (question.type !== "choice") return null;
  const abstainId = question.abstainOptionId;
  if (typeof abstainId !== "string" || !Object.hasOwn(question.criteria, abstainId)) return null;
  const result = Object.setPrototypeOf({}, null) as Record<string, number>;
  for (const key of Object.keys(question.criteria)) {
    Object.defineProperty(result, key, {
      value: key === abstainId ? 1 : 0,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return {
    type: "choice",
    choice: abstainId,
    probabilities: Object.freeze(result),
  };
}

/**
 * Deterministic single-pass syntax extractor for quantized / small-parameter model outputs.
 * Strips paired reasoning tags (`<think>...</think>`), outer Markdown fences, surrounding prose,
 * and JSON trailing commas while bounding input length and refusing truncated or ambiguous JSON.
 */
export function sanitizeStructuredDecisionText(rawText: string, vendorLabel = "The Decisions"): string {
  if (rawText.length > MAX_STRUCTURED_DECISION_CHARS) {
    throw new DecisionAdapterError(
      "decision_protocol_invalid",
      `${vendorLabel} response content exceeded the ${String(MAX_STRUCTURED_DECISION_CHARS)}-character safety limit.`,
    );
  }
  const withoutThinking = stripReasoningBlocks(rawText, vendorLabel).trim();
  const unfenced = extractDeterministicFence(withoutThinking, vendorLabel);
  const objectSpan = extractSingleJsonObjectSpan(unfenced, vendorLabel);
  return stripJsonTrailingCommas(objectSpan);
}

export function decodeStructuredDecisionJson(
  rawText: string,
  question: DecisionProviderQuestion,
  vendorLabel: string,
): NormalizedDecisionAnswer {
  try {
    const sanitized = sanitizeStructuredDecisionText(rawText, vendorLabel);
    const parsed = parseJsonObject(sanitized, `${vendorLabel} response content was not valid JSON.`);
    return decodeAnswerObject(parsed, question, vendorLabel);
  } catch (error) {
    if (error instanceof DecisionAdapterError && error.code === "decision_protocol_invalid") {
      const abstained = buildAbstainChoiceAnswer(question);
      if (abstained !== null) return abstained;
    }
    throw error;
  }
}

/** Shared decoder for native Decisions HTTP protocols (OpenRouter, Google Gemini Decisions, Perplexity Decider, decisions-http). */
export function decodeNativeDecisionsEnvelope(
  rawBody: string,
  requestedModel: string,
  question: DecisionProviderQuestion,
  vendorLabel: string,
): NormalizedDecisionEnvelope {
  const envelope = parseJsonObject(rawBody, `${vendorLabel} returned malformed JSON.`);
  for (const stopReason of [envelope.finish_reason, envelope.finishReason, envelope.stop_reason, envelope.stopReason]) {
    if (stopReason === undefined || stopReason === null) continue;
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

function extractDeterministicFence(text: string, vendorLabel: string): string {
  const delimiters = findFenceDelimitersOutsideJsonStrings(text);
  if (delimiters.length === 0) return text;
  if (delimiters.length !== 2) {
    throw new DecisionAdapterError(
      "decision_protocol_invalid",
      `${vendorLabel} response contained an unclosed or ambiguous code fence.`,
    );
  }
  const [opening, closing] = delimiters;
  const fencedSegment = text.slice(opening, closing);
  const header = fenceOpeningPattern.exec(fencedSegment);
  if (!header) {
    throw new DecisionAdapterError(
      "decision_protocol_invalid",
      `${vendorLabel} response contained an unsupported or ambiguous code fence.`,
    );
  }
  return `${text.slice(0, opening)}${fencedSegment.slice(header[0].length)}${text.slice(closing + 3)}`;
}

function findFenceDelimitersOutsideJsonStrings(text: string): number[] {
  const delimiters: number[] = [];
  let inString = false;
  let escaped = false;
  let objectDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (objectDepth > 0 && inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (objectDepth > 0 && character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      objectDepth += 1;
      continue;
    }
    if (character === "}" && objectDepth > 0) {
      objectDepth -= 1;
      continue;
    }
    if (text.startsWith("```", index)) {
      delimiters.push(index);
      index += 2;
    }
  }
  return delimiters;
}

function stripReasoningBlocks(text: string, vendorLabel: string): string {
  const tags = [...text.matchAll(reasoningTagPattern)];
  if (tags.length === 0) return text;
  const nextClosing: number[] = new Array(tags.length).fill(-1);
  const closingByName = new Map<string, number>();
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    const tag = tags[index]!;
    const name = tag[1]!.toLowerCase();
    if (tag[0]!.startsWith("</")) closingByName.set(name, index);
    else nextClosing[index] = closingByName.get(name) ?? -1;
  }
  let outputCursor = 0;
  let scanCursor = 0;
  let objectDepth = 0;
  let inString = false;
  let escaped = false;
  let output = "";
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index]!;
    const start = tag.index!;
    for (let offset = scanCursor; offset < start; offset += 1) {
      const character = text[offset]!;
      if (objectDepth > 0 && inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
      } else if (objectDepth > 0 && character === '"') inString = true;
      else if (!inString && character === "{") objectDepth += 1;
      else if (!inString && character === "}" && objectDepth > 0) objectDepth -= 1;
    }
    scanCursor = start + tag[0]!.length;
    const isOpening = !tag[0]!.startsWith("</");
    if (!isOpening || objectDepth > 0 || inString) continue;
    const closingIndex = nextClosing[index]!;
    if (closingIndex === -1)
      throw new DecisionAdapterError(
        "decision_protocol_invalid",
        `${vendorLabel} response contained an unclosed reasoning block.`,
      );
    const closing = tags[closingIndex]!;
    output += text.slice(outputCursor, start);
    outputCursor = closing.index! + closing[0]!.length;
    scanCursor = outputCursor;
    index = closingIndex;
  }
  return output + text.slice(outputCursor);
}

/**
 * Single-pass O(N) balanced-brace scan locating the one top-level JSON object inside optional
 * explanatory prose. Rejects truncated objects (unclosed `{`) and ambiguous multiple objects.
 */
function extractSingleJsonObjectSpan(text: string, vendorLabel: string): string {
  let start = -1;
  let end = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (depth > 0 && inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (depth > 0 && ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        if (end !== -1) {
          throw new DecisionAdapterError(
            "decision_protocol_invalid",
            `${vendorLabel} response contained multiple JSON objects and was ambiguous.`,
          );
        }
        start = i;
      }
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) {
        throw new DecisionAdapterError(
          "decision_protocol_invalid",
          `${vendorLabel} response content was not valid JSON.`,
        );
      }
      depth -= 1;
      if (depth === 0) end = i;
    }
  }
  if (inString || depth !== 0 || start === -1 || end === -1) {
    throw new DecisionAdapterError(
      "decision_protocol_invalid",
      `${vendorLabel} response content did not contain a complete JSON object.`,
    );
  }
  return text.slice(start, end + 1);
}

/** Single-pass O(N) removal of JSON trailing commas (`,}` / `,]`) strictly outside string literals. */
function stripJsonTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let next = i + 1;
      while (next < text.length && /\s/u.test(text[next]!)) next += 1;
      if (next < text.length && (text[next] === "}" || text[next] === "]")) {
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

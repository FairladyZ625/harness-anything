import { DecisionAdapterError, type DecisionPostJsonInput, type DecisionPostJsonResult } from "./types.ts";

type JsonObject = Readonly<Record<string, unknown>>;

/** Safe machine-readable error code tokens only; never free-text prose or echoed secrets. */
const safeMachineCodePattern = /^[A-Za-z0-9_.:-]{1,64}$/u;

/** A 404 is a model-configuration fault only when the provider names the model as unavailable. */
export const modelUnavailablePattern =
  /(?:model[^.\n]{0,80}unavailable|model[^.\n]{0,80}does not exist|model not exist|model_not_found|models\/[^\s]{1,120}\s+is not found|unavailable for free|use this slug instead|model not found|no such model|unknown model)/iu;

const authHeaderLeakPattern =
  /(?:authorization\s*[:=]\s*bearer|bearer|x-api-key\s*[:=]|x-goog-api-key\s*[:=])\s*[^\s,;'"`]+/giu;

const decisionFailureDetailMaxLength = 400;

/**
 * Wraps global `fetch` to prohibit HTTP redirects on every outbound Decisions request.
 * Prevents POST payload exfiltration or HTTPS/loopback boundary bypass via 3xx responses.
 */
export function noRedirectFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (input instanceof Request) {
    return fetch(new Request(input, { ...init, redirect: "error" }));
  }
  return fetch(input, { ...init, redirect: "error" });
}

export async function postDecisionJson(input: DecisionPostJsonInput): Promise<DecisionPostJsonResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  let response: Response, rawBody: string;
  try {
    response = await noRedirectFetch(input.url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...input.headers,
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });
    rawBody = await response.text();
  } catch (error) {
    throw classifyFetchTransportError(error, timedOut);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw buildControlledHttpError(response.status, rawBody);
  return { status: response.status, rawBody };
}

export function isRedirectFetchError(error: unknown): boolean {
  const messages = collectErrorMessages(error);
  return messages.some((message) => /redirect/iu.test(message));
}

function classifyFetchTransportError(error: unknown, timedOut: boolean): DecisionAdapterError {
  if (isRedirectFetchError(error)) {
    return new DecisionAdapterError("decision_transport", "Endpoint attempted an HTTP redirect, which is prohibited.", {
      name: "RedirectRejectedError",
      transient: false,
      localControlledMessage: true,
    });
  }
  const cause = isJsonObject(error) && isJsonObject(error.cause) ? error.cause : null;
  const causeCode =
    cause && typeof cause.code === "string" && safeMachineCodePattern.test(cause.code) ? cause.code : null;
  const errorName = isJsonObject(error) && typeof error.name === "string" ? error.name : "";
  if (
    timedOut ||
    errorName === "TimeoutError" ||
    errorName === "AbortError" ||
    causeCode === "ETIMEDOUT" ||
    causeCode === "UND_ERR_CONNECT_TIMEOUT" ||
    causeCode === "UND_ERR_HEADERS_TIMEOUT" ||
    causeCode === "UND_ERR_BODY_TIMEOUT"
  ) {
    return new DecisionAdapterError("decision_timeout", "Request timed out.", {
      name: "TimeoutError",
      ...(causeCode === null ? {} : { providerCode: causeCode }),
      transient: true,
      localControlledMessage: true,
    });
  }
  const detail = causeCode === null ? "Network connection failed." : `Network connection failed (${causeCode}).`;
  return new DecisionAdapterError("decision_transport", detail, {
    name: "ConnectionError",
    ...(causeCode === null ? {} : { providerCode: causeCode }),
    transient: true,
    localControlledMessage: true,
  });
}

/**
 * Maps an upstream non-2xx HTTP response to a strictly local, controlled diagnostic error.
 * Upstream raw bodies and free-text error messages are inspected ONLY internally for safe
 * classification signals (safe machine error code + model-unavailable detection) and are
 * NEVER forwarded into receipts, logs, or incident reasons.
 */
function buildControlledHttpError(status: number, rawBody: string): DecisionAdapterError {
  const parsedResult = tryParseJsonObject(rawBody);
  const parsed = parsedResult.ok ? parsedResult.value : null;
  const nestedError = parsed && isJsonObject(parsed.error) ? parsed.error : null;
  const providerCode = extractSafeMachineCode(nestedError, parsed, status);
  const modelUnavailable = status === 404 && detectModelUnavailable(providerCode, nestedError, parsed);
  const code =
    status === 401 || status === 403
      ? "provider_credential_unavailable"
      : modelUnavailable
        ? "decision_model_unavailable"
        : status === 429
          ? "decision_rate_limited"
          : status === 408 || status === 524
            ? "decision_timeout"
            : "decision_transport";
  const transient = status === 429 || status === 408 || status === 524 || status >= 500;
  return new DecisionAdapterError(code, controlledHttpReason(status, modelUnavailable), {
    name: httpErrorName(status),
    statusCode: status,
    ...(providerCode === undefined ? {} : { providerCode }),
    transient,
    modelUnavailable,
    localControlledMessage: true,
  });
}

function controlledHttpReason(status: number, modelUnavailable: boolean): string {
  if (status === 401 || status === 403) return "Authentication failed.";
  if (modelUnavailable) return "Configured model is unavailable on the endpoint.";
  if (status === 404) return "Endpoint or resource not found.";
  if (status === 408 || status === 524) return "Upstream request timed out.";
  if (status === 429) return "Rate limit exceeded.";
  if (status >= 500) return "Upstream service returned a server error.";
  return "Upstream rejected the request.";
}

function extractSafeMachineCode(
  nestedError: JsonObject | null,
  parsed: JsonObject | null,
  httpStatus: number,
): string | number | undefined {
  const candidates = [nestedError?.code, nestedError?.type, nestedError?.status, parsed?.code, parsed?.type];
  let numericFallback: number | undefined;
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (safeMachineCodePattern.test(trimmed)) return trimmed;
    } else if (
      numericFallback === undefined &&
      typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate !== httpStatus
    ) {
      numericFallback = candidate;
    }
  }
  return numericFallback;
}

function detectModelUnavailable(
  providerCode: string | number | undefined,
  nestedError: JsonObject | null,
  parsed: JsonObject | null,
): boolean {
  if (providerCode === "model_not_found") return true;
  const messages = [
    typeof nestedError?.message === "string" ? nestedError.message : null,
    typeof parsed?.message === "string" ? parsed.message : null,
  ];
  return messages.some((message) => message !== null && modelUnavailablePattern.test(message));
}

function httpErrorName(status: number): string {
  if (status === 401) return "UnauthorizedResponseError";
  if (status === 402) return "PaymentRequiredResponseError";
  if (status === 403) return "ForbiddenResponseError";
  if (status === 404) return "NotFoundResponseError";
  if (status === 408 || status === 524) return "RequestTimeoutResponseError";
  if (status === 429) return "TooManyRequestsResponseError";
  if (status === 503) return "ServiceUnavailableResponseError";
  return "HttpResponseError";
}

/**
 * Redacts credentials of ANY non-empty length (plus leaked auth header patterns) BEFORE truncating.
 * Short secrets (<4 chars) use token boundaries so local English words are never corrupted.
 */
export function redactDecisionSecret(
  text: string,
  apiKey?: string,
  maxLength = decisionFailureDetailMaxLength,
): string {
  let redacted = text.replace(authHeaderLeakPattern, "[redacted]");
  const secret = apiKey?.trim();
  if (secret && secret.length > 0) {
    if (secret.length >= 4) {
      redacted = redacted.split(secret).join("[redacted]");
    } else {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const bounded = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "gu");
      redacted = redacted.replace(bounded, "[redacted]");
    }
  }
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}

function collectErrorMessages(error: unknown): string[] {
  const result: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      result.push(current.message);
      current = current.cause;
    } else if (isJsonObject(current)) {
      if (typeof current.message === "string") result.push(current.message);
      current = current.cause;
    } else {
      break;
    }
  }
  return result;
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

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

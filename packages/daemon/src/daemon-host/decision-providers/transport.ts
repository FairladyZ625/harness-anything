import {
  DecisionAdapterError,
  type DecisionDiagnosticCode,
  type DecisionPostJsonInput,
  type DecisionPostJsonResult,
} from "./types.ts";

type JsonObject = Readonly<Record<string, unknown>>;

/** A 404 is a model-configuration fault only when the provider names the model as unavailable. */
export const modelUnavailablePattern =
  /(?:model[^.\n]{0,80}unavailable|model[^.\n]{0,80}does not exist|model not exist|model_not_found|models\/[^\s]{1,120}\s+is not found|unavailable for free|use this slug instead|model not found|no such model|unknown model)/iu;

const authHeaderLeakPattern =
  /(?:authorization\s*[:=]\s*bearer|bearer|x-api-key\s*[:=]|x-goog-api-key\s*[:=])\s*[^\s,;'"`]+/giu;

const decisionFailureDetailMaxLength = 400;
/** Hard upper bound on a single upstream Decisions HTTP response body to prevent memory exhaustion. */
export const MAX_DECISION_RESPONSE_BYTES = 256 * 1024;

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
  if (input.timeoutMs <= 0) {
    throw new DecisionAdapterError("decision_timeout", "Request timed out.", {
      name: "TimeoutError",
      diagnosticCode: "timeout",
      transient: true,
    });
  }
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(input.signal?.reason);
  if (input.signal) {
    if (input.signal.aborted) {
      controller.abort(input.signal.reason);
    } else {
      input.signal.addEventListener("abort", onParentAbort, { once: true });
    }
  }
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
    rawBody = await readBoundedResponseText(response, MAX_DECISION_RESPONSE_BYTES, controller);
  } catch (error) {
    if (error instanceof DecisionAdapterError) throw error;
    throw classifyFetchTransportError(error, timedOut);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onParentAbort);
  }
  if (!response.ok) throw buildControlledHttpError(response.status, rawBody);
  return { status: response.status, rawBody };
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<string> {
  const declaredLength = response.headers?.get("content-length");
  if (declaredLength !== null && declaredLength !== undefined) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      controller.abort();
      throw new DecisionAdapterError(
        "decision_protocol_invalid",
        `Upstream response exceeded the ${String(maxBytes)}-byte safety limit.`,
      );
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new DecisionAdapterError(
        "decision_protocol_invalid",
        `Upstream response exceeded the ${String(maxBytes)}-byte safety limit.`,
      );
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        controller.abort();
        throw new DecisionAdapterError(
          "decision_protocol_invalid",
          `Upstream response exceeded the ${String(maxBytes)}-byte safety limit.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

export function isRedirectFetchError(error: unknown): boolean {
  const messages = collectErrorMessages(error);
  return messages.some((message) => /redirect/iu.test(message));
}

function classifyFetchTransportError(error: unknown, timedOut: boolean): DecisionAdapterError {
  if (isRedirectFetchError(error)) {
    return new DecisionAdapterError("decision_transport", "Endpoint attempted an HTTP redirect, which is prohibited.", {
      name: "RedirectRejectedError",
      diagnosticCode: "redirect_blocked",
      transient: false,
    });
  }
  const cause = isJsonObject(error) && isJsonObject(error.cause) ? error.cause : null;
  const causeCode = cause && typeof cause.code === "string" ? cause.code : null;
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
      diagnosticCode: "timeout",
      transient: true,
    });
  }
  return new DecisionAdapterError("decision_transport", "Network connection failed.", {
    name: "ConnectionError",
    diagnosticCode: "connection_error",
    transient: true,
  });
}

/**
 * Maps an upstream non-2xx HTTP response to a strictly local, controlled diagnostic error.
 * Upstream raw bodies, free-text error messages, and upstream code/type/status strings are
 * inspected ONLY internally for model-unavailable classification and are NEVER forwarded into
 * receipts, logs, or incident reasons.
 */
function buildControlledHttpError(status: number, rawBody: string): DecisionAdapterError {
  const parsedResult = tryParseJsonObject(rawBody);
  const parsed = parsedResult.ok ? parsedResult.value : null;
  const nestedError = parsed && isJsonObject(parsed.error) ? parsed.error : null;
  const modelUnavailable = status === 404 && detectModelUnavailable(nestedError, parsed);
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
    diagnosticCode: httpDiagnosticCode(status, modelUnavailable),
    transient,
    modelUnavailable,
  });
}

export function httpDiagnosticCode(status: number, modelUnavailable: boolean): DecisionDiagnosticCode {
  if (status === 401) return "http_401";
  if (status === 402) return "http_402";
  if (status === 403) return "http_403";
  if (modelUnavailable) return "model_unavailable";
  if (status === 404) return "http_404";
  if (status === 408 || status === 524) return "timeout";
  if (status === 429) return "http_429";
  if (status >= 500 && status <= 599) return "http_5xx";
  if (status >= 400 && status <= 499) return "http_4xx";
  return "http_error";
}

export function controlledHttpReason(status: number, modelUnavailable: boolean): string {
  if (status === 401 || status === 403) return "Authentication failed.";
  if (modelUnavailable) return "Configured model is unavailable on the endpoint.";
  if (status === 404) return "Endpoint or resource not found.";
  if (status === 408 || status === 524) return "Upstream request timed out.";
  if (status === 429) return "Rate limit exceeded.";
  if (status >= 500) return "Upstream service returned a server error.";
  return "Upstream rejected the request.";
}

function detectModelUnavailable(nestedError: JsonObject | null, parsed: JsonObject | null): boolean {
  if (nestedError?.code === "model_not_found" || parsed?.code === "model_not_found") return true;
  const messages = [
    typeof nestedError?.message === "string" ? nestedError.message : null,
    typeof parsed?.message === "string" ? parsed.message : null,
  ];
  return messages.some((message) => message !== null && modelUnavailablePattern.test(message));
}

export function httpErrorName(status: number): string {
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

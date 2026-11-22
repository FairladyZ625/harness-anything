import { DecisionAdapterError, type DecisionProviderAdapter } from "./types.ts";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type ValidatedBaseUrl = {
  readonly stored: string | null;
  readonly parsed: URL | null;
};

/**
 * Single cross-cutting validator for DecisionProvider baseUrl values.
 * Enforces HTTPS or loopback HTTP, forbids embedded credentials and query/fragment delimiters
 * (including bare `?` or `#` that WHATWG URL normalizes into empty `.search`/`.hash`).
 */
export function parseSecureDecisionBaseUrl(value: unknown): URL | null {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value !== "string")
    throw new DecisionAdapterError("invalid_base_url", "baseUrl must be an absolute HTTPS URL or loopback HTTP URL.");
  const text = value.trim();
  if (text.includes("?") || text.includes("#"))
    throw new DecisionAdapterError(
      "invalid_base_url",
      "baseUrl cannot contain credentials, query parameters, or a fragment.",
    );
  if (!URL.canParse(text))
    throw new DecisionAdapterError("invalid_base_url", "baseUrl must be an absolute HTTPS URL or loopback HTTP URL.");
  const url = new URL(text);
  const isHttps = url.protocol === "https:";
  const isLoopbackHttp = url.protocol === "http:" && loopbackHosts.has(url.hostname.toLowerCase());
  if (!isHttps && !isLoopbackHttp)
    throw new DecisionAdapterError("invalid_base_url", "baseUrl must use HTTPS or loopback HTTP.");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    throw new DecisionAdapterError(
      "invalid_base_url",
      "baseUrl cannot contain credentials, query parameters, or a fragment.",
    );
  return new URL(canonicalBaseUrlString(url));
}

export function canonicalBaseUrlString(url: URL): string {
  const trimmedPath = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${trimmedPath}`;
}

export function parseDecisionProviderBaseUrl(
  adapter: Pick<DecisionProviderAdapter, "vendor" | "requiresBaseUrl" | "defaultBaseUrl">,
  rawBaseUrl: unknown,
): ValidatedBaseUrl {
  const parsed = parseSecureDecisionBaseUrl(rawBaseUrl);
  if (parsed === null && adapter.requiresBaseUrl)
    throw new DecisionAdapterError(
      "invalid_base_url",
      `${adapter.vendor} providers require an absolute HTTPS URL or loopback HTTP baseUrl.`,
    );
  return {
    stored: parsed === null ? null : canonicalBaseUrlString(parsed),
    parsed,
  };
}

export function resolveAdapterBaseUrl(
  adapter: Pick<DecisionProviderAdapter, "vendor" | "requiresBaseUrl" | "defaultBaseUrl">,
  parsedBaseUrl: URL | null,
): URL {
  if (parsedBaseUrl !== null) return parsedBaseUrl;
  if (adapter.defaultBaseUrl !== null) {
    const fallback = parseSecureDecisionBaseUrl(adapter.defaultBaseUrl);
    if (fallback !== null) return fallback;
  }
  throw new DecisionAdapterError(
    "invalid_base_url",
    `${adapter.vendor} providers require an absolute HTTPS URL or loopback HTTP baseUrl.`,
  );
}

/** Joins an API endpoint segment onto an already-validated URL's pathname without string concatenation hazards. */
export function joinEndpointUrl(baseUrl: URL, segmentPath: string): URL {
  const endpoint = new URL(baseUrl.toString());
  const basePath = endpoint.pathname.replace(/\/+$/u, "");
  const cleanSegment = segmentPath.replace(/^\/+/u, "");
  endpoint.pathname = cleanSegment === "" ? basePath || "/" : `${basePath}/${cleanSegment}`;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

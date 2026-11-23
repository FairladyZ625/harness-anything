import { consumeKnownError } from "@harness-anything/kernel";
import { identityArtifactDownloadPolicy } from "@harness-anything/kernel/internal/domain/managed-identity-policy.ts";
import { transientTransportFailure } from "./oidc-session-helpers.ts";

export interface ManagedArtifactFetchInput {
  readonly url: string;
  readonly label: string;
  readonly errorCode: "rbac_download_failed" | "rbac_checksum_unavailable";
  readonly requireBody: boolean;
  readonly fetch: typeof fetch;
  readonly now: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function downloadError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function parseRetryAfterMs(header: string | null, nowMs: number, maxDelayMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds)) return Math.min(maxDelayMs, Math.max(0, seconds * 1_000));
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.min(maxDelayMs, Math.max(0, dateMs - nowMs));
  return null;
}

function computeBackoffDelayMs(
  attempt: number,
  retryAfterHeader: string | null,
  nowMs: number,
  random: () => number,
): number {
  const { baseDelayMs, maxDelayMs } = identityArtifactDownloadPolicy.defaultValue;
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader, nowMs, maxDelayMs);
  if (retryAfterMs !== null) return retryAfterMs;
  const exponentCap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  const sample = random();
  const clamped = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  return Math.min(maxDelayMs, Math.round(exponentCap * (0.5 + 0.5 * clamped)));
}

/**
 * Fetches an idempotent managed runtime artifact or checksum over GET with bounded exponential
 * backoff + jitter on transient HTTP (408/429/502/503/504) and transport errors, while failing
 * fast on permanent client errors (400/401/403/404).
 */
export async function fetchManagedArtifactResource(input: ManagedArtifactFetchInput): Promise<Response> {
  const policy = identityArtifactDownloadPolicy.defaultValue;
  const sleep = input.sleep ?? defaultSleep;
  const random = input.random ?? Math.random;

  for (let attempt = 0; attempt <= policy.maxRetries; attempt += 1) {
    let response: Response;
    try {
      response = await input.fetch(input.url);
    } catch (error) {
      if (transientTransportFailure(error) && attempt < policy.maxRetries) {
        const delayMs = computeBackoffDelayMs(attempt, null, Date.parse(input.now()), random);
        await sleep(delayMs);
        continue;
      }
      throw downloadError(
        input.errorCode,
        `${input.label} failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }

    if (response.ok) {
      if (input.requireBody && !response.body) {
        throw downloadError(input.errorCode, `${input.label} returned HTTP ${response.status}.`);
      }
      return response;
    }

    const status = response.status;
    const retryAfter = response.headers?.get("retry-after") ?? null;
    if (response.body) void response.body.cancel().catch(consumeKnownError);

    if (policy.retryableStatuses.includes(status) && attempt < policy.maxRetries) {
      const delayMs = computeBackoffDelayMs(attempt, retryAfter, Date.parse(input.now()), random);
      await sleep(delayMs);
      continue;
    }

    throw downloadError(input.errorCode, `${input.label} returned HTTP ${status}.`);
  }

  throw downloadError(input.errorCode, `${input.label} exhausted retry budget.`);
}

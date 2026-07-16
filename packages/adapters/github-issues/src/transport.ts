import { Effect } from "effect";
import type { GithubHttpResponse, GithubTransport, GithubTransportError } from "./types.ts";

export interface FetchGithubTransportOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const defaultTimeoutMs = 15_000;
const responseHeaderNames = [
  "content-type",
  "link",
  "retry-after",
  "x-ratelimit-remaining",
  "x-ratelimit-reset"
] as const;

export function makeFetchGithubTransport(options: FetchGithubTransportOptions = {}): GithubTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;

  return {
    request: (request) => Effect.tryPromise({
      try: async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(request.url, {
            method: request.method,
            headers: request.headers,
            signal: controller.signal
          });
          const result: GithubHttpResponse = {
            status: response.status,
            headers: selectHeaders(response.headers),
            ...(response.ok ? { body: await decodeJson(response) } : {})
          };
          return result;
        } finally {
          clearTimeout(timer);
        }
      },
      catch: (error): GithubTransportError => transportError(error, timeoutMs)
    })
  };
}

async function decodeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw { _tag: "GithubInvalidJson" } satisfies GithubTransportError;
  }
}

function selectHeaders(headers: Headers): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const name of responseHeaderNames) {
    const value = headers.get(name);
    if (value !== null) selected[name] = value;
  }
  return selected;
}

function transportError(error: unknown, timeoutMs: number): GithubTransportError {
  if (isInvalidJsonError(error)) return error;
  if (isAbortError(error)) return { _tag: "GithubTransportTimeout", ms: timeoutMs };
  return { _tag: "GithubNetworkFailure" };
}

function isInvalidJsonError(error: unknown): error is Extract<GithubTransportError, { readonly _tag: "GithubInvalidJson" }> {
  return isTransportErrorRecord(error) && error._tag === "GithubInvalidJson";
}

function isAbortError(error: unknown): boolean {
  return isTransportErrorRecord(error) && error.name === "AbortError";
}

function isTransportErrorRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

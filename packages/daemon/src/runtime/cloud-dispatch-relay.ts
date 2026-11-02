/**
 * Per-dispatch cloud relay.
 *
 * The worker receives only a loopback URL and an attempt-scoped bearer token.
 * Provider credentials are fetched by `keyFor` immediately before an upstream
 * request and are never returned, persisted, or cached by this module.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { modelPriceOf, modelPricingVersion, type ModelPrice } from "../agent-runtime-model-pricing.ts";
import { RuntimeBoundaryError } from "./model-slot-queue.ts";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const OUTPUT_CAP_TOKENS = 32_768;
/** Instructions, tool schemas and framing added by the runtime around a task prompt. */
export const REQUEST_OVERHEAD_TOKENS = 20_000;
/** Fixed lower bound for a code-run allowance; one run may issue multiple generations. */
export const CLOUD_CODE_RESERVE_MICROS = 2_000_000;
export const DEFAULT_MAX_GENERATIONS = 16;
const UPSTREAM_TIMEOUT_MS = 600_000;
const ROUTE = "/v1/responses";

export interface RelayPrice {
  readonly inputPerMillion: number;
  readonly cacheReadPerMillion: number;
  readonly outputPerMillion: number;
}

export interface TokenCounts {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
}

export interface UpstreamRequest {
  readonly url: URL;
  readonly body: Buffer;
  readonly key: string;
  readonly signal?: AbortSignal;
  readonly onChunk?: (text: string) => void;
}

export interface UpstreamResponse {
  readonly status: number;
  readonly type: string;
  readonly body: Buffer;
  readonly retryAfterSeconds?: number;
}

export type Upstream = (request: UpstreamRequest) => Promise<UpstreamResponse>;

export interface CloudDispatchRelayOptions {
  readonly allowedHosts: readonly string[];
  readonly upstream?: Upstream;
  readonly maxGenerations?: number;
  readonly outputCapTokens?: number;
  readonly maxUpstreamConcurrency?: number;
}

export interface RelayRegistration {
  readonly attemptId: string;
  readonly targetBaseUrl: string;
  readonly model: string;
  readonly keyFor: () => Promise<string>;
  readonly price?: RelayPrice;
  readonly budgetMicros?: number;
  readonly maxGenerations?: number;
}

export interface RelayUsage {
  requests: number;
  generations: number;
  rejected: number;
  readonly failures: string[];
  readonly tokens?: TokenCounts;
  readonly costMicros?: number;
}

export interface RelaySettlement {
  readonly actualMicros: string;
  readonly costStatus: "reported" | "estimated";
}

export class CloudDispatchRelayError extends RuntimeBoundaryError {
  constructor(
    code: "RELAY_REFUSED" | "MODEL_UNPRICED" | "BUDGET_EXCEEDED" | "GENERATION_LIMIT",
    message: string,
    status = 422,
  ) {
    super(code, message, status);
  }
}

class RelayRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "RelayRequestError";
    this.code = code;
    this.status = status;
  }
}

interface Flight {
  readonly hold: number;
  readonly inputEstimate: number;
  sent: boolean;
  outputSeen: number;
}

interface Entry {
  readonly id: string;
  readonly keyFor: () => Promise<string>;
  readonly target: URL;
  readonly model: string;
  readonly token: Buffer;
  readonly maxGenerations: number;
  readonly outputCap: number;
  readonly usage: RelayUsage;
  readonly ledger: AttemptLedger | null;
}

/** USD per million tokens equals micro-USD per token; all results stay integer. */
export function costMicros(price: RelayPrice, counts: TokenCounts): number {
  const cached = Math.max(0, Math.min(counts.cachedInput, counts.input));
  return Math.ceil(
    (counts.input - cached) * price.inputPerMillion +
      cached * price.cacheReadPerMillion +
      counts.output * price.outputPerMillion,
  );
}

export function inputTokenEstimate(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("bytes must be a non-negative safe integer");
  return Math.ceil(bytes / 2);
}

const boundedCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e9 ? Math.floor(value) : null;

/** Read the last provider usage object from JSON or an event stream. */
export function usageOf(text: string, contentType: string): TokenCounts | null {
  const candidates: unknown[] = [];
  if (contentType.includes("event-stream") || /^\s*(event|data):/mu.test(text.slice(0, 200))) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const event = JSON.parse(data) as Record<string, unknown>;
        candidates.push(
          event.response && typeof event.response === "object"
            ? (event.response as Record<string, unknown>).usage
            : event.usage,
        );
      } catch {
        throw new RelayRequestError("relay_invalid_provider_response", 502, "provider returned invalid event data");
      }
    }
  } else {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      candidates.push(
        body.usage ??
          (body.response && typeof body.response === "object"
            ? (body.response as Record<string, unknown>).usage
            : undefined),
      );
    } catch {
      throw new RelayRequestError("relay_invalid_provider_response", 502, "provider returned invalid JSON");
    }
  }
  for (const usage of candidates.reverse()) {
    if (!usage || typeof usage !== "object") continue;
    const value = usage as Record<string, unknown>;
    const details = (value.input_tokens_details ?? value.prompt_tokens_details ?? {}) as Record<string, unknown>;
    const input = boundedCount(value.input_tokens ?? value.prompt_tokens);
    const output = boundedCount(value.output_tokens ?? value.completion_tokens);
    if (input !== null && output !== null)
      return { input, cachedInput: boundedCount(details.cached_tokens) ?? 0, output };
  }
  return null;
}

export function deltaChars(chunk: string): number {
  let total = 0;
  for (const match of chunk.matchAll(/"delta"\s*:\s*"((?:[^"\\]|\\.)*)"/gu)) total += match[1]!.length;
  return total;
}

export function clampOutput(payload: Record<string, unknown>, cap: number): Record<string, unknown> {
  const asked = boundedCount(payload.max_output_tokens);
  return { ...payload, max_output_tokens: asked === null ? cap : Math.min(asked, cap) };
}

/** Conservative request-level budget accounting. Pending flights remain held until settled. */
export class AttemptLedger {
  private resolved = 0;
  private estimated = 0;
  private readonly flights = new Set<Flight>();
  readonly tokens = { input: 0, cachedInput: 0, output: 0 };
  readonly price: RelayPrice;
  readonly budgetMicros: number;
  readonly outputCap: number;

  constructor(price: RelayPrice, budgetMicros: number, outputCap: number = OUTPUT_CAP_TOKENS) {
    this.price = price;
    this.budgetMicros = budgetMicros;
    this.outputCap = outputCap;
    if (!Number.isSafeInteger(budgetMicros) || budgetMicros < 1)
      throw new RangeError("budgetMicros must be a positive safe integer");
    if (!Number.isSafeInteger(outputCap) || outputCap < 1 || outputCap > OUTPUT_CAP_TOKENS)
      throw new RangeError("outputCap is invalid");
  }

  admit(bodyBytes: number): Flight | null {
    const inputEstimate = inputTokenEstimate(bodyBytes);
    const hold = costMicros(this.price, { input: inputEstimate, cachedInput: 0, output: this.outputCap });
    let held = 0;
    for (const flight of this.flights) held += flight.hold;
    if (this.resolved + held + hold > this.budgetMicros) return null;
    const flight: Flight = { hold, inputEstimate, sent: false, outputSeen: 0 };
    this.flights.add(flight);
    return flight;
  }

  send(flight: Flight): void {
    flight.sent = true;
  }
  seen(flight: Flight, chars: number): void {
    flight.outputSeen = Math.min(this.outputCap, flight.outputSeen + Math.max(0, chars));
  }
  refund(flight: Flight): void {
    this.flights.delete(flight);
  }
  keep(flight: Flight): void {
    if (this.flights.delete(flight)) {
      this.resolved += flight.hold;
      this.estimated++;
    }
  }
  abort(flight: Flight): void {
    if (this.flights.delete(flight)) {
      if (flight.sent) {
        this.resolved += this.estimate(flight);
        this.estimated++;
      }
    }
  }
  settleUsage(flight: Flight, usage: TokenCounts): void {
    if (!this.flights.delete(flight)) return;
    this.resolved += costMicros(this.price, usage);
    this.tokens.input += usage.input;
    this.tokens.cachedInput += usage.cachedInput;
    this.tokens.output += usage.output;
  }
  get costMicros(): number {
    let pending = 0;
    for (const flight of this.flights) if (flight.sent) pending += this.estimate(flight);
    return this.resolved + pending;
  }
  get status(): "reported" | "estimated" {
    return this.estimated > 0 || [...this.flights].some((flight) => flight.sent) ? "estimated" : "reported";
  }
  private estimate(flight: Flight): number {
    const output = Math.min(this.outputCap, Math.max(flight.outputSeen, 2_000));
    return Math.min(flight.hold, costMicros(this.price, { input: flight.inputEstimate, cachedInput: 0, output }));
  }
}

/** Convert the daemon's versioned model table to the relay's inclusive price shape. */
export function relayPriceOf(model: string): RelayPrice {
  const price = relayModelPriceOf(model)?.price;
  if (!price) throw new CloudDispatchRelayError("MODEL_UNPRICED", `no public price is registered for model ${model}`);
  return {
    inputPerMillion: price.inputPerMillion,
    cacheReadPerMillion: price.cacheReadPerMillion,
    outputPerMillion: price.outputPerMillion,
  };
}

/** The relay's conservative model aliases are shared by launch and quote paths. */
export function relayModelPriceOf(model: string): { readonly sourceModel: string; readonly price: ModelPrice } | null {
  const sourceModel = model === "grok-4.6" ? "gpt-6.1-sol" : model,
    price = modelPriceOf(sourceModel);
  return price === null ? null : { sourceModel, price };
}

export interface AgentRuntimeQuote {
  readonly ok: true;
  readonly model: string;
  readonly pricing: ModelPrice & { readonly version: string };
  /** Effective request input after the fixed runtime instruction overhead. */
  readonly inputTokens: number;
  /** Supplied byte estimate, or null when the caller supplied tokens. */
  readonly inputBytes: number | null;
  readonly outputCapTokens: number;
  readonly codeRun: boolean;
  readonly strategy: "single-request" | "code-run-floor";
  readonly reserveMicros: string;
}

/**
 * Pure, stateless reservation quote used by daemon consumers before dispatch.
 * Input is either a token estimate or a UTF-8 byte estimate; the fixed runtime overhead
 * is applied in one place so callers cannot silently under-reserve. Unknown prices throw
 * MODEL_UNPRICED instead of being converted to a zero-cost quote.
 */
export function quoteAgentRuntimeBudget(input: {
  readonly model: string;
  readonly inputTokens?: number;
  readonly inputBytes?: number;
  readonly outputCapTokens?: number;
  readonly codeRun?: boolean;
}): AgentRuntimeQuote {
  const priced = relayModelPriceOf(input.model);
  if (priced === null)
    throw new CloudDispatchRelayError("MODEL_UNPRICED", `no public price is registered for model ${input.model}`);
  const hasTokens = input.inputTokens !== undefined,
    hasBytes = input.inputBytes !== undefined;
  if (hasTokens === hasBytes)
    throw new CloudDispatchRelayError("RELAY_REFUSED", "quote requires inputTokens or inputBytes", 400);
  const promptTokens = hasTokens ? input.inputTokens! : inputTokenEstimate(input.inputBytes!),
    outputCapTokens = input.outputCapTokens ?? OUTPUT_CAP_TOKENS;
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0)
    throw new CloudDispatchRelayError("RELAY_REFUSED", "input estimate must be a non-negative safe integer", 400);
  if (!Number.isSafeInteger(outputCapTokens) || outputCapTokens < 1 || outputCapTokens > OUTPUT_CAP_TOKENS)
    throw new CloudDispatchRelayError(
      "RELAY_REFUSED",
      `output cap must be an integer from 1 to ${OUTPUT_CAP_TOKENS}`,
      400,
    );
  const effectiveInputTokens = promptTokens + REQUEST_OVERHEAD_TOKENS;
  if (!Number.isSafeInteger(effectiveInputTokens))
    throw new CloudDispatchRelayError("RELAY_REFUSED", "input estimate is too large", 400);
  const single = costMicros(relayPriceOf(input.model), {
      input: effectiveInputTokens,
      cachedInput: 0,
      output: outputCapTokens,
    }),
    codeRun = input.codeRun === true,
    reserveMicros = codeRun ? Math.max(single, CLOUD_CODE_RESERVE_MICROS) : single;
  return {
    ok: true,
    model: input.model,
    pricing: { ...priced.price, version: modelPricingVersion },
    inputTokens: effectiveInputTokens,
    inputBytes: hasBytes ? input.inputBytes! : null,
    outputCapTokens,
    codeRun,
    strategy: codeRun ? "code-run-floor" : "single-request",
    reserveMicros: String(reserveMicros),
  };
}

/** Worst-case micro-USD budget used by the daemon launch boundary. */
export function relayBudgetMicrosOf(model: string, inputTokens: number, outputCap = OUTPUT_CAP_TOKENS): number | null {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 1) return null;
  if (!relayModelPriceOf(model)) return null;
  return costMicros(relayPriceOf(model), { input: inputTokens, cachedInput: 0, output: outputCap });
}

export function mask(text: string, secrets: readonly string[]): string {
  let masked = text;
  for (const secret of secrets) if (secret.length >= 8) masked = masked.split(secret).join("[REDACTED]");
  return masked.replace(/Bearer\s+[^\s"'<>]+/giu, "Bearer [REDACTED]");
}

export const httpsUpstream: Upstream = ({ url, body, key, signal, onChunk }) =>
  new Promise<UpstreamResponse>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "POST",
        ...(signal ? { signal } : {}),
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          authorization: `Bearer ${key}`,
          accept: "application/json, text/event-stream",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("upstream response too large"));
            return;
          }
          chunks.push(chunk);
          onChunk?.(chunk.toString("utf8"));
        });
        response.on("end", () => {
          const retryAfter = Number(response.headers["retry-after"]);
          resolve({
            status: response.statusCode ?? 502,
            type: String(response.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks),
            ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
          });
        });
        response.on("error", reject);
      },
    );
    request.setTimeout(UPSTREAM_TIMEOUT_MS, () => request.destroy(new Error("upstream request timed out")));
    request.on("error", reject);
    request.end(body);
  });

const sameToken = (presented: string, token: Buffer): boolean =>
  Buffer.byteLength(presented) === token.length && timingSafeEqual(Buffer.from(presented), token);

export class CloudDispatchRelay {
  private readonly entries = new Map<string, Entry>();
  private server: ReturnType<typeof createServer> | null = null;
  private origin = "";
  private closed = false;
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly options: CloudDispatchRelayOptions;

  constructor(options: CloudDispatchRelayOptions) {
    this.options = options;
    if (!Array.isArray(options.allowedHosts))
      throw new CloudDispatchRelayError("RELAY_REFUSED", "allowedHosts is required", 500);
    const max = options.maxGenerations ?? DEFAULT_MAX_GENERATIONS;
    if (!Number.isSafeInteger(max) || max < 1 || max > 10_000)
      throw new CloudDispatchRelayError("RELAY_REFUSED", "maxGenerations is invalid", 500);
  }

  get baseUrl(): string {
    if (!this.origin) throw new CloudDispatchRelayError("RELAY_REFUSED", "relay has not started", 500);
    return `${this.origin}/v1`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => void this.handle(request, response).catch(() => undefined));
    server.requestTimeout = 125_000;
    server.headersTimeout = 10_000;
    server.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
    server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    this.server = server;
  }

  register(input: RelayRegistration): { readonly token: string; readonly baseUrl: string } {
    if (this.closed) throw new CloudDispatchRelayError("RELAY_REFUSED", "relay is closed", 503);
    if (this.entries.has(input.attemptId))
      throw new CloudDispatchRelayError("RELAY_REFUSED", "attempt is already registered", 409);
    if (!/^[A-Za-z0-9._:-]{1,120}$/u.test(input.model))
      throw new CloudDispatchRelayError("RELAY_REFUSED", "model name is invalid", 422);
    const target = new URL(input.targetBaseUrl);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.port ||
      target.search ||
      target.hash ||
      target.pathname.replace(/\/$/u, "") !== "/v1"
    )
      throw new CloudDispatchRelayError("RELAY_REFUSED", "upstream must be credential-free https://host/v1", 422);
    if (!this.options.allowedHosts.includes(target.hostname))
      throw new CloudDispatchRelayError("RELAY_REFUSED", `upstream host ${target.hostname} is not allowed`, 422);
    if ((input.price === undefined) !== (input.budgetMicros === undefined))
      throw new CloudDispatchRelayError("RELAY_REFUSED", "price and budget must be supplied together", 422);
    const max = input.maxGenerations ?? this.options.maxGenerations ?? DEFAULT_MAX_GENERATIONS;
    if (!Number.isSafeInteger(max) || max < 1 || max > 10_000)
      throw new CloudDispatchRelayError("RELAY_REFUSED", "maxGenerations is invalid", 422);
    const outputCap = this.options.outputCapTokens ?? OUTPUT_CAP_TOKENS;
    const ledger =
      input.price !== undefined && input.budgetMicros !== undefined
        ? new AttemptLedger(input.price, input.budgetMicros, outputCap)
        : null;
    const token = randomBytes(32).toString("hex");
    this.entries.set(input.attemptId, {
      id: input.attemptId,
      keyFor: input.keyFor,
      target,
      model: input.model,
      token: Buffer.from(token),
      maxGenerations: max,
      outputCap,
      usage: { requests: 0, generations: 0, rejected: 0, failures: [] },
      ledger,
    });
    return { token, baseUrl: this.baseUrl };
  }

  usage(attemptId: string): RelayUsage | null {
    const entry = this.entries.get(attemptId);
    if (!entry) return null;
    return {
      ...entry.usage,
      failures: [...entry.usage.failures],
      ...(entry.ledger ? { tokens: { ...entry.ledger.tokens }, costMicros: entry.ledger.costMicros } : {}),
    };
  }

  settlement(attemptId: string): RelaySettlement | null {
    const ledger = this.entries.get(attemptId)?.ledger;
    return ledger ? { actualMicros: String(ledger.costMicros), costStatus: ledger.status } : null;
  }

  release(attemptId: string): void {
    this.entries.delete(attemptId);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.entries.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async limited<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const capacity = Math.max(1, this.options.maxUpstreamConcurrency ?? 2);
    while (this.active >= capacity) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error("request aborted while waiting for upstream slot"));
        const wake = (): void => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const index = this.waiters.indexOf(wake);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("request aborted while waiting for upstream slot"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waiters.push(wake);
      });
    }
    this.active++;
    try {
      return await run();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let entry: Entry | undefined;
    let flight: Flight | null = null;
    let generationReserved = false;
    let generationSent = false;
    const gone = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) gone.abort();
    });
    const deny = (status: number, code: string, message: string): void => {
      if (entry) entry.usage.rejected++;
      if (response.destroyed) return;
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: { type: code, message } }));
    };
    try {
      if (this.closed) return deny(503, "relay_closed", "relay is closed");
      const presented =
        String(request.headers.authorization ?? "").replace(/^Bearer\s+/iu, "") ||
        String(request.headers["x-api-key"] ?? "");
      entry = [...this.entries.values()].find((candidate) => sameToken(presented, candidate.token));
      if (!entry) return deny(401, "relay_unauthorized", "local relay authentication failed");
      entry.usage.requests++;
      const url = new URL(request.url ?? "", this.origin);
      if (request.method !== "POST") return deny(405, "relay_method_denied", "only POST is accepted");
      if (url.pathname !== ROUTE || url.search || url.username || url.password || url.hash)
        return deny(403, "relay_route_denied", "route is not authorized");
      if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")
        return deny(415, "relay_encoding_denied", "compressed requests are not accepted");
      if (!String(request.headers["content-type"] ?? "").startsWith("application/json"))
        return deny(415, "relay_content_type_denied", "request must be JSON");
      if (Number(request.headers["content-length"]) > MAX_BODY_BYTES)
        return deny(413, "relay_body_too_large", "request exceeds relay body limit");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MAX_BODY_BYTES) return deny(413, "relay_body_too_large", "request exceeds relay body limit");
        chunks.push(buffer);
      }
      const body = Buffer.concat(chunks);
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        throw new RelayRequestError("relay_invalid_json", 400, "request is not valid JSON");
      }
      if (payload === null) return deny(400, "relay_invalid_json", "request is not valid JSON");
      if (!payload || typeof payload !== "object" || (payload as { model?: unknown }).model !== entry.model)
        return deny(403, "relay_model_denied", "request model is not the model registered for this attempt");
      if (entry.usage.generations >= entry.maxGenerations) {
        entry.usage.failures.push("max-generations");
        return deny(429, "generation_limit", "maximum generations for this attempt have been reached");
      }
      const outbound = Buffer.from(
        JSON.stringify(clampOutput(payload as Record<string, unknown>, entry.outputCap)),
        "utf8",
      );
      if (entry.ledger) {
        flight = entry.ledger.admit(outbound.length);
        if (!flight) {
          entry.usage.failures.push("budget-exceeded");
          return deny(429, "budget_exceeded", "request would exceed the reserved micro-USD budget");
        }
      }
      entry.usage.generations++;
      generationReserved = true;
      let key: string | null = null;
      try {
        key = await entry.keyFor();
      } catch {
        entry.usage.generations--;
        generationReserved = false;
        if (flight && entry.ledger) {
          entry.ledger.refund(flight);
          flight = null;
        }
        entry.usage.failures.push("key-unavailable");
        throw new RelayRequestError("provider_key_unavailable", 502, "provider key unavailable");
      }
      if (typeof key !== "string" || key.length < 8 || key.length > 4096) {
        entry.usage.generations--;
        generationReserved = false;
        if (flight && entry.ledger) entry.ledger.refund(flight);
        entry.usage.failures.push("key-invalid");
        return deny(502, "provider_key_invalid", "provider key is invalid");
      }
      if (gone.signal.aborted) {
        entry.usage.generations--;
        generationReserved = false;
        if (flight && entry.ledger) entry.ledger.abort(flight);
        return;
      }
      const currentEntry = entry;
      const result = await this.limited(gone.signal, () => {
        generationSent = true;
        if (flight && currentEntry.ledger) currentEntry.ledger.send(flight);
        return (this.options.upstream ?? httpsUpstream)({
          url: new URL(`${currentEntry.target.origin}${currentEntry.target.pathname}/responses`),
          body: outbound,
          key,
          signal: gone.signal,
          onChunk:
            flight && currentEntry.ledger ? (text) => currentEntry.ledger!.seen(flight!, deltaChars(text)) : undefined,
        });
      });
      const raw = result.body.toString("utf8");
      if (flight && entry.ledger) {
        if (result.status >= 400 && result.status < 500) entry.ledger.refund(flight);
        else {
          const usage = result.status >= 200 && result.status < 300 ? usageOf(raw, result.type) : null;
          if (usage) entry.ledger.settleUsage(flight, usage);
          else entry.ledger.keep(flight);
        }
        flight = null;
      }
      if (response.destroyed) return;
      response.writeHead(result.status, {
        "content-type": result.type.startsWith("text/event-stream") ? "text/event-stream" : "application/json",
        "cache-control": "no-store",
      });
      response.end(mask(raw, [key, presented]));
    } catch (error) {
      if (flight && entry?.ledger) {
        if (gone.signal.aborted) entry.ledger.abort(flight);
        else entry.ledger.keep(flight);
      }
      if (entry && generationReserved && !generationSent) entry.usage.generations--;
      if (!response.destroyed && !response.writableEnded) {
        const failure = error instanceof RelayRequestError ? error : null;
        deny(
          failure?.status ?? 502,
          failure?.code ?? "relay_upstream_failed",
          failure?.message ?? "provider request failed; provider details are withheld by the relay",
        );
      }
      throw error;
    }
  }
}

/** Alias used by callers that imported the HAiKnow name during the migration. */
export const CloudRelay = CloudDispatchRelay;

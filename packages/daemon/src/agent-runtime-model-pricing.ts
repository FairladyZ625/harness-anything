/**
 * The model price table for the token usage page's "converted at public API list
 * prices" amounts: one versioned, build-shipped data module the daemon read side
 * multiplies usage by. Every node running the same build computes the same amount
 * from the same usage — nothing is fetched at runtime and no amount is written
 * back to the event stream.
 *
 * Rates are USD per 1M tokens, split the way `runtime_metrics` counts tokens:
 * inputTokens already includes cache reads and cache writes (the write boundary
 * folds exclusive-input providers into the inclusive shape and counts cache
 * writes separately), so the input rate prices only the cache-miss remainder,
 * while cache reads and cache writes each price at their own published rate.
 * Cache writes have been counted separately since the 2026-10-10 table (before
 * that they sit inside the input remainder and cannot be split — the page says
 * so); providers whose usage reports carry no cache-write field count as zero.
 * There is no long-context/peak tier: per-request tier boundaries cannot be
 * reconstructed from per-dispatch aggregates, so every model prices at its base
 * tier. Both approximations are deliberate and documented per row.
 */

/** Version of the price table: the page labels amounts with this date. Bump it
 * with every price change — history is priced at the current table, so the date
 * is the honesty contract with the reader. */
export const modelPricingVersion = "2026-10-10";

export interface ModelPrice {
  /** USD per 1M fresh input tokens (inputTokens minus cache reads and writes). */
  readonly inputPerMillion: number;
  /** USD per 1M cache-read tokens. */
  readonly cacheReadPerMillion: number;
  /** USD per 1M cache-write tokens; equals inputPerMillion for providers that
   * bill writes as normal input (no published cache-write surcharge). */
  readonly cacheWritePerMillion: number;
  /** USD per 1M output tokens. */
  readonly outputPerMillion: number;
}

/**
 * Keys are the model strings exactly as dispatches declare them
 * (`definitionSnapshot.model`), aliases and relay variants included; the table
 * was populated from every model id observed in this fleet's dispatch streams.
 * Every rate below comes from the provider's own public pricing page, checked
 * 2026-10-10 (no third-party aggregator is used as a source):
 * - OpenAI: https://developers.openai.com/api/docs/pricing — all six ids appear
 *   verbatim; cache writes are a listed column at 1.25× input (gpt-5.6-sol's
 *   2026-08-21 promotional rates run at least through 2026-11-21; long-context
 *   >272K roughly doubles input/cached rates — not applied, see header)
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing —
 *   opus→Claude Opus 5.5, fable→Claude Fable 5.1, sonnet→Claude Sonnet 5.5
 *   (CLI aliases follow the newest model of each family); cache writes are
 *   1.25× input at the 5m TTL (the 2× 1h-TTL tier cannot be split from
 *   per-dispatch aggregates, so the 5m rate is used)
 * - Z.ai: https://docs.z.ai/guides/overview/pricing — GLM-5.3, GLM-5.3-Flash;
 *   cached-input storage is listed "limited-time free", so writes bill as
 *   normal input; the relay's GLM-5.3[1m] has no separate Z.ai list price and
 *   prices at the base rates
 * - Google: https://ai.google.dev/gemini-api/docs/pricing — gemini-3.8-flash
 *   and gemini-3.7-flash; the page lists the flash family (3.6/3.8 checked
 *   2026-10-10) at one shared rate, so 3.7 prices at that family rate even
 *   where the page does not list it separately; the -high/-low suffixes are
 *   thinking-effort variants of the same model at the same rate; cache storage
 *   is billed per token-hour ($0.50/1M/h through 2026), which no per-dispatch
 *   counter can reconstruct — writes bill as normal input
 * - xAI: https://docs.x.ai/docs/models — grok-4.6[1m] is the relay's
 *   1M-context annotation of grok-4.6; xAI publishes no [1m] variant (grok-4.6
 *   is 500k context) and no cache-write rate, so it prices at the base <200K
 *   tier with writes as normal input (≥200K prompts double — not applied)
 * - DeepSeek: https://api-docs.deepseek.com/quick_start/pricing — deepseek-flash
 *   is the official id (DeepSeek-V4.1-Flash); peak hours (weekdays 01:00–04:00
 *   and 06:00–10:00 UTC) double every rate — the off-peak base is tabulated
 *   and the peak tier is not applied; cache writes bill as cache-miss input
 * Models without a public list price (swe2) are absent on purpose: their usage
 * counts as unpriced, never as zero-cost.
 */
const modelPrices: Readonly<Record<string, ModelPrice>> = {
  // OpenAI — input/cacheRead/cacheWrite/output per 1M.
  "gpt-5.6-sol": { inputPerMillion: 4, cacheReadPerMillion: 0.4, cacheWritePerMillion: 5, outputPerMillion: 20 },
  "gpt-5.6-terra": { inputPerMillion: 2, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2.5, outputPerMillion: 12 },
  "gpt-5.6-luna": {
    inputPerMillion: 0.2,
    cacheReadPerMillion: 0.02,
    cacheWritePerMillion: 0.25,
    outputPerMillion: 1.2,
  },
  "gpt-6.1-sol": { inputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 2.5, outputPerMillion: 10 },
  "gpt-6-sol": { inputPerMillion: 2, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2.5, outputPerMillion: 10 },
  "gpt-6-astra": { inputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 12.5, outputPerMillion: 50 },
  // Anthropic via Claude Code aliases; cache write = 1.25× input (5m TTL).
  opus: { inputPerMillion: 4, cacheReadPerMillion: 0.2, cacheWritePerMillion: 5, outputPerMillion: 20 },
  "claude-opus-5-5": { inputPerMillion: 4, cacheReadPerMillion: 0.2, cacheWritePerMillion: 5, outputPerMillion: 20 },
  fable: { inputPerMillion: 10, cacheReadPerMillion: 0.25, cacheWritePerMillion: 12.5, outputPerMillion: 50 },
  sonnet: { inputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 2.5, outputPerMillion: 10 },
  // Z.ai; cached-input storage is free, writes bill as input.
  "GLM-5.3": { inputPerMillion: 1.4, cacheReadPerMillion: 0.26, cacheWritePerMillion: 1.4, outputPerMillion: 4.4 },
  // The relay's 1M-context annotation of GLM-5.3: priced at the base rates
  // (Z.ai publishes no separate [1m] list price).
  "GLM-5.3[1m]": { inputPerMillion: 1.4, cacheReadPerMillion: 0.26, cacheWritePerMillion: 1.4, outputPerMillion: 4.4 },
  "GLM-5.3-Flash": {
    inputPerMillion: 0.15,
    cacheReadPerMillion: 0.03,
    cacheWritePerMillion: 0.15,
    outputPerMillion: 0.5,
  },
  // Google Gemini flash at both thinking efforts; cache storage is per
  // token-hour and cannot be reconstructed, writes bill as input.
  "gemini-3.8-flash-high": {
    inputPerMillion: 0.75,
    cacheReadPerMillion: 0.075,
    cacheWritePerMillion: 0.75,
    outputPerMillion: 3.75,
  },
  "gemini-3.8-flash-low": {
    inputPerMillion: 0.75,
    cacheReadPerMillion: 0.075,
    cacheWritePerMillion: 0.75,
    outputPerMillion: 3.75,
  },
  "gemini-3.7-flash-high": {
    inputPerMillion: 0.75,
    cacheReadPerMillion: 0.075,
    cacheWritePerMillion: 0.75,
    outputPerMillion: 3.75,
  },
  // xAI grok-4.6 base <200K tier; no published cache-write rate, writes bill as input.
  "grok-4.6[1m]": { inputPerMillion: 2, cacheReadPerMillion: 0.5, cacheWritePerMillion: 2, outputPerMillion: 6 },
  // DeepSeek deepseek-flash (official id), off-peak base tier; peak hours double.
  "deepseek-flash": {
    inputPerMillion: 0.15,
    cacheReadPerMillion: 0.003,
    cacheWritePerMillion: 0.15,
    outputPerMillion: 0.6,
  },
};

const caseFoldedPrices = new Map(Object.entries(modelPrices).map(([model, price]) => [model.toLowerCase(), price]));

/** The price of one dispatched model string, or null when no public price is
 * tabulated — exact spelling first, case-folded second (the same model id
 * reaches us with drifted casing). */
export function modelPriceOf(model: string | null): ModelPrice | null {
  if (model === null || model === "") return null;
  return modelPrices[model] ?? caseFoldedPrices.get(model.toLowerCase()) ?? null;
}

/** USD amount of one counter set at the given price. `inputTokens` includes
 * cache reads and cache writes; the remainder prices at the input rate. */
export function usageCostUsd(
  price: ModelPrice,
  counters: {
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
  },
): number {
  const cacheRead = Math.max(0, Math.min(counters.cacheReadTokens, counters.inputTokens)),
    cacheWrite = Math.max(0, Math.min(counters.cacheWriteTokens, counters.inputTokens - cacheRead)),
    freshInput = counters.inputTokens - cacheRead - cacheWrite;
  return (
    (freshInput * price.inputPerMillion +
      cacheRead * price.cacheReadPerMillion +
      cacheWrite * price.cacheWritePerMillion +
      counters.outputTokens * price.outputPerMillion) /
    1_000_000
  );
}

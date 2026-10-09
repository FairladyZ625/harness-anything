/**
 * The model price table for the token usage page's "converted at public API list
 * prices" amounts: one versioned, build-shipped data module the daemon read side
 * multiplies usage by. Every node running the same build computes the same amount
 * from the same usage — nothing is fetched at runtime and no amount is written
 * back to the event stream.
 *
 * Rates are USD per 1M tokens, split the way `runtime_metrics` counts tokens:
 * inputTokens already includes cache reads (`runtime-spawn-provider-stream.ts`
 * folds exclusive-input providers into the inclusive shape), so the input rate
 * prices the cache-miss remainder and the cacheRead rate prices the hits. There
 * is no cache-write tier and no long-context/peak tier: the counters carry no
 * cache-write number (writes are folded into inputTokens at the write boundary
 * and price at the input rate), and per-request tier boundaries cannot be
 * reconstructed from per-dispatch aggregates, so every model prices at its base
 * tier. Both approximations are deliberate and documented per row.
 */

/** Version of the price table: the page labels amounts with this date. Bump it
 * with every price change — history is priced at the current table, so the date
 * is the honesty contract with the reader. */
export const modelPricingVersion = "2026-10-09";

export interface ModelPrice {
  /** USD per 1M fresh input tokens (inputTokens minus cacheReadTokens). */
  readonly inputPerMillion: number;
  /** USD per 1M cache-read tokens. */
  readonly cacheReadPerMillion: number;
  /** USD per 1M output tokens. */
  readonly outputPerMillion: number;
}

/**
 * Keys are the model strings exactly as dispatches declare them
 * (`definitionSnapshot.model`), aliases and relay variants included; the table
 * was populated from every model id observed in this fleet's dispatch streams.
 * Sources, checked 2026-10-09:
 * - OpenAI: https://developers.openai.com/api/docs/pricing (gpt-5.6-sol's
 *   2026-08-21 promotional rates, listed through ~2026-11-21; cached input is
 *   10% of input for the gpt-6.x/5.6 rows)
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 *   (opus→Claude Opus 5.5, fable→Claude Fable 5.1, sonnet→Claude Sonnet 5.5;
 *   these CLI aliases follow the newest model of each family)
 * - Z.ai: https://docs.z.ai/guides/overview/pricing (GLM-5.3, GLM-5.3-Flash)
 * - Google: https://ai.google.dev/gemini-api/docs/pricing (gemini-3.8/3.7-flash;
 *   the -high/-low suffixes are thinking-effort variants at the same rate,
 *   cache read from models.dev https://models.dev/api.json)
 * - xAI grok-4.6 and deepseek-flash: models.dev https://models.dev/api.json
 *   (base tier; grok's >200K-context doubling cannot be applied — see above)
 * Cross-checked against ccusage's embedded models.dev snapshot (2026-10-09).
 * Models without a public list price (swe2) are absent on purpose: their usage
 * counts as unpriced, never as zero-cost.
 */
const modelPrices: Readonly<Record<string, ModelPrice>> = {
  // OpenAI — input/cacheRead/output per 1M.
  "gpt-5.6-sol": { inputPerMillion: 4, cacheReadPerMillion: 0.4, outputPerMillion: 20 },
  "gpt-5.6-terra": { inputPerMillion: 2, cacheReadPerMillion: 0.2, outputPerMillion: 12 },
  "gpt-5.6-luna": { inputPerMillion: 0.2, cacheReadPerMillion: 0.02, outputPerMillion: 1.2 },
  "gpt-6.1-sol": { inputPerMillion: 2, cacheReadPerMillion: 0.1, outputPerMillion: 10 },
  "gpt-6-sol": { inputPerMillion: 2, cacheReadPerMillion: 0.2, outputPerMillion: 10 },
  "gpt-6-astra": { inputPerMillion: 10, cacheReadPerMillion: 1, outputPerMillion: 50 },
  // Anthropic via Claude Code aliases.
  opus: { inputPerMillion: 4, cacheReadPerMillion: 0.2, outputPerMillion: 20 },
  "claude-opus-5-5": { inputPerMillion: 4, cacheReadPerMillion: 0.2, outputPerMillion: 20 },
  fable: { inputPerMillion: 10, cacheReadPerMillion: 0.25, outputPerMillion: 50 },
  sonnet: { inputPerMillion: 2, cacheReadPerMillion: 0.1, outputPerMillion: 10 },
  // Z.ai.
  "GLM-5.3": { inputPerMillion: 1.4, cacheReadPerMillion: 0.26, outputPerMillion: 4.4 },
  // The relay's 1M-context annotation of GLM-5.3: priced at the base rates
  // (Z.ai publishes no separate [1m] list price).
  "GLM-5.3[1m]": { inputPerMillion: 1.4, cacheReadPerMillion: 0.26, outputPerMillion: 4.4 },
  "GLM-5.3-Flash": { inputPerMillion: 0.15, cacheReadPerMillion: 0.03, outputPerMillion: 0.5 },
  // Google Gemini flash at both thinking efforts.
  "gemini-3.8-flash-high": { inputPerMillion: 0.75, cacheReadPerMillion: 0.075, outputPerMillion: 3.75 },
  "gemini-3.8-flash-low": { inputPerMillion: 0.75, cacheReadPerMillion: 0.075, outputPerMillion: 3.75 },
  "gemini-3.7-flash-high": { inputPerMillion: 0.75, cacheReadPerMillion: 0.075, outputPerMillion: 3.75 },
  // models.dev only: base tier.
  "deepseek-flash": { inputPerMillion: 0.15, cacheReadPerMillion: 0.003, outputPerMillion: 0.6 },
  "grok-4.6[1m]": { inputPerMillion: 2, cacheReadPerMillion: 0.5, outputPerMillion: 6 },
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
 * cache reads; the remainder prices at the input rate. */
export function usageCostUsd(
  price: ModelPrice,
  counters: { readonly inputTokens: number; readonly cacheReadTokens: number; readonly outputTokens: number },
): number {
  const cacheRead = Math.max(0, Math.min(counters.cacheReadTokens, counters.inputTokens)),
    freshInput = counters.inputTokens - cacheRead;
  return (
    (freshInput * price.inputPerMillion +
      cacheRead * price.cacheReadPerMillion +
      counters.outputTokens * price.outputPerMillion) /
    1_000_000
  );
}

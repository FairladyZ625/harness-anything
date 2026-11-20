import { readFileSync } from "node:fs";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import { parseModelPricingCatalog, type ModelPricingCatalog } from "./model-pricing-catalog.ts";

/** Version of the synchronized public price catalog. */
export let modelPricingVersion: string;

export interface ModelPrice {
  /** USD per 1M fresh input tokens (inputTokens minus cache reads and writes). */
  readonly inputPerMillion: number;
  /** USD per 1M cache-read tokens. */
  readonly cacheReadPerMillion: number;
  /** USD per 1M cache-write tokens; defaults to input when no surcharge is published. */
  readonly cacheWritePerMillion: number;
  /** USD per 1M output tokens. */
  readonly outputPerMillion: number;
}

interface ModelPriceTable {
  readonly exact: ReadonlyMap<string, ModelPrice>;
  readonly folded: ReadonlyMap<string, ModelPrice>;
}

function pricesFromCatalog(catalog: ModelPricingCatalog): ModelPriceTable {
  const exact = new Map<string, ModelPrice>();
  for (const model of catalog.models) {
    if (exact.has(model.id)) continue;
    const { inputPerMillion, cacheReadPerMillion, cacheWritePerMillion, outputPerMillion } = model;
    exact.set(model.id, { inputPerMillion, cacheReadPerMillion, cacheWritePerMillion, outputPerMillion });
  }
  return { exact, folded: new Map([...exact].map(([id, price]) => [id.toLowerCase(), price])) };
}

const builtinCatalog = parseModelPricingCatalog(
    JSON.parse(readFileSync(new URL("./model-pricing-catalog.json", import.meta.url), "utf8")),
  ),
  exactAliases: ReadonlyMap<string, string> = new Map([
    ["opus", "claude-opus-5-5"],
    ["sonnet", "claude-sonnet-5-5"],
    ["fable", "claude-fable-5-1"],
  ]),
  normalizedAliases: ReadonlyMap<string, readonly string[]> = new Map([
    ["deepseek-v4.1-flash", ["deepseek-v4-flash", "deepseek-flash"]],
  ]);

let prices: ModelPriceTable = pricesFromCatalog(builtinCatalog);
modelPricingVersion = builtinCatalog.version;

/** Update the process-local read table after a complete catalog has been fetched and validated. */
export function installModelPricingCatalog(value: unknown): void {
  const catalog = parseModelPricingCatalog(value),
    nextPrices = pricesFromCatalog(catalog);
  prices = nextPrices;
  modelPricingVersion = catalog.version;
}

/** Unwrap known model wrappers and remove only the controlled runtime suffixes. */
export function normalizeModelPricingKey(model: string): string | null {
  let candidate = model.trim();
  if (!candidate) return null;
  if (candidate.startsWith("[")) {
    let tuple: unknown;
    try {
      tuple = JSON.parse(candidate) as unknown;
    } catch (error) {
      consumeKnownError(error);
      return null;
    }
    if (!Array.isArray(tuple) || tuple.length !== 2 || tuple.some((item) => typeof item !== "string")) return null;
    candidate = tuple[1] as string;
  }
  candidate = candidate.replace(/\[[^\]]+\]$/u, "");
  const providerIndex = candidate.indexOf("/");
  if (providerIndex !== -1) candidate = candidate.slice(providerIndex + 1);
  let previous: string;
  do {
    previous = candidate;
    candidate = candidate.replace(/-(?:minimal|low|medium|high|xhigh|max)$/iu, "");
    candidate = candidate.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/u, "");
  } while (candidate !== previous);
  return candidate ? candidate.toLowerCase() : null;
}

/** Exact match, case-folded match, then suffix normalization and a controlled alias set. */
export function modelPriceOf(model: string | null): ModelPrice | null {
  if (model === null || model === "") return null;
  const direct = prices.exact.get(model);
  if (direct) return direct;
  const folded = model.toLowerCase(),
    caseFolded = prices.folded.get(folded);
  if (caseFolded) return caseFolded;
  const normalized = normalizeModelPricingKey(model);
  if (!normalized) return null;
  const aliased = exactAliases.get(normalized) ?? normalized;
  return (
    prices.folded.get(aliased) ??
    (normalizedAliases.get(aliased) ?? []).map((alias) => prices.folded.get(alias)).find(Boolean) ??
    null
  );
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

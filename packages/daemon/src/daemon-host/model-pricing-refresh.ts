import { readFile } from "node:fs/promises";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import { hostEnvironmentFilePath, writeHostEnvironmentFile } from "./host-environment-io.ts";
import { createModelPricingCatalog, parseModelPricingCatalog } from "../runtime-engine/model-pricing-catalog.ts";
import { installModelPricingCatalog } from "../runtime-engine/agent-runtime-model-pricing.ts";
import type { ModelPricingCatalog } from "../runtime-engine/model-pricing-catalog.ts";

export const MODEL_PRICING_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const MODEL_PRICING_CACHE_MAX_AGE_MS = MODEL_PRICING_REFRESH_INTERVAL_MS;
const MODEL_PRICING_URL = "https://models.dev/api.json";
const MODEL_PRICING_CACHE_SCHEMA = "model-pricing-cache/v1";

interface ModelPricingCache {
  readonly schema: typeof MODEL_PRICING_CACHE_SCHEMA;
  readonly fetchedAt: string;
  readonly catalog: ModelPricingCatalog;
}

function parseModelPricingCache(value: unknown): ModelPricingCache | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cache = value as Partial<ModelPricingCache>;
  if (
    cache.schema !== MODEL_PRICING_CACHE_SCHEMA ||
    typeof cache.fetchedAt !== "string" ||
    !Number.isFinite(Date.parse(cache.fetchedAt))
  )
    return null;
  try {
    return {
      schema: MODEL_PRICING_CACHE_SCHEMA,
      fetchedAt: cache.fetchedAt,
      catalog: parseModelPricingCatalog(cache.catalog),
    };
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

export async function loadModelPricingCache(input: {
  readonly userRoot: string;
  readonly now?: () => Date;
  readonly install?: (catalog: unknown) => void;
}): Promise<{ readonly catalog: ModelPricingCatalog; readonly ageMs: number } | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(hostEnvironmentFilePath("modelPricingCache", input.userRoot), "utf8")) as unknown;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
  const cache = parseModelPricingCache(value);
  if (!cache) return null;
  return { catalog: cache.catalog, ageMs: (input.now ?? (() => new Date()))().getTime() - Date.parse(cache.fetchedAt) };
}

export async function refreshModelPricingCatalog(
  input: {
    readonly fetcher?: typeof fetch;
    readonly install?: (catalog: unknown) => void;
    readonly now?: () => Date;
    readonly timeoutMs?: number;
    readonly userRoot?: string;
  } = {},
): Promise<boolean> {
  const fetcher = input.fetcher ?? fetch,
    response = await fetcher(MODEL_PRICING_URL, {
      signal: AbortSignal.timeout(input.timeoutMs ?? 8_000),
    });
  if (!response.ok) return false;
  const fetchedAt = (input.now ?? (() => new Date()))().toISOString();
  const catalog = createModelPricingCatalog({
    modelsDev: await response.json(),
    version: fetchedAt.slice(0, 10),
    source: MODEL_PRICING_URL,
  });
  if (input.userRoot) {
    const cache: ModelPricingCache = { schema: MODEL_PRICING_CACHE_SCHEMA, fetchedAt, catalog };
    await writeHostEnvironmentFile("modelPricingCache", input.userRoot, `${JSON.stringify(cache, null, 2)}\n`);
  }
  (input.install ?? installModelPricingCatalog)(catalog);
  return true;
}

export async function initializeModelPricingCatalog(input: {
  readonly userRoot: string;
  readonly fetcher?: typeof fetch;
  readonly install?: (catalog: unknown) => void;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}): Promise<number> {
  const cached = await loadModelPricingCache(input);
  if (cached && cached.ageMs >= 0 && cached.ageMs < MODEL_PRICING_CACHE_MAX_AGE_MS) {
    (input.install ?? installModelPricingCatalog)(cached.catalog);
    return MODEL_PRICING_CACHE_MAX_AGE_MS - cached.ageMs;
  }
  try {
    await refreshModelPricingCatalog(input);
  } catch (error) {
    consumeKnownError(error);
  }
  return MODEL_PRICING_REFRESH_INTERVAL_MS;
}

export function startModelPricingRefresh(input: {
  readonly userRoot: string;
  readonly fetcher?: typeof fetch;
  readonly install?: (catalog: unknown) => void;
  readonly now?: () => Date;
}): () => void {
  let stopped = false,
    timer: NodeJS.Timeout | undefined;
  const schedule = (delay: number) => {
    timer = setTimeout(() => void initialize(), delay);
    timer.unref();
  };
  const initialize = async () => {
    try {
      const delay = await initializeModelPricingCatalog(input);
      if (!stopped) schedule(delay);
    } catch (error) {
      consumeKnownError(error);
      if (!stopped) schedule(MODEL_PRICING_REFRESH_INTERVAL_MS);
    }
  };
  void initialize();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

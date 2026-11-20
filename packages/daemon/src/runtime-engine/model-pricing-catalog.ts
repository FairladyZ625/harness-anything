export const modelPricingProviders = ["openai", "anthropic", "google", "deepseek", "zai", "xai"] as const;

export interface ModelPricingCatalogEntry {
  readonly id: string;
  readonly provider: (typeof modelPricingProviders)[number];
  readonly inputPerMillion: number;
  readonly cacheReadPerMillion: number;
  readonly cacheWritePerMillion: number;
  readonly outputPerMillion: number;
}

export interface ModelPricingCatalog {
  readonly schema: "model-pricing-catalog/v1";
  readonly version: string;
  readonly source: string;
  readonly models: readonly ModelPricingCatalogEntry[];
}

interface ModelsDevEntry {
  readonly name?: string;
  readonly cost?: {
    readonly input?: unknown;
    readonly output?: unknown;
    readonly cache_read?: unknown;
    readonly cache_write?: unknown;
  };
}

function positivePrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativePrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function createModelPricingCatalog(input: {
  readonly modelsDev: unknown;
  readonly version: string;
  readonly source: string;
}): ModelPricingCatalog {
  if (!input.modelsDev || typeof input.modelsDev !== "object" || Array.isArray(input.modelsDev))
    throw new TypeError("models.dev response must be an object");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.version)) throw new TypeError("model pricing version must be an ISO date");
  const root = input.modelsDev as Record<string, unknown>,
    models: ModelPricingCatalogEntry[] = [];
  for (const provider of modelPricingProviders) {
    const rawProvider = root[provider];
    if (!rawProvider || typeof rawProvider !== "object" || Array.isArray(rawProvider)) continue;
    const providerModels = (rawProvider as { readonly models?: unknown }).models;
    if (!providerModels || typeof providerModels !== "object" || Array.isArray(providerModels)) continue;
    for (const [id, rawModel] of Object.entries(providerModels as Record<string, ModelsDevEntry>)) {
      const cost = rawModel?.cost,
        inputPerMillion = cost?.input,
        outputPerMillion = cost?.output;
      if (!positivePrice(inputPerMillion) || !positivePrice(outputPerMillion)) continue;
      const cacheReadPerMillion = nonNegativePrice(cost?.cache_read) ? cost.cache_read : inputPerMillion,
        cacheWritePerMillion = positivePrice(cost?.cache_write) ? cost.cache_write : inputPerMillion;
      models.push({ id, provider, inputPerMillion, cacheReadPerMillion, cacheWritePerMillion, outputPerMillion });
    }
  }
  models.sort((left, right) => {
    const leftKey = `${left.provider}/${left.id}`,
      rightKey = `${right.provider}/${right.id}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  if (models.length === 0) throw new TypeError("models.dev response contains no supported priced models");
  return {
    schema: "model-pricing-catalog/v1",
    version: input.version,
    source: input.source,
    models,
  };
}

export function parseModelPricingCatalog(value: unknown): ModelPricingCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("model pricing catalog must be an object");
  const catalog = value as Partial<ModelPricingCatalog>;
  if (
    catalog.schema !== "model-pricing-catalog/v1" ||
    typeof catalog.version !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(catalog.version) ||
    typeof catalog.source !== "string" ||
    !Array.isArray(catalog.models) ||
    catalog.models.length === 0
  )
    throw new TypeError("model pricing catalog has an invalid shape");
  for (const model of catalog.models) {
    if (
      !model ||
      typeof model.id !== "string" ||
      !model.id ||
      !modelPricingProviders.includes(model.provider) ||
      !positivePrice(model.inputPerMillion) ||
      !Number.isFinite(model.cacheReadPerMillion) ||
      model.cacheReadPerMillion < 0 ||
      !Number.isFinite(model.cacheWritePerMillion) ||
      model.cacheWritePerMillion < 0 ||
      !positivePrice(model.outputPerMillion)
    )
      throw new TypeError("model pricing catalog contains an invalid model rate");
  }
  return catalog as ModelPricingCatalog;
}

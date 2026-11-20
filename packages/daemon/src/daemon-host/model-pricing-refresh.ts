import { createModelPricingCatalog } from "../runtime-engine/model-pricing-catalog.ts";
import { installModelPricingCatalog } from "../runtime-engine/agent-runtime-model-pricing.ts";

export const MODEL_PRICING_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MODEL_PRICING_URL = "https://models.dev/api.json";

export async function refreshModelPricingCatalog(
  input: {
    readonly fetcher?: typeof fetch;
    readonly install?: (catalog: unknown) => void;
    readonly now?: () => Date;
    readonly timeoutMs?: number;
  } = {},
): Promise<boolean> {
  const fetcher = input.fetcher ?? fetch,
    response = await fetcher(MODEL_PRICING_URL, {
      signal: AbortSignal.timeout(input.timeoutMs ?? 8_000),
    });
  if (!response.ok) return false;
  const catalog = createModelPricingCatalog({
    modelsDev: await response.json(),
    version: (input.now ?? (() => new Date()))().toISOString().slice(0, 10),
    source: MODEL_PRICING_URL,
  });
  (input.install ?? installModelPricingCatalog)(catalog);
  return true;
}

export function startModelPricingRefresh(
  input: {
    readonly fetcher?: typeof fetch;
    readonly install?: (catalog: unknown) => void;
    readonly now?: () => Date;
  } = {},
): () => void {
  const refresh = () => {
    void refreshModelPricingCatalog(input).catch(() => undefined);
  };
  refresh();
  const interval = setInterval(refresh, MODEL_PRICING_REFRESH_INTERVAL_MS);
  interval.unref();
  return () => clearInterval(interval);
}

import type { DecisionProviderRecord } from "@harness-anything/daemon/protocol";
import { invoke } from "./api-client-invoke.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";

export type DecisionProviderCreateInput = {
  readonly type: "decisions";
  readonly providerId: string;
  readonly name: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly enabled: boolean;
};

export type DecisionProviderUpdateInput = {
  readonly providerId: string;
  readonly name?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly enabled?: boolean;
};

export const decisionProviderClient = {
  list: async (): Promise<readonly DecisionProviderRecord[]> => {
    const result = await checked(invoke("daemon.provider.list", {}));
    if (!Array.isArray(result.providers))
      throw new Error(rendererErrorHint(result, "Decisions provider list returned an invalid receipt."));
    return result.providers as DecisionProviderRecord[];
  },
  show: async (providerId: string): Promise<DecisionProviderRecord> =>
    provider(await checked(invoke("daemon.provider.show", { providerId })), "provider"),
  create: async (input: DecisionProviderCreateInput): Promise<DecisionProviderRecord> =>
    provider(await checked(invoke("daemon.provider.create", input)), "provider"),
  update: async (input: DecisionProviderUpdateInput): Promise<DecisionProviderRecord> =>
    provider(await checked(invoke("daemon.provider.update", input)), "provider"),
  probe: async (providerId: string): Promise<DecisionProviderRecord> =>
    provider(await checked(invoke("daemon.provider.probe", { providerId })), "provider"),
  delete: async (providerId: string): Promise<void> => {
    const result = await checked(invoke("daemon.provider.delete", { providerId }));
    if (result.deletedProviderId !== providerId)
      throw new Error(rendererErrorHint(result, "Decisions provider delete returned an invalid receipt."));
  },
};

async function checked(value: Promise<unknown>): Promise<Record<string, unknown>> {
  const result = await value;
  if (!isRendererRecord(result) || result.schema !== "command-receipt/v2" || result.ok !== true)
    throw new Error(rendererErrorHint(result, "Decisions provider operation was rejected."));
  return result;
}

function provider(value: Record<string, unknown>, field: string): DecisionProviderRecord {
  const result = value[field];
  if (!isRendererRecord(result) || result.schema !== "decision-provider/v1" || result.providerType !== "decisions")
    throw new Error(rendererErrorHint(value, "Decisions provider operation returned an invalid provider."));
  return result as unknown as DecisionProviderRecord;
}

import type { RuntimeSpawnInput } from "./runtime-control.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";

type RuntimeCommandBridge = {
  readonly spawnAgentRuntime: (payload: { readonly repoId: string } & RuntimeSpawnInput) => Promise<unknown>;
  readonly showReceipt: (payload: { readonly repoId: string; readonly opId: string }) => Promise<unknown>;
};
const bridge = (): RuntimeCommandBridge => { const value = window.harness as unknown as Partial<RuntimeCommandBridge> | undefined; if (!value?.spawnAgentRuntime || !value.showReceipt) throw new Error("Runtime command bridge is unavailable."); return value as RuntimeCommandBridge; };
export const runtimeCommandClient = {
  spawn: async (repoId: string, input: RuntimeSpawnInput): Promise<unknown> => action(await bridge().spawnAgentRuntime({ repoId, ...input })),
  showReceipt: async (repoId: string, opId: string): Promise<unknown> => action(await bridge().showReceipt({ repoId, opId }))
};
function action(value: unknown): Record<string, unknown> { if (!isRendererRecord(value) || value.schema !== "command-receipt/v2" || typeof value.opId !== "string") throw new Error(rendererErrorHint(value, "Runtime mutation returned an invalid receipt.")); return value; }

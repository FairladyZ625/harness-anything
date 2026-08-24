import type { RuntimeSpawnInput } from "./runtime-control.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";

type RuntimeCommandBridge = {
  readonly spawnAgentRuntime: (payload: { readonly repoId: string } & RuntimeSpawnInput) => Promise<unknown>;
  readonly cancelAgentRuntime: (payload: {
    readonly repoId: string;
    readonly runtimeSessionId: string;
  }) => Promise<unknown>;
  readonly showReceipt: (payload: { readonly repoId: string; readonly opId: string }) => Promise<unknown>;
};
const bridge = (): Partial<RuntimeCommandBridge> | undefined =>
  window.harness as unknown as Partial<RuntimeCommandBridge> | undefined;
const spawnBridge = (): RuntimeCommandBridge["spawnAgentRuntime"] => {
  const value = bridge()?.spawnAgentRuntime;
  if (!value) throw new Error("Runtime command bridge method unavailable: spawnAgentRuntime.");
  return value;
};
const cancelBridge = (): RuntimeCommandBridge["cancelAgentRuntime"] => {
  const value = bridge()?.cancelAgentRuntime;
  if (!value) throw new Error("Runtime command bridge method unavailable: cancelAgentRuntime.");
  return value;
};
const receiptBridge = (): RuntimeCommandBridge["showReceipt"] => {
  const value = bridge()?.showReceipt;
  if (!value) throw new Error("Runtime command bridge method unavailable: showReceipt.");
  return value;
};
export const runtimeCommandClient = {
  spawn: async (repoId: string, input: RuntimeSpawnInput): Promise<unknown> =>
    action(await spawnBridge()({ repoId, ...input })),
  cancel: async (repoId: string, runtimeSessionId: string): Promise<unknown> =>
    action(await cancelBridge()({ repoId, runtimeSessionId })),
  showReceipt: async (repoId: string, opId: string): Promise<unknown> =>
    action(await receiptBridge()({ repoId, opId })),
};
function action(value: unknown): Record<string, unknown> {
  if (!isRendererRecord(value) || value.schema !== "command-receipt/v2" || typeof value.opId !== "string")
    throw new Error(rendererErrorHint(value, "Runtime mutation returned an invalid receipt."));
  return value;
}

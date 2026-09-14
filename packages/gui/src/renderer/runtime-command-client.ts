import type { RuntimeSpawnInput } from "./runtime-control.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";
import { invoke } from "./api-client-invoke.ts";
export const runtimeCommandClient = {
  spawn: async (repoId: string, input: RuntimeSpawnInput): Promise<unknown> =>
    action(await invoke("repo.agentRuntime.spawn", { repoId, ...input }, "spawnAgentRuntime")),
  cancel: async (repoId: string, runtimeSessionId: string): Promise<unknown> =>
    action(
      await invoke(
        "repo.agentRuntime.cancel",
        { repoId, runtimeSessionId } as { readonly repoId: string } & object,
        "cancelAgentRuntime",
      ),
    ),
  showReceipt: async (repoId: string, opId: string): Promise<unknown> =>
    action(await invoke("repo.receipt.show", { repoId, opId } as { readonly repoId: string } & object, "showReceipt")),
};
function action(value: unknown): Record<string, unknown> {
  if (!isRendererRecord(value) || value.schema !== "command-receipt/v2" || typeof value.opId !== "string")
    throw new Error(rendererErrorHint(value, "Runtime mutation returned an invalid receipt."));
  return value;
}

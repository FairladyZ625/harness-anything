import type { ActorAxesBindingRuntimeV2 } from "@harness-anything/application";
import type { AuthorityConnectionContext } from "../../protocol/connection-context.ts";
import type {
  AuthorityProductionRepoConfigV1,
  DurableAuthorityBindingRuntimeV2
} from "./authority-production-state.ts";

export function connectionBoundRuntime(
  runtime: DurableAuthorityBindingRuntimeV2,
  config: AuthorityProductionRepoConfigV1,
  context: AuthorityConnectionContext
): ActorAxesBindingRuntimeV2 {
  return {
    ...runtime,
    getBinding: async (bindingId) => {
      const record = await runtime.getBinding(bindingId);
      if (!record) return undefined;
      if (record.principalPersonId !== context.actor.personId
        || record.workspaceId !== config.workspaceId
        || record.deviceId !== config.deviceId
        || record.viewId !== config.viewId
        || record.attribution.actor.principal.personId !== context.actor.personId) return undefined;
      return record;
    }
  };
}

import { daemonGuiActionMethods } from "./daemon-protocol-gui-actions.ts";
import { daemonGuiReadMethods } from "./daemon-protocol-gui-reads.ts";
import { runtimeInstanceAuthMethods, runtimeInstanceMethods } from "./daemon-protocol-runtime-instance-methods.ts";

export const daemonGuiInvokeFacets = Object.freeze([
  ...daemonGuiReadMethods,
  ...daemonGuiActionMethods,
  ...runtimeInstanceMethods.filter((method) => "guiBridgeMethod" in method),
  ...runtimeInstanceAuthMethods,
]);

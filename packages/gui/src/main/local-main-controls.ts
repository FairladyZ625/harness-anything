import type { GuiServiceBridge } from "../api/service-bridge.ts";
import { guiBuildStamp, type GuiBuildStamp } from "./gui-build-identity.ts";

type Target = {
  readonly repoId: string;
  readonly socketPath: string;
  readonly userRoot: string;
  readonly daemonId: string;
};
export function addLocalMainControls(input: {
  readonly bridge: GuiServiceBridge;
  /** The attached daemon; only its user root is overlaid, so no repository is required. */
  readonly target: () => Promise<Pick<Target, "userRoot">>;
  /** The bundle's own build stamp; injectable so the overlay stays testable. */
  readonly guiBuild?: () => GuiBuildStamp;
}): GuiServiceBridge {
  return {
    stream: input.bridge.stream,
    invoke: async (method, payload) => {
      const result = asRecord(await input.bridge.invoke(method, payload));
      return method === "getSystemStatus" ? overlayLocalSystem(result, input.guiBuild ?? guiBuildStamp) : result;
    },
  };
  // The daemon system-status contract carries neither the user root nor the GUI bundle's build
  // id; main owns both local facts and overlays them here instead of growing the daemon contract.
  // Daemon-provided fields always win if the contract ever grows one.
  async function overlayLocalSystem(
    value: Record<string, unknown>,
    guiBuild: () => GuiBuildStamp,
  ): Promise<Record<string, unknown>> {
    const daemon = asRecord(value.daemon);
    if (!daemon.daemonId) return value;
    const overlaid = { ...value, daemon: { userRoot: (await input.target()).userRoot, ...daemon } };
    return Object.hasOwn(value, "guiBuild") ? overlaid : { ...overlaid, guiBuild: guiBuild() };
  }
}
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

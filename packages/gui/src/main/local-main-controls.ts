import type { GuiServiceBridge } from "../api/service-bridge.ts";

type Target = {
  readonly repoId: string;
  readonly socketPath: string;
  readonly userRoot: string;
  readonly daemonId: string;
};
export function addLocalMainControls(input: {
  readonly bridge: GuiServiceBridge;
  readonly target: (repoId?: string) => Promise<Target>;
}): GuiServiceBridge {
  return {
    stream: input.bridge.stream,
    invoke: async (method, payload) => {
      const result = asRecord(await input.bridge.invoke(method, payload));
      return method === "getSystemStatus" ? overlayLocalUserRoot(result) : result;
    },
  };
  // The daemon system-status contract does not carry the user root; the System
  // page needs it (which user root this daemon serves), and main already
  // resolves the target, so overlay it here instead of extending the daemon
  // contract. Daemon-provided fields always win if the contract grows one.
  async function overlayLocalUserRoot(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!asRecord(value.daemon).daemonId) return value;
    try {
      return { ...value, daemon: { userRoot: (await input.target()).userRoot, ...asRecord(value.daemon) } };
    } catch {
      return value;
    }
  }
}
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

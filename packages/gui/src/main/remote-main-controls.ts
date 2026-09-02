import type { GuiServiceBridge } from "../api/service-bridge.ts";
import { createRuntimeInstanceCredentialController } from "./secure-credential-broker.ts";
import type { CredentialPort } from "../../../daemon/src/agent-runtime-credential-port.ts";

/** Main-process controls for remote mode. Remote daemon restart is never
 * delegated to the local supervisor, so the GUI cannot silently start a local daemon. */
export function addRemoteMainControls(input: {
  readonly bridge: GuiServiceBridge;
  readonly credentialPort?: CredentialPort;
}): GuiServiceBridge {
  const credentialController = createRuntimeInstanceCredentialController({
    ...(input.credentialPort ? { port: input.credentialPort } : {}),
    create: async (payload) => asRecord(await input.bridge.invoke("createRuntimeInstance", payload)),
  });
  return {
    stream: input.bridge.stream,
    invoke: async (method, payload) => {
      if (method === "createRuntimeInstance") return credentialController.create(asRecord(payload) as never);
      if (method === "requestDaemonControl" && asRecord(payload).kind === "restart")
        return {
          schema: "daemon-control-receipt/v1",
          ok: false,
          outcome: "op_rejected",
          error: {
            code: "remote_restart_unsupported",
            hint: "Restart the remote daemon on its host; remote GUI mode never starts a local daemon.",
          },
          nextAction: "Restart the resident daemon on the remote host, then retry.",
        };
      return input.bridge.invoke(method, payload);
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

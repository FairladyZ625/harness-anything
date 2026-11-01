import { evaluateIpcSender, type IpcSenderIdentity, type IpcWebContentsTrustPolicy } from "./security-policy.ts";

/** The one IPC sender trust gate; registration and per-message checks both enter here. */
export function assertTrustedIpcSender(event: IpcSenderIdentity, trustPolicy: IpcWebContentsTrustPolicy): true {
  const decision = evaluateIpcSender(event, trustPolicy);
  if (decision.action === "deny") {
    throw new Error(`Rejected IPC message: ${decision.reason}.`);
  }
  return true;
}

import { EXTERNAL_URL_OPEN_CHANNEL } from "../api/external-url-contract.ts";
import { assertTrustedIpcSender, type HarnessIpcRegistrar } from "./ipc-handlers.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";
import { evaluateExternalUrlTarget } from "./trust-policy.ts";

export function registerExternalUrlIpc(
  registrar: Pick<HarnessIpcRegistrar, "handle">,
  services: {
    readonly rootDir: string;
    readonly openExternal: (url: string) => Promise<void>;
  },
  trustPolicy: IpcWebContentsTrustPolicy,
): void {
  registrar.handle(EXTERNAL_URL_OPEN_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    if (typeof payload !== "string") throw new Error("External URL must be an HTTP(S) address.");
    const decision = evaluateExternalUrlTarget(
      { projectId: "gui", allowedRoots: [services.rootDir], allowedUrlOrigins: [], openExternalByDefault: true },
      payload,
    );
    if (decision.action !== "open_external") throw new Error(`External URL rejected: ${decision.reason}.`);
    await services.openExternal(payload);
  });
}

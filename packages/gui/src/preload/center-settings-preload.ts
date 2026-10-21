import {
  CENTER_SETTINGS_CHANNEL,
  type CenterListenerSettings,
  type CenterSettingsApi,
  type CertificateMode,
} from "../api/center-settings-contract.ts";

export function centerSettingsPreloadApi(
  invoke: (channel: string, request: unknown) => Promise<unknown>,
): CenterSettingsApi {
  return {
    listener: () => invoke(CENTER_SETTINGS_CHANNEL, { operation: "listener" }) as Promise<CenterListenerSettings>,
    setCertificate: (input) => invoke(CENTER_SETTINGS_CHANNEL, { operation: "listener-set", ...input }),
    selectFile: (kind: "certificate" | "private-key") =>
      invoke(CENTER_SETTINGS_CHANNEL, { operation: "select-file", kind }) as Promise<string | null>,
  };
}

export type { CertificateMode };

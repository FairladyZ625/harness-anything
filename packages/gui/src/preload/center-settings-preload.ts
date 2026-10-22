import {
  CENTER_SETTINGS_CHANNEL,
  type CenterSettingsApi,
  type CertificateMode,
} from "../api/center-settings-contract.ts";

export function centerSettingsPreloadApi(
  invoke: (channel: string, request: unknown) => Promise<unknown>,
): CenterSettingsApi {
  return {
    listener: () =>
      invoke(CENTER_SETTINGS_CHANNEL, { operation: "listener" }) as ReturnType<CenterSettingsApi["listener"]>,
    externalAddress: () =>
      invoke(CENTER_SETTINGS_CHANNEL, { operation: "external-address" }) as ReturnType<
        CenterSettingsApi["externalAddress"]
      >,
    setExternalAddress: (input) =>
      invoke(CENTER_SETTINGS_CHANNEL, { operation: "external-address-set", ...input }) as ReturnType<
        CenterSettingsApi["setExternalAddress"]
      >,
    setCertificate: (input) =>
      invoke(CENTER_SETTINGS_CHANNEL, { operation: "listener-set", ...input }) as ReturnType<
        CenterSettingsApi["setCertificate"]
      >,
    selectFile: (kind: "certificate" | "private-key") =>
      invoke(CENTER_SETTINGS_CHANNEL, { operation: "select-file", kind }) as Promise<string | null>,
  };
}

export type { CertificateMode };

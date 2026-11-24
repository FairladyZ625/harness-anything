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
    fleetStatus: () =>
      invoke(CENTER_SETTINGS_CHANNEL, { operation: "fleet-status" }) as ReturnType<CenterSettingsApi["fleetStatus"]>,
    startCenter: (input) =>
      invoke(CENTER_SETTINGS_CHANNEL, { operation: "center-start", ...input }) as ReturnType<
        CenterSettingsApi["startCenter"]
      >,
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
    centerSwitch: (input) =>
      invoke(CENTER_SETTINGS_CHANNEL, { operation: "center-switch", ...input }) as ReturnType<
        NonNullable<CenterSettingsApi["centerSwitch"]>
      >,
    promoteFromEdge: (input) =>
      invoke(CENTER_SETTINGS_CHANNEL, { operation: "promote-from-edge", ...input }) as ReturnType<
        NonNullable<CenterSettingsApi["promoteFromEdge"]>
      >,
    edgeLocalState: (input) =>
      invoke(CENTER_SETTINGS_CHANNEL, { operation: "edge-local-state", ...input }) as ReturnType<
        NonNullable<CenterSettingsApi["edgeLocalState"]>
      >,
  };
}

export type { CertificateMode };

export const CENTER_SETTINGS_CHANNEL = "harness:center:settings";

export type CertificateMode = "self-signed" | "domain" | "internal-ca";

export interface CenterListenerSettings {
  readonly ok: true;
  readonly command: "rbac-listener";
  readonly listener: {
    readonly address: string;
    readonly hostname: string;
    readonly port: number;
    readonly certificateFile: string;
  } | null;
  readonly certificateMode: CertificateMode;
  readonly version: string;
}

export type CenterSettingsReply<T> =
  | T
  | {
      readonly ok: false;
      readonly code: string;
      readonly rejectionExplanation?: string;
    };

/** The fleet center service read (`daemon.fleet.center.read`): the live listener flag plus the saved start parameters. */
export interface CenterFleetStatus {
  readonly ok: true;
  readonly running: boolean;
  readonly port: number | null;
  readonly bind: string | null;
  readonly externalUrl: string | null;
  readonly repoId: string | null;
  readonly quotaBytes: number | null;
  readonly certificateSource: "login-listener" | "explicit" | null;
}

/**
 * One fleet center start. The TLS certificate is deliberately absent: the daemon reuses the
 * login service listener certificate when the start carries no pair, so no key path is ever
 * typed, stored, or displayed here.
 */
export interface CenterStartInput {
  readonly port: number;
  readonly repoId: string;
  readonly quotaBytes: number;
  readonly bind: string;
  readonly externalUrl?: string;
}

export interface CenterSettingsApi {
  readonly listener: () => Promise<CenterSettingsReply<CenterListenerSettings>>;
  readonly fleetStatus: () => Promise<CenterSettingsReply<CenterFleetStatus>>;
  readonly startCenter: (input: CenterStartInput) => Promise<
    CenterSettingsReply<{
      readonly ok: true;
      readonly port?: number;
      readonly externalAddressWarning?: string;
    }>
  >;
  readonly externalAddress: () => Promise<
    CenterSettingsReply<{ readonly ok: true; readonly externalUrl: string | null }>
  >;
  readonly setExternalAddress: (input: { readonly externalUrl: string }) => Promise<
    CenterSettingsReply<{
      readonly ok: true;
      readonly externalUrl: string;
      readonly warning?: string | null;
    }>
  >;
  readonly setCertificate: (input: {
    readonly expectedVersion: string;
    readonly certificateMode: CertificateMode;
    readonly hostname?: string;
    readonly listenAddress?: string;
    readonly port?: number;
    readonly certificateFile?: string;
    readonly certificateKeyFile?: string;
  }) => Promise<CenterSettingsReply<{ readonly ok: true }>>;
  readonly selectFile: (kind: "certificate" | "private-key") => Promise<string | null>;
}

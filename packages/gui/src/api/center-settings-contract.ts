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

export interface CenterSettingsApi {
  readonly listener: () => Promise<CenterSettingsReply<CenterListenerSettings>>;
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

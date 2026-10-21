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

export interface CenterSettingsApi {
  readonly listener: () => Promise<CenterListenerSettings>;
  readonly setCertificate: (input: {
    readonly expectedVersion: string;
    readonly certificateMode: CertificateMode;
    readonly hostname?: string;
    readonly listenAddress?: string;
    readonly port?: number;
    readonly certificateFile?: string;
    readonly certificateKeyFile?: string;
  }) => Promise<unknown>;
  readonly selectFile: (kind: "certificate" | "private-key") => Promise<string | null>;
}

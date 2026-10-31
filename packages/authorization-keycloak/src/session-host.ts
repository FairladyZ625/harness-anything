import type { OidcLoginAuthority, FleetDeviceLoginNotice } from "@harness-anything/kernel";
export interface KeycloakEdgeLogin {
  readonly repoId: string;
  readonly host: string;
  readonly port: number;
  readonly caPath: string;
  readonly servername?: string;
  readonly nodeId: string;
  readonly credential: string;
  readonly loginUrl?: string;
  readonly loginServername?: string;
  readonly loginBrowserUrl?: string;
  readonly loginCertificate?: string;
}
interface FleetTarget {
  readonly hostname: string;
  readonly port: number;
  readonly ca: Buffer;
  readonly servername?: string;
  readonly nodeId: string;
  readonly credential: string;
}
interface Selection {
  readonly issuer: string;
  readonly authority: OidcLoginAuthority;
}
export interface KeycloakSessionHost {
  readonly centers: {
    read(target?: string): Selection | undefined;
    write(target: string | undefined, selection: Selection): void;
  };
  readonly readFleetEdgeConfig: (target: string) => KeycloakEdgeLogin | null;
  readonly readFleetLoginAuthorityClient: (
    target: FleetTarget & { readonly resetSession: boolean },
  ) => Promise<OidcLoginAuthority>;
  readonly reportFleetDeviceLogin: (target: FleetTarget, notice: FleetDeviceLoginNotice) => Promise<void>;
  readonly errorMessageWithCause: (error: unknown) => string;
  readonly rootCaFromCertificateChain: (certificate: string) => string | undefined;
  readonly systemCaCertificates: () => readonly string[];
  readonly probeSystemCaTrust: (fetcher: typeof fetch, ca: readonly string[], url: string) => Promise<boolean>;
  readonly fetchWithTlsCa: (
    fetcher: typeof fetch,
    ca: string | readonly string[],
    input: string | URL,
    init?: RequestInit,
    servername?: string,
  ) => Promise<Response>;
}

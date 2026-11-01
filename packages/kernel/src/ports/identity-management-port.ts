export interface AccessAdminRequest {
  readonly operation?: string;
  readonly rootDir?: string;
  readonly operationId?: string;
  readonly confirm?: boolean;
  readonly force?: boolean;
  readonly groupId?: string;
  readonly displayName?: string;
  readonly scopes?: readonly unknown[];
  readonly composites?: readonly unknown[];
  readonly expectedVersion?: string;
  readonly personId?: string;
  readonly username?: string;
  readonly email?: string;
  readonly repoIds?: readonly unknown[];
  readonly groupIds?: readonly unknown[];
  readonly nodeLabel?: string;
  readonly resource?: string;
  readonly sessionLifetimeSeconds?: number;
  readonly teamId?: string;
  readonly teamName?: string;
  readonly nodeId?: string;
  readonly systemName?: string;
  readonly platform?: string;
  readonly transport?: "direct" | "ssh-reverse";
  readonly sshTarget?: string;
  readonly credentialFile?: string;
  readonly joinId?: string;
  readonly requestId?: string;
  readonly requestVersion?: number;
  readonly decision?: "approve" | "reject";
  readonly rationale?: string;
}

export interface ManagedRbacRequest extends AccessAdminRequest {
  readonly repoId?: string;
  readonly rootDir?: string;
  /** edge-join: where the remote-edge mirror lives; defaults to ~/harness-edge/<repoId>. */
  readonly workspaceRoot?: string;
  /** edge-join: persistent replica quota in bytes; omitted to derive from the target volume. */
  readonly quotaBytes?: number;
  readonly link?: string;
  readonly operation?: string;
  readonly mode?: "managed" | "external";
  readonly url?: string;
  readonly realm?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly loginUrl?: string;
  readonly loginRealm?: string;
  readonly loginClientId?: string;
  readonly backupDir?: string;
  readonly redirectUri?: string;
  readonly code?: string;
  readonly state?: string;
  readonly username?: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly password?: string;
  readonly personId?: string;
  readonly listenAddress?: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly certificateFile?: string;
  readonly certificateKeyFile?: string;
  readonly certificateMode?: CertificateMode;
}

export type CertificateMode = "self-signed" | "domain" | "internal-ca";

/**
 * Where edge nodes reach the managed Keycloak: HTTPS on one address of this machine, under the
 * hostname its certificate names. Without one, Keycloak serves loopback HTTP only.
 */
export interface ManagedRbacListener {
  readonly address: string;
  readonly hostname: string;
  readonly port: number;
  readonly certificateFile: string;
  readonly certificateKeyFile: string;
}

export interface IdentityManagementPort {
  run(request: ManagedRbacRequest): Promise<Record<string, unknown>>;
  resume(): Promise<void>;
  loginListenerCertificate(): { readonly certificateFile: string; readonly certificateKeyFile: string } | null;
  start(): Promise<void>;
  stop(): Promise<Record<string, unknown>>;
  health(): Promise<Record<string, unknown>>;
}

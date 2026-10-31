import type { ComponentType } from "react";
import type { AccessAdminApi } from "./access-admin-contract.ts";
import type { OidcAuthApi } from "./oidc-auth-contract.ts";

export interface AuthorizationUserIdentityProps {
  readonly personId: string;
}

export interface AuthorizationLoginProps {
  readonly auth: OidcAuthApi;
  readonly repoId?: string;
  readonly rootDir?: string;
}

export interface AuthorizationAccessControlProps extends AuthorizationLoginProps {
  readonly access: AccessAdminApi;
  readonly repositories: readonly {
    readonly repoId: string;
    readonly displayName: string;
    readonly mode?: "local" | "remote-proxy" | "remote-center" | "remote-edge";
  }[];
}

/** Renderer component slots a host application can embed or replace independently. */
export interface AuthorizationUiComponents {
  readonly UserIdentity?: ComponentType<AuthorizationUserIdentityProps>;
  readonly Login?: ComponentType<AuthorizationLoginProps>;
  readonly AccessControl?: ComponentType<AuthorizationAccessControlProps>;
}

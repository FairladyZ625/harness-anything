export const OIDC_LOGIN_CHANNEL = "harness:auth:login";
export const OIDC_LOGOUT_CHANNEL = "harness:auth:logout";
export const OIDC_STATUS_CHANNEL = "harness:auth:status";
export const OIDC_BINDING_STATUS_CHANNEL = "harness:auth:binding-status";
export const OIDC_OPEN_CONSOLE_CHANNEL = "harness:auth:open-console";
export const OIDC_CONFIGURE_CHANNEL = "harness:auth:configure";
export const OIDC_BOOTSTRAP_STATUS_CHANNEL = "harness:auth:bootstrap-status";
export const OIDC_BOOTSTRAP_ADMIN_CHANNEL = "harness:auth:bootstrap-admin";

export type RbacBindingInput =
  | { readonly mode: "managed" }
  | { readonly mode: "external"; readonly url: string; readonly realm: string; readonly clientId: string };

export interface BootstrapAdminInput {
  readonly username: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
  readonly personId: string;
}

export interface OidcAuthApi {
  readonly login: (repoId?: string) => Promise<unknown>;
  readonly logout: (repoId?: string) => Promise<unknown>;
  readonly status: (repoId?: string) => Promise<unknown>;
  readonly bindingStatus: (repoId?: string) => Promise<unknown>;
  readonly openConsole: (repoId?: string) => Promise<unknown>;
  readonly configure: (input: RbacBindingInput, repoId?: string) => Promise<unknown>;
  readonly bootstrapStatus: (repoId?: string) => Promise<unknown>;
  readonly bootstrapAdmin: (input: BootstrapAdminInput) => Promise<unknown>;
}

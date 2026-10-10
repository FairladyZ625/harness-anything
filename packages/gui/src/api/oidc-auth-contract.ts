export const OIDC_LOGIN_URL_CHANNEL = "harness:auth:login-url";
export const OIDC_CANCEL_LOGIN_CHANNEL = "harness:auth:cancel-login";
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
  | {
      readonly mode: "external";
      readonly url: string;
      readonly realm: string;
      readonly clientId: string;
      readonly clientSecret: string;
    };

export interface BootstrapAdminInput {
  readonly username: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
  readonly personId: string;
}

/**
 * The page an embedded sign-in shows: the provider's authorization URL, plus the main process's
 * one-shot webview grant token when the sign-in has its own isolated login partition (a
 * daemon-configured self-signed HTTPS listener). The token is opaque and names no session.
 */
export interface EmbeddedLoginPage {
  readonly url: string;
  readonly partitionToken?: string;
}

export interface OidcAuthApi {
  readonly login: (
    repoId: string | undefined,
    openBrowser: (page: EmbeddedLoginPage) => void,
    userCode?: string,
  ) => Promise<unknown>;
  readonly cancelLogin: () => Promise<unknown>;
  readonly logout: (repoId?: string) => Promise<unknown>;
  readonly status: (repoId?: string) => Promise<unknown>;
  readonly bindingStatus: (repoId?: string) => Promise<unknown>;
  readonly openConsole: (repoId?: string) => Promise<unknown>;
  readonly configure: (input: RbacBindingInput, repoId?: string) => Promise<unknown>;
  readonly bootstrapStatus: (repoId?: string) => Promise<unknown>;
  readonly bootstrapAdmin: (input: BootstrapAdminInput) => Promise<unknown>;
}

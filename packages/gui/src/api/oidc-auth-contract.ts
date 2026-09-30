export const OIDC_LOGIN_CHANNEL = "harness:auth:login";
export const OIDC_LOGOUT_CHANNEL = "harness:auth:logout";
export const OIDC_STATUS_CHANNEL = "harness:auth:status";

export interface OidcAuthApi {
  readonly login: () => Promise<unknown>;
  readonly logout: () => Promise<unknown>;
  readonly status: () => Promise<unknown>;
}

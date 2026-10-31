import {
  KeycloakPolicyAdapter,
  keycloakLoginAttributes,
  keycloakLoginMappers,
  type KeycloakPolicyAdapterConfig,
} from "@harness-anything/authorization-keycloak";
import type { AuthorizationProvider } from "@harness-anything/kernel";

/** Default implementation selection. Only process/service composition roots import this module. */
export const createAuthorizationProvider = (
  config: KeycloakPolicyAdapterConfig,
  fetchPort?: typeof fetch,
  refreshAdminAccessToken?: (rejectedAccessToken: string) => Promise<string>,
): AuthorizationProvider => new KeycloakPolicyAdapter(config, fetchPort, refreshAdminAccessToken);
export { keycloakLoginAttributes, keycloakLoginMappers };

import { OidcSessionService } from "@harness-anything/authorization-keycloak";
import type { IdentitySessionPort, OidcSessionPorts } from "@harness-anything/kernel";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { reportFleetDeviceLogin, readFleetLoginAuthorityClient } from "./fleet/peer.ts";
import { oidcCenterSelections } from "./oidc-center-selection.ts";
import { errorMessageWithCause } from "./error-cause.ts";
import {
  fetchWithTlsCa,
  probeSystemCaTrust,
  rootCaFromCertificateChain,
  systemCaCertificates,
} from "./tls-ca-certificate.ts";
export function createIdentitySession(userRoot: string, ports: Partial<OidcSessionPorts> = {}): IdentitySessionPort {
  return new OidcSessionService(
    userRoot,
    {
      centers: oidcCenterSelections(userRoot),
      readFleetEdgeConfig,
      reportFleetDeviceLogin,
      readFleetLoginAuthorityClient,
      errorMessageWithCause,
      fetchWithTlsCa,
      probeSystemCaTrust,
      rootCaFromCertificateChain,
      systemCaCertificates,
    },
    ports,
  );
}

import { ManagedRbacService, type ManagedRbacPorts } from "@harness-anything/authorization-keycloak";
import { runProcessText, runProcessTextAsync, runProcessExitAsync } from "./process-port.ts";
import { mapListenerBindError, validateCertificateNames } from "./tls-listener-admission.ts";
export function createIdentityManagement(userRoot: string, ports: Partial<ManagedRbacPorts> = {}) {
  return new ManagedRbacService(
    userRoot,
    { runProcessText, runProcessTextAsync, runProcessExitAsync, mapListenerBindError, validateCertificateNames },
    ports,
  );
}

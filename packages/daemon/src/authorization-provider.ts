import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defaultAssets } from "@harness-anything/preset/internal/preset-resolver-common";
import {
  KeycloakPolicyAdapter,
  keycloakLoginAttributes,
  keycloakLoginMappers,
  type KeycloakPolicyAdapterConfig,
} from "@harness-anything/authorization-keycloak";
import {
  artifactActionPolicyActionsForDefinition,
  readDaemonRegistry,
  type AuthorizationProvider,
} from "@harness-anything/kernel";

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
    { readArtifactActionScopes: readArtifactActionScopes(userRoot), ...ports },
  );
}

/**
 * Policy sync runs outside the writer process, so it rebuilds the runtime Artifact scope inventory
 * from the accepted canonical declarations: the bundled default plus each registered repository's
 * materialized vertical.json. The writer's process-local registry is never assumed to be visible.
 */
export function readArtifactActionScopes(userRoot: string): () => Promise<readonly string[]> {
  return async () => {
    const files = new Set<string>([path.join(defaultAssets, "vertical.json")]),
      scopes = new Set<string>();
    for (const repo of readDaemonRegistry({ userRoot }).repos)
      if (repo.canonicalRoot !== null) {
        files.add(path.join(repo.canonicalRoot, "vertical.json"));
        files.add(path.join(repo.canonicalRoot, "harness", "vertical.json"));
      }
    for (const file of files)
      if (existsSync(file))
        for (const scope of artifactActionPolicyActionsForDefinition(JSON.parse(readFileSync(file, "utf8"))))
          scopes.add(scope);
    return [...scopes].sort();
  };
}

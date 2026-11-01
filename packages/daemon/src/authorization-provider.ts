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
  artifactActionPoliciesByKind,
  decodeVerticalDefinition,
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
    const readDefinition = (file: string) => {
        const raw = JSON.parse(readFileSync(file, "utf8")) as unknown,
          envelope =
            raw !== null && typeof raw === "object" && "schema" in raw && "definition" in raw
              ? (raw as { readonly schema?: unknown; readonly definition?: unknown })
              : null;
        return decodeVerticalDefinition(
          envelope?.schema === "repository-vertical-declaration/v1" ? envelope.definition : raw,
        );
      },
      seed = readDefinition(path.join(defaultAssets, "vertical.json")),
      repos = readDaemonRegistry({ userRoot }).repos.filter(
        (repo): repo is typeof repo & { readonly canonicalRoot: string } => repo.canonicalRoot !== null,
      ),
      // One view per registered repository. A repository that has not materialized a declaration
      // falls back to the bundled seed; a repository that has one owns its own active/retired state.
      views = repos.length
        ? repos.map((repo) => {
            const file = [
              path.join(repo.canonicalRoot, "vertical.json"),
              path.join(repo.canonicalRoot, "harness", "vertical.json"),
            ].find((candidate) => existsSync(candidate));
            return file === undefined ? seed : readDefinition(file);
          })
        : [seed],
      seedByKind = artifactActionPoliciesByKind(seed),
      viewMaps = views.map((view) => artifactActionPoliciesByKind(view)),
      kinds = new Set([...seedByKind.keys(), ...viewMaps.flatMap((map) => [...map.keys()])]),
      byKind = new Map<string, readonly string[]>();
    for (const kind of kinds) {
      let active: readonly string[] | null = null,
        retired: readonly string[] | null = null;
      for (const map of viewMaps) {
        const scopes = map.get(kind) ?? seedByKind.get(kind);
        if (scopes === undefined) continue;
        if (scopes.includes(`${kind}/import`)) {
          active = scopes;
          break;
        }
        retired ??= scopes;
      }
      // A kind stays grantable if any repository keeps it active; only an all-retired set removes
      // import. Registration order can never let one repository revoke another's active kind (F8).
      if (active !== null) byKind.set(kind, active);
      else if (retired !== null) byKind.set(kind, retired);
    }
    return [...byKind.values()].flat().sort();
  };
}

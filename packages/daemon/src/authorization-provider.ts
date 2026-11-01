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
  BuiltinIdentityManagement,
  BuiltinIdentitySession,
  BuiltinPolicyAdapter,
  userRootFromBuiltinUrl,
} from "@harness-anything/authorization-builtin";
import {
  artifactActionPoliciesByKind,
  decodeVerticalDefinition,
  readDaemonRegistry,
  type AuthorizationProvider,
} from "@harness-anything/kernel";

/** Default implementation selection. Only process/service composition roots import this module. */
export type AuthorizationProviderConfig = KeycloakPolicyAdapterConfig & {
  readonly mode?: "builtin" | "managed" | "external";
  readonly userRoot?: string;
};

export const createAuthorizationProvider = (
  config: AuthorizationProviderConfig,
  fetchPort?: typeof fetch,
  refreshAdminAccessToken?: (rejectedAccessToken: string) => Promise<string>,
): AuthorizationProvider => {
  const userRoot = config.userRoot ?? userRootFromBuiltinUrl(config.url);
  // An explicit external/managed selection is authoritative even when a stale
  // builtin:// URL is still present in a caller's config object.  The URL is
  // only an implicit builtin selector for the default (mode omitted) path.
  return config.mode === "builtin" || (config.mode === undefined && userRoot)
    ? new BuiltinPolicyAdapter({
        userRoot: userRoot ?? process.env.HARNESS_USER_ROOT ?? process.cwd(),
        readArtifactActionScopes: readArtifactActionScopes(userRoot ?? process.env.HARNESS_USER_ROOT ?? process.cwd()),
      })
    : new KeycloakPolicyAdapter(config, fetchPort, refreshAdminAccessToken);
};
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
  const mode = readProviderMode(userRoot);
  const external = new OidcSessionService(
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
  return mode === "builtin"
    ? new BuiltinIdentitySession(userRoot, readArtifactActionScopes(userRoot), external)
    : external;
}

import { ManagedRbacService, type ManagedRbacPorts } from "@harness-anything/authorization-keycloak";
import { runProcessText, runProcessTextAsync, runProcessExitAsync } from "./process-port.ts";
import { mapListenerBindError, validateCertificateNames } from "./tls-listener-admission.ts";
export function createIdentityManagement(userRoot: string, ports: Partial<ManagedRbacPorts> = {}) {
  const mode = readProviderMode(userRoot);
  const managed = new ManagedRbacService(
    userRoot,
    { runProcessText, runProcessTextAsync, runProcessExitAsync, mapListenerBindError, validateCertificateNames },
    { readArtifactActionScopes: readArtifactActionScopes(userRoot), ...ports },
  );
  return mode === "builtin" ? new BuiltinIdentityManagement(userRoot, managed) : managed;
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
function readProviderMode(userRoot: string): "builtin" | "managed" | "external" | "legacy" {
  const file = path.join(userRoot, "rbac", "config.json");
  // A pre-provider edge root has no selector but carries its durable fleet binding. Keep
  // resolving that root through the Keycloak implementation until the operator writes an
  // explicit mode; a brand-new local root remains builtin by default.
  if (!existsSync(file))
    return existsSync(path.join(userRoot, "fleet-edge.json")) ||
      existsSync(path.join(userRoot, "rbac", "oidc-session.json")) ||
      existsSync(path.join(userRoot, "rbac", "oidc-sessions")) ||
      existsSync(path.join(userRoot, "rbac", "oidc-centers"))
      ? "legacy"
      : "builtin";
  try {
    const config = JSON.parse(readFileSync(file, "utf8")) as { readonly mode?: unknown };
    return config.mode === "builtin" || config.mode === "managed" || config.mode === "external"
      ? config.mode
      : "legacy";
  } catch {
    return "legacy";
  }
}

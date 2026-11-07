import { readFileSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, type OidcLoginAuthority } from "@harness-anything/kernel";
import { fetchWithTlsCa } from "../tls-ca-certificate.ts";
import { systemCaCertificates } from "../tls-ca-certificate.ts";
import { readFleetLoginAuthorityClient } from "./peer.ts";
import type { FleetEdgeConfig } from "../client/fleet-edge-config.ts";

type ReplicaAccessConfig = Pick<
  FleetEdgeConfig,
  | "host"
  | "port"
  | "caPath"
  | "servername"
  | "loginUrl"
  | "loginRealm"
  | "loginServername"
  | "loginCertificate"
  | "nodeId"
  | "credential"
>;

/** Creates a reader for replica admission, preferring the current user session and then the node identity. */
export function createFleetReplicaAccessTokenReader(input: {
  readonly config: ReplicaAccessConfig;
  readonly workspaceRoot: string;
  readonly readUserAccessToken: () => Promise<string | undefined>;
}): () => Promise<string | undefined> {
  let replicaLoginAuthority: OidcLoginAuthority | null | undefined;
  return async () => {
    let userToken: string | undefined;
    try {
      userToken = await input.readUserAccessToken();
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code !== "authentication_required") throw error;
      consumeKnownError(error);
    }
    if (userToken) return userToken;
    if (replicaLoginAuthority === undefined) {
      const centerAuthority =
        input.config.loginUrl && !input.config.loginRealm
          ? await readFleetLoginAuthorityClient({
              hostname: input.config.host,
              port: input.config.port,
              ca: readFileSync(
                path.isAbsolute(input.config.caPath)
                  ? input.config.caPath
                  : path.resolve(input.workspaceRoot, input.config.caPath),
              ),
              ...(input.config.servername ? { servername: input.config.servername } : {}),
              nodeId: input.config.nodeId,
              credential: input.config.credential,
            })
          : null;
      replicaLoginAuthority = resolveFleetReplicaAuthority(input.config, centerAuthority);
    }
    const loginAuthority = replicaLoginAuthority;
    if (!loginAuthority) return undefined;
    return requestFleetReplicaToken({
      ...loginAuthority,
      nodeId: input.config.nodeId,
      credential: input.config.credential,
      ca: loginAuthority.certificate ?? input.config.loginCertificate ?? systemCaCertificates(),
      ...(input.config.loginServername ? { servername: input.config.loginServername } : {}),
    });
  };
}

/** Resolves the machine-token authority while repairing configs written before loginRealm existed. */
export function resolveFleetReplicaAuthority(
  config: Pick<FleetEdgeConfig, "loginUrl" | "loginRealm" | "nodeId" | "loginCertificate" | "loginServername">,
  centerAuthority: OidcLoginAuthority | null,
): OidcLoginAuthority | null {
  if (!config.loginUrl) return null;
  const clientId = `harness-node-${config.nodeId}`;
  if (!config.loginRealm) return centerAuthority?.clientId === clientId ? centerAuthority : null;
  return {
    url: config.loginUrl,
    realm: config.loginRealm,
    clientId,
    ...(config.loginCertificate ? { certificate: config.loginCertificate } : {}),
    ...(config.loginServername ? { servername: config.loginServername } : {}),
  };
}

export async function requestFleetReplicaToken(
  input: {
    readonly url: string;
    readonly realm: string;
    readonly nodeId: string;
    readonly credential: string;
    readonly ca: string | readonly string[];
    readonly servername?: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const authority = new URL(input.url);
  if (authority.protocol !== "https:" || authority.username !== "" || authority.password !== "")
    throw Object.assign(new Error("The Fleet identity authority must be HTTPS without embedded credentials."), {
      code: "fleet_replica_token_unavailable",
    });
  const endpoint = `${authority.toString().replace(/\/$/u, "")}/realms/${encodeURIComponent(input.realm)}/protocol/openid-connect/token`,
    response = await fetchWithTlsCa(
      fetcher,
      input.ca,
      endpoint,
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: `harness-node-${input.nodeId}`,
          client_secret: input.credential,
        }),
        signal: AbortSignal.timeout(10_000),
      },
      input.servername,
    );
  if (!response.ok)
    throw Object.assign(
      new Error(`The Fleet identity authority rejected the node credential (HTTP ${response.status}).`),
      { code: "fleet_replica_token_unavailable" },
    );
  const payload = (await response.json()) as { readonly access_token?: unknown };
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0)
    throw Object.assign(new Error("The Fleet identity authority returned no access token."), {
      code: "fleet_replica_token_unavailable",
    });
  return payload.access_token;
}

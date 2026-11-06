import { fetchWithTlsCa } from "../tls-ca-certificate.ts";
import type { FleetEdgeConfig } from "../client/fleet-edge-config.ts";
import type { OidcLoginAuthority } from "@harness-anything/kernel";

/** Resolves the machine-token authority while repairing configs written before loginRealm existed. */
export function resolveFleetReplicaAuthority(
  config: Pick<FleetEdgeConfig, "loginUrl" | "loginRealm" | "nodeId">,
  discovery: (nodeId: string) => OidcLoginAuthority | null,
): OidcLoginAuthority | null {
  if (!config.loginUrl) return null;
  const discovered = config.loginRealm ? null : discovery(config.nodeId),
    url = config.loginUrl,
    realm = config.loginRealm ?? discovered?.realm;
  return url && realm
    ? {
        url,
        realm,
        clientId: discovered?.clientId ?? `harness-node-${config.nodeId}`,
        ...(discovered?.certificate ? { certificate: discovered.certificate } : {}),
        ...(discovered?.servername ? { servername: discovered.servername } : {}),
      }
    : null;
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

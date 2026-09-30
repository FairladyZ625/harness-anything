import {
  actionDeclarations,
  assertAcyclicPolicyGroups,
  deriveBasePolicyGroups,
  encodeAuthorizationResource,
  type AuthorizationResource,
  type PolicyGroup,
} from "@harness-anything/kernel";

export interface KeycloakPolicyAdapterConfig {
  readonly url: string;
  readonly realm: string;
  readonly resourceServerClientId: string;
}

export interface KeycloakPolicySyncReceipt {
  readonly scopeCount: number;
  readonly groupCount: number;
}

export interface KeycloakPermissionDecision {
  readonly outcome: "allowed" | "denied";
  readonly reasonCode: "keycloak_allowed" | "keycloak_denied" | "unknown_scope" | "keycloak_unavailable";
  readonly resource: string;
  readonly scope: string;
}

type FetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type KeycloakRole = {
  readonly id: string;
  readonly name: string;
  readonly clientRole?: boolean;
  readonly containerId?: string;
};
type NamedRepresentation = { readonly id?: unknown; readonly name?: unknown };

export class KeycloakPolicyAdapter {
  readonly #config: KeycloakPolicyAdapterConfig;
  readonly #fetch: FetchPort;
  readonly #knownScopes = new Set(actionDeclarations.map((item) => item.policyAction));

  constructor(config: KeycloakPolicyAdapterConfig, fetchPort: FetchPort = fetch) {
    this.#config = config;
    this.#fetch = fetchPort;
  }

  async syncBasePolicy(adminAccessToken: string): Promise<KeycloakPolicySyncReceipt> {
    const groups = deriveBasePolicyGroups();
    assertAcyclicPolicyGroups(groups);
    const clientUuid = await this.#clientUuid(adminAccessToken),
      scopesPath = `/clients/${clientUuid}/authz/resource-server/scope`,
      rolesPath = `/clients/${clientUuid}/roles`,
      scopeByName = await this.#collection(adminAccessToken, scopesPath),
      roleByName = await this.#collection(adminAccessToken, rolesPath);
    for (const scope of [...this.#knownScopes].sort())
      await this.#ensure(adminAccessToken, scopesPath, scopeByName, scope, {
        name: scope,
      });
    for (const group of groups)
      await this.#ensure(adminAccessToken, rolesPath, roleByName, group.id, {
        name: group.id,
        description: `Harness Base policy group ${group.id}; generated from ActionDeclaration policyTier.`,
      });
    for (const group of groups) {
      const role = roleByName.get(group.id);
      if (!role) throw new Error(`Keycloak did not return generated Base role ${group.id}.`);
      const composites = group.composites.map((name) => roleByName.get(name));
      if (composites.some((item) => item === undefined)) throw new Error(`Keycloak Base role composite is missing.`);
      if (composites.length)
        await this.#request(
          adminAccessToken,
          `/clients/${clientUuid}/roles/${encodeURIComponent(role.name)}/composites`,
          {
            method: "POST",
            body: JSON.stringify(composites),
          },
        );
    }
    const rolePoliciesPath = `/clients/${clientUuid}/authz/resource-server/policy/role`,
      policyByName = await this.#collection(adminAccessToken, rolePoliciesPath);
    for (const group of groups.filter((item) => item.id !== "viewer")) {
      const role = roleByName.get(group.id)!;
      await this.#ensure(adminAccessToken, rolePoliciesPath, policyByName, `base-${group.id}`, {
        name: `base-${group.id}`,
        type: "role",
        logic: "POSITIVE",
        decisionStrategy: "UNANIMOUS",
        roles: [{ id: role.id, required: true }],
      });
    }
    const permissionsPath = `/clients/${clientUuid}/authz/resource-server/permission/scope`,
      permissionByName = await this.#collection(adminAccessToken, permissionsPath);
    for (const group of groups) {
      const policyId = policyByName.get(`base-${group.id}`)?.id;
      if (group.scopes.length && !policyId) throw new Error(`Keycloak Base policy ${group.id} is missing.`);
      for (const scope of group.scopes) {
        const scopeId = scopeByName.get(scope)?.id;
        if (!scopeId) throw new Error(`Keycloak action scope ${scope} is missing after sync.`);
        await this.#ensure(adminAccessToken, permissionsPath, permissionByName, `base-${group.id}-${scope}`, {
          name: `base-${group.id}-${scope}`,
          type: "scope",
          logic: "POSITIVE",
          decisionStrategy: "UNANIMOUS",
          scopes: [scopeId],
          policies: [policyId!],
        });
      }
    }
    return Object.freeze({ scopeCount: this.#knownScopes.size, groupCount: groups.length });
  }

  validatePolicyGroups(groups: readonly PolicyGroup[]): void {
    assertAcyclicPolicyGroups(groups);
    for (const group of groups)
      for (const scope of group.scopes)
        if (!this.#knownScopes.has(scope)) throw new Error(`Unknown Keycloak action scope ${scope}.`);
  }

  async authorize(input: {
    readonly userAccessToken: string;
    readonly action: string;
    readonly resource: AuthorizationResource;
  }): Promise<KeycloakPermissionDecision> {
    const resource = encodeAuthorizationResource(input.resource);
    if (!this.#knownScopes.has(input.action))
      return Object.freeze({ outcome: "denied", reasonCode: "unknown_scope", resource, scope: input.action });
    const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:uma-ticket",
        audience: this.#config.resourceServerClientId,
        permission: `${resource}#${input.action}`,
        response_mode: "decision",
      }),
      response = await this.#fetch(this.#realmUrl("/protocol/openid-connect/token"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.userAccessToken}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
    if (!response.ok)
      return Object.freeze({ outcome: "denied", reasonCode: "keycloak_denied", resource, scope: input.action });
    const result = (await response.json()) as { readonly result?: unknown };
    return Object.freeze({
      outcome: result.result === true ? "allowed" : "denied",
      reasonCode: result.result === true ? "keycloak_allowed" : "keycloak_denied",
      resource,
      scope: input.action,
    });
  }

  async #clientUuid(token: string): Promise<string> {
    const clients = await this.#json<readonly { readonly id?: unknown }[]>(
      token,
      `/clients?clientId=${encodeURIComponent(this.#config.resourceServerClientId)}`,
    );
    const id = clients[0]?.id;
    if (typeof id !== "string" || !id) throw new Error(`Keycloak resource-server client is missing.`);
    return id;
  }

  async #collection(token: string, path: string): Promise<Map<string, KeycloakRole>> {
    const entries = new Map<string, KeycloakRole>();
    for (let first = 0; ; first += 100) {
      const page = await this.#json<NamedRepresentation[]>(token, `${path}?first=${first}&max=100`);
      for (const item of page)
        if (typeof item.name === "string" && typeof item.id === "string")
          entries.set(item.name, { ...item, name: item.name, id: item.id });
      if (page.length < 100) return entries;
    }
  }

  async #ensure(
    token: string,
    collection: string,
    entries: Map<string, KeycloakRole>,
    name: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (entries.has(name)) return;
    const response = await this.#request(token, collection, { method: "POST", body: JSON.stringify(body) });
    // Client-role POST returns a Location containing the name, not the role id.
    const item = collection.endsWith("/roles")
      ? await this.#json<NamedRepresentation>(token, `${collection}/${encodeURIComponent(name)}`)
      : ((await response.json()) as NamedRepresentation);
    if (typeof item.id !== "string" || !item.id) throw new Error(`Keycloak did not return an id for ${name}.`);
    entries.set(name, { ...item, id: item.id, name });
  }

  async #json<T>(token: string, path: string): Promise<T> {
    const response = await this.#request(token, path);
    return (await response.json()) as T;
  }

  async #request(token: string, path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.#fetch(this.#adminUrl(path), {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    });
    if (!response.ok) throw new Error(`Keycloak Admin REST ${path} returned HTTP ${response.status}.`);
    return response;
  }

  #adminUrl(path: string): string {
    return `${this.#config.url.replace(/\/$/u, "")}/admin/realms/${encodeURIComponent(this.#config.realm)}${path}`;
  }

  #realmUrl(path: string): string {
    return `${this.#config.url.replace(/\/$/u, "")}/realms/${encodeURIComponent(this.#config.realm)}${path}`;
  }
}

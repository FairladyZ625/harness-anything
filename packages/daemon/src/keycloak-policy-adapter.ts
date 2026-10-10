import {
  actionDeclarations,
  assertAcyclicPolicyGroups,
  decodeAuthorizationResource,
  deriveBasePolicyGroups,
  effectivePolicyGroupScopes,
  encodeAuthorizationResource,
  type AuthorizationResource,
  type PolicyGroup,
} from "@harness-anything/kernel";
import { keycloakLoginAttributes, keycloakLoginMappers } from "./keycloak-login-client.ts";

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

export interface KeycloakPolicyGroup extends PolicyGroup {
  readonly displayName: string;
}

/** One `(policy group, resource)` grant and the Keycloak users holding it. */
export interface KeycloakGrant {
  readonly groupId: string;
  readonly resource: string;
  readonly userIds: readonly string[];
}

/** One fleet node: a confidential Keycloak client whose single owner attribute names the person it acts for. */
export interface KeycloakNode {
  readonly nodeId: string;
  readonly personId: string;
}

type FetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type NodeClient = {
  readonly id: string;
  readonly clientId: string;
  readonly attributes?: Readonly<Record<string, string>>;
};
type KeycloakRole = {
  readonly id: string;
  readonly name: string;
  readonly clientRole?: boolean;
  readonly containerId?: string;
};
type NamedRepresentation = { readonly id?: unknown; readonly name?: unknown };
type RoleRepresentation = KeycloakRole & {
  readonly description?: string;
  readonly attributes?: Readonly<Record<string, readonly string[]>>;
};

// Keycloak keeps policies and permissions in one name space, so the two halves of a grant differ by prefix.
const grantUsersPrefix = "grant-users:",
  grantPermissionPrefix = "grant:",
  personAttribute = "harness_person_id",
  nodeClientPrefix = "harness-node-",
  customGroupAttribute = "harness_policy_group",
  groupScopesAttribute = "harness_scopes";

export class KeycloakPolicyAdapter {
  readonly #config: KeycloakPolicyAdapterConfig;
  readonly #fetch: FetchPort;
  readonly #knownScopes = new Set(actionDeclarations.map((item) => item.policyAction));

  constructor(config: KeycloakPolicyAdapterConfig, fetchPort: FetchPort = fetch) {
    this.#config = config;
    // Authorization runs inside the repository write queue, so a Keycloak peer that accepts but
    // never answers must release that queue within the same 10s bound runtime credentials use.
    this.#fetch = async (input, init) => {
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 10_000),
        signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
      try {
        return await fetchPort(input, { ...init, signal });
      } finally {
        clearTimeout(timer);
      }
    };
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
    // Keycloak drops user attributes its profile does not declare; grants address people by this one.
    const profile = await this.#json<{ readonly attributes?: readonly { readonly name?: string }[] }>(
      adminAccessToken,
      "/users/profile",
    );
    if (!profile.attributes?.some((attribute) => attribute.name === personAttribute))
      await this.#request(adminAccessToken, "/users/profile", {
        method: "PUT",
        body: JSON.stringify({
          ...profile,
          attributes: [
            ...(profile.attributes ?? []),
            { name: personAttribute, permissions: { view: ["admin"], edit: ["admin"] }, multivalued: false },
          ],
        }),
      });
    // A policy group grants nothing by itself: every permission is bound to the resource it was granted on.
    await this.materializeGrants(adminAccessToken);
    return Object.freeze({ scopeCount: this.#knownScopes.size, groupCount: groups.length });
  }

  validatePolicyGroups(groups: readonly PolicyGroup[]): void {
    assertAcyclicPolicyGroups(groups);
    for (const group of groups)
      for (const scope of group.scopes)
        if (!this.#knownScopes.has(scope)) throw new Error(`Unknown Keycloak action scope ${scope}.`);
  }

  /** Align existing managed login clients as part of the same realm synchronization. */
  async syncLoginClients(adminAccessToken: string): Promise<void> {
    for (const client of await this.#pages<NodeClient>(adminAccessToken, "/clients", "")) {
      if (client.clientId !== "harness-gui" && !client.clientId.startsWith(nodeClientPrefix)) continue;
      const current = await this.#json<Record<string, unknown>>(adminAccessToken, `/clients/${client.id}`);
      await this.#request(adminAccessToken, `/clients/${client.id}`, {
        method: "PUT",
        body: JSON.stringify({
          ...current,
          standardFlowEnabled: true,
          directAccessGrantsEnabled: false,
          redirectUris: ["http://127.0.0.1/*"],
          attributes: { ...client.attributes, ...keycloakLoginAttributes },
          protocolMappers: keycloakLoginMappers(this.#config.resourceServerClientId),
        }),
      });
    }
  }

  /** Base groups come from ActionDeclaration; custom groups are the client roles carrying the group marker. */
  async readPolicyGroups(adminAccessToken: string): Promise<readonly KeycloakPolicyGroup[]> {
    const clientUuid = await this.#clientUuid(adminAccessToken),
      rolesPath = `/clients/${clientUuid}/roles`,
      custom: KeycloakPolicyGroup[] = [];
    for (const role of await this.#pages<RoleRepresentation>(
      adminAccessToken,
      rolesPath,
      "briefRepresentation=false",
    )) {
      if (role.attributes?.[customGroupAttribute]?.[0] !== "custom") continue;
      const composites = await this.#json<readonly RoleRepresentation[]>(
        adminAccessToken,
        `${rolesPath}/${encodeURIComponent(role.name)}/composites`,
      );
      custom.push(
        Object.freeze({
          id: role.name,
          base: false,
          displayName: role.description ?? role.name,
          scopes: Object.freeze([...(role.attributes[groupScopesAttribute] ?? [])].sort()),
          composites: Object.freeze(
            composites
              .filter((item) => item.clientRole === true && item.containerId === clientUuid)
              .map((item) => item.name)
              .sort(),
          ),
        }),
      );
    }
    return Object.freeze([
      ...deriveBasePolicyGroups().map((group) => Object.freeze({ ...group, displayName: group.id })),
      ...custom.sort((left, right) => left.id.localeCompare(right.id)),
    ]);
  }

  async writePolicyGroup(
    adminAccessToken: string,
    group: KeycloakPolicyGroup,
    current: KeycloakPolicyGroup | undefined,
  ): Promise<void> {
    const clientUuid = await this.#clientUuid(adminAccessToken),
      rolesPath = `/clients/${clientUuid}/roles`,
      rolePath = `${rolesPath}/${encodeURIComponent(group.id)}`,
      body = JSON.stringify({
        name: group.id,
        description: group.displayName,
        attributes: { [customGroupAttribute]: ["custom"], [groupScopesAttribute]: group.scopes },
      });
    await this.#request(
      adminAccessToken,
      current ? rolePath : rolesPath,
      current ? { method: "PUT", body } : { method: "POST", body },
    );
    const composite = (name: string) => this.#json<RoleRepresentation>(adminAccessToken, `${rolesPath}/${name}`),
      added = group.composites.filter((name) => !current?.composites.includes(name)),
      removed = (current?.composites ?? []).filter((name) => !group.composites.includes(name));
    if (added.length)
      await this.#request(adminAccessToken, `${rolePath}/composites`, {
        method: "POST",
        body: JSON.stringify(await Promise.all(added.map(composite))),
      });
    if (removed.length)
      await this.#request(adminAccessToken, `${rolePath}/composites`, {
        method: "DELETE",
        body: JSON.stringify(await Promise.all(removed.map(composite))),
      });
  }

  async deletePolicyGroup(adminAccessToken: string, groupId: string): Promise<void> {
    const clientUuid = await this.#clientUuid(adminAccessToken);
    await this.#request(adminAccessToken, `/clients/${clientUuid}/roles/${encodeURIComponent(groupId)}`, {
      method: "DELETE",
    });
  }

  async readGrants(adminAccessToken: string): Promise<readonly KeycloakGrant[]> {
    const clientUuid = await this.#clientUuid(adminAccessToken),
      policies = await this.#pages<{ readonly name: string; readonly users?: readonly string[] }>(
        adminAccessToken,
        `/clients/${clientUuid}/authz/resource-server/policy/user`,
      );
    return Object.freeze(
      policies
        .filter((policy) => policy.name.startsWith(grantUsersPrefix))
        .map((policy) => {
          const [groupId, ...resource] = policy.name.slice(grantUsersPrefix.length).split(":");
          return Object.freeze({
            groupId: groupId!,
            resource: resource.join(":"),
            userIds: Object.freeze([...(policy.users ?? [])].sort()),
          });
        }),
    );
  }

  /**
   * Writes one grant as a user policy plus a scope permission bound to exactly that resource. The
   * permission carries the group's expanded action scopes, so Keycloak evaluates one action on one resource.
   */
  async writeGrant(adminAccessToken: string, grant: KeycloakGrant, scopes: readonly string[]): Promise<void> {
    const clientUuid = await this.#clientUuid(adminAccessToken),
      server = `/clients/${clientUuid}/authz/resource-server`,
      suffix = `${grant.groupId}:${grant.resource}`,
      policy = await this.#named(adminAccessToken, server, `${grantUsersPrefix}${suffix}`),
      permission = await this.#named(adminAccessToken, server, `${grantPermissionPrefix}${suffix}`),
      send = (path: string, method: string, body?: unknown) =>
        this.#request(adminAccessToken, `${server}${path}`, {
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    // A grant nobody holds, or one whose group expands to no action, leaves no permission behind.
    if (permission && (grant.userIds.length === 0 || scopes.length === 0))
      await send(`/permission/scope/${permission.id}`, "DELETE");
    if (grant.userIds.length === 0) {
      if (policy) await send(`/policy/user/${policy.id}`, "DELETE");
      return;
    }
    const policyBody = { name: `${grantUsersPrefix}${suffix}`, logic: "POSITIVE", users: grant.userIds };
    let policyId = policy?.id;
    if (policyId) await send(`/policy/user/${policyId}`, "PUT", { ...policyBody, id: policyId });
    else policyId = requiredId(await (await send("/policy/user", "POST", policyBody)).json(), suffix);
    if (scopes.length === 0) return;
    const resourceBody = {
        name: grant.resource,
        type: `harness:${decodeAuthorizationResource(grant.resource).kind}`,
        ownerManagedAccess: false,
        scopes: [...this.#knownScopes].sort().map((name) => ({ name })),
      },
      resources = await this.#json<readonly { readonly _id: string; readonly name: string }[]>(
        adminAccessToken,
        `${server}/resource?name=${encodeURIComponent(grant.resource)}&exactName=true`,
      );
    let resourceId = resources.find((item) => item.name === grant.resource)?._id;
    if (resourceId) await send(`/resource/${resourceId}`, "PUT", { ...resourceBody, _id: resourceId });
    else resourceId = requiredId(await (await send("/resource", "POST", resourceBody)).json(), grant.resource, "_id");
    const permissionBody = {
      name: `${grantPermissionPrefix}${suffix}`,
      resources: [resourceId],
      scopes,
      policies: [policyId],
      decisionStrategy: "AFFIRMATIVE",
    };
    if (permission) await send(`/permission/scope/${permission.id}`, "PUT", { ...permissionBody, id: permission.id });
    else await send("/permission/scope", "POST", permissionBody);
  }

  /** Re-expands stored grants after a group or the declared action set changed. */
  async materializeGrants(adminAccessToken: string, groupIds?: ReadonlySet<string>): Promise<void> {
    const grants = (await this.readGrants(adminAccessToken)).filter((grant) => groupIds?.has(grant.groupId) ?? true);
    if (grants.length === 0) return;
    const groups = await this.readPolicyGroups(adminAccessToken);
    for (const grant of grants)
      await this.writeGrant(
        adminAccessToken,
        grant,
        groups.some((group) => group.id === grant.groupId) ? effectivePolicyGroupScopes(groups, grant.groupId) : [],
      );
  }

  /** The accounts a grant can name: Keycloak users carrying a Harness person id. */
  async readPeople(
    adminAccessToken: string,
  ): Promise<readonly { readonly userId: string; readonly personId: string; readonly username: string }[]> {
    const users = await this.#pages<{
      readonly id: string;
      readonly username?: string;
      readonly attributes?: Readonly<Record<string, readonly string[]>>;
    }>(adminAccessToken, "/users");
    return users
      .flatMap((user) => {
        const personId = user.attributes?.[personAttribute]?.[0];
        return personId ? [{ userId: user.id, personId, username: user.username ?? personId }] : [];
      })
      .sort((left, right) => left.personId.localeCompare(right.personId));
  }

  async findUserId(adminAccessToken: string, personId: string): Promise<string | undefined> {
    const users = await this.#json<readonly { readonly id?: unknown }[]>(
      adminAccessToken,
      `/users?q=${encodeURIComponent(`${personAttribute}:${personId}`)}&exact=true`,
    );
    return users.length === 1 && typeof users[0]!.id === "string" ? users[0]!.id : undefined;
  }

  async readPersonTeams(adminAccessToken: string, personId: string): Promise<readonly string[]> {
    const userId = await this.findUserId(adminAccessToken, personId);
    if (!userId) throw new Error(`Keycloak has no unique user for ${personId}.`);
    const groups = await this.#pages<NamedRepresentation>(
      adminAccessToken,
      `/users/${encodeURIComponent(userId)}/groups`,
    );
    return groups.map((group) => requiredId(group, "work team"));
  }

  async readTeam(adminAccessToken: string, teamId: string): Promise<{ readonly id: string; readonly name: string }> {
    const group = await this.#json<NamedRepresentation>(adminAccessToken, `/groups/${encodeURIComponent(teamId)}`);
    if (typeof group.name !== "string") throw new Error("Keycloak work team name is missing.");
    return { id: requiredId(group, "work team"), name: group.name };
  }

  async readTeams(adminAccessToken: string): Promise<readonly { readonly id: string; readonly name: string }[]> {
    const groups = await this.#pages<NamedRepresentation>(adminAccessToken, "/groups", "briefRepresentation=true");
    return groups.map((group) => {
      if (typeof group.name !== "string") throw new Error("Keycloak work team name is missing.");
      return { id: requiredId(group, "work team"), name: group.name };
    });
  }

  async readTeamMembers(adminAccessToken: string, teamId: string): Promise<readonly string[]> {
    const members = await this.#pages<{ readonly id: string }>(
      adminAccessToken,
      `/groups/${encodeURIComponent(teamId)}/members`,
    );
    return members.map((member) => member.id).sort();
  }

  async createTeam(adminAccessToken: string, name: string): Promise<void> {
    await this.#request(adminAccessToken, "/groups", { method: "POST", body: JSON.stringify({ name }) });
  }

  async updateTeam(adminAccessToken: string, teamId: string, name: string): Promise<void> {
    await this.#request(adminAccessToken, `/groups/${encodeURIComponent(teamId)}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    });
  }

  async deleteTeam(adminAccessToken: string, teamId: string): Promise<void> {
    await this.#request(adminAccessToken, `/groups/${encodeURIComponent(teamId)}`, { method: "DELETE" });
  }

  async setTeamMember(adminAccessToken: string, teamId: string, userId: string, held: boolean): Promise<void> {
    await this.#request(adminAccessToken, `/users/${encodeURIComponent(userId)}/groups/${encodeURIComponent(teamId)}`, {
      method: held ? "PUT" : "DELETE",
    });
  }

  async readNodes(adminAccessToken: string): Promise<readonly KeycloakNode[]> {
    const clients = await this.#pages<NodeClient>(
      adminAccessToken,
      "/clients",
      `clientId=${encodeURIComponent(nodeClientPrefix)}&search=true`,
    );
    return Object.freeze(
      clients
        .filter((client) => client.clientId.startsWith(nodeClientPrefix))
        .map(nodeOf)
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    );
  }

  async readNode(adminAccessToken: string, nodeId: string): Promise<KeycloakNode | undefined> {
    const client = await this.#nodeClient(adminAccessToken, nodeId);
    return client && nodeOf(client);
  }

  /**
   * Creates the node's client in one POST carrying the machine credential the center minted for
   * it, so no read-back can fail between the client existing and its holder knowing the credential.
   */
  async createNode(adminAccessToken: string, node: KeycloakNode, secret: string): Promise<void> {
    await this.#request(adminAccessToken, "/clients", {
      method: "POST",
      body: JSON.stringify({ ...nodeClientBody(this.#config, node), secret }),
    });
  }

  /** Moves a registered node to another owner; its machine credential is never touched here. */
  async moveNode(adminAccessToken: string, node: KeycloakNode): Promise<void> {
    const current = await this.#nodeClient(adminAccessToken, node.nodeId);
    if (!current) throw new Error(`Keycloak has no client for node ${node.nodeId}; it was removed.`);
    await this.#request(adminAccessToken, `/clients/${current.id}`, {
      method: "PUT",
      body: JSON.stringify(nodeClientBody(this.#config, node)),
    });
  }

  /** Revoke the owner's offline consent for this device before deleting its client. */
  async deleteNode(adminAccessToken: string, nodeId: string): Promise<void> {
    const current = await this.#nodeClient(adminAccessToken, nodeId);
    if (!current) return;
    const personId = nodeOf(current).personId,
      userId = await this.findUserId(adminAccessToken, personId);
    if (!userId)
      throw Object.assign(new Error(`No Keycloak account carries Harness person ${personId}.`), {
        code: "access_person_unknown",
      });
    const consentPath = `/users/${encodeURIComponent(userId)}/consents`,
      consents = await this.#json<readonly { readonly clientId: string }[]>(adminAccessToken, consentPath);
    // Keycloak lists offline grants here even when the client never requested browser consent.
    // An absent grant needs no deletion; a failed DELETE is still an error, including HTTP 404.
    if (consents.some((consent) => consent.clientId === current.clientId))
      await this.#request(adminAccessToken, `${consentPath}/${encodeURIComponent(current.clientId)}`, {
        method: "DELETE",
      });
    await this.#request(adminAccessToken, `/clients/${current.id}`, { method: "DELETE" });
  }

  /** Authenticate the confidential login client without minting a service-account token. */
  async authenticateNode(nodeId: string, credential: string): Promise<boolean> {
    const response = await this.#fetch(this.#realmUrl("/protocol/openid-connect/token/introspect"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: "harness-client-authentication",
        client_id: `${nodeClientPrefix}${nodeId}`,
        client_secret: credential,
      }),
    });
    return response.ok;
  }

  /** A repository grant covers the objects inside that repository; an EntityRef grant covers only its object. */
  async authorize(input: {
    readonly userAccessToken: string;
    readonly action: string;
    readonly resource: AuthorizationResource;
  }): Promise<KeycloakPermissionDecision> {
    const resource = encodeAuthorizationResource(input.resource);
    if (!this.#knownScopes.has(input.action))
      return Object.freeze({ outcome: "denied", reasonCode: "unknown_scope", resource, scope: input.action });
    for (const candidate of coveringResources(input.resource)) {
      const response = await this.#fetch(this.#realmUrl("/protocol/openid-connect/token"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.userAccessToken}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:uma-ticket",
          audience: this.#config.resourceServerClientId,
          permission: `${candidate}#${input.action}`,
          response_mode: "decision",
        }),
      });
      if (response.ok && ((await response.json()) as { readonly result?: unknown }).result === true)
        return Object.freeze({ outcome: "allowed", reasonCode: "keycloak_allowed", resource, scope: input.action });
    }
    return Object.freeze({ outcome: "denied", reasonCode: "keycloak_denied", resource, scope: input.action });
  }

  /**
   * The same grants evaluated for a person who holds no token here (a node's owner, the issuer behind an
   * execution token): the center asks Keycloak's own policy evaluation on that person's behalf.
   */
  async authorizePerson(input: {
    readonly adminAccessToken: string;
    readonly personId: string;
    readonly action: string;
    readonly resource: AuthorizationResource;
  }): Promise<KeycloakPermissionDecision> {
    const resource = encodeAuthorizationResource(input.resource),
      denied = (reasonCode: KeycloakPermissionDecision["reasonCode"]) =>
        Object.freeze({ outcome: "denied" as const, reasonCode, resource, scope: input.action });
    if (!this.#knownScopes.has(input.action)) return denied("unknown_scope");
    const userId = await this.findUserId(input.adminAccessToken, input.personId);
    if (!userId) return denied("keycloak_denied");
    const server = `/clients/${await this.#clientUuid(input.adminAccessToken)}/authz/resource-server`;
    for (const candidate of coveringResources(input.resource)) {
      const found = await this.#json<readonly { readonly _id: string; readonly name: string }[]>(
          input.adminAccessToken,
          `${server}/resource?name=${encodeURIComponent(candidate)}&exactName=true`,
        ),
        resourceId = found.find((item) => item.name === candidate)?._id;
      // A resource nobody was ever granted on has no permission to evaluate.
      if (!resourceId) continue;
      const evaluation = (await (
        await this.#request(input.adminAccessToken, `${server}/policy/evaluate`, {
          method: "POST",
          body: JSON.stringify({
            userId,
            roleIds: [],
            entitlements: false,
            context: { attributes: {} },
            resources: [{ _id: resourceId, scopes: [{ name: input.action }] }],
          }),
        })
      ).json()) as { readonly status?: unknown; readonly results?: readonly { readonly status?: unknown }[] };
      if (
        evaluation.status === "PERMIT" &&
        Array.isArray(evaluation.results) &&
        evaluation.results.length > 0 &&
        evaluation.results.every((result) => result.status === "PERMIT")
      )
        return Object.freeze({ outcome: "allowed", reasonCode: "keycloak_allowed", resource, scope: input.action });
    }
    return denied("keycloak_denied");
  }

  async #nodeClient(token: string, nodeId: string): Promise<NodeClient | undefined> {
    const clientId = `${nodeClientPrefix}${nodeId}`,
      clients = await this.#json<readonly NodeClient[]>(token, `/clients?clientId=${encodeURIComponent(clientId)}`);
    return clients.find((client) => client.clientId === clientId);
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

  async #named(token: string, server: string, name: string): Promise<{ readonly id: string } | undefined> {
    const response = await this.#request(token, `${server}/policy/search?name=${encodeURIComponent(name)}`),
      text = await response.text();
    return text === "" ? undefined : { id: requiredId(JSON.parse(text), name) };
  }

  async #pages<T>(token: string, path: string, query = ""): Promise<T[]> {
    const items: T[] = [];
    for (let first = 0; ; first += 100) {
      const page = await this.#json<T[]>(token, `${path}?first=${first}&max=100${query ? `&${query}` : ""}`);
      items.push(...page);
      if (page.length < 100) return items;
    }
  }

  async #collection(token: string, path: string): Promise<Map<string, KeycloakRole>> {
    const entries = new Map<string, KeycloakRole>();
    for (const item of await this.#pages<NamedRepresentation>(token, path))
      if (typeof item.name === "string" && typeof item.id === "string")
        entries.set(item.name, { ...item, name: item.name, id: item.id });
    return entries;
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
    }).catch((cause: unknown) => {
      throw Object.assign(new Error(`Keycloak Admin REST ${path} could not be reached.`, { cause }), {
        code: "daemon_error",
      });
    });
    if (!response.ok)
      throw Object.assign(new Error(`Keycloak Admin REST ${path} returned HTTP ${response.status}.`), {
        code: "keycloak_admin_rejected",
      });
    return response;
  }

  #adminUrl(path: string): string {
    return `${this.#config.url.replace(/\/$/u, "")}/admin/realms/${encodeURIComponent(this.#config.realm)}${path}`;
  }

  #realmUrl(path: string): string {
    return `${this.#config.url.replace(/\/$/u, "")}/realms/${encodeURIComponent(this.#config.realm)}${path}`;
  }
}

function coveringResources(resource: AuthorizationResource): readonly string[] {
  const encoded = encodeAuthorizationResource(resource);
  return resource.kind === "entity"
    ? [encodeAuthorizationResource({ kind: "repository", repoId: resource.repoId }), encoded]
    : [encoded];
}

/** The client representation one node is created or moved with; its secret travels only with creation. */
function nodeClientBody(config: KeycloakPolicyAdapterConfig, node: KeycloakNode): Readonly<Record<string, unknown>> {
  return {
    clientId: `${nodeClientPrefix}${node.nodeId}`,
    enabled: true,
    publicClient: false,
    serviceAccountsEnabled: false,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    redirectUris: ["http://127.0.0.1/*"],
    attributes: { [personAttribute]: node.personId, ...keycloakLoginAttributes },
    protocolMappers: keycloakLoginMappers(config.resourceServerClientId),
  };
}

function nodeOf(client: NodeClient): KeycloakNode {
  return Object.freeze({
    nodeId: client.clientId.slice(nodeClientPrefix.length),
    personId: client.attributes?.[personAttribute] ?? "",
  });
}

function requiredId(value: unknown, name: string, field = "id"): string {
  const id = (value as Readonly<Record<string, unknown>> | null)?.[field];
  if (typeof id !== "string" || !id) throw new Error(`Keycloak did not return an id for ${name}.`);
  return id;
}

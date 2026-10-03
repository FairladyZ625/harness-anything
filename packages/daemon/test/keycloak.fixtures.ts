import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { managedRbacSessionStore } from "../src/managed-rbac-service.ts";

export { OidcSessionService } from "../src/oidc-session-service.ts";

export const keycloakUrl = "http://127.0.0.1:8080",
  keycloakRealm = "harness";

type Named = { id: string; name: string };
type Role = Named & {
  description?: string;
  attributes?: Record<string, string[]>;
  composites: Set<string>;
};
type Permission = Named & { resources: string[]; scopes: string[]; policies: string[] };
type NodeClient = {
  id: string;
  clientId: string;
  attributes: Record<string, string>;
  secret: string;
  enabled?: boolean;
};

/**
 * In-memory Keycloak that answers the Admin REST and UMA calls the daemon makes. Decisions follow the
 * realm's AFFIRMATIVE strategy: a permission applies to the resources it names, or to every resource
 * when it names none, which is how an unbound scope permission behaves in Keycloak.
 */
export function fakeKeycloak() {
  let sequence = 0;
  const id = (prefix: string) => `${prefix}-${++sequence}`,
    scopes = new Map<string, Named>(),
    roles = new Map<string, Role>(),
    teams = new Map<string, Named & { members: Set<string> }>(),
    realmRoles = new Map<string, Named & { members: Set<string> }>(),
    resources = new Map<string, { _id: string; name: string; type?: string; scopes: { name: string }[] }>(),
    userPolicies = new Map<string, Named & { users: string[] }>(),
    permissions = new Map<string, Permission>(),
    users = new Map<string, { id: string; username: string; attributes: Record<string, string[]> }>(),
    tokens = new Map<string, string>(),
    interactiveSessions = new Map<string, { personId: string; nodeId: string; issuer: string }>(),
    nodeClients = new Map<string, NodeClient>(),
    nodeLogins: { clientId: string; ok: boolean }[] = [],
    profile = { attributes: [{ name: "username" }, { name: "email" }] as { name: string }[] },
    // Keycloak's own defaults: a realm nobody configured idles out after half an hour.
    realm = { ssoSessionIdleTimeout: 1_800, ssoSessionMaxLifespan: 36_000 },
    writes: string[] = [];

  const json = (value: unknown, status = 200) => Response.json(value, { status }),
    // Keycloak 26.7.3 adds attributes of its own to every client and keeps them across updates.
    serverClientAttributes = (): Record<string, string> => ({
      realm_client: "false",
      "client.secret.creation.time": "1790000000",
    }),
    page = (items: readonly unknown[], url: URL) => {
      const first = Number(url.searchParams.get("first") ?? 0);
      return json(items.slice(first, first + Number(url.searchParams.get("max") ?? items.length)));
    },
    roleView = (role: Role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      attributes: role.attributes ?? {},
      clientRole: true,
      containerId: "client-1",
    });

  const permits = (userId: string | undefined, resourceId: string, scope: string): boolean =>
    [...permissions.values()].some(
      (item) =>
        (item.resources.length === 0 || item.resources.includes(resourceId)) &&
        item.scopes.includes(scope) &&
        item.policies.some((policyId) => userPolicies.get(policyId)?.users.includes(userId ?? "")),
    );

  function decide(userId: string | undefined, permission: string): Response {
    const [resourceName, scope] = permission.split("#") as [string, string],
      resource = [...resources.values()].find((item) => item.name === resourceName);
    if (!resource) return json({ error: "invalid_resource" }, 400);
    return permits(userId, resource._id, scope) ? json({ result: true }) : json({ error: "access_denied" }, 403);
  }

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    // Yield like a real round trip, so unserialized callers interleave.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const url = new URL(String(input)),
      method = init?.method ?? "GET",
      body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      bearer = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "");
    if (url.pathname.endsWith("/protocol/openid-connect/revoke")) return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/protocol/openid-connect/token/introspect")) {
      const token = (init?.body as URLSearchParams).get("token") ?? "",
        session = interactiveSessions.get(token);
      return json(
        session
          ? {
              active: true,
              exp: Math.floor(Date.now() / 1000) + 3600,
              iss: `${session.issuer}/realms/${keycloakRealm}`,
              azp: `harness-node-${session.nodeId}`,
              aud: ["harness-center"],
              sub: tokens.get(token),
              harness_person_id: session.personId,
            }
          : { active: false },
      );
    }
    if (url.pathname.endsWith("/protocol/openid-connect/token")) {
      const form = init?.body as URLSearchParams;
      if (form.get("grant_type") === "client_credentials") {
        const clientId = form.get("client_id") ?? "";
        if (!clientId.startsWith("harness-node-") && !clientId.startsWith("harness-execution-"))
          return json({ access_token: "center-token" });
        const client = nodeClients.get(clientId),
          ok = client?.secret === form.get("client_secret") && client?.enabled !== false;
        nodeLogins.push({ clientId, ok });
        if (ok) return json({ access_token: `node-token-${clientId}` });
        // Keycloak 26.7.3 names the two refusals differently; both are HTTP 401.
        return json({ error: client ? "unauthorized_client" : "invalid_client" }, 401);
      }
      return decide(tokens.get(bearer ?? ""), form.get("permission") ?? "");
    }
    const route = url.pathname.replace(`/admin/realms/${keycloakRealm}`, ""),
      server = "/clients/client-1/authz/resource-server",
      tail = decodeURIComponent(route.split("/").at(-1)!);
    if (method !== "GET") writes.push(`${method} ${route}`);
    if (route === "/groups") {
      if (method === "GET")
        return page(
          [...teams.values()].map(({ id, name }) => ({ id, name })),
          url,
        );
      const name = String(body!.name);
      if ([...teams.values()].some((team) => team.name === name)) return json({}, 409);
      const team = { id: id("team"), name, members: new Set<string>() };
      teams.set(team.id, team);
      return new Response(null, { status: 201, headers: { location: `${url.origin}${url.pathname}/${team.id}` } });
    }
    if (/^\/groups\/[^/]+(?:\/members)?$/u.test(route)) {
      const teamId = decodeURIComponent(route.split("/")[2]!),
        team = teams.get(teamId);
      if (!team) return json({}, 404);
      if (method === "DELETE") teams.delete(teamId);
      if (method === "PUT") team.name = String(body!.name);
      if (method !== "GET") return new Response(null, { status: 204 });
      return route.endsWith("/members")
        ? page(
            [...team.members].map((id) => ({ id })),
            url,
          )
        : json({ id: team.id, name: team.name });
    }
    if (/^\/users\/[^/]+\/groups(?:\/[^/]+)?$/u.test(route)) {
      const userId = decodeURIComponent(route.split("/")[2]!),
        teamId = route.split("/")[4];
      if (method === "GET")
        return page(
          [...teams.values()].filter((team) => team.members.has(userId)).map(({ id, name }) => ({ id, name })),
          url,
        );
      const team = teams.get(decodeURIComponent(teamId!));
      if (!team || !users.has(userId)) return json({}, 404);
      if (method === "PUT") team.members.add(userId);
      else if (method === "DELETE") team.members.delete(userId);
      return new Response(null, { status: 204 });
    }
    if (route === "") {
      if (method === "PUT") Object.assign(realm, body);
      return method === "GET" ? json({ realm: keycloakRealm, ...realm }) : new Response(null, { status: 204 });
    }
    if (route === "/clients" && method === "POST") {
      const clientId = String(body!.clientId),
        client = {
          id: id("node-client"),
          enabled: body!.enabled !== false,
          clientId,
          attributes: { ...serverClientAttributes(), ...(body!.attributes as Record<string, string>) },
          // Keycloak 26 stores the secret a caller supplies with a new client (F-2CBA6A96).
          secret: typeof body!.secret === "string" && body!.secret ? body!.secret : id("node-secret"),
        };
      if (nodeClients.has(clientId)) return json({ errorMessage: `Client ${clientId} already exists` }, 409);
      nodeClients.set(clientId, client);
      return new Response(null, { status: 201, headers: { location: `${keycloakUrl}/clients/${client.id}` } });
    }
    if (route === "/clients") {
      const clientId = url.searchParams.get("clientId") ?? "";
      if (!clientId.startsWith("harness-node-") && !clientId.startsWith("harness-execution-"))
        return json([{ id: "client-1", clientId: "harness-center" }]);
      const found = [...nodeClients.values()].filter((client) =>
        url.searchParams.get("search") === "true" ? client.clientId.startsWith(clientId) : client.clientId === clientId,
      );
      return page(
        found.map(({ secret: _secret, ...client }) => client),
        url,
      );
    }
    const nodeClient = [...nodeClients.values()].find((client) => route.startsWith(`/clients/${client.id}`));
    if (nodeClient) {
      if (method === "DELETE") {
        nodeClients.delete(nodeClient.clientId);
        return new Response(null, { status: 204 });
      }
      if (method === "GET") return json({ ...nodeClient, secret: undefined });
      if (typeof body!.enabled === "boolean") nodeClient.enabled = body!.enabled;
      nodeClient.attributes = { ...nodeClient.attributes, ...(body!.attributes as Record<string, string>) };
      return new Response(null, { status: 204 });
    }
    if (route === `${server}/policy/evaluate`) {
      const request = body as { userId: string; resources: { _id: string; scopes: { name: string }[] }[] },
        results = request.resources.map((resource) => ({
          status: resource.scopes.every((scope) => permits(request.userId, resource._id, scope.name))
            ? "PERMIT"
            : "DENY",
        }));
      return json({ status: results.every((result) => result.status === "PERMIT") ? "PERMIT" : "DENY", results });
    }
    if (route === "/users/profile") {
      if (method === "PUT") profile.attributes = (body as typeof profile).attributes;
      return json(profile);
    }
    if (/^\/users\/[^/]+$/u.test(route) && method === "GET") {
      const user = users.get(tail);
      return user ? json({ ...user, enabled: true }) : json({}, 404);
    }
    if (route === "/users" && method === "GET") {
      const query = url.searchParams.get("q"),
        [attribute, value] = (query ?? ":").split(":"),
        username = url.searchParams.get("username");
      if (!query && !username) return page([...users.values()], url);
      return json(
        [...users.values()].filter((user) =>
          username ? user.username === username : user.attributes[attribute!]?.[0] === value,
        ),
      );
    }
    if (route === "/users") {
      const user = { id: id("user"), username: String(body!.username), attributes: {} as Record<string, string[]> };
      // Keycloak silently drops attributes its user profile does not declare.
      for (const [name, value] of Object.entries((body!.attributes ?? {}) as Record<string, string[]>))
        if (profile.attributes.some((attribute) => attribute.name === name)) user.attributes[name] = value;
      users.set(user.id, user);
      return new Response(null, { status: 201, headers: { location: `${keycloakUrl}/users/${user.id}` } });
    }
    if (route.endsWith("/role-mappings/realm")) {
      for (const role of body as unknown as Named[]) realmRoles.get(role.name)?.members.add(route.split("/")[2]!);
      return new Response(null, { status: 204 });
    }
    if (route === "/roles") {
      realmRoles.set(String(body!.name), { id: id("realm-role"), name: String(body!.name), members: new Set() });
      return new Response(null, { status: 201 });
    }
    if (route.startsWith("/roles/")) {
      const role = realmRoles.get(route.split("/")[2]!);
      if (!role) return json({ error: "Could not find role" }, 404);
      return json(route.endsWith("/users") ? [...role.members].map((member) => ({ id: member })) : role);
    }
    if (route === `${server}/scope`) {
      if (method === "GET") return page([...scopes.values()], url);
      const scope = { id: id("scope"), name: String(body!.name) };
      scopes.set(scope.name, scope);
      return json(scope, 201);
    }
    if (route === "/clients/client-1/roles") {
      if (method === "GET") return page([...roles.values()].map(roleView), url);
      const role: Role = { ...(body as unknown as Role), id: id("role"), composites: new Set() };
      roles.set(role.name, role);
      return new Response(null, { status: 201 });
    }
    if (route.endsWith("/composites")) {
      const role = roles.get(decodeURIComponent(route.split("/").at(-2)!))!;
      if (method === "GET") return json([...role.composites].map((name) => roleView(roles.get(name)!)));
      for (const composite of body as unknown as Named[])
        if (method === "POST") role.composites.add(composite.name);
        else role.composites.delete(composite.name);
      return new Response(null, { status: 204 });
    }
    if (route.startsWith("/clients/client-1/roles/")) {
      const role = roles.get(tail);
      if (!role) return json({ error: "Could not find role" }, 404);
      if (method === "DELETE") roles.delete(tail);
      if (method === "PUT") Object.assign(role, body);
      return method === "GET" ? json(roleView(role)) : new Response(null, { status: 204 });
    }
    if (route === `${server}/policy/search`) {
      const name = url.searchParams.get("name"),
        found = [...userPolicies.values(), ...permissions.values()].find((item) => item.name === name);
      return found ? json(found) : new Response(null, { status: 204 });
    }
    if (route === `${server}/policy/user`) {
      if (method === "GET") return page([...userPolicies.values()], url);
      const policy = { id: id("policy"), name: String(body!.name), users: body!.users as string[] };
      userPolicies.set(policy.id, policy);
      return json(policy, 201);
    }
    if (route.startsWith(`${server}/policy/user/`)) {
      if (method === "DELETE") userPolicies.delete(tail);
      else userPolicies.get(tail)!.users = body!.users as string[];
      return new Response(null, { status: method === "DELETE" ? 204 : 201 });
    }
    if (route === `${server}/resource`) {
      if (method === "GET")
        return json([...resources.values()].filter((item) => item.name === url.searchParams.get("name")));
      const resource = { ...(body as { name: string; scopes: { name: string }[] }), _id: id("resource") };
      resources.set(resource._id, resource);
      return json(resource, 201);
    }
    if (route.startsWith(`${server}/resource/`)) {
      Object.assign(resources.get(tail)!, body);
      return new Response(null, { status: 204 });
    }
    if (route === `${server}/permission/scope`) {
      const permission = { ...(body as unknown as Permission), id: id("permission") };
      permissions.set(permission.id, permission);
      return json(permission, 201);
    }
    if (route.startsWith(`${server}/permission/scope/`)) {
      if (method === "DELETE") permissions.delete(tail);
      else Object.assign(permissions.get(tail)!, body);
      return new Response(null, { status: method === "DELETE" ? 204 : 201 });
    }
    return new Response(null, { status: 404 });
  }

  return {
    fetch: handle as typeof fetch,
    writes,
    scopes,
    roles,
    resources,
    permissions,
    userPolicies,
    users,
    realmRoles,
    profile,
    realm,
    nodeClients,
    /** Every machine-credential check Keycloak was asked to make, in order. */
    nodeLogins,
    /** Grants `personId` the named actions on one resource, the way a stored grant materializes. */
    permit(personId: string, resourceName: string, actions: readonly string[]): void {
      const user = [...users.values()].find((item) => item.attributes.harness_person_id?.[0] === personId);
      if (!user) throw new Error(`fixture account ${personId} is not registered`);
      const resource = [...resources.values()].find((item) => item.name === resourceName) ?? {
          _id: id("resource"),
          name: resourceName,
          scopes: [],
        },
        policy = { id: id("policy"), name: `fixture-users:${personId}:${resourceName}:${sequence}`, users: [user.id] },
        permission = {
          id: id("permission"),
          name: `fixture:${personId}:${resourceName}:${sequence}`,
          resources: [resource._id],
          scopes: [...actions],
          policies: [policy.id],
        };
      resources.set(resource._id, resource);
      userPolicies.set(policy.id, policy);
      permissions.set(permission.id, permission);
    },
    /** Removes the named actions from all fixture permissions for this person and resource. */
    revoke(personId: string, resourceName: string, actions: readonly string[]): void {
      const user = [...users.values()].find((item) => item.attributes.harness_person_id?.[0] === personId);
      if (!user) throw new Error(`fixture account ${personId} is not registered`);
      const removed = new Set(actions);
      for (const [permissionId, permission] of permissions) {
        const resource = [...resources.values()].find((item) => item._id === permission.resources[0]);
        if (resource?.name !== resourceName) continue;
        const appliesToUser = permission.policies.some((policyId) =>
          userPolicies.get(policyId)?.users.includes(user.id),
        );
        if (!appliesToUser) continue;
        permission.scopes = permission.scopes.filter((scope) => !removed.has(scope));
        if (permission.scopes.length === 0) permissions.delete(permissionId);
      }
    },
    /** Registers a node for `personId` the way the center registry would and returns its machine credential. */
    node(nodeId: string, personId: string): string {
      const clientId = `harness-node-${nodeId}`,
        client = nodeClients.get(clientId) ?? {
          id: id("node-client"),
          clientId,
          attributes: serverClientAttributes(),
          secret: `secret-${nodeId}`,
        };
      client.attributes = { ...client.attributes, harness_person_id: personId };
      nodeClients.set(clientId, client);
      return client.secret;
    },
    interactiveSession(personId: string, nodeId: string, issuer: string, token = `token-${personId}`): void {
      if (!tokens.has(`token-${personId}`)) throw new Error(`unknown fixture account ${personId}`);
      tokens.set(token, tokens.get(`token-${personId}`)!);
      interactiveSessions.set(token, { personId, nodeId, issuer });
    },
    /** Registers an account the way an administrator would and returns its bearer token. */
    account(personId: string): string {
      const user = { id: id("user"), username: personId, attributes: { harness_person_id: [personId] } };
      users.set(user.id, user);
      tokens.set(`token-${personId}`, user.id);
      return `token-${personId}`;
    },
  };
}

/** Stores a signed-in session holding `roles` in a daemon user root that is bound to the fake realm. */
export function signInAt(userRoot: string, personId: string, roles: readonly string[] = ["access-admin"]): void {
  managedRbacSessionStore(userRoot).write(
    JSON.stringify({
      schema: "harness-oidc-session/v2",
      accessToken: `token-${personId}`,
      subject: personId,
      personId,
      expiresAt: Date.now() + 3_600_000,
      roles,
    }),
  );
}

/** Ends the session `signInAt` stored, so the daemon at `userRoot` answers as nobody signed in. */
export function signOutAt(userRoot: string): void {
  managedRbacSessionStore(userRoot).delete();
}

/** A daemon user root bound to the fake realm, with one signed-in session holding `roles`. */
export function keycloakUserRoot(
  personId = "person-admin",
  roles: readonly string[] = ["access-admin"],
): {
  readonly root: string;
  readonly signIn: (personId: string, roles?: readonly string[]) => void;
} {
  const root = mkdtempSync(path.join(tmpdir(), "ha-access-admin-")),
    signIn = (who: string, held?: readonly string[]) => signInAt(root, who, held);
  mkdirSync(path.join(root, "rbac"), { recursive: true });
  writeFileSync(path.join(root, "rbac", "config.json"), JSON.stringify({ url: keycloakUrl, realm: keycloakRealm }));
  writeFileSync(path.join(root, "rbac", "center-client-secret"), "fixture-secret");
  signIn(personId, roles);
  return { root, signIn };
}

/**
 * Serves the fake realm over loopback HTTP for daemon hosts, which reach Keycloak through global fetch.
 * `bind` points a daemon user root at it; close the returned server when the test ends.
 */
export async function serveKeycloak(): Promise<{
  readonly keycloak: ReturnType<typeof fakeKeycloak>;
  readonly url: string;
  readonly bind: (userRoot: string) => void;
  readonly close: () => Promise<void>;
}> {
  const keycloak = fakeKeycloak(),
    server = createServer((request, response) => {
      void (async () => {
        let raw = "";
        for await (const chunk of request) raw += String(chunk);
        const form = request.headers["content-type"]?.includes("x-www-form-urlencoded") ?? false,
          answer = await keycloak.fetch(`http://127.0.0.1${request.url}`, {
            method: request.method,
            headers: request.headers as Record<string, string>,
            ...(raw === "" ? {} : { body: form ? new URLSearchParams(raw) : raw }),
          });
        response.statusCode = answer.status;
        response.setHeader("content-type", "application/json");
        response.end(await answer.text());
      })().catch((error: unknown) => {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: String(error) }));
      });
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // A fixture that fails before its teardown registers must not hold the test process open.
  server.unref();
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture Keycloak did not bind a port");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    keycloak,
    url,
    bind: (userRoot) => {
      mkdirSync(path.join(userRoot, "rbac"), { recursive: true });
      writeFileSync(path.join(userRoot, "rbac", "config.json"), JSON.stringify({ url, realm: keycloakRealm }));
      writeFileSync(path.join(userRoot, "rbac", "center-client-secret"), "fixture-secret");
    },
    // Fixtures register their teardown more than once; closing an already closed server is not a failure.
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

type RealmControl =
  | { readonly op: "account"; readonly personId: string }
  | { readonly op: "permit"; readonly personId: string; readonly resource: string; readonly actions: readonly string[] }
  | { readonly op: "node"; readonly nodeId: string; readonly personId: string }
  | { readonly op: "nodeLogins" };

/** Applies one control message to a served realm; the child entry and its parent share this vocabulary. */
export function applyRealmControl(keycloak: ReturnType<typeof fakeKeycloak>, message: RealmControl): unknown {
  if (message.op === "account") return keycloak.account(message.personId);
  if (message.op === "permit") {
    keycloak.permit(message.personId, message.resource, message.actions);
    return null;
  }
  if (message.op === "node") return keycloak.node(message.nodeId, message.personId);
  return keycloak.nodeLogins;
}

/**
 * The fake realm in its own process, for tests that block their event loop on spawnSync while a daemon
 * they started calls Keycloak. `control` drives the same fixture operations over the child's IPC channel.
 */
export async function spawnKeycloak(): Promise<{
  readonly url: string;
  readonly bind: (userRoot: string) => void;
  readonly control: <T = unknown>(message: RealmControl) => Promise<T>;
  readonly close: () => void;
}> {
  const child = fork(path.join(import.meta.dirname, "fixtures/keycloak-realm-child.ts"), [], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    }),
    // A child that dies before announcing itself must fail the test, not leave it waiting.
    [ready] = (await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error("fixture Keycloak process exited before it was ready");
      }),
    ])) as [{ readonly url: string }];
  let chain: Promise<unknown> = Promise.resolve();
  return {
    url: ready.url,
    bind: (userRoot) => {
      mkdirSync(path.join(userRoot, "rbac"), { recursive: true });
      writeFileSync(
        path.join(userRoot, "rbac", "config.json"),
        JSON.stringify({ url: ready.url, realm: keycloakRealm }),
      );
      writeFileSync(path.join(userRoot, "rbac", "center-client-secret"), "fixture-secret");
    },
    // One request at a time, so each reply answers the message before it.
    control: <T>(message: RealmControl) => {
      const reply = chain.then(async () => {
        child.send(message);
        const [answer] = (await once(child, "message")) as [{ readonly result: T }];
        return answer.result;
      });
      chain = reply.catch(() => undefined);
      return reply;
    },
    close: () => {
      child.kill();
    },
  };
}

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { managedRbacSessionStore } from "../src/managed-rbac-service.ts";

export const keycloakUrl = "http://127.0.0.1:8080",
  keycloakRealm = "harness";

type Named = { id: string; name: string };
type Role = Named & {
  description?: string;
  attributes?: Record<string, string[]>;
  composites: Set<string>;
};
type Permission = Named & { resources: string[]; scopes: string[]; policies: string[] };

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
    realmRoles = new Map<string, Named & { members: Set<string> }>(),
    resources = new Map<string, { _id: string; name: string; type?: string; scopes: { name: string }[] }>(),
    userPolicies = new Map<string, Named & { users: string[] }>(),
    permissions = new Map<string, Permission>(),
    users = new Map<string, { id: string; username: string; attributes: Record<string, string[]> }>(),
    tokens = new Map<string, string>(),
    profile = { attributes: [{ name: "username" }, { name: "email" }] as { name: string }[] },
    writes: string[] = [];

  const json = (value: unknown, status = 200) => Response.json(value, { status }),
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

  function decide(userId: string | undefined, permission: string): Response {
    const [resourceName, scope] = permission.split("#") as [string, string],
      resource = [...resources.values()].find((item) => item.name === resourceName);
    if (!resource) return json({ error: "invalid_resource" }, 400);
    const allowed = [...permissions.values()].some(
      (item) =>
        (item.resources.length === 0 || item.resources.includes(resource._id)) &&
        item.scopes.includes(scope) &&
        item.policies.some((policyId) => userPolicies.get(policyId)?.users.includes(userId ?? "")),
    );
    return allowed ? json({ result: true }) : json({ error: "access_denied" }, 403);
  }

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    // Yield like a real round trip, so unserialized callers interleave.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const url = new URL(String(input)),
      method = init?.method ?? "GET",
      body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      bearer = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "");
    if (url.pathname.endsWith("/protocol/openid-connect/token")) {
      const form = init?.body as URLSearchParams;
      if (form.get("grant_type") === "client_credentials") return json({ access_token: "center-token" });
      return decide(tokens.get(bearer ?? ""), form.get("permission") ?? "");
    }
    const route = url.pathname.replace(`/admin/realms/${keycloakRealm}`, ""),
      server = "/clients/client-1/authz/resource-server",
      tail = decodeURIComponent(route.split("/").at(-1)!);
    if (method !== "GET") writes.push(`${method} ${route}`);
    if (route === "/clients") return json([{ id: "client-1" }]);
    if (route === "/users/profile") {
      if (method === "PUT") profile.attributes = (body as typeof profile).attributes;
      return json(profile);
    }
    if (route === "/users" && method === "GET") {
      const [attribute, value] = (url.searchParams.get("q") ?? ":").split(":"),
        username = url.searchParams.get("username");
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
    /** Registers an account the way an administrator would and returns its bearer token. */
    account(personId: string): string {
      const user = { id: id("user"), username: personId, attributes: { harness_person_id: [personId] } };
      users.set(user.id, user);
      tokens.set(`token-${personId}`, user.id);
      return `token-${personId}`;
    },
  };
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
    signIn = (who: string, held: readonly string[] = ["access-admin"]) =>
      managedRbacSessionStore(root).write(
        JSON.stringify({
          schema: "harness-oidc-session/v1",
          accessToken: `token-${who}`,
          subject: who,
          personId: who,
          expiresAt: Date.now() + 3_600_000,
          roles: held,
        }),
      );
  mkdirSync(path.join(root, "rbac"), { recursive: true });
  writeFileSync(path.join(root, "rbac", "config.json"), JSON.stringify({ url: keycloakUrl, realm: keycloakRealm }));
  writeFileSync(path.join(root, "rbac", "center-client-secret"), "fixture-secret");
  signIn(personId, roles);
  return { root, signIn };
}

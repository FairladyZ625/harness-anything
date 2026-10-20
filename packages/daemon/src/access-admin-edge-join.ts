import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  effectivePolicyGroupScopes,
  encodeAuthorizationResource,
  readDaemonRegistry,
  sha256Text,
  stableStringify,
} from "@harness-anything/kernel";
import { KeycloakPolicyAdapter, type KeycloakGrant } from "./keycloak-policy-adapter.ts";
import type { AccessAdminPorts, AccessAdminRequest } from "./access-admin-contract.ts";
import { coded, names, requiredUserId, text, uniqueSorted } from "./access-admin-utils.ts";
import { admitEdgeJoin, restoreEdgeJoinStore } from "./fleet/edge-join-admission.ts";
import { createEdgeJoinStore, encodeEdgeJoinLink, type EdgeJoinRecord } from "./fleet/edge-join.ts";
import { readFleetCenterConfig } from "./fleet-center-config.ts";
import type { OidcSessionService } from "./oidc-session-service.ts";

interface Session {
  readonly adapter: KeycloakPolicyAdapter;
  readonly token: string;
}

export class EdgeJoinAdminService {
  readonly #oidc: OidcSessionService;
  readonly #userRoot: string;
  readonly #daemonId: string;
  readonly #now: () => string;
  readonly #session: () => Promise<Session>;
  readonly #joins: ReturnType<typeof createEdgeJoinStore>;

  constructor(input: {
    readonly oidc: OidcSessionService;
    readonly userRoot: string;
    readonly daemonId: string;
    readonly now: () => string;
    readonly journal: AccessAdminPorts["journal"];
    readonly session: () => Promise<Session>;
  }) {
    this.#oidc = input.oidc;
    this.#userRoot = input.userRoot;
    this.#daemonId = input.daemonId;
    this.#now = input.now;
    this.#session = input.session;
    this.#joins = restoreEdgeJoinStore(input.journal);
  }

  async create(request: AccessAdminRequest, actor: string): Promise<Record<string, unknown>> {
    const personId = text(request.personId, "personId"),
      repoIds = uniqueSorted(names(request.repoIds, "repoIds") ?? []),
      groupIds = uniqueSorted(names(request.groupIds, "groupIds") ?? []),
      nodeLabel = request.nodeLabel?.trim() || undefined,
      platform = request.platform;
    if (repoIds.length === 0) throw coded("edge_join_invalid", "Select at least one repository.");
    if (groupIds.length === 0) throw coded("edge_join_invalid", "Select at least one permission group.");
    if (repoIds.some((repoId) => !/^[a-z][a-z0-9-]{0,62}$/u.test(repoId)))
      throw coded("edge_join_invalid", "Repository ids must use lowercase letters, digits, and hyphens.");
    if (platform !== undefined && platform !== "darwin" && platform !== "linux")
      throw coded("edge_join_invalid", "The edge platform must be darwin or linux.");
    this.#assertRepositories(repoIds);
    const config = readFleetCenterConfig(this.#userRoot, this.#daemonId);
    if (!config) throw coded("fleet_center_unavailable", "Start the fleet center before issuing an edge invitation.");
    if (config.bind === "0.0.0.0" || config.bind === "::")
      throw coded(
        "fleet_center_address_unavailable",
        "Bind the fleet center to the reachable address used by edge nodes.",
      );
    const bind = config.bind.includes(":") && !config.bind.startsWith("[") ? `[${config.bind}]` : config.bind,
      centerOrigin = new URL(`https://${bind}:${config.port}`).origin,
      certificate = new X509Certificate(readFileSync(config.certPath)),
      spkiSha256 = createHash("sha256")
        .update(certificate.publicKey.export({ type: "spki", format: "der" }))
        .digest("hex"),
      session = await this.#session(),
      groups = await session.adapter.readPolicyGroups(session.token),
      permissionSnapshot = groupIds.map((groupId) => {
        const group = groups.find((candidate) => candidate.id === groupId);
        if (!group) throw coded("policy_group_unknown", `Policy group ${groupId} does not exist.`);
        const effectiveScopes = effectivePolicyGroupScopes(groups, groupId);
        if (effectiveScopes.length === 0)
          throw coded("permission_group_empty", `Policy group ${groupId} grants no actions.`);
        return { groupId, version: edgeJoinPermissionVersion(groupId, effectiveScopes) };
      });

    if (!(await session.adapter.findUserId(session.token, personId)))
      // Already inside the edge-join-create write queue; invite renews the session in place.
      // Username, email, and displayName are new-user fields: an existing member needs none.
      await this.#oidc.invite(
        {
          personId,
          username: newUserField(request.username, "username", personId),
          email: newUserField(request.email, "email", personId),
          displayName: newUserField(request.displayName, "displayName", personId),
        },
        true,
      );
    const userId = await requiredUserId(session.adapter, session.token, personId),
      grants: readonly KeycloakGrant[] = await session.adapter.readGrants(session.token);
    for (const repoId of repoIds) {
      const resource = encodeAuthorizationResource({ kind: "repository", repoId });
      for (const { groupId } of permissionSnapshot) {
        const existing = grants.find((grant) => grant.groupId === groupId && grant.resource === resource),
          userIds = uniqueSorted([...(existing?.userIds ?? []), userId]);
        await session.adapter.writeGrant(
          session.token,
          { groupId, resource, userIds },
          effectivePolicyGroupScopes(groups, groupId),
        );
      }
    }

    const login = await this.#oidc.interactiveAuthority(),
      created = this.#joins.create({
        centerOrigin,
        repoIds,
        personId,
        permissionSnapshot,
        ...(nodeLabel ? { nodeLabel } : {}),
        ...(platform ? { platform } : {}),
        spkiSha256,
        loginUrl: login.url,
        loginRealm: login.realm,
        loginClientId: login.clientId,
        createdBy: actor,
        ttlMs: 72 * 60 * 60 * 1000,
      });
    return {
      ok: true,
      joinId: created.record.joinId,
      state: "pending",
      expiresAt: created.record.expiresAt,
      link: encodeEdgeJoinLink(created.link),
    };
  }

  async admit(input: { readonly joinId: string; readonly inviteToken: string; readonly accessToken: string }) {
    return admitEdgeJoin({
      ...input,
      oidc: this.#oidc,
      edgeJoins: this.#joins,
      validateSnapshot: (record) => this.#validateSnapshot(record),
      registerNode: async (record, nodeId) => {
        const session = await this.#session(),
          current = await session.adapter.readNode(session.token, nodeId);
        if (current) throw coded("edge_join_invalid", "The generated edge node id is already registered.");
        const credential = randomBytes(32).toString("base64url");
        await session.adapter.createNode(
          session.token,
          {
            nodeId,
            personId: record.personId,
            systemName: record.nodeLabel ?? nodeId,
            displayName: record.nodeLabel ?? nodeId,
            platform: record.platform ?? "unknown",
            registeredAt: this.#now(),
          },
          credential,
        );
        return credential;
      },
    });
  }

  status(joinId: string) {
    return this.#joins.status(joinId);
  }

  list() {
    return this.#joins.list();
  }

  revoke(joinId: string, actor: string): Record<string, unknown> {
    this.#joins.revoke(joinId, actor);
    return { ok: true, joinId, state: "revoked" };
  }

  async #validateSnapshot(record: EdgeJoinRecord): Promise<void> {
    this.#assertRepositories(record.repoIds);
    const session = await this.#session(),
      groups = await session.adapter.readPolicyGroups(session.token),
      userId = await requiredUserId(session.adapter, session.token, record.personId),
      grants: readonly KeycloakGrant[] = await session.adapter.readGrants(session.token);
    for (const snapshot of record.permissionSnapshot) {
      const group = groups.find((candidate) => candidate.id === snapshot.groupId),
        effectiveScopes = group ? effectivePolicyGroupScopes(groups, snapshot.groupId) : [];
      if (
        !group ||
        effectiveScopes.length === 0 ||
        edgeJoinPermissionVersion(snapshot.groupId, effectiveScopes) !== snapshot.version
      )
        throw coded("permission_snapshot_changed", `Permissions for ${snapshot.groupId} changed after invitation.`);
      for (const repoId of record.repoIds) {
        const resource = encodeAuthorizationResource({ kind: "repository", repoId }),
          grant = grants.find((candidate) => candidate.groupId === snapshot.groupId && candidate.resource === resource);
        if (!grant?.userIds.includes(userId))
          throw coded("permission_snapshot_changed", `The invited person's grant for ${repoId} changed.`);
      }
    }
  }

  #assertRepositories(repoIds: readonly string[]): void {
    const registry = readDaemonRegistry({ userRoot: this.#userRoot });
    for (const repoId of repoIds) {
      const repository = registry.repos.find(
        (candidate) =>
          candidate.repoId === repoId &&
          candidate.state === "enabled" &&
          candidate.mode !== "remote-proxy" &&
          candidate.canonicalRoot !== null,
      );
      if (!repository)
        throw coded("repo_namespace_unknown", `Repository ${repoId} is no longer available from this fleet center.`);
    }
  }
}

function edgeJoinPermissionVersion(groupId: string, effectiveScopes: readonly string[]): string {
  return sha256Text(stableStringify({ groupId, effectiveScopes: uniqueSorted(effectiveScopes) }));
}

/** An invitation for an unknown person creates the account, so the new-user fields become required there. */
function newUserField(value: string | undefined, field: string, personId: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw coded(
      "access_request_invalid",
      `Person ${personId} is not a member yet; inviting a new member requires a ${field}.`,
    );
  return value;
}

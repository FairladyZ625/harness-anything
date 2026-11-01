import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  effectivePolicyGroupScopes,
  encodeAuthorizationResource,
  readDaemonRegistry,
  sha256Text,
  stableStringify,
} from "@harness-anything/kernel";
import type { AuthorizationGrant, AuthorizationProvider } from "@harness-anything/kernel";
import type { AccessAdminPorts, AccessAdminRequest } from "./access-admin-contract.ts";
import { coded, names, requiredUserId, text, uniqueSorted } from "./access-admin-utils.ts";
import { admitEdgeJoin, restoreEdgeJoinStore } from "./fleet/edge-join-admission.ts";
import {
  createEdgeJoinStore,
  edgeJoinPlatforms,
  encodeEdgeJoinLink,
  isEdgeJoinPlatform,
  type EdgeJoinRecord,
} from "./fleet/edge-join.ts";
import { readFleetCenterConfig } from "./fleet-center-config.ts";
import { EdgeJoinSshTunnelManager, validateSshTarget, type EdgeJoinTunnelPorts } from "./fleet/edge-join-ssh-tunnel.ts";
import type { IdentitySessionPort } from "@harness-anything/kernel";

interface Session {
  readonly adapter: AuthorizationProvider;
  readonly token: string;
}

type Schedule = (callback: () => void, delayMs: number) => () => void;

export class EdgeJoinAdminService {
  readonly #oidc: IdentitySessionPort;
  readonly #userRoot: string;
  readonly #daemonId: string;
  readonly #now: () => string;
  readonly #session: () => Promise<Session>;
  readonly #joins: ReturnType<typeof createEdgeJoinStore>;
  readonly #sshTunnels: EdgeJoinSshTunnelManager;
  readonly #schedule: Schedule;
  #cancelExpirySweep?: () => void;

  constructor(input: {
    readonly oidc: IdentitySessionPort;
    readonly userRoot: string;
    readonly daemonId: string;
    readonly now: () => string;
    readonly journal: AccessAdminPorts["journal"];
    readonly session: () => Promise<Session>;
    readonly sshTunnels: EdgeJoinSshTunnelManager;
    readonly schedule?: Schedule;
    readonly joins?: ReturnType<typeof createEdgeJoinStore>;
  }) {
    this.#oidc = input.oidc;
    this.#userRoot = input.userRoot;
    this.#daemonId = input.daemonId;
    this.#now = input.now;
    this.#session = input.session;
    this.#sshTunnels = input.sshTunnels;
    this.#joins = input.joins ?? restoreEdgeJoinStore(input.journal, input.now);
    this.#schedule =
      input.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return () => clearTimeout(timer);
      });
    this.#scheduleExpirySweep();
  }

  async create(request: AccessAdminRequest, actor: string): Promise<Record<string, unknown>> {
    const personId = text(request.personId, "personId"),
      repoIds = uniqueSorted(names(request.repoIds, "repoIds") ?? []),
      groupIds = uniqueSorted(names(request.groupIds, "groupIds") ?? []),
      nodeLabel = request.nodeLabel?.trim() || undefined,
      platform = request.platform,
      transport = request.transport,
      sshTarget = transport === "ssh-reverse" ? validateSshTarget(text(request.sshTarget, "sshTarget")) : undefined;
    if (transport !== undefined && transport !== "direct" && transport !== "ssh-reverse")
      throw coded("edge_join_invalid", "The edge transport must be direct or ssh-reverse.");
    if (transport !== "ssh-reverse" && request.sshTarget !== undefined)
      throw coded("edge_join_invalid", "An SSH target is only valid with the ssh-reverse transport.");
    if (repoIds.length === 0) throw coded("edge_join_invalid", "Select at least one repository.");
    if (groupIds.length === 0) throw coded("edge_join_invalid", "Select at least one permission group.");
    if (repoIds.some((repoId) => !/^[a-z][a-z0-9-]{0,62}$/u.test(repoId)))
      throw coded("edge_join_invalid", "Repository ids must use lowercase letters, digits, and hyphens.");
    if (platform !== undefined && !isEdgeJoinPlatform(platform))
      throw coded("edge_join_invalid", `The edge platform must be one of ${edgeJoinPlatforms.join(", ")}.`);
    this.#assertRepositories(repoIds);
    const config = readFleetCenterConfig(this.#userRoot, this.#daemonId);
    if (!config) throw coded("fleet_center_unavailable", "Start the fleet center before issuing an edge invitation.");
    if (!config.externalUrl)
      throw coded(
        "fleet_center_address_unavailable",
        "Set the center's externally reachable HTTPS address with `ha daemon fleet center start --external-url https://center.example:7545`, then issue a new invitation.",
      );
    const centerOrigin = config.externalUrl,
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

    const login = await this.#oidc.interactiveAuthority();
    try {
      if (sshTarget && login.url === "builtin://local")
        throw coded(
          "edge_join_invalid",
          "Built-in identity invitations use the pinned center channel; SSH login tunnels require an HTTPS authority.",
        );
      const loginAddress = new URL(login.url),
        serviceHosts = sshServiceHosts(config.bind, login.url),
        tunnel = sshTarget
          ? await this.#sshTunnels.start({
              target: sshTarget,
              fleetServicePort: config.port,
              fleetServiceHost: serviceHosts.fleet,
              loginServicePort: Number(loginAddress.port || 443),
              loginServiceHost: serviceHosts.login,
            })
          : undefined,
        tunnelFields = sshTarget && tunnel ? sshJoinFields(config.externalUrl!, login.url, tunnel) : undefined;
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
        grants: readonly AuthorizationGrant[] = await session.adapter.readGrants(session.token);
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
      const created = this.#joins.create({
        centerOrigin: tunnelFields?.centerOrigin ?? centerOrigin,
        ...(tunnelFields
          ? {
              transport: "ssh-reverse" as const,
              centerServername: tunnelFields.centerServername,
              loginUrl: tunnelFields.loginUrl,
              loginServername: tunnelFields.loginServername,
              loginBrowserUrl: login.url,
              sshTarget,
              sshFleetPort: tunnelFields.ports.fleet,
              sshLoginPort: tunnelFields.ports.login,
              sshLoginServicePort: Number(loginAddress.port || 443),
            }
          : { loginUrl: login.url }),
        repoIds,
        personId,
        permissionSnapshot,
        ...(nodeLabel ? { nodeLabel } : {}),
        ...(platform ? { platform } : {}),
        spkiSha256,
        loginRealm: login.realm,
        loginClientId: login.clientId,
        ...(login.certificate ? { loginCertificate: login.certificate } : {}),
        createdBy: actor,
        ttlMs: 72 * 60 * 60 * 1000,
      });
      this.#scheduleExpirySweep();
      return {
        ok: true,
        joinId: created.record.joinId,
        state: "pending",
        expiresAt: created.record.expiresAt,
        link: encodeEdgeJoinLink(created.link),
      };
    } catch (error) {
      if (sshTarget && !this.#hasActiveTarget(sshTarget)) this.#sshTunnels.release(sshTarget);
      throw error;
    }
  }

  async admit(input: { readonly joinId: string; readonly inviteToken: string; readonly accessToken?: string }) {
    const result = await admitEdgeJoin({
      ...input,
      oidc: this.#oidc,
      edgeJoins: this.#joins,
      ...(this.#oidc.issueInvitationSession
        ? { issueInvitationSession: (personId: string) => this.#oidc.issueInvitationSession!(personId) }
        : {}),
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
    this.#scheduleExpirySweep();
    return result;
  }

  invitationClientForNode(nodeId: string): { readonly clientId: string; readonly personId: string } | undefined {
    const record = this.#joins.records().find((candidate) => candidate.nodeId === nodeId && candidate.consumedAt);
    return record ? { clientId: record.loginClientId, personId: record.personId } : undefined;
  }

  status(joinId: string) {
    const record = this.#joins.get(joinId),
      status = this.#joins.status(joinId);
    return {
      ...status,
      ...(record?.sshTarget ? { tunnelState: this.#sshTunnels.state(record.sshTarget) } : {}),
    };
  }

  list() {
    return this.#joins.list().map((summary) => {
      const record = this.#joins.get(summary.joinId);
      return {
        ...summary,
        ...(record?.transport ? { transport: record.transport } : {}),
        ...(record?.sshTarget ? { tunnelState: this.#sshTunnels.state(record.sshTarget) } : {}),
      };
    });
  }

  revoke(joinId: string, actor: string): Record<string, unknown> {
    const record = this.#joins.revoke(joinId, actor);
    if (record.sshTarget) this.#releaseIfUnused(record.sshTarget);
    this.#scheduleExpirySweep();
    return { ok: true, joinId, state: "revoked" };
  }

  async resumeSshTunnels(fleetServicePort: number): Promise<void> {
    const records = this.#joins
      .records()
      .filter(
        (record) =>
          record.transport === "ssh-reverse" &&
          record.sshTarget &&
          record.sshFleetPort !== undefined &&
          record.sshLoginPort !== undefined &&
          record.sshLoginServicePort !== undefined &&
          ["pending", "consumed"].includes(this.#joins.status(record.joinId).state),
      );
    if (records.length === 0) return;
    const config = readFleetCenterConfig(this.#userRoot, this.#daemonId);
    if (!config)
      throw coded(
        "edge_join_ssh_state_invalid",
        "Cannot resume SSH invitations without the current fleet center config.",
      );
    const fleetServiceHost = sshFleetServiceHost(config.bind),
      byTarget = new Map<
        string,
        { readonly ports: EdgeJoinTunnelPorts; readonly loginServicePort: number; readonly loginServiceHost: string }
      >();
    for (const record of records) {
      if (!record.loginServername)
        throw coded("edge_join_ssh_state_invalid", "SSH invitations are missing their login service hostname.");
      const ports = { fleet: record.sshFleetPort!, login: record.sshLoginPort! },
        previous = byTarget.get(record.sshTarget!);
      if (
        previous &&
        (previous.ports.fleet !== ports.fleet ||
          previous.ports.login !== ports.login ||
          previous.loginServicePort !== record.sshLoginServicePort ||
          previous.loginServiceHost !== record.loginServername)
      )
        throw coded("edge_join_ssh_state_invalid", "Invitations for one SSH target disagree on tunnel addresses.");
      byTarget.set(record.sshTarget!, {
        ports,
        loginServicePort: record.sshLoginServicePort!,
        loginServiceHost: record.loginServername,
      });
    }
    for (const [target, entry] of byTarget)
      this.#sshTunnels.resume({
        target,
        fleetServicePort,
        fleetServiceHost,
        loginServicePort: entry.loginServicePort,
        loginServiceHost: entry.loginServiceHost,
        remotePorts: entry.ports,
      });
  }

  stopSshTunnels(): Promise<void> {
    return this.#sshTunnels.stopAll();
  }

  close(): Promise<void> {
    this.#cancelExpirySweep?.();
    this.#cancelExpirySweep = undefined;
    return this.#sshTunnels.close();
  }

  releaseNodeTunnel(nodeId: string): void {
    const records = this.#joins.records();
    for (const record of records.filter((candidate) => candidate.nodeId === nodeId && candidate.sshTarget)) {
      const stillUsed = records.some(
        (candidate) =>
          candidate.sshTarget === record.sshTarget &&
          candidate.nodeId !== nodeId &&
          ["pending", "consumed"].includes(this.#joins.status(candidate.joinId).state),
      );
      if (!stillUsed) this.#sshTunnels.release(record.sshTarget!);
    }
  }

  #hasActiveTarget(target: string): boolean {
    return this.#joins
      .records()
      .some(
        (record) =>
          record.sshTarget === target && ["pending", "consumed"].includes(this.#joins.status(record.joinId).state),
      );
  }

  #releaseIfUnused(target: string): void {
    if (!this.#hasActiveTarget(target)) this.#sshTunnels.release(target);
  }

  #scheduleExpirySweep(): void {
    this.#cancelExpirySweep?.();
    this.#cancelExpirySweep = undefined;
    const pending = this.#joins
      .records()
      .filter(
        (record) =>
          record.transport === "ssh-reverse" &&
          record.sshTarget &&
          this.#joins.status(record.joinId).state === "pending",
      );
    if (pending.length === 0) return;
    const nextExpiry = Math.min(...pending.map((record) => Date.parse(record.expiresAt))),
      delayMs = Math.max(0, nextExpiry - Date.parse(this.#now()));
    this.#cancelExpirySweep = this.#schedule(() => {
      this.#cancelExpirySweep = undefined;
      for (const record of pending) {
        if (this.#joins.status(record.joinId).state === "expired") this.#releaseIfUnused(record.sshTarget!);
      }
      this.#scheduleExpirySweep();
    }, delayMs);
  }

  async #validateSnapshot(record: EdgeJoinRecord): Promise<void> {
    this.#assertRepositories(record.repoIds);
    const session = await this.#session(),
      groups = await session.adapter.readPolicyGroups(session.token),
      userId = await requiredUserId(session.adapter, session.token, record.personId),
      grants: readonly AuthorizationGrant[] = await session.adapter.readGrants(session.token);
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

function sshJoinFields(
  centerUrl: string,
  loginUrl: string,
  ports: EdgeJoinTunnelPorts,
): {
  readonly centerOrigin: string;
  readonly centerServername: string;
  readonly loginUrl: string;
  readonly loginServername: string;
  readonly ports: EdgeJoinTunnelPorts;
} {
  const center = new URL(centerUrl),
    login = new URL(loginUrl),
    machineLogin = new URL(loginUrl);
  machineLogin.hostname = "127.0.0.1";
  machineLogin.port = String(ports.login);
  return {
    centerOrigin: `https://127.0.0.1:${ports.fleet}`,
    centerServername: center.hostname,
    loginUrl: machineLogin.toString().replace(/\/$/u, ""),
    loginServername: login.hostname,
    ports,
  };
}

function sshServiceHosts(fleetBind: string, loginUrl: string): { readonly fleet: string; readonly login: string } {
  return {
    fleet: sshFleetServiceHost(fleetBind),
    login: new URL(loginUrl).hostname.replace(/^\[|\]$/gu, ""),
  };
}

function sshFleetServiceHost(fleetBind: string): string {
  const fleet = fleetBind.replace(/^\[|\]$/gu, "");
  return fleet === "0.0.0.0" || fleet === "::" ? "127.0.0.1" : fleet;
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

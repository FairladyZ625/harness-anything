import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import {
  actionDeclarations,
  actionPresentation,
  decodeAuthorizationResource,
  effectivePolicyGroupScopes,
  encodeAuthorizationResource,
  stableStringify,
  sha256Text,
} from "@harness-anything/kernel";
import type {
  AuthorizationProvider,
  AuthorizationGrant,
  AuthorizationNode,
  AuthorizationPolicyGroup,
} from "@harness-anything/kernel";
import {
  managedPermissionRequestStore,
  managedRbacReceiptJournal,
  reserveCredentialFile,
} from "./access-admin-state.ts";
import type { IdentitySessionPort } from "@harness-anything/kernel";
import { type AccessAdminOperation, type AccessAdminPorts, type AccessAdminRequest } from "./access-admin-contract.ts";
import { createNodeRetirement, planNodeRetirement } from "./fleet/node-retirement.ts";
import { EdgeJoinAdminService } from "./access-admin-edge-join.ts";
import { EdgeJoinSshTunnelManager } from "./fleet/edge-join-ssh-tunnel.ts";
import { coded, names, requiredUserId, text, uniqueSorted } from "./access-admin-utils.ts";
export { type AccessAdminOperation, type AccessAdminPorts, type AccessAdminRequest } from "./access-admin-contract.ts";
/** What Keycloak must show once an operation took effect; reconciliation observes exactly this. */
type Expectation =
  | { readonly kind: "team"; readonly teamId: string; readonly version: string }
  | { readonly kind: "team-created"; readonly name: string }
  | { readonly kind: "group"; readonly groupId: string; readonly version: string | null }
  | {
      readonly kind: "grant";
      readonly groupId: string;
      readonly resource: string;
      readonly personId: string;
      readonly held: boolean;
    }
  | {
      readonly kind: "node";
      readonly nodeId: string;
      readonly version: string;
      readonly state?: AuthorizationNode["state"];
    }
  | { readonly kind: "devices"; readonly nodes: readonly { readonly nodeId: string; readonly version: string }[] }
  | { readonly kind: "session-lifetime"; readonly seconds: number };

interface Plan {
  readonly expect: Expectation;
  readonly preview?: Readonly<Record<string, unknown>>;
  /** Whatever the write returns is handed to the caller once and never journaled. */
  readonly apply: () => Promise<Readonly<Record<string, unknown>> | void>;
  /** Releases local-only preparation when the write never started: its intent could not be recorded. */
  readonly abandon?: () => void;
}

interface Conflict {
  readonly conflict: Readonly<Record<"expectedVersion" | "currentVersion", string>> & {
    readonly teamId?: string;
    readonly groupId?: string;
    readonly nodeId?: string;
  };
}

interface Session {
  readonly adapter: AuthorizationProvider;
  readonly token: string;
  readonly authority: { readonly url: string; readonly realm: string; readonly clientId: string };
  readonly realmAdmin: { readonly url: string; readonly realm: string; readonly accessToken: string };
}

const resourceServerClientId = "harness-center",
  receiptListLimit = 200;

interface PermissionRequest {
  readonly requestId: string;
  readonly version: number;
  readonly state: "pending" | "approved" | "rejected" | "withdrawn";
  readonly personId: string;
  readonly groupId: string;
  readonly resource: string;
  readonly actions: readonly string[];
  readonly rationale: string;
  readonly createdAt: string;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly decision?: "approve" | "reject";
}

/**
 * Typed administration of policy groups, `(group, resource)` grants, the fleet node registry, and
 * the realm's session lifetime. Keycloak holds the only state evaluation reads; the journal written
 * here is an audit trail that nothing evaluates.
 */
export class AccessAdminService {
  readonly #oidc: IdentitySessionPort;
  readonly #ports: AccessAdminPorts;
  readonly #permissionRequests: ReturnType<typeof managedPermissionRequestStore>;
  readonly #edgeJoinAdmin: EdgeJoinAdminService;
  readonly #edgeJoinTunnels: EdgeJoinSshTunnelManager;

  constructor(oidc: IdentitySessionPort, userRoot: string, ports: Partial<AccessAdminPorts> = {}) {
    this.#oidc = oidc;
    this.#permissionRequests = managedPermissionRequestStore(userRoot);
    this.#ports = {
      fetch,
      now: () => new Date().toISOString(),
      journal: managedRbacReceiptJournal(userRoot),
      nodeRetirement: createNodeRetirement({ stateRoot: path.join(userRoot, "fleet") }),
      ...ports,
    };
    this.#edgeJoinTunnels = ports.sshTunnels ?? new EdgeJoinSshTunnelManager();
    this.#edgeJoinAdmin = new EdgeJoinAdminService({
      oidc,
      userRoot,
      daemonId: this.#ports.daemonId ?? "default",
      now: this.#ports.now,
      journal: this.#ports.journal,
      session: () => this.#session(),
      sshTunnels: this.#edgeJoinTunnels,
      ...(ports.edgeJoins ? { joins: ports.edgeJoins } : {}),
    });
  }

  /** Pre-session admission used only by the fleet edge.join frame. The whole invite/node write is
   * serialized by the OIDC writer, and the machine credential is returned only to this caller. */
  async admitEdgeJoin(input: { readonly joinId: string; readonly inviteToken: string; readonly accessToken?: string }) {
    return this.#edgeJoinAdmin.admit(input);
  }

  invitationClientForNode(nodeId: string): { readonly clientId: string; readonly personId: string } | undefined {
    return this.#edgeJoinAdmin.invitationClientForNode(nodeId);
  }

  resumeEdgeJoinTunnels(fleetServicePort: number): Promise<void> {
    return this.#edgeJoinAdmin.resumeSshTunnels(fleetServicePort);
  }

  stopEdgeJoinTunnels(): Promise<void> {
    return this.#edgeJoinAdmin.stopSshTunnels();
  }

  close(): Promise<void> {
    return this.#edgeJoinAdmin.close();
  }

  async run(request: AccessAdminRequest, requester?: string): Promise<Record<string, unknown>> {
    if (request.operation === "permission-request-create" && requester !== undefined)
      return this.#createPermissionRequest(request, requester);
    const ownDevices = request.operation?.startsWith("device-") === true,
      publicRequest =
        request.operation === "permission-request-create" || request.operation === "permission-request-withdraw",
      actor = (
        await (ownDevices ||
        publicRequest ||
        request.operation === "permission-request-list" ||
        request.operation === "permission-request-decide"
          ? this.#oidc.requireSession(request.rootDir)
          : this.#oidc.requireRole("access-admin", request.rootDir))
      ).personId;
    switch (request.operation as AccessAdminOperation) {
      case "group-list":
        return this.#listGroups();
      case "grant-list":
        return this.#listGrants();
      case "permission-request-create":
        return this.#createPermissionRequest(request, actor);
      case "permission-request-list":
        return this.#listPermissionRequests(actor);
      case "permission-request-decide":
        return this.#decidePermissionRequest(request, actor);
      case "permission-request-withdraw":
        return this.#withdrawPermissionRequest(request, actor);
      case "effective-permissions":
        return this.#effectivePermissions(request);
      case "receipt-list":
        return { ok: true, receipts: this.#receipts().slice(0, receiptListLimit) };
      case "team-list":
        return this.#listTeams();
      case "team-create":
      case "team-update":
      case "team-delete":
      case "team-member-add":
      case "team-member-remove":
        return this.#mutate(request, actor, (session) => this.#planTeam(session, request));
      case "node-list":
        return this.#listNodes();
      case "device-list":
        return this.#listNodes(actor);
      case "device-rename":
      case "device-pause":
      case "device-resume":
      case "device-remove":
        return this.#mutate(request, actor, (session) => this.#planDevice(session, request, actor));
      case "device-logout-all":
        return this.#logoutDevices(request, actor);
      case "node-register":
        return this.#mutate(request, actor, (session) => this.#planNodeRegistration(session, request));
      case "node-unregister":
        return this.#mutate(request, actor, (session) =>
          planNodeRetirement(session, request, this.#ports.nodeRetirement!),
        );
      case "edge-join-create":
        return this.#oidc.serialize(() => this.#edgeJoinAdmin.create(request, actor));
      case "edge-join-status":
        return this.#oidc.serialize(async () => ({
          ok: true,
          ...this.#edgeJoinAdmin.status(text(request.joinId, "joinId")),
        }));
      case "edge-join-list":
        return this.#oidc.serialize(async () => ({ ok: true, joins: this.#edgeJoinAdmin.list() }));
      case "edge-join-revoke":
        return this.#oidc.serialize(async () => this.#edgeJoinAdmin.revoke(text(request.joinId, "joinId"), actor));
      case "receipt-reconcile":
        return this.#oidc.serialize(() => this.#reconcile(text(request.operationId, "operationId"), actor));
      case "group-create":
      case "group-update":
        return this.#mutate(request, actor, (session) => this.#planGroupWrite(session, request));
      case "group-delete":
        return this.#mutate(request, actor, (session) => this.#planGroupDelete(session, request));
      case "grant":
      case "revoke":
        return this.#mutate(request, actor, (session) => this.#planGrant(session, request));
      case "session-lifetime":
        return this.#sessionLifetime();
      case "session-lifetime-set":
        return this.#mutate(request, actor, (session) => this.#planSessionLifetime(session, request));
      default:
        throw coded("access_operation_unknown", `Unknown access administration operation ${request.operation}.`);
    }
  }

  async #createPermissionRequest(request: AccessAdminRequest, actor: string): Promise<Record<string, unknown>> {
    return this.#oidc.serialize(async () => {
      const session = await this.#session(),
        resource = canonicalResource(request.resource),
        groups = await session.adapter.readPolicyGroups(session.token),
        group = groups.find((item) => item.id === text(request.groupId, "groupId"));
      if (!group) throw coded("policy_group_unknown", `Policy group ${request.groupId} does not exist.`);
      if (actor !== text(request.personId ?? actor, "personId"))
        throw coded("authorization_denied", "A person may request access only for their own account.");
      const scope = effectivePolicyGroupScopes(groups, group.id);
      if (!scope.length) throw coded("permission_request_empty", "Choose a policy group with at least one action.");
      const requests = this.#permissionRequests.read().map((line) => JSON.parse(line) as PermissionRequest),
        current = requests.find(
          (item) =>
            item.personId === actor &&
            item.groupId === group.id &&
            item.resource === resource &&
            item.state === "pending",
        );
      if (current) return { ok: true, request: current };
      const created: PermissionRequest = {
        requestId: randomBytes(16).toString("hex"),
        version: 1,
        state: "pending",
        personId: actor,
        groupId: group.id,
        resource,
        actions: scope,
        rationale: request.rationale?.trim() ?? "",
        createdAt: this.#ports.now(),
      };
      this.#permissionRequests.write([...requests.map((row) => JSON.stringify(row)), JSON.stringify(created)]);
      return { ok: true, request: created };
    });
  }

  async #listPermissionRequests(actor: string): Promise<Record<string, unknown>> {
    const rows = this.#permissionRequests.read().map((line) => JSON.parse(line) as PermissionRequest),
      session = await this.#session(),
      decision = await session.adapter.authorizePerson({
        adminAccessToken: session.token,
        personId: actor,
        action: "permission-request-decide",
        resource: { kind: "fleet" },
      }),
      canDecide = decision.outcome === "allowed";
    return {
      ok: true,
      canDecide,
      requests: rows.filter((item) => item.personId === actor || (canDecide && item.state === "pending")),
    };
  }

  async #decidePermissionRequest(request: AccessAdminRequest, actor: string): Promise<Record<string, unknown>> {
    return this.#oidc.serialize(async () => {
      const rows = this.#permissionRequests.read().map((line) => JSON.parse(line) as PermissionRequest),
        id = text(request.requestId, "requestId"),
        index = rows.findIndex((item) => item.requestId === id),
        current = rows[index];
      if (!current) throw coded("permission_request_unknown", `Permission request ${id} does not exist.`);
      if (current.version !== request.requestVersion || current.state !== "pending")
        return {
          ok: false,
          code: "version_conflict",
          requestId: id,
          expectedVersion: request.requestVersion,
          currentVersion: current.version,
        };
      if (actor === current.personId)
        throw coded("authorization_denied", "A requester cannot decide their own permission request.");
      const session = await this.#session(),
        groups = await session.adapter.readPolicyGroups(session.token),
        group = groups.find((item) => item.id === current.groupId);
      if (
        !group ||
        stableStringify(effectivePolicyGroupScopes(groups, current.groupId)) !== stableStringify(current.actions)
      )
        throw coded("permission_request_changed", "The policy group changed; submit a new permission request.");
      if (request.decision === "approve") {
        const approverResource = decodeAuthorizationResource(current.resource),
          resourceAncestors =
            approverResource.kind === "entity"
              ? [{ kind: "repository" as const, repoId: approverResource.repoId }]
              : [];
        for (const action of current.actions) {
          const decision = await session.adapter.authorizePerson({
            adminAccessToken: session.token,
            personId: actor,
            action,
            resource: approverResource,
            resourceAncestors,
          });
          if (decision.outcome !== "allowed")
            throw coded(
              "authorization_denied",
              `Approver ${actor} is not authorized for ${action} on ${current.resource}.`,
            );
        }
        const holders = await this.#grantHolders(session, current.groupId, current.resource);
        await session.adapter.writeGrant(
          session.token,
          {
            groupId: current.groupId,
            resource: current.resource,
            userIds: uniqueSorted([...holders, await requiredUserId(session.adapter, session.token, current.personId)]),
          },
          effectivePolicyGroupScopes(groups, current.groupId),
        );
      } else if (request.decision !== "reject") throw coded("access_request_invalid", "Choose approve or reject.");
      const settled = {
        ...current,
        state: request.decision === "approve" ? ("approved" as const) : ("rejected" as const),
        version: current.version + 1,
        decidedBy: actor,
        decidedAt: this.#ports.now(),
        decision: request.decision,
      };
      rows[index] = settled;
      this.#permissionRequests.write(rows.map((row) => JSON.stringify(row)));
      return { ok: true, request: settled };
    });
  }

  async #withdrawPermissionRequest(request: AccessAdminRequest, actor: string): Promise<Record<string, unknown>> {
    return this.#oidc.serialize(async () => {
      const rows = this.#permissionRequests.read().map((line) => JSON.parse(line) as PermissionRequest),
        id = text(request.requestId, "requestId"),
        index = rows.findIndex((item) => item.requestId === id),
        current = rows[index];
      if (!current || current.personId !== actor)
        throw coded("permission_request_unknown", `Permission request ${id} is unavailable.`);
      if (current.version !== request.requestVersion || current.state !== "pending")
        return {
          ok: false,
          code: "version_conflict",
          requestId: id,
          expectedVersion: request.requestVersion,
          currentVersion: current.version,
        };
      rows[index] = { ...current, state: "withdrawn", version: current.version + 1 };
      this.#permissionRequests.write(rows.map((row) => JSON.stringify(row)));
      return { ok: true, request: rows[index] };
    });
  }

  async #listGroups(): Promise<Record<string, unknown>> {
    const session = await this.#session(),
      groups = await session.adapter.readPolicyGroups(session.token);
    return {
      ok: true,
      groups: groups.map((group) => ({
        ...group,
        effectiveScopes: effectivePolicyGroupScopes(groups, group.id),
        version: groupVersion(group),
      })),
      // The facets an action picker groups by, read from the declarations the Base groups derive from.
      actions: actionDeclarations.map((declaration) => ({
        action: declaration.policyAction,
        presentation: actionPresentation[declaration.kind as keyof typeof actionPresentation],
        executionClass: declaration.executionClass,
        policyTier: declaration.policyTier,
        residencyScope: declaration.residency.scope,
      })),
    };
  }

  /** Every account that can hold a grant, and every `(person, group, resource)` grant held. */
  async #listGrants(): Promise<Record<string, unknown>> {
    const session = await this.#session(),
      people = await session.adapter.readPeople(session.token),
      personByUser = new Map(people.map((person) => [person.userId, person.personId] as const));
    return {
      ok: true,
      people: people.map(({ personId, username }) => ({ personId, username })),
      grants: (await session.adapter.readGrants(session.token)).flatMap((grant) =>
        grant.userIds.flatMap((userId) => {
          const personId = personByUser.get(userId);
          return personId === undefined ? [] : [{ personId, groupId: grant.groupId, resource: grant.resource }];
        }),
      ),
    };
  }

  async #sessionLifetime(): Promise<Record<string, unknown>> {
    const session = await this.#session(),
      seconds = await session.adapter.readSessionLifetime(session.token);
    return {
      ok: true,
      seconds,
      version: String(seconds),
      authority: { url: session.realmAdmin.url, realm: session.realmAdmin.realm },
      ...session.adapter.sessionLifetimeBounds,
    };
  }

  async #listTeams(): Promise<Record<string, unknown>> {
    const session = await this.#session(),
      people = await session.adapter.readPeople(session.token),
      teams = await session.adapter.readTeams(session.token);
    return {
      ok: true,
      people: people.map(({ personId, username }) => ({ personId, username })),
      teams: await Promise.all(
        teams.map(async (team) => {
          const members = await session.adapter.readTeamMembers(session.token, team.id);
          return {
            ...team,
            version: teamVersion(team.name, members),
            personIds: people.filter((person) => members.includes(person.userId)).map((person) => person.personId),
          };
        }),
      ),
    };
  }

  async #planTeam(session: Session, request: AccessAdminRequest): Promise<Plan | Conflict> {
    const teams = await session.adapter.readTeams(session.token);
    if (request.operation === "team-create") {
      const name = text(request.teamName, "teamName");
      if (teams.some((team) => team.name === name)) throw coded("team_exists", `Work team ${name} already exists.`);
      return { expect: { kind: "team-created", name }, apply: () => session.adapter.createTeam(session.token, name) };
    }
    const teamId = text(request.teamId, "teamId"),
      current = teams.find((team) => team.id === teamId);
    if (!current) throw coded("team_unknown", `Work team ${teamId} does not exist.`);
    const members = await session.adapter.readTeamMembers(session.token, teamId),
      currentVersion = teamVersion(current.name, members);
    if (currentVersion !== request.expectedVersion)
      return {
        conflict: { teamId, expectedVersion: text(request.expectedVersion, "expectedVersion"), currentVersion },
      };
    if (request.operation === "team-delete")
      return {
        expect: { kind: "team", teamId, version: "" },
        apply: () => session.adapter.deleteTeam(session.token, teamId),
      };
    if (request.operation === "team-update") {
      const name = text(request.teamName, "teamName");
      if (teams.some((team) => team.id !== teamId && team.name === name))
        throw coded("team_exists", `Work team ${name} already exists.`);
      return {
        expect: { kind: "team", teamId, version: teamVersion(name, members) },
        apply: () => session.adapter.updateTeam(session.token, teamId, name),
      };
    }
    const personId = text(request.personId, "personId"),
      userId = await session.adapter.findUserId(session.token, personId);
    if (!userId) throw coded("access_person_unknown", `No Keycloak account carries Harness person ${personId}.`);
    const held = request.operation === "team-member-add",
      next = held ? uniqueSorted([...members, userId]) : members.filter((id) => id !== userId);
    return {
      expect: { kind: "team", teamId, version: teamVersion(current.name, next) },
      apply: () => session.adapter.setTeamMember(session.token, teamId, userId, held),
    };
  }

  async #listNodes(personId?: string): Promise<Record<string, unknown>> {
    const session = await this.#session(),
      nodes = (await session.adapter.readNodes(session.token)).filter(
        (node) => !personId || node.personId === personId,
      );
    return {
      ok: true,
      nodes: nodes.map((node) => ({ ...node, version: nodeVersion(node) })),
      version: deviceListVersion(nodes),
    };
  }

  /** Expands the person's grants on the resource (and its repository) down to each action's source group. */
  async #effectivePermissions(request: AccessAdminRequest): Promise<Record<string, unknown>> {
    const session = await this.#session(),
      personId = text(request.personId, "personId"),
      resource = canonicalResource(request.resource),
      decoded = decodeAuthorizationResource(resource),
      covering = new Set([
        resource,
        ...(decoded.kind === "entity"
          ? [encodeAuthorizationResource({ kind: "repository", repoId: decoded.repoId })]
          : []),
      ]),
      userId = await session.adapter.findUserId(session.token, personId);
    if (!userId) throw coded("access_person_unknown", `No Keycloak account carries Harness person ${personId}.`);
    const groups = await session.adapter.readPolicyGroups(session.token),
      byId = new Map(groups.map((group) => [group.id, group] as const)),
      held = (await session.adapter.readGrants(session.token)).filter(
        (grant) => grant.userIds.includes(userId) && covering.has(grant.resource) && byId.has(grant.groupId),
      ),
      sources = new Map<string, { grantedGroup: string; sourceGroup: string; resource: string }[]>();
    for (const grant of held)
      for (const sourceGroup of inheritedGroupIds(byId, grant.groupId))
        for (const action of byId.get(sourceGroup)!.scopes)
          sources.set(action, [
            ...(sources.get(action) ?? []),
            { grantedGroup: grant.groupId, sourceGroup, resource: grant.resource },
          ]);
    const involved = new Set(held.flatMap((grant) => inheritedGroupIds(byId, grant.groupId)));
    return {
      ok: true,
      personId,
      resource,
      grants: held.map((grant) => ({
        groupId: grant.groupId,
        resource: grant.resource,
        inheritedGroups: inheritedGroupIds(byId, grant.groupId),
      })),
      actions: [...sources]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([action, from]) => ({
          action,
          sources: from,
        })),
      // The audit trail behind this answer: grants to this person here, and writes to the groups they expand to.
      receipts: this.#receipts().filter(({ expect }) =>
        expect?.kind === "grant"
          ? expect.personId === personId && covering.has(expect.resource)
          : expect?.kind === "group" && involved.has(expect.groupId),
      ),
    };
  }

  /** One row per operation, newest first: its settled receipt, or its intent while it is unsettled. */
  #receipts(): readonly (Readonly<Record<string, unknown>> & { readonly expect?: Expectation })[] {
    const byOperation = new Map<string, Readonly<Record<string, unknown>>>();
    for (const line of this.#ports.journal.read()) {
      const record = JSON.parse(line) as Readonly<Record<string, unknown>>;
      if (record.schema === "harness-edge-join/v1" || record.schema === "harness-edge-join/v2") continue;
      const operationId = String(record.operationId);
      byOperation.set(operationId, { ...byOperation.get(operationId), ...record });
    }
    return [...byOperation.values()].reverse();
  }

  #mutate(
    request: AccessAdminRequest,
    actor: string,
    plan: (session: Session) => Promise<Plan | Conflict>,
  ): Promise<Record<string, unknown>> {
    // An operationId is the journal key for retries and reconciliation, not an input the caller must
    // invent: generate one when omitted and return it in the receipt like an explicitly supplied id.
    const suppliedOperationId = request.operationId?.trim(),
      operationId = suppliedOperationId ? suppliedOperationId : randomUUID(),
      operation = request.operation!;
    return this.#oidc.serialize(async () => {
      const recorded = this.#records(operationId);
      if (recorded.some((record) => record.phase === "settled"))
        throw coded("access_operation_settled", `Operation ${operationId} already settled; use a new operationId.`);
      if (recorded.length > 0) throw unsettled(operationId);
      const session = await this.#session(),
        planned = await plan(session),
        base = { schema: "harness-access-receipt/v1", operationId, operation, actor, authority: session.authority };
      if (!("conflict" in planned) && planned.preview && request.confirm !== true)
        return {
          ok: true,
          dryRun: true,
          summary: `Dry run: planned node retirement.
${JSON.stringify(planned.preview, null, 2)}`,
          ...planned.preview,
        };
      if ("conflict" in planned) {
        const receipt = {
          ...base,
          phase: "settled",
          outcome: "version_conflict",
          ...planned.conflict,
          settledAt: this.#ports.now(),
        };
        this.#ports.journal.append(JSON.stringify(receipt));
        return { ok: false, code: "version_conflict", ...receipt };
      }
      // All removal entry points share admission fencing, including owner device-remove.
      const removed = removedNode(planned.expect),
        release = removed ? this.#ports.nodeRetirement!.fence(removed) : undefined;
      try {
        // The intent lands before Keycloak changes, so a lost receipt can be reconciled without replaying the write.
        try {
          this.#ports.journal.append(
            JSON.stringify({
              ...base,
              phase: "intent",
              expect: planned.expect,
              ...(planned.preview ? { retirement: planned.preview } : {}),
              recordedAt: this.#ports.now(),
            }),
          );
        } catch (error) {
          planned.abandon?.();
          throw error;
        }
        if (removed) await this.#ports.nodeRetirement!.drain(removed);
        const issued = await planned.apply();
        return {
          ...this.#settle(
            { ...base, expect: planned.expect, ...(planned.preview ? { retirement: planned.preview } : {}) },
            "applied",
          ),
          ...issued,
        };
      } finally {
        release?.();
      }
    });
  }

  async #reconcile(operationId: string, actor: string): Promise<Record<string, unknown>> {
    const recorded = this.#records(operationId),
      settled = recorded.find((record) => record.phase === "settled"),
      intent = recorded.find((record) => record.phase === "intent");
    if (settled) return { ok: settled.outcome === "applied", ...settled };
    if (!intent) throw coded("access_operation_unknown", `No access operation ${operationId} is recorded.`);
    const observed = await this.#observed(await this.#session(), intent.expect as Expectation);
    const removed = observed ? removedNode(intent.expect) : null,
      release = removed ? this.#ports.nodeRetirement!.fence(removed) : undefined;
    try {
      if (removed) await this.#ports.nodeRetirement!.drain(removed);
      return this.#settle({ ...intent, reconciledBy: actor }, observed ? "applied" : "failed");
    } finally {
      release?.();
    }
  }

  async #observed(session: Session, expect: Expectation): Promise<boolean> {
    switch (expect.kind) {
      case "team-created":
        return (await session.adapter.readTeams(session.token)).some((team) => team.name === expect.name);
      case "team": {
        const team = (await session.adapter.readTeams(session.token)).find((team) => team.id === expect.teamId);
        return (
          (team ? teamVersion(team.name, await session.adapter.readTeamMembers(session.token, team.id)) : "") ===
          expect.version
        );
      }
      case "group":
        return (
          ((await session.adapter.readPolicyGroups(session.token))
            .filter((group) => group.id === expect.groupId)
            .map(groupVersion)[0] ?? null) === expect.version
        );
      case "grant":
        return (
          (await this.#grantHolders(session, expect.groupId, expect.resource)).includes(
            (await session.adapter.findUserId(session.token, expect.personId)) ?? "",
          ) === expect.held
        );
      case "node": {
        const node = await session.adapter.readNode(session.token, expect.nodeId);
        return (
          nodeVersion(node) === expect.version &&
          node?.revocation === "complete" &&
          (expect.state === undefined || node.state === expect.state)
        );
      }
      case "devices":
        for (const expected of expect.nodes)
          if (!(await this.#observed(session, { kind: "node", ...expected }))) return false;
        return true;
      case "session-lifetime":
        return (await session.adapter.readSessionLifetime(session.token)) === expect.seconds;
    }
  }

  #settle(record: Readonly<Record<string, unknown>>, outcome: "applied" | "failed"): Record<string, unknown> {
    const removed = outcome === "applied" ? removedNode(record.expect) : null;
    if (removed) this.#ports.nodeRetirement!.remove(removed);
    const receipt = { ...record, phase: "settled", outcome, settledAt: this.#ports.now() };
    try {
      this.#ports.journal.append(JSON.stringify(receipt));
    } catch (error) {
      throw Object.assign(unsettled(String(record.operationId)), { cause: error });
    }
    if (removed) {
      this.#edgeJoinAdmin.releaseNodeTunnel(removed);
      this.#ports.onNodeRemoved?.(removed);
    }
    return { ok: outcome === "applied", ...receipt };
  }

  async #planGroupWrite(session: Session, request: AccessAdminRequest): Promise<Plan | Conflict> {
    const groupId = text(request.groupId, "groupId"),
      groups = await session.adapter.readPolicyGroups(session.token),
      current = groups.find((group) => group.id === groupId),
      creating = request.operation === "group-create";
    if (current?.base) throw coded("base_policy_group_read_only", `Base policy group ${groupId} is generated.`);
    if (creating && current) throw coded("policy_group_exists", `Policy group ${groupId} already exists.`);
    if (creating && !/^[a-z][a-z0-9-]{0,62}$/u.test(groupId))
      throw coded("policy_group_invalid", "A policy group id uses lowercase letters, digits, and hyphens.");
    if (!creating && !current) throw coded("policy_group_unknown", `Policy group ${groupId} does not exist.`);
    if (current && groupVersion(current) !== request.expectedVersion)
      return {
        conflict: {
          groupId,
          expectedVersion: text(request.expectedVersion, "expectedVersion"),
          currentVersion: groupVersion(current),
        },
      };
    const next: AuthorizationPolicyGroup = {
        id: groupId,
        base: false,
        displayName: request.displayName?.trim() || current?.displayName || groupId,
        scopes: uniqueSorted(names(request.scopes, "scopes") ?? current?.scopes ?? []),
        composites: uniqueSorted(names(request.composites, "composites") ?? current?.composites ?? []),
      },
      nextGroups = [...groups.filter((group) => group.id !== groupId), next];
    try {
      session.adapter.validatePolicyGroups(nextGroups);
    } catch (error) {
      throw coded("policy_group_invalid", error instanceof Error ? error.message : String(error));
    }
    // Every group that inherits from this one expands differently now; their grants are re-expanded with it.
    const changed = new Set(
      nextGroups
        .filter(
          (group) =>
            !groups.some((before) => before.id === group.id) ||
            stableStringify(effectivePolicyGroupScopes(groups, group.id)) !==
              stableStringify(effectivePolicyGroupScopes(nextGroups, group.id)),
        )
        .map((group) => group.id),
    );
    return {
      expect: { kind: "group", groupId, version: groupVersion(next) },
      apply: async () => {
        await session.adapter.writePolicyGroup(session.token, next, current);
        await session.adapter.materializeGrants(session.token, changed);
      },
    };
  }

  async #planGroupDelete(session: Session, request: AccessAdminRequest): Promise<Plan | Conflict> {
    const groupId = text(request.groupId, "groupId"),
      groups = await session.adapter.readPolicyGroups(session.token),
      current = groups.find((group) => group.id === groupId);
    if (!current) throw coded("policy_group_unknown", `Policy group ${groupId} does not exist.`);
    if (current.base) throw coded("base_policy_group_read_only", `Base policy group ${groupId} is generated.`);
    if (groupVersion(current) !== request.expectedVersion)
      return {
        conflict: {
          groupId,
          expectedVersion: text(request.expectedVersion, "expectedVersion"),
          currentVersion: groupVersion(current),
        },
      };
    if (
      groups.some((group) => group.composites.includes(groupId)) ||
      (await session.adapter.readGrants(session.token)).some((grant) => grant.groupId === groupId)
    )
      throw coded("policy_group_in_use", `Policy group ${groupId} is still inherited or granted.`);
    return {
      expect: { kind: "group", groupId, version: null },
      apply: () => session.adapter.deletePolicyGroup(session.token, groupId),
    };
  }

  async #planGrant(session: Session, request: AccessAdminRequest): Promise<Plan> {
    const groupId = text(request.groupId, "groupId"),
      personId = text(request.personId, "personId"),
      resource = canonicalResource(request.resource),
      held = request.operation === "grant",
      groups = await session.adapter.readPolicyGroups(session.token);
    if (!groups.some((group) => group.id === groupId))
      throw coded("policy_group_unknown", `Policy group ${groupId} does not exist.`);
    const userId = await session.adapter.findUserId(session.token, personId);
    if (!userId) throw coded("access_person_unknown", `No Keycloak account carries Harness person ${personId}.`);
    const holders = await this.#grantHolders(session, groupId, resource),
      userIds = held ? uniqueSorted([...holders, userId]) : holders.filter((id) => id !== userId);
    return {
      expect: { kind: "grant", groupId, resource, personId, held },
      apply: () =>
        session.adapter.writeGrant(
          session.token,
          { groupId, resource, userIds },
          effectivePolicyGroupScopes(groups, groupId),
        ),
    };
  }

  /** The lifetime is one number, so the value an administrator read is the version their change is made against. */
  async #planSessionLifetime(session: Session, request: AccessAdminRequest): Promise<Plan | Conflict> {
    const seconds = request.sessionLifetimeSeconds,
      { minimumSeconds, maximumSeconds } = session.adapter.sessionLifetimeBounds;
    if (!Number.isInteger(seconds) || seconds! < minimumSeconds || seconds! > maximumSeconds)
      throw coded(
        "session_lifetime_invalid",
        `The session lifetime is a whole number of seconds from ${minimumSeconds} to ${maximumSeconds}.`,
      );
    if (typeof request.expectedVersion !== "string" || request.expectedVersion.trim() === "")
      throw coded(
        "access_request_invalid",
        "Access administration requires expectedVersion. Run `ha bootstrap --operation session-lifetime` and pass its version as --expected-version.",
      );
    const expectedVersion = text(request.expectedVersion, "expectedVersion"),
      currentVersion = String(await session.adapter.readSessionLifetime(session.token));
    if (currentVersion !== expectedVersion) return { conflict: { expectedVersion, currentVersion } };
    return {
      expect: { kind: "session-lifetime", seconds: seconds! },
      apply: () => session.adapter.writeSessionLifetime(session.token, seconds!),
    };
  }

  /**
   * One node answers to exactly one person. A first registration carries no version; changing the
   * owner carries the version read, so two administrators registering one node cannot both apply.
   */
  async #planNodeRegistration(session: Session, request: AccessAdminRequest): Promise<Plan | Conflict> {
    const nodeId = text(request.nodeId, "nodeId"),
      personId = text(request.personId, "personId");
    if (!/^[A-Za-z0-9_-]{1,96}$/u.test(nodeId))
      throw coded("node_invalid", "A node id uses letters, digits, underscores, and hyphens.");
    if (!(await session.adapter.findUserId(session.token, personId)))
      throw coded("access_person_unknown", `No Keycloak account carries Harness person ${personId}.`);
    const current = await session.adapter.readNode(session.token, nodeId),
      currentVersion = nodeVersion(current),
      next = {
        nodeId,
        personId,
        systemName: request.systemName,
        displayName: request.displayName,
        platform: request.platform,
        registeredAt: this.#ports.now(),
      };
    if ((request.expectedVersion ?? "") !== currentVersion)
      return { conflict: { nodeId, expectedVersion: request.expectedVersion ?? "", currentVersion } };
    if (current) {
      if (current.state === "removed") throw coded("device_removed", "A removed device cannot be registered again.");
      const moved: AuthorizationNode = { ...current, personId, revision: current.revision + 1 };
      return {
        expect: { kind: "node", nodeId, version: String(moved.revision), state: moved.state },
        apply: () =>
          current.personId === personId
            ? session.adapter.writeNode(session.token, moved)
            : session.adapter.transferNode(session.token, moved, current.personId),
      };
    }
    // Only creating the node mints a credential, and a minted credential never travels in a
    // receipt: without a file to hold it the registration is refused before anything is reserved,
    // journaled, or written, so a first registration cannot end half-registered.
    if (request.credentialFile === undefined)
      throw coded(
        "credential_file_required",
        "A first node registration writes the node's machine credential into --credential-file; nothing was registered.",
      );
    const reserved = credentialReservation(request.credentialFile);
    return {
      expect: { kind: "node", nodeId, version: "1" },
      abandon: () => reserved.discard(),
      apply: async () => {
        // The minted credential is 32 random bytes in the shape real Keycloak 26 was probed with
        // (F-2CBA6A96). Every fallible local step ends before Keycloak is written: once the client
        // exists, nothing stands between it and the operator holding this credential.
        const credential = randomBytes(32).toString("base64url");
        try {
          reserved.keep(credential);
        } catch (error) {
          reserved.discard();
          throw error;
        }
        // A POST that fails here may still have created the client, so the credential stays in its
        // file and the intent stays unsettled: reconcile settles the operation by what Keycloak shows.
        await session.adapter.createNode(session.token, next, credential);
        return { credentialFile: reserved.file };
      },
    };
  }

  async #planDevice(session: Session, request: AccessAdminRequest, actor: string): Promise<Plan | Conflict> {
    const nodeId = text(request.nodeId, "nodeId"),
      node = await session.adapter.readNode(session.token, nodeId);
    if (!node || node.personId !== actor) throw coded("authorization_denied", "Only the device's owner may manage it.");
    const expectedVersion = text(request.expectedVersion, "expectedVersion"),
      currentVersion = nodeVersion(node);
    if (expectedVersion !== currentVersion) return { conflict: { nodeId, expectedVersion, currentVersion } };
    if (node.state === "removed" && !(node.revocation === "pending" && request.operation === "device-remove"))
      throw coded("device_removed", "A removed device cannot be restored or registered again.");
    if (node.revocation === "pending" && !["device-pause", "device-remove"].includes(request.operation!))
      throw coded("access_operation_unsettled", "Finish the pending device revocation first.");
    const state =
        request.operation === "device-pause"
          ? "paused"
          : request.operation === "device-remove"
            ? "removed"
            : request.operation === "device-resume"
              ? "active"
              : node.state,
      next: AuthorizationNode = {
        ...node,
        state,
        revision: node.revision + 1,
        ...(request.operation === "device-rename" ? { displayName: text(request.displayName, "displayName") } : {}),
      };
    return {
      expect: { kind: "node", nodeId, version: nodeVersion(next), state },
      apply: () =>
        request.operation === "device-pause" || request.operation === "device-remove"
          ? session.adapter.revokeNode(session.token, { ...node, state })
          : session.adapter.writeNode(session.token, next),
    };
  }

  #logoutDevices(request: AccessAdminRequest, actor: string): Promise<Record<string, unknown>> {
    return this.#mutate(request, actor, async (session) => {
      const nodes = (await session.adapter.readNodes(session.token)).filter((node) => node.personId === actor),
        expectedVersion = text(request.expectedVersion, "expectedVersion"),
        currentVersion = deviceListVersion(nodes);
      if (expectedVersion !== currentVersion) return { conflict: { expectedVersion, currentVersion } };
      const active = nodes.filter((node) => node.state !== "removed");
      return {
        expect: {
          kind: "devices",
          nodes: active.map((node) => ({ nodeId: node.nodeId, version: String(node.revision + 1) })),
        },
        apply: () =>
          session.adapter.revokeNodes(
            session.token,
            active.map((node) => ({ ...node, state: "paused" })),
          ),
      };
    });
  }

  async #grantHolders(session: Session, groupId: string, resource: string): Promise<readonly string[]> {
    const grants: readonly AuthorizationGrant[] = await session.adapter.readGrants(session.token);
    return grants.find((grant) => grant.groupId === groupId && grant.resource === resource)?.userIds ?? [];
  }

  async #session(): Promise<Session> {
    const center = await this.#oidc.center(),
      authority = { url: center.url, realm: center.realm, clientId: resourceServerClientId },
      adapter = center.provider.withFetchPort?.(this.#ports.fetch) ?? center.provider;
    return {
      authority,
      realmAdmin: center,
      token: center.accessToken,
      adapter,
    };
  }

  #records(operationId: string): readonly Readonly<Record<string, unknown>>[] {
    return this.#ports.journal
      .read()
      .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>)
      .filter((record) => record.operationId === operationId);
  }
}

function groupVersion(group: AuthorizationPolicyGroup): string {
  return createHash("sha256")
    .update(
      stableStringify({
        id: group.id,
        displayName: group.displayName,
        scopes: group.scopes,
        composites: group.composites,
      }),
    )
    .digest("hex");
}

/** An unregistered node has the empty version, which is what a first registration expects. */
function nodeVersion(node: AuthorizationNode | undefined): string {
  return node ? String(node.revision) : "";
}

function deviceListVersion(nodes: readonly AuthorizationNode[]): string {
  return JSON.stringify(nodes.map((node) => [node.nodeId, node.revision]));
}

function inheritedGroupIds(byId: ReadonlyMap<string, AuthorizationPolicyGroup>, groupId: string): readonly string[] {
  const seen = new Set<string>(),
    visit = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const composite of byId.get(id)?.composites ?? []) visit(composite);
    };
  visit(groupId);
  return [...seen];
}

function canonicalResource(value: string | undefined): string {
  try {
    return encodeAuthorizationResource(decodeAuthorizationResource(text(value, "resource")));
  } catch (error) {
    throw coded("access_resource_invalid", error instanceof Error ? error.message : String(error));
  }
}

function credentialReservation(file: string): ReturnType<typeof reserveCredentialFile> & { readonly file: string } {
  if (!path.isAbsolute(file))
    throw coded("credential_file_unavailable", `The credential file must be an absolute path; got ${file}.`);
  try {
    return { file, ...reserveCredentialFile(file) };
  } catch (error) {
    throw Object.assign(
      coded(
        "credential_file_unavailable",
        `The credential file ${file} could not be created (${(error as NodeJS.ErrnoException).code}); an existing file is never overwritten. Nothing was registered.`,
      ),
      { cause: error },
    );
  }
}

/** Removal retains a disabled tombstone; only a removed-state expectation permits fleet cleanup. */
function removedNode(expect: unknown): string | null {
  if (typeof expect !== "object" || expect === null || (expect as { kind?: unknown }).kind !== "node") return null;
  const node = expect as { nodeId?: unknown; state?: unknown };
  return typeof node.nodeId === "string" && node.state === "removed" ? node.nodeId : null;
}

function unsettled(operationId: string): Error {
  return coded(
    "access_receipt_unsettled",
    `Operation ${operationId} reached Keycloak without a settled receipt; reconcile it by operationId instead of repeating it.`,
  );
}

function teamVersion(name: string, members: readonly string[]): string {
  return sha256Text(stableStringify({ name, members: [...members].sort() }));
}

import {
  actionDeclarations,
  assertAcyclicPolicyGroups,
  deriveBasePolicyGroups,
  effectivePolicyGroupScopes,
  encodeAuthorizationResource,
  type AuthorizationGrant,
  type AuthorizationIdentityDirectoryPort,
  type AuthorizationNode,
  type AuthorizationNodeCredentialPort,
  type AuthorizationPermissionDecision,
  type AuthorizationPolicyAdministrationPort,
  type AuthorizationPolicyGroup,
  type AuthorizationResource,
  type AuthorizationDecisionPort,
  type PolicyGroup,
} from "@harness-anything/kernel";
import { randomUUID } from "node:crypto";
import {
  builtinSessionLifetimeBounds,
  findSession,
  hashSecret,
  hashToken,
  readState,
  type BuiltinState,
  type BuiltinStoredNode,
  type BuiltinUser,
  writeState,
  verifySecret,
} from "./state.ts";

export interface BuiltinPolicyAdapterConfig {
  readonly userRoot: string;
  readonly resourceServerClientId?: string;
  readonly mode?: "builtin";
}
export type BuiltinPolicyGroup = AuthorizationPolicyGroup;
export type BuiltinGrant = AuthorizationGrant;
export type BuiltinNode = AuthorizationNode;
export type BuiltinPermissionDecision = AuthorizationPermissionDecision;

export class BuiltinPolicyAdapter
  implements
    AuthorizationPolicyAdministrationPort,
    AuthorizationIdentityDirectoryPort,
    AuthorizationNodeCredentialPort,
    AuthorizationDecisionPort
{
  readonly policyRef = "builtin-policy@1";
  readonly authority = "builtin";
  readonly deniedReasonCode = "builtin_denied";
  readonly sessionLifetimeBounds = builtinSessionLifetimeBounds;
  readonly #root: string;
  readonly #knownScopes = new Set(actionDeclarations.map((item) => item.policyAction));
  #centerToken: string | undefined;
  constructor(config: BuiltinPolicyAdapterConfig) {
    this.#root = config.userRoot;
  }
  withFetchPort(): BuiltinPolicyAdapter {
    return new BuiltinPolicyAdapter({ userRoot: this.#root });
  }
  readSessionLifetime(token: string): Promise<number> {
    this.#assertCenter(token);
    return Promise.resolve(readState(this.#root).sessionLifetimeSeconds);
  }
  writeSessionLifetime(token: string, seconds: number): Promise<void> {
    return this.#write(token, (state) => ({ ...state, sessionLifetimeSeconds: boundedLifetime(seconds) }));
  }
  async syncBasePolicy(token: string): Promise<{ readonly scopeCount: number; readonly groupCount: number }> {
    this.#assertCenter(token);
    const base = deriveBasePolicyGroups();
    assertAcyclicPolicyGroups(base);
    return Object.freeze({ scopeCount: this.#knownScopes.size, groupCount: base.length });
  }
  validatePolicyGroups(groups: readonly PolicyGroup[]): void {
    assertAcyclicPolicyGroups(groups);
    for (const group of groups)
      for (const scope of group.scopes)
        if (!this.#knownScopes.has(scope)) throw new Error(`Unknown built-in action scope ${scope}.`);
  }
  syncLoginClients(token: string): Promise<void> {
    this.#assertCenter(token);
    return Promise.resolve();
  }
  async readPolicyGroups(token: string): Promise<readonly BuiltinPolicyGroup[]> {
    this.#assertCenter(token);
    const state = readState(this.#root);
    return Object.freeze(
      [
        ...deriveBasePolicyGroups().map((group) => Object.freeze({ ...group, displayName: group.id })),
        ...state.groups,
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  }
  async writePolicyGroup(
    token: string,
    group: BuiltinPolicyGroup,
    current: BuiltinPolicyGroup | undefined,
  ): Promise<void> {
    this.#assertCenter(token);
    this.validatePolicyGroups([group]);
    await this.#write(token, (state) => {
      const groups = state.groups.filter((item) => item.id !== group.id);
      if (current && current.id !== group.id)
        throw new Error(`Built-in policy group ${group.id} changed concurrently.`);
      return {
        ...state,
        groups: [
          ...groups,
          Object.freeze({
            id: group.id,
            base: false,
            displayName: group.displayName,
            scopes: [...group.scopes],
            composites: [...group.composites],
          }),
        ],
      };
    });
  }
  async deletePolicyGroup(token: string, groupId: string): Promise<void> {
    this.#assertCenter(token);
    await this.#write(token, (state) => ({
      ...state,
      groups: state.groups.filter((group) => group.id !== groupId),
      grants: state.grants.filter((grant) => grant.groupId !== groupId),
    }));
  }
  async readGrants(token: string): Promise<readonly BuiltinGrant[]> {
    this.#assertCenter(token);
    return Object.freeze(
      readState(this.#root).grants.map((grant) => Object.freeze({ ...grant, userIds: [...grant.userIds].sort() })),
    );
  }
  async writeGrant(token: string, grant: BuiltinGrant, scopes: readonly string[]): Promise<void> {
    this.#assertCenter(token);
    for (const scope of scopes)
      if (!this.#knownScopes.has(scope)) throw new Error(`Unknown built-in action scope ${scope}.`);
    await this.#write(token, (state) => ({
      ...state,
      grants: [
        ...state.grants.filter((item) => !(item.groupId === grant.groupId && item.resource === grant.resource)),
        { groupId: grant.groupId, resource: grant.resource, userIds: [...new Set(grant.userIds)] },
      ],
    }));
  }
  async claimRepositoryOwner(token: string, repoId: string, personId: string): Promise<void> {
    this.#assertCenter(token);
    const state = readState(this.#root),
      user = state.users.find((item) => item.personId === personId);
    if (!user)
      throw Object.assign(new Error(`No built-in account carries Harness person ${personId}.`), {
        code: "access_person_unknown",
      });
    const owner = state.repositoryOwners[repoId];
    if (owner && owner !== personId)
      throw Object.assign(new Error(`Repository ${repoId} is already claimed by the center.`), {
        code: "repository_already_claimed",
      });
    await this.#write(token, (next) => ({
      ...next,
      repositoryOwners: { ...next.repositoryOwners, [repoId]: personId },
      grants: [
        ...next.grants.filter((grant) => !(grant.groupId === "admin" && grant.resource === repoId)),
        { groupId: "admin", resource: repoId, userIds: [user.userId] },
      ],
    }));
  }
  async materializeGrants(token: string, groupIds?: ReadonlySet<string>): Promise<void> {
    this.#assertCenter(token);
    const state = readState(this.#root),
      groups = [...deriveBasePolicyGroups().map((group) => ({ ...group, displayName: group.id })), ...state.groups];
    for (const grant of state.grants)
      if (!groupIds || groupIds.has(grant.groupId))
        await this.writeGrant(token, grant, effectivePolicyGroupScopes(groups, grant.groupId));
  }
  async readPeople(
    token: string,
  ): Promise<readonly { readonly userId: string; readonly personId: string; readonly username: string }[]> {
    this.#assertCenter(token);
    return Object.freeze(
      readState(this.#root)
        .users.map(({ userId, personId, username }) => ({ userId, personId, username }))
        .sort((a, b) => a.personId.localeCompare(b.personId)),
    );
  }
  async findUserId(token: string, personId: string): Promise<string | undefined> {
    this.#assertCenter(token);
    return readState(this.#root).users.find((user) => user.personId === personId)?.userId;
  }
  async readPersonTeams(token: string, personId: string): Promise<readonly string[]> {
    this.#assertCenter(token);
    const user = this.#user(personId);
    return Object.freeze([...user.teamIds]);
  }
  async readTeam(token: string, teamId: string): Promise<{ readonly id: string; readonly name: string }> {
    this.#assertCenter(token);
    const team = readState(this.#root).teams.find((item) => item.id === teamId);
    if (!team) throw new Error(`Built-in work team ${teamId} is missing.`);
    return { id: team.id, name: team.name };
  }
  async readTeams(token: string): Promise<readonly { readonly id: string; readonly name: string }[]> {
    this.#assertCenter(token);
    return Object.freeze(
      readState(this.#root)
        .teams.map(({ id, name }) => ({ id, name }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  }
  async readTeamMembers(token: string, teamId: string): Promise<readonly string[]> {
    this.#assertCenter(token);
    return Object.freeze(
      readState(this.#root)
        .teams.find((team) => team.id === teamId)
        ?.memberUserIds.slice()
        .sort() ?? [],
    );
  }
  async createTeam(token: string, name: string): Promise<void> {
    this.#assertCenter(token);
    await this.#write(token, (state) => ({
      ...state,
      teams: [...state.teams, { id: randomUUID(), name, memberUserIds: [] }],
    }));
  }
  async updateTeam(token: string, teamId: string, name: string): Promise<void> {
    this.#assertCenter(token);
    await this.#write(token, (state) => ({
      ...state,
      teams: state.teams.map((team) => (team.id === teamId ? { ...team, name } : team)),
    }));
  }
  async deleteTeam(token: string, teamId: string): Promise<void> {
    this.#assertCenter(token);
    await this.#write(token, (state) => ({
      ...state,
      teams: state.teams.filter((team) => team.id !== teamId),
      users: state.users.map((user) => ({ ...user, teamIds: user.teamIds.filter((id) => id !== teamId) })),
    }));
  }
  async setTeamMember(token: string, teamId: string, userId: string, held: boolean): Promise<void> {
    this.#assertCenter(token);
    await this.#write(token, (state) => ({
      ...state,
      teams: state.teams.map((team) =>
        team.id === teamId
          ? {
              ...team,
              memberUserIds: held
                ? [...new Set([...team.memberUserIds, userId])]
                : team.memberUserIds.filter((id) => id !== userId),
            }
          : team,
      ),
      users: state.users.map((user) =>
        user.userId === userId
          ? {
              ...user,
              teamIds: held ? [...new Set([...user.teamIds, teamId])] : user.teamIds.filter((id) => id !== teamId),
            }
          : user,
      ),
    }));
  }
  async readNodes(token: string): Promise<readonly BuiltinNode[]> {
    this.#assertCenter(token);
    return Object.freeze(
      readState(this.#root)
        .nodes.map(({ credentialHash: _credentialHash, ...node }) => node)
        .sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    );
  }
  async readNode(token: string, nodeId: string): Promise<BuiltinNode | undefined> {
    this.#assertCenter(token);
    const node = readState(this.#root).nodes.find((item) => item.nodeId === nodeId);
    if (!node) return undefined;
    const { credentialHash: _credentialHash, ...publicNode } = node;
    return publicNode;
  }
  async createNode(
    token: string,
    registration: Pick<AuthorizationNode, "nodeId" | "personId"> &
      Partial<Pick<AuthorizationNode, "systemName" | "displayName" | "platform" | "registeredAt">>,
    secret: string,
  ): Promise<void> {
    this.#assertCenter(token);
    const node: BuiltinStoredNode = {
      nodeId: registration.nodeId,
      personId: registration.personId,
      systemName: registration.systemName ?? registration.nodeId,
      displayName: registration.displayName ?? registration.nodeId,
      platform: registration.platform ?? "unknown",
      registeredAt: registration.registeredAt ?? new Date().toISOString(),
      state: "active",
      revision: 1,
      revocation: "complete",
      credentialHash: hashToken(secret),
    };
    await this.#write(token, (state) =>
      state.nodes.some((item) => item.nodeId === node.nodeId) ? state : { ...state, nodes: [...state.nodes, node] },
    );
  }
  async writeNode(token: string, node: BuiltinNode): Promise<void> {
    this.#assertCenter(token);
    await this.#write(token, (state) => ({
      ...state,
      nodes: state.nodes.map((item) => (item.nodeId === node.nodeId ? { ...item, ...node } : item)),
    }));
  }
  async rotateNodeCredential(token: string, node: BuiltinNode, secret: string): Promise<void> {
    this.#assertCenter(token);
    await this.#write(token, (state) => ({
      ...state,
      nodes: state.nodes.map((item) =>
        item.nodeId === node.nodeId ? { ...item, ...node, credentialHash: hashToken(secret) } : item,
      ),
    }));
  }
  async deleteNode(token: string, nodeId: string): Promise<void> {
    this.#assertCenter(token);
    const current = await this.readNode(token, nodeId);
    if (current) await this.revokeNode(token, current);
  }
  async revokeNode(token: string, node: BuiltinNode): Promise<void> {
    await this.revokeNodes(token, [node]);
  }
  async transferNode(token: string, node: BuiltinNode, _previousPersonId: string): Promise<void> {
    await this.writeNode(token, node);
  }
  async revokeNodes(token: string, nodes: readonly BuiltinNode[]): Promise<void> {
    this.#assertCenter(token);
    for (const node of nodes)
      await this.writeNode(token, { ...node, state: "removed", revision: node.revision + 1, revocation: "complete" });
  }
  async revokeNodeConsent(token: string, nodeId: string, _consentPersonId?: string): Promise<void> {
    this.#assertCenter(token);
    if (!readState(this.#root).nodes.some((node) => node.nodeId === nodeId))
      throw new Error(`Built-in node ${nodeId} is missing.`);
  }
  async authenticateNode(nodeId: string, credential: string): Promise<boolean> {
    const node = readState(this.#root).nodes.find((item) => item.nodeId === nodeId);
    return (
      !!node && node.state === "active" && node.revocation === "complete" && verifyHash(credential, node.credentialHash)
    );
  }
  async authorize(input: {
    readonly userAccessToken: string;
    readonly action: string;
    readonly resource: AuthorizationResource;
    readonly resourceAncestors?: readonly AuthorizationResource[];
  }): Promise<BuiltinPermissionDecision> {
    const session = findSession(readState(this.#root), input.userAccessToken);
    return this.#decision(session?.personId, input.action, input.resource, input.resourceAncestors);
  }
  async authorizePerson(input: {
    readonly adminAccessToken: string;
    readonly personId: string;
    readonly action: string;
    readonly resource: AuthorizationResource;
    readonly resourceAncestors?: readonly AuthorizationResource[];
  }): Promise<BuiltinPermissionDecision> {
    this.#assertCenter(input.adminAccessToken);
    return this.#decision(input.personId, input.action, input.resource, input.resourceAncestors);
  }
  async validateUserAccessToken(token: string, personId: string): Promise<boolean> {
    return findSession(readState(this.#root), token)?.personId === personId;
  }
  /** Session service uses this to mint the one center credential without exposing state internals. */
  issueCenterToken(): string {
    if (this.#centerToken && this.#isCenter(this.#centerToken)) return this.#centerToken;
    const token = `builtin-center.${randomUUID()}`;
    this.#centerToken = token;
    this.#writeUnchecked((state) => ({
      ...state,
      centerTokenHashes: [...new Set([...state.centerTokenHashes, hashToken(token)])],
    }));
    return token;
  }
  registerSession(token: string, record: Omit<import("./state.ts").BuiltinSessionRecord, "tokenHash">): void {
    this.#writeUnchecked((state) => ({
      ...state,
      sessions: [
        ...state.sessions.filter((item) => item.tokenHash !== hashToken(token)),
        { ...record, tokenHash: hashToken(token) },
      ],
    }));
  }
  removeSession(token: string): void {
    this.#writeUnchecked((state) => ({
      ...state,
      sessions: state.sessions.filter((item) => item.tokenHash !== hashToken(token)),
    }));
  }
  userByUsername(username: string): BuiltinUser | undefined {
    return readState(this.#root).users.find((user) => user.username === username);
  }
  verifyPassword(user: BuiltinUser, password: string): boolean {
    return verifySecret(password, user.passwordSalt, user.passwordHash);
  }
  addUser(
    input: Omit<BuiltinUser, "userId" | "passwordSalt" | "passwordHash" | "roles" | "teamIds"> & {
      readonly password: string;
      readonly roles?: readonly string[];
    },
  ): BuiltinUser {
    const existing = readState(this.#root).users.find(
      (user) => user.username === input.username || user.personId === input.personId,
    );
    if (existing) {
      throw Object.assign(new Error("A built-in account already uses this username or person ID."), {
        code: existing.username === input.username ? "account_username_taken" : "account_person_taken",
      });
    }
    const hashed = hashSecret(input.password),
      user: BuiltinUser = {
        userId: randomUUID(),
        personId: input.personId,
        username: input.username,
        email: input.email,
        displayName: input.displayName,
        passwordSalt: hashed.salt,
        passwordHash: hashed.hash,
        roles: [...(input.roles ?? [])],
        teamIds: [],
      };
    const state = readState(this.#root);
    writeState(this.#root, { ...state, users: [...state.users, user] });
    return user;
  }
  users(): readonly BuiltinUser[] {
    return readState(this.#root).users;
  }
  #decision(
    personId: string | undefined,
    action: string,
    resourceValue: AuthorizationResource,
    ancestors: readonly AuthorizationResource[] = [],
  ): BuiltinPermissionDecision {
    const resource = encodeAuthorizationResource(resourceValue),
      denied = (reasonCode: string): BuiltinPermissionDecision =>
        Object.freeze({ outcome: "denied", reasonCode, resource, scope: action });
    if (!this.#knownScopes.has(action)) return denied("unknown_scope");
    if (!personId) return denied(this.deniedReasonCode);
    const state = readState(this.#root),
      user = state.users.find((item) => item.personId === personId);
    if (!user) return denied(this.deniedReasonCode);
    const groups = [...deriveBasePolicyGroups().map((group) => ({ ...group, displayName: group.id })), ...state.groups],
      covered = coveringResources(resourceValue, ancestors);
    for (const grant of state.grants)
      if (
        grant.userIds.includes(user.userId) &&
        covered.includes(grant.resource) &&
        effectivePolicyGroupScopes(groups, grant.groupId).includes(action)
      )
        return Object.freeze({ outcome: "allowed", reasonCode: "builtin_allowed", resource, scope: action });
    return denied(this.deniedReasonCode);
  }
  #user(personId: string): BuiltinUser {
    const user = readState(this.#root).users.find((item) => item.personId === personId);
    if (!user) throw new Error(`Built-in account ${personId} is missing.`);
    return user;
  }
  #isCenter(token: string): boolean {
    return readState(this.#root).centerTokenHashes.includes(hashToken(token));
  }
  #assertCenter(token: string): void {
    if (!this.#isCenter(token))
      throw Object.assign(new Error("Built-in center credential is invalid."), { code: "rbac_admin_unavailable" });
  }
  async #write(token: string, update: (state: BuiltinState) => BuiltinState): Promise<void> {
    this.#assertCenter(token);
    await this.#writeUnchecked(update);
  }
  #writeUnchecked(update: (state: BuiltinState) => BuiltinState): void {
    writeState(this.#root, update(readState(this.#root)));
  }
}
function verifyHash(value: string, expected: string): boolean {
  return hashToken(value) === expected;
}
function boundedLifetime(seconds: number): number {
  return Math.max(
    builtinSessionLifetimeBounds.minimumSeconds,
    Math.min(builtinSessionLifetimeBounds.maximumSeconds, Math.floor(seconds)),
  );
}
function coveringResources(
  resource: AuthorizationResource,
  ancestors: readonly AuthorizationResource[],
): readonly string[] {
  const encoded = encodeAuthorizationResource(resource);
  return resource.kind === "entity"
    ? [
        ...new Set([
          encodeAuthorizationResource({ kind: "repository", repoId: resource.repoId }),
          ...ancestors.map(encodeAuthorizationResource),
          encoded,
        ]),
      ]
    : [encoded];
}

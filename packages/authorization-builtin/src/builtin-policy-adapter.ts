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
  type BuiltinUser,
  writeState,
  verifySecret,
} from "./state.ts";
import { identityPluginRequired } from "./collaboration.ts";

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
    this.#user(personId);
    return Object.freeze([]);
  }
  async readTeam(token: string, teamId: string): Promise<{ readonly id: string; readonly name: string }> {
    this.#assertCenter(token);
    void teamId;
    throw identityPluginRequired();
  }
  async readTeams(token: string): Promise<readonly { readonly id: string; readonly name: string }[]> {
    this.#assertCenter(token);
    throw identityPluginRequired();
  }
  async readTeamMembers(token: string, teamId: string): Promise<readonly string[]> {
    this.#assertCenter(token);
    void teamId;
    throw identityPluginRequired();
  }
  async createTeam(token: string, name: string): Promise<void> {
    this.#assertCenter(token);
    void name;
    throw identityPluginRequired();
  }
  async updateTeam(token: string, teamId: string, name: string): Promise<void> {
    this.#assertCenter(token);
    void teamId;
    void name;
    throw identityPluginRequired();
  }
  async deleteTeam(token: string, teamId: string): Promise<void> {
    this.#assertCenter(token);
    void teamId;
    throw identityPluginRequired();
  }
  async setTeamMember(token: string, teamId: string, userId: string, held: boolean): Promise<void> {
    this.#assertCenter(token);
    void teamId;
    void userId;
    void held;
    throw identityPluginRequired();
  }
  async readNodes(token: string): Promise<readonly BuiltinNode[]> {
    this.#assertCenter(token);
    throw identityPluginRequired();
  }
  async readNode(token: string, nodeId: string): Promise<BuiltinNode | undefined> {
    this.#assertCenter(token);
    void nodeId;
    throw identityPluginRequired();
  }
  async createNode(
    token: string,
    registration: Pick<AuthorizationNode, "nodeId" | "personId"> &
      Partial<Pick<AuthorizationNode, "systemName" | "displayName" | "platform" | "registeredAt">>,
    secret: string,
  ): Promise<void> {
    this.#assertCenter(token);
    void registration;
    void secret;
    throw identityPluginRequired();
  }
  async writeNode(token: string, node: BuiltinNode): Promise<void> {
    this.#assertCenter(token);
    void node;
    throw identityPluginRequired();
  }
  async rotateNodeCredential(token: string, node: BuiltinNode, secret: string): Promise<void> {
    this.#assertCenter(token);
    void node;
    void secret;
    throw identityPluginRequired();
  }
  async deleteNode(token: string, nodeId: string): Promise<void> {
    this.#assertCenter(token);
    void nodeId;
    throw identityPluginRequired();
  }
  async revokeNode(token: string, node: BuiltinNode): Promise<void> {
    this.#assertCenter(token);
    void node;
    throw identityPluginRequired();
  }
  async transferNode(token: string, node: BuiltinNode, _previousPersonId: string): Promise<void> {
    this.#assertCenter(token);
    void node;
    throw identityPluginRequired();
  }
  async revokeNodes(token: string, nodes: readonly BuiltinNode[]): Promise<void> {
    this.#assertCenter(token);
    void nodes;
    throw identityPluginRequired();
  }
  async revokeNodeConsent(token: string, nodeId: string, _consentPersonId?: string): Promise<void> {
    this.#assertCenter(token);
    void nodeId;
    throw identityPluginRequired();
  }
  async authenticateNode(nodeId: string, credential: string): Promise<boolean> {
    void nodeId;
    void credential;
    throw identityPluginRequired();
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
    input: Omit<BuiltinUser, "userId" | "passwordSalt" | "passwordHash" | "roles"> & {
      readonly password: string;
      readonly roles?: readonly string[];
    },
  ): BuiltinUser {
    if (readState(this.#root).users.length > 0) throw identityPluginRequired();
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

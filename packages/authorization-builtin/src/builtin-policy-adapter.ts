import {
  actionDeclarations,
  baseEntityPolicyActions,
  executionCredentialRejected,
  type RuntimeExecutionPrincipal,
  assertAcyclicPolicyGroups,
  deriveBasePolicyGroups,
  effectivePolicyGroupScopes,
  encodeAuthorizationResource,
  registeredArtifactActionPolicyActions,
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
import { randomBytes, randomUUID } from "node:crypto";
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
  /** Canonical accepted Artifact scopes, read from durable declarations in another process. */
  readonly readArtifactActionScopes?: () => Promise<readonly string[]>;
}
export type BuiltinPolicyGroup = AuthorizationPolicyGroup;
export type BuiltinNode = AuthorizationNode;
export type BuiltinPermissionDecision = AuthorizationPermissionDecision;

export class BuiltinPolicyAdapter
  implements
    AuthorizationPolicyAdministrationPort,
    AuthorizationIdentityDirectoryPort,
    AuthorizationNodeCredentialPort,
    AuthorizationDecisionPort
{
  readonly credentialCapabilities = Object.freeze({ changeOwn: true, resetOthers: false });
  readonly policyRef = "builtin-policy@1";
  readonly authority = "builtin";
  readonly deniedReasonCode = "builtin_denied";
  readonly sessionLifetimeBounds = builtinSessionLifetimeBounds;
  readonly #root: string;
  readonly #knownScopes = new Set([...actionDeclarations.map((item) => item.policyAction), ...baseEntityPolicyActions]);
  readonly #readArtifactActionScopes: () => Promise<readonly string[]>;
  #centerToken: string | undefined;
  constructor(config: BuiltinPolicyAdapterConfig) {
    this.#root = config.userRoot;
    this.#readArtifactActionScopes =
      config.readArtifactActionScopes ?? (async () => registeredArtifactActionPolicyActions());
  }
  withFetchPort(): BuiltinPolicyAdapter {
    return new BuiltinPolicyAdapter({ userRoot: this.#root, readArtifactActionScopes: this.#readArtifactActionScopes });
  }
  async issueExecutionCredential(token: string, principal: RuntimeExecutionPrincipal): Promise<string> {
    this.#assertCenter(token);
    if (principal.source !== "local") throw identityPluginRequired();
    if (this.owner()?.personId !== principal.personId) throw executionCredentialRejected();
    const credential = `harness-execution-${principal.dispatchId}:${randomBytes(32).toString("base64url")}`;
    this.#writeUnchecked((state) => ({
      ...state,
      sessions: [
        ...state.sessions.filter((session) => session.executionPrincipal?.dispatchId !== principal.dispatchId),
        {
          tokenHash: hashToken(credential),
          personId: principal.personId,
          subject: `execution:${principal.dispatchId}`,
          expiresAt: Date.parse(principal.expiresAt),
          sessionExpiresAt: null,
          roles: [],
          executionPrincipal: principal,
        },
      ],
    }));
    return credential;
  }
  async authenticateExecutionCredential(token: string, credential: string): Promise<RuntimeExecutionPrincipal> {
    this.#assertCenter(token);
    const session = readState(this.#root).sessions.find((entry) => entry.tokenHash === hashToken(credential));
    if (!session?.executionPrincipal) throw executionCredentialRejected("authentication");
    return this.readExecutionPrincipal(token, session.executionPrincipal.dispatchId);
  }
  async readExecutionPrincipal(token: string, dispatchId: string): Promise<RuntimeExecutionPrincipal> {
    this.#assertCenter(token);
    const session = readState(this.#root).sessions.find((entry) => entry.executionPrincipal?.dispatchId === dispatchId);
    if (!session?.executionPrincipal) throw executionCredentialRejected("revoked");
    if (session.expiresAt <= Date.now()) throw executionCredentialRejected("expired");
    return session.executionPrincipal;
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
    const artifactScopes = await this.#readArtifactActionScopes(),
      base = deriveBasePolicyGroups(actionDeclarations, artifactScopes);
    assertAcyclicPolicyGroups(base);
    await this.materializeGrants(token);
    return Object.freeze({ scopeCount: this.#knownScopes.size + artifactScopes.length, groupCount: base.length });
  }
  validatePolicyGroups(groups: readonly PolicyGroup[]): void {
    assertAcyclicPolicyGroups(groups);
    for (const group of groups)
      for (const scope of group.scopes)
        if (
          !this.#knownScopes.has(scope) &&
          !/^entity-kind\/KND-[0-9a-f]{32}\/(?:import|update|archive|delete)$/u.test(scope)
        )
          throw new Error(`Unknown built-in action scope ${scope}.`);
  }
  syncLoginClients(token: string): Promise<void> {
    this.#assertCenter(token);
    return Promise.resolve();
  }
  async readPolicyGroups(token: string): Promise<readonly BuiltinPolicyGroup[]> {
    this.#assertCenter(token);
    const scopes = await this.#readArtifactActionScopes();
    return [
      ...deriveBasePolicyGroups(actionDeclarations, scopes).map((group) => ({ ...group, displayName: group.id })),
      ...(readState(this.#root).policyGroups ?? []),
    ];
  }
  async writePolicyGroup(
    token: string,
    group: BuiltinPolicyGroup,
    current: BuiltinPolicyGroup | undefined,
  ): Promise<void> {
    this.#assertCenter(token);
    void current;
    await this.#write(token, (state) => ({
      ...state,
      policyGroups: [...(state.policyGroups ?? []).filter((item) => item.id !== group.id), group],
    }));
  }
  async deletePolicyGroup(token: string, groupId: string): Promise<void> {
    this.#assertCenter(token);
    await this.#write(token, (state) => ({
      ...state,
      policyGroups: (state.policyGroups ?? []).filter((item) => item.id !== groupId),
    }));
  }
  async readGrants(token: string): Promise<readonly AuthorizationGrant[]> {
    this.#assertCenter(token);
    return this.#grants(readState(this.#root)).map(({ scopes: _scopes, ...grant }) => grant);
  }
  async writeGrant(token: string, grant: AuthorizationGrant, scopes: readonly string[]): Promise<void> {
    this.#assertCenter(token);
    const owner = this.owner();
    if (grant.userIds.some((userId) => userId !== owner?.userId)) throw identityPluginRequired();
    await this.#write(token, (state) => ({
      ...state,
      grants: [
        ...this.#grants(state).filter((item) => item.groupId !== grant.groupId || item.resource !== grant.resource),
        ...(grant.userIds.length ? [{ ...grant, scopes }] : []),
      ],
    }));
  }
  async claimRepositoryOwner(token: string, repoId: string, personId: string): Promise<void> {
    this.#assertCenter(token);
    const state = readState(this.#root),
      user = state.owner?.personId === personId ? state.owner : undefined;
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
    }));
    if (!owner)
      await this.writeGrant(
        token,
        { groupId: "admin", resource: repoId, userIds: [user.userId] },
        effectivePolicyGroupScopes(await this.readPolicyGroups(token), "admin"),
      );
  }
  async materializeGrants(token: string, groupIds?: ReadonlySet<string>): Promise<void> {
    this.#assertCenter(token);
    const groups = await this.readPolicyGroups(token);
    for (const grant of await this.readGrants(token))
      if (groupIds?.has(grant.groupId) ?? true)
        await this.writeGrant(
          token,
          grant,
          groups.some((group) => group.id === grant.groupId) ? effectivePolicyGroupScopes(groups, grant.groupId) : [],
        );
  }
  async readPeople(
    token: string,
  ): Promise<readonly { readonly userId: string; readonly personId: string; readonly username: string }[]> {
    this.#assertCenter(token);
    const owner = this.owner();
    return owner ? [{ userId: owner.userId, personId: owner.personId, username: owner.username }] : [];
  }
  async findUserId(token: string, personId: string): Promise<string | undefined> {
    this.#assertCenter(token);
    const owner = readState(this.#root).owner;
    return owner?.personId === personId ? owner.userId : undefined;
  }
  async writePasswordCredential(token: string, personId: string, password: string): Promise<void> {
    this.#assertCenter(token);
    if (password.length === 0)
      throw Object.assign(new Error("A password cannot be empty."), { code: "password_invalid" });
    const state = readState(this.#root),
      owner = state.owner;
    if (!owner || owner.personId !== personId)
      throw Object.assign(new Error(`No built-in account carries Harness person ${personId}.`), {
        code: "access_person_unknown",
      });
    const next = hashSecret(password);
    await this.#write(token, (current) => ({
      ...current,
      owner: { ...owner, passwordSalt: next.salt, passwordHash: next.hash },
    }));
  }
  async readPersonTeams(token: string, personId: string): Promise<readonly string[]> {
    this.#assertCenter(token);
    if (this.owner()?.personId !== personId)
      throw Object.assign(new Error(`No built-in account carries Harness person ${personId}.`), {
        code: "access_person_unknown",
      });
    return [];
  }
  async readTeam(token: string, teamId: string): Promise<{ readonly id: string; readonly name: string }> {
    this.#assertCenter(token);
    void teamId;
    throw identityPluginRequired();
  }
  async readTeams(token: string): Promise<readonly { readonly id: string; readonly name: string }[]> {
    this.#assertCenter(token);
    return [];
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
    return [];
  }
  async readNode(token: string, nodeId: string): Promise<BuiltinNode | undefined> {
    this.#assertCenter(token);
    void nodeId;
    return undefined;
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
    if (nodes.length) throw identityPluginRequired();
  }
  async revokeNodeConsent(token: string, nodeId: string, _consentPersonId?: string): Promise<void> {
    this.#assertCenter(token);
    void nodeId;
    throw identityPluginRequired();
  }
  async authenticateNode(nodeId: string, credential: string): Promise<boolean> {
    void nodeId;
    void credential;
    return false;
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
    const owner = readState(this.#root).owner;
    return owner?.username === username ? owner : undefined;
  }
  verifyPassword(user: BuiltinUser, password: string): boolean {
    return verifySecret(password, user.passwordSalt, user.passwordHash);
  }
  addUser(
    input: Omit<BuiltinUser, "userId" | "passwordSalt" | "passwordHash"> & { readonly password: string },
  ): BuiltinUser {
    const state = readState(this.#root);
    if (state.owner)
      throw Object.assign(new Error("The built-in owner account has already been created."), {
        code: "bootstrap_admin_closed",
      });
    const hashed = hashSecret(input.password),
      user: BuiltinUser = {
        userId: randomUUID(),
        personId: input.personId,
        username: input.username,
        email: input.email,
        displayName: input.displayName,
        passwordSalt: hashed.salt,
        passwordHash: hashed.hash,
      };
    writeState(this.#root, { ...state, owner: user });
    return user;
  }
  owner(): BuiltinUser | undefined {
    return readState(this.#root).owner;
  }
  async #decision(
    personId: string | undefined,
    action: string,
    resourceValue: AuthorizationResource,
    ancestors: readonly AuthorizationResource[] = [],
  ): Promise<BuiltinPermissionDecision> {
    const resource = encodeAuthorizationResource(resourceValue),
      denied = (reasonCode: string): BuiltinPermissionDecision =>
        Object.freeze({ outcome: "denied", reasonCode, resource, scope: action });
    const artifactScopes = await this.#readArtifactActionScopes();
    if (!this.#knownScopes.has(action) && !artifactScopes.includes(action)) return denied("unknown_scope");
    if (!personId) return denied(this.deniedReasonCode);
    const state = readState(this.#root),
      user = state.owner?.personId === personId ? state.owner : undefined;
    if (!user) return denied(this.deniedReasonCode);
    // These provider actions address a shared center or another machine. Ordinary
    // repository and policy administration still use the grants below.
    switch (action) {
      case "daemon-fleet-center-start":
      case "daemon-fleet-edge-sync":
      case "daemon-node-auto-claim":
      case "daemon-connection-add":
      case "daemon-connection-update":
      case "daemon-connection-remove":
      case "daemon-connection-probe":
        throw identityPluginRequired();
    }
    const covered = coveringResources(resourceValue, ancestors);
    if (
      this.#grants(state, artifactScopes).some(
        (grant) =>
          grant.userIds.includes(user.userId) && covered.includes(grant.resource) && grant.scopes.includes(action),
      )
    )
      return Object.freeze({ outcome: "allowed", reasonCode: "builtin_allowed", resource, scope: action });
    return denied(this.deniedReasonCode);
  }
  #grants(state: BuiltinState, artifactScopes: readonly string[] = registeredArtifactActionPolicyActions()) {
    if (state.grants) return state.grants;
    if (!state.owner) return [];
    const scopes = effectivePolicyGroupScopes(deriveBasePolicyGroups(actionDeclarations, artifactScopes), "admin");
    return ["@fleet", ...Object.keys(state.repositoryOwners)].map((resource) => ({
      groupId: "admin",
      resource,
      userIds: [state.owner!.userId],
      scopes,
    }));
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

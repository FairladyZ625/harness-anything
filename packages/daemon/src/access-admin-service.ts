import { createHash } from "node:crypto";
import {
  decodeAuthorizationResource,
  effectivePolicyGroupScopes,
  encodeAuthorizationResource,
  stableStringify,
} from "@harness-anything/kernel";
import { KeycloakPolicyAdapter, type KeycloakGrant, type KeycloakPolicyGroup } from "./keycloak-policy-adapter.ts";
import { managedRbacReceiptJournal } from "./managed-rbac-service.ts";
import type { OidcSessionService } from "./oidc-session-service.ts";

export const accessAdminOperations = Object.freeze([
  "group-list",
  "group-create",
  "group-update",
  "group-delete",
  "grant",
  "revoke",
  "effective-permissions",
  "receipt-reconcile",
] as const);
export type AccessAdminOperation = (typeof accessAdminOperations)[number];

export interface AccessAdminRequest {
  readonly operation?: string;
  readonly operationId?: string;
  readonly groupId?: string;
  readonly displayName?: string;
  readonly scopes?: readonly unknown[];
  readonly composites?: readonly unknown[];
  readonly expectedVersion?: string;
  readonly personId?: string;
  readonly resource?: string;
}

export interface AccessAdminPorts {
  readonly fetch: typeof fetch;
  readonly now: () => string;
  readonly journal: ReturnType<typeof managedRbacReceiptJournal>;
}

/** What Keycloak must show once an operation took effect; reconciliation observes exactly this. */
type Expectation =
  | { readonly kind: "group"; readonly groupId: string; readonly version: string | null }
  | {
      readonly kind: "grant";
      readonly groupId: string;
      readonly resource: string;
      readonly personId: string;
      readonly held: boolean;
    };

interface Plan {
  readonly expect: Expectation;
  readonly apply: () => Promise<void>;
}

interface Conflict {
  readonly conflict: { readonly groupId: string; readonly expectedVersion: string; readonly currentVersion: string };
}

interface Session {
  readonly adapter: KeycloakPolicyAdapter;
  readonly token: string;
  readonly authority: { readonly url: string; readonly realm: string; readonly clientId: string };
}

const resourceServerClientId = "harness-center";

/**
 * Typed administration of policy groups and `(group, resource)` grants. Keycloak holds the only
 * state evaluation reads; the journal written here is an audit trail that nothing evaluates.
 */
export class AccessAdminService {
  readonly #oidc: OidcSessionService;
  readonly #ports: AccessAdminPorts;

  constructor(oidc: OidcSessionService, userRoot: string, ports: Partial<AccessAdminPorts> = {}) {
    this.#oidc = oidc;
    this.#ports = {
      fetch,
      now: () => new Date().toISOString(),
      journal: managedRbacReceiptJournal(userRoot),
      ...ports,
    };
  }

  async run(request: AccessAdminRequest): Promise<Record<string, unknown>> {
    const actor = this.#oidc.requireRole("access-admin").personId;
    switch (request.operation as AccessAdminOperation) {
      case "group-list":
        return this.#listGroups();
      case "effective-permissions":
        return this.#effectivePermissions(request);
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
      default:
        throw coded("access_operation_unknown", `Unknown access administration operation ${request.operation}.`);
    }
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
    };
  }

  #mutate(
    request: AccessAdminRequest,
    actor: string,
    plan: (session: Session) => Promise<Plan | Conflict>,
  ): Promise<Record<string, unknown>> {
    const operationId = text(request.operationId, "operationId"),
      operation = request.operation!;
    return this.#oidc.serialize(async () => {
      const recorded = this.#records(operationId);
      if (recorded.some((record) => record.phase === "settled"))
        throw coded("access_operation_settled", `Operation ${operationId} already settled; use a new operationId.`);
      if (recorded.length > 0) throw unsettled(operationId);
      const session = await this.#session(),
        planned = await plan(session),
        base = { schema: "harness-access-receipt/v1", operationId, operation, actor, authority: session.authority };
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
      // The intent lands before Keycloak changes, so a lost receipt can be reconciled without replaying the write.
      this.#ports.journal.append(
        JSON.stringify({ ...base, phase: "intent", expect: planned.expect, recordedAt: this.#ports.now() }),
      );
      await planned.apply();
      return this.#settle({ ...base, expect: planned.expect }, "applied");
    });
  }

  async #reconcile(operationId: string, actor: string): Promise<Record<string, unknown>> {
    const recorded = this.#records(operationId),
      settled = recorded.find((record) => record.phase === "settled"),
      intent = recorded.find((record) => record.phase === "intent");
    if (settled) return { ok: settled.outcome === "applied", ...settled };
    if (!intent) throw coded("access_operation_unknown", `No access operation ${operationId} is recorded.`);
    const session = await this.#session(),
      expect = intent.expect as Expectation,
      observed =
        expect.kind === "group"
          ? ((await session.adapter.readPolicyGroups(session.token))
              .filter((group) => group.id === expect.groupId)
              .map(groupVersion)[0] ?? null) === expect.version
          : (await this.#grantHolders(session, expect.groupId, expect.resource)).includes(
              (await session.adapter.findUserId(session.token, expect.personId)) ?? "",
            ) === expect.held;
    return this.#settle({ ...intent, reconciledBy: actor }, observed ? "applied" : "failed");
  }

  #settle(record: Readonly<Record<string, unknown>>, outcome: "applied" | "failed"): Record<string, unknown> {
    const receipt = { ...record, phase: "settled", outcome, settledAt: this.#ports.now() };
    try {
      this.#ports.journal.append(JSON.stringify(receipt));
    } catch (error) {
      throw Object.assign(unsettled(String(record.operationId)), { cause: error });
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
    const next: KeycloakPolicyGroup = {
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

  async #grantHolders(session: Session, groupId: string, resource: string): Promise<readonly string[]> {
    const grants: readonly KeycloakGrant[] = await session.adapter.readGrants(session.token);
    return grants.find((grant) => grant.groupId === groupId && grant.resource === resource)?.userIds ?? [];
  }

  async #session(): Promise<Session> {
    const center = await this.#oidc.center(),
      authority = { url: center.url, realm: center.realm, clientId: resourceServerClientId };
    return {
      authority,
      token: center.accessToken,
      adapter: new KeycloakPolicyAdapter(
        { url: center.url, realm: center.realm, resourceServerClientId },
        this.#ports.fetch,
      ),
    };
  }

  #records(operationId: string): readonly Readonly<Record<string, unknown>>[] {
    return this.#ports.journal
      .read()
      .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>)
      .filter((record) => record.operationId === operationId);
  }
}

function groupVersion(group: KeycloakPolicyGroup): string {
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

function inheritedGroupIds(byId: ReadonlyMap<string, KeycloakPolicyGroup>, groupId: string): readonly string[] {
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

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function names(value: readonly unknown[] | undefined, field: string): readonly string[] | undefined {
  if (value?.some((item) => typeof item !== "string"))
    throw coded("access_request_invalid", `Access administration requires ${field} to list names.`);
  return value as readonly string[] | undefined;
}

function text(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw coded("access_request_invalid", `Access administration requires ${field}.`);
  return value;
}

function unsettled(operationId: string): Error {
  return coded(
    "access_receipt_unsettled",
    `Operation ${operationId} reached Keycloak without a settled receipt; reconcile it by operationId instead of repeating it.`,
  );
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

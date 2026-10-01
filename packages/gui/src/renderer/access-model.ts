import type { AccessAction, AccessPolicyGroup, AccessReceipt, AccessRejection } from "../api/access-admin-contract.ts";
import { t, type MessageKey } from "./i18n/index.tsx";

/** The declaration facets the action picker can group by. */
export const ACTION_FACETS = ["policyTier", "executionClass", "residencyScope"] as const;
export type ActionFacet = (typeof ACTION_FACETS)[number];

/** Narrowest to widest; a value the daemon adds later still gets its own section, after these. */
const FACET_ORDER: Readonly<Record<ActionFacet, readonly string[]>> = {
  policyTier: ["contributor", "maintainer", "admin"],
  executionClass: ["repo-write", "arbiter", "admin"],
  residencyScope: ["canonical", "runtime-local", "host-local"],
};

export function groupActionsByFacet(
  actions: readonly AccessAction[],
  facet: ActionFacet,
): readonly { readonly value: string; readonly actions: readonly string[] }[] {
  const sections = new Map<string, string[]>();
  for (const action of actions) sections.set(action[facet], [...(sections.get(action[facet]) ?? []), action.action]);
  const rank = (value: string) => {
    const index = FACET_ORDER[facet].indexOf(value);
    return index < 0 ? FACET_ORDER[facet].length : index;
  };
  return [...sections]
    .sort(([left], [right]) => rank(left) - rank(right) || left.localeCompare(right))
    .map(([value, names]) => ({ value, actions: names.sort() }));
}

/** Actions a group gets from the groups it inherits, as the daemon expanded them. */
export function inheritedScopes(
  groups: readonly AccessPolicyGroup[],
  composites: Iterable<string>,
): ReadonlySet<string> {
  const inherited = new Set<string>(),
    names = new Set(composites);
  for (const group of groups) if (names.has(group.id)) for (const scope of group.effectiveScopes) inherited.add(scope);
  return inherited;
}

export type AccessScope =
  | { readonly kind: "fleet" }
  | { readonly kind: "repository"; readonly repoId: string }
  | { readonly kind: "entity"; readonly repoId: string; readonly entityRef: string };

/** The resource name a grant is made on, or null while the scope is still incomplete. */
export function resourceOfScope(scope: AccessScope): string | null {
  if (scope.kind === "fleet") return "@fleet";
  const repoId = scope.repoId.trim();
  if (repoId === "") return null;
  if (scope.kind === "repository") return repoId;
  const entityRef = scope.entityRef.trim();
  return entityRef === "" ? null : `${repoId}:${entityRef}`;
}

export function scopeOfResource(resource: string): AccessScope {
  if (resource === "@fleet") return { kind: "fleet" };
  const separator = resource.indexOf(":");
  return separator < 0
    ? { kind: "repository", repoId: resource }
    : { kind: "entity", repoId: resource.slice(0, separator), entityRef: resource.slice(separator + 1) };
}

export function resourceLabel(resource: string): string {
  const scope = scopeOfResource(resource);
  if (scope.kind === "fleet") return t("accessControl.scope.fleet");
  return scope.kind === "repository"
    ? t("accessControl.scope.repositoryNamed", { repoId: scope.repoId })
    : t("accessControl.scope.entityNamed", { repoId: scope.repoId, entityRef: scope.entityRef });
}

const REJECTION_KEYS: Readonly<Record<string, MessageKey>> = {
  authentication_required: "accessControl.error.authenticationRequired",
  authorization_denied: "accessControl.error.authorizationDenied",
  base_policy_group_read_only: "accessControl.error.baseReadOnly",
  policy_group_exists: "accessControl.error.groupExists",
  policy_group_unknown: "accessControl.error.groupUnknown",
  policy_group_in_use: "accessControl.error.groupInUse",
  version_conflict: "accessControl.error.versionConflict",
  access_person_unknown: "accessControl.error.personUnknown",
  access_resource_invalid: "accessControl.error.resourceInvalid",
  access_receipt_unsettled: "accessControl.error.receiptUnsettled",
  session_lifetime_invalid: "accessControl.error.sessionLifetimeInvalid",
  rbac_not_configured: "accessControl.error.notConfigured",
  rbac_admin_unavailable: "accessControl.error.serviceUnavailable",
  daemon_unavailable: "accessControl.error.daemonUnavailable",
};

/** What a refusal means for the person looking at it; codes without their own sentence show the daemon's. */
export function rejectionText(rejection: AccessRejection): string {
  const key = REJECTION_KEYS[rejection.code];
  if (key) return t(key);
  const code = rejection.code ?? t("accessControl.error.failed");
  return rejection.rejectionExplanation ? `${code}: ${rejection.rejectionExplanation}` : code;
}

const OPERATION_KEYS: Readonly<Record<string, MessageKey>> = {
  "group-create": "accessControl.operation.groupCreate",
  "group-update": "accessControl.operation.groupUpdate",
  "group-delete": "accessControl.operation.groupDelete",
  grant: "accessControl.operation.grant",
  revoke: "accessControl.operation.revoke",
  "session-lifetime-set": "accessControl.operation.sessionLifetimeSet",
};

/** One line saying what an operation did and to what. */
export function receiptTitle(receipt: AccessReceipt): string {
  const key = OPERATION_KEYS[receipt.operation],
    operation = key ? t(key) : receipt.operation,
    expect = receipt.expect;
  if (expect?.kind === "grant")
    return `${operation}: ${expect.groupId} · ${expect.personId} · ${resourceLabel(expect.resource)}`;
  if (expect?.kind === "session-lifetime")
    return `${operation}: ${t("accessControl.lifetime.minutes", { minutes: Math.round(expect.seconds / 60) })}`;
  const groupId = expect?.groupId ?? receipt.groupId;
  return groupId ? `${operation}: ${groupId}` : operation;
}

export function isRejection(reply: { readonly ok: boolean }): reply is AccessRejection {
  return reply.ok === false;
}

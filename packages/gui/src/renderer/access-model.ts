import type { AccessPolicyGroup, AccessReceipt, AccessRejection } from "../api/access-admin-contract.ts";
import { t, type MessageKey } from "./i18n/index.tsx";

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
  "node-register": "accessControl.operation.nodeRegister",
  "node-unregister": "accessControl.operation.nodeUnregister",
  "team-create": "accessControl.operation.teamCreate",
  "team-update": "accessControl.operation.teamUpdate",
  "team-delete": "accessControl.operation.teamDelete",
  "team-member-add": "accessControl.operation.teamMemberAdd",
  "team-member-remove": "accessControl.operation.teamMemberRemove",
};

/** One line saying what an operation did and to what. */
export function receiptTitle(receipt: AccessReceipt): string {
  const key = OPERATION_KEYS[receipt.operation],
    operation = key ? t(key) : receipt.operation,
    expect = receipt.expect;
  if (expect?.kind === "grant")
    return `${operation}: ${roleLabel(expect.groupId)} · ${expect.personId} · ${resourceLabel(expect.resource)}`;
  if (expect?.kind === "session-lifetime") return `${operation}: ${sessionDuration(expect.seconds)}`;
  const groupId = expect?.groupId ?? receipt.groupId;
  return groupId ? `${operation}: ${groupId}` : operation;
}

export function isRejection(reply: { readonly ok: boolean }): reply is AccessRejection {
  return reply.ok === false;
}

/**
 * The access system answering as designed: the signed-in account simply lacks a role. Whether that
 * may read as information is decided by the caller from the real operation origin — a read the page
 * made on its own is a permission note, while a write the person asked for keeps its error feedback.
 * This check only names the code; it does not infer what kind of operation met it.
 */
export function isPermissionRefusal(rejection: AccessRejection): boolean {
  return rejection.code === "authorization_denied";
}

/** A row per known account, including accounts without a direct grant. */
export function grantsByPerson(
  people: readonly { readonly personId: string; readonly username: string }[],
  grants: readonly import("../api/access-admin-contract.ts").AccessGrant[],
  repoId = "",
) {
  return people.map((person) => ({
    ...person,
    grants: grants.filter((grant) => {
      const scope = scopeOfResource(grant.resource);
      return grant.personId === person.personId && (repoId === "" || scope.kind === "fleet" || scope.repoId === repoId);
    }),
  }));
}

export function roleLabel(id: string, displayName = id): string {
  return ["viewer", "contributor", "maintainer", "admin"].includes(id)
    ? t(`accessControl.role.${id}` as MessageKey)
    : displayName;
}

export function sessionDuration(seconds: number): string {
  const unit = seconds % 86400 === 0 ? 86400 : seconds % 3600 === 0 ? 3600 : 60;
  return `${seconds / unit} ${t(unit === 86400 ? "accessControl.lifetime.days" : unit === 3600 ? "accessControl.lifetime.hours" : "accessControl.lifetime.minutes")}`;
}

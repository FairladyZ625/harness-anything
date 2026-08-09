import type {
  AuthorizationProvider,
  DaemonCommandClass,
  IdentityAuthorizationAction,
  IdentityAuthorizationDecision,
  IdentityAuthorizationFailure,
  IdentityAuthorizationSuccess,
  PeopleRoster,
  PersonId
} from "./types.ts";

export type AuthorizationFailure = IdentityAuthorizationFailure;
export type AuthorizationSuccess = IdentityAuthorizationSuccess;

export function authorizePersonForMethod(
  personId: PersonId,
  action: IdentityAuthorizationAction,
  roster: PeopleRoster
): IdentityAuthorizationDecision {
  if (!action.commandClass) {
    return {
      ok: false,
      code: "command_class_missing",
      message: `Method ${action.method} is missing its required commandClass mapping, so authorization cannot choose a role grant. Inspect the supported surface with \`ha daemon --help\` and upgrade the daemon with \`ha daemon upgrade --ref HEAD --json\` before retrying.`
    };
  }
  const binding = roster.people.find((person) => person.personId === personId);
  if (binding?.roles.some((roleId) => roster.roleAllows(roleId, action.commandClass!))) return { ok: true };
  return {
    ok: false,
    code: "rbac_forbidden",
    message: `Person ${personId} is forbidden from ${action.commandClass} method ${action.method} because the active PeopleRoster grants none of their assigned roles that command class. This authorization check does not know the roster source path and made no configuration change. Inspect the owning identity configuration and logs; use \`ha daemon status --json\` only to verify the active daemon before retrying after the role grant is confirmed.`
  };
}

export function makePeopleRosterAuthorizationProvider(roster: PeopleRoster): AuthorizationProvider {
  return { authorize: async ({ personId, action }) => authorizePersonForMethod(personId, action, roster) };
}

export function makePersonAuthorizationProvider(
  personId: PersonId,
  commandClasses: ReadonlyArray<DaemonCommandClass>
): AuthorizationProvider {
  const allowed = new Set(commandClasses);
  return {
    authorize: async ({ personId: candidate, action }) => {
      if (!action.commandClass) {
        return {
          ok: false,
          code: "command_class_missing",
          message: `Method ${action.method} is missing its required commandClass mapping, so authorization cannot choose a role grant. Inspect the supported surface with \`ha daemon --help\` and upgrade the daemon with \`ha daemon upgrade --ref HEAD --json\` before retrying.`
        };
      }
      if (candidate === personId && allowed.has(action.commandClass)) return { ok: true };
      return {
        ok: false,
        code: "rbac_forbidden",
        message: `Person ${candidate} is forbidden from ${action.commandClass} method ${action.method} because this authorization provider's configured command-class grant is missing. The grant comes from provider composition, not from a roster path, and this check made no configuration change. Inspect the owning authorization configuration and logs; use \`ha daemon status --json\` only to verify the active daemon before retrying after the grant is confirmed.`
      };
    }
  };
}

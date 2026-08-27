// @slice-activation PLT-Daemon W4 identity/RBAC roster exported for daemon composition and W7 team server wiring.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parsePeopleRosterDocument, resolveHarnessLayout, type HarnessLayoutInput } from "../../../kernel/src/index.ts";
import {
  credentialKey,
  type CredentialRef,
  type IdentityProviderFailure,
  type PeopleRoster,
  type PersonProfile,
} from "./types.ts";

export function loadPeopleRoster(rootInput: HarnessLayoutInput): PeopleRoster {
  const layout = resolveHarnessLayout(rootInput),
    filePath = path.join(layout.authoredRoot, "people.yaml");
  if (!existsSync(filePath)) throw new Error(`people.yaml not found: ${path.relative(layout.rootDir, filePath)}`);
  return peopleRosterFromDocument(readFileSync(filePath, "utf8"));
}

export function peopleRosterFromDocument(body: string): PeopleRoster {
  const raw = parsePeopleRosterDocument(body),
    peopleByCredential = new Map<string, PersonProfile>();
  for (const person of raw.people)
    for (const credential of person.credentials) peopleByCredential.set(credentialKey(credential), person);
  const rolesById = new Map(raw.roles.map((role) => [role.roleId, role]));
  return {
    schema: raw.schema,
    people: raw.people,
    roles: raw.roles,
    resolveCredential: (credential, providerId) => {
      const person = peopleByCredential.get(credentialKey(credential));
      if (!person)
        return credentialResolutionFailure(
          providerId,
          "credential_unknown",
          "Credential is not bound to a person.",
          credential,
        );
      if (person.disabled)
        return credentialResolutionFailure(
          providerId,
          "person_disabled",
          `Person is disabled: ${person.personId}`,
          credential,
        );
      return {
        ok: true,
        actor: {
          personId: person.personId,
          displayName: person.displayName,
          ...(person.primaryEmail ? { primaryEmail: person.primaryEmail } : {}),
          roles: person.roles,
          resolvedCredential: credential,
          providerId,
        },
      };
    },
    roleAllows: (roleId, commandClass) => rolesById.get(roleId)?.commandClasses.includes(commandClass) ?? false,
  };
}

function credentialResolutionFailure(
  providerId: string,
  code: IdentityProviderFailure["code"],
  message: string,
  credential?: CredentialRef,
): IdentityProviderFailure {
  return { ok: false, code, providerId, message, ...(credential ? { credential } : {}) };
}

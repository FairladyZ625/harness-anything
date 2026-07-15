// @slice-activation PLT-Daemon W4 identity/RBAC roster exported for daemon composition and W7 team server wiring.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../../kernel/src/index.ts";
import {
  credentialKey,
  type CredentialRef,
  type CredentialKind,
  type DaemonCommandClass,
  type IdentityProviderFailure,
  type IdentityAdminSnapshot,
  type PeopleRoster,
  type PersonRegistry,
  type PersonProfile,
  type RolePolicy
} from "./types.ts";

const commandClasses = new Set<DaemonCommandClass>(["admin", "repo-write", "repo-read", "arbiter"]);
const credentialKinds = new Set<CredentialKind>([
  "unix-socket-owner-boundary",
  "windows-named-pipe-client",
  "ssh-username",
  "ssh-forced-command-person",
  "ssh-tunnel-token-subject",
  "email-address",
  "password-account",
  "oauth-subject",
  "api-token"
]);

export function loadPeopleRoster(rootInput: HarnessLayoutInput): PeopleRoster {
  const layout = resolveHarnessLayout(rootInput);
  const filePath = path.join(layout.authoredRoot, "people.yaml");
  if (!existsSync(filePath)) {
    throw new Error(`people.yaml not found: ${path.relative(layout.rootDir, filePath)}`);
  }
  return loadPeopleRosterFile(filePath);
}

export function loadPeopleRosterFile(filePath: string): PeopleRoster {
  return peopleRosterFromDocument(readFileSync(filePath, "utf8"));
}

export function peopleRosterFromDocument(body: string): PeopleRoster {
  const raw = parsePeopleYaml(body);
  if (raw.schema !== "harness-people/v1") throw new Error("people.yaml schema must be harness-people/v1");
  return peopleRosterFromRecords(raw.people, raw.roles);
}

export function mergePeopleRosters(machine: PeopleRoster, project: PeopleRoster): PeopleRoster {
  // The machine roster (~/.harness/people.yaml) is the default only; a project
  // roster overrides it. The same machine credential (e.g. this laptop's uid)
  // may resolve to a different person per repository — company A's identity in
  // one repo, company B's in another — because the project people.yaml is an
  // explicit, committed, auditable declaration, not a covert swap. Ownership of
  // a credential therefore transfers to the project's person: we strip the
  // credential from the machine person that previously held it so the merged
  // roster keeps exactly one owner per credential (validateRoster forbids two).
  const projectCredentialOwners = new Map<string, string>();
  for (const person of project.people) {
    for (const credential of person.credentials) projectCredentialOwners.set(credentialKey(credential), person.personId);
  }

  const people = new Map(machine.people.map((person) => [
    person.personId,
    {
      ...person,
      credentials: person.credentials.filter((credential) => {
        const projectOwner = projectCredentialOwners.get(credentialKey(credential));
        return projectOwner === undefined || projectOwner === person.personId;
      })
    }
  ]));
  for (const projectPerson of project.people) {
    const machinePerson = people.get(projectPerson.personId);
    const credentials = new Map((machinePerson?.credentials ?? []).map((credential) => [credentialKey(credential), credential]));
    for (const credential of projectPerson.credentials) credentials.set(credentialKey(credential), credential);
    people.set(projectPerson.personId, {
      ...machinePerson,
      ...projectPerson,
      credentials: [...credentials.values()]
    });
  }
  const roles = new Map(machine.roles.map((role) => [role.roleId, role]));
  for (const role of project.roles) roles.set(role.roleId, role);
  return peopleRosterFromRecords([...people.values()], [...roles.values()]);
}

function peopleRosterFromRecords(people: ReadonlyArray<PersonProfile>, roles: ReadonlyArray<RolePolicy>): PeopleRoster {
  validateRoster(people, roles);
  const peopleByCredential = new Map<string, PersonProfile>();
  for (const person of people) {
    for (const credential of person.credentials) {
      peopleByCredential.set(credentialKey(credential), person);
    }
  }
  const rolesById = new Map(roles.map((role) => [role.roleId, role]));
  return {
    schema: "harness-people/v1",
    people,
    roles,
    resolveCredential: (credential, providerId) => {
      const person = peopleByCredential.get(credentialKey(credential));
      if (!person) return credentialResolutionFailure(providerId, "credential_unknown", "Credential is not bound to a person.", credential);
      return {
        ok: true,
        personId: person.personId,
        providerId,
        credential,
        ...(person.primaryEmail ? { primaryEmail: person.primaryEmail } : {})
      };
    },
    roleAllows: (roleId, commandClass) => rolesById.get(roleId)?.commandClasses.includes(commandClass) ?? false
  };
}

export function makePeopleRosterIdentityAdminSnapshot(
  roster: PeopleRoster,
  registry: PersonRegistry
): IdentityAdminSnapshot {
  const bindings = new Map(roster.people.map((person) => [person.personId, person]));
  return {
    people: registry.people.map((person) => {
      const binding = bindings.get(person.personId);
      return {
        personId: person.personId,
        displayName: person.displayName,
        ...(binding?.primaryEmail ? { primaryEmail: binding.primaryEmail } : {}),
        roles: binding?.roles ?? [],
        disabled: person.disabled ?? false,
        credentials: binding?.credentials ?? []
      };
    }),
    roles: roster.roles
  };
}

function credentialResolutionFailure(
  providerId: string,
  code: IdentityProviderFailure["code"],
  message: string,
  credential?: CredentialRef
): IdentityProviderFailure {
  return { ok: false, code, providerId, message, ...(credential ? { credential } : {}) };
}

function validateRoster(people: ReadonlyArray<PersonProfile>, roles: ReadonlyArray<RolePolicy>): void {
  const personIds = new Set<string>();
  const credentialKeys = new Set<string>();
  const roleIds = new Set(roles.map((role) => role.roleId));
  for (const role of roles) {
    if (!role.roleId) throw new Error("roleId is required");
    if (role.commandClasses.length === 0) throw new Error(`role ${role.roleId} must allow at least one command class`);
    for (const commandClass of role.commandClasses) {
      if (!commandClasses.has(commandClass)) throw new Error(`unknown command class: ${commandClass}`);
    }
  }
  for (const person of people) {
    if (!person.personId) throw new Error("personId is required");
    if (personIds.has(person.personId)) throw new Error(`duplicate personId: ${person.personId}`);
    personIds.add(person.personId);
    for (const roleId of person.roles) {
      if (!roleIds.has(roleId)) throw new Error(`person ${person.personId} references unknown role ${roleId}`);
    }
    for (const credential of person.credentials) {
      if (!credentialKinds.has(credential.kind)) throw new Error(`unknown credential kind: ${credential.kind}`);
      const key = credentialKey(credential);
      if (credentialKeys.has(key)) throw new Error(`duplicate credential binding: ${credential.kind}:${credential.issuer}:${credential.subject}`);
      credentialKeys.add(key);
    }
  }
}

function parsePeopleYaml(body: string): { readonly schema: string; readonly people: PersonProfile[]; readonly roles: RolePolicy[] } {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) return JSON.parse(body) as { readonly schema: string; readonly people: PersonProfile[]; readonly roles: RolePolicy[] };

  let schema = "";
  let section: "people" | "roles" | undefined;
  let currentPerson: MutablePerson | undefined;
  let currentCredential: MutableCredential | undefined;
  let currentRole: MutableRole | undefined;
  const people: MutablePerson[] = [];
  const roles: MutableRole[] = [];

  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "");
    if (!line.trim()) continue;
    const topLevel = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u.exec(line);
    if (topLevel) {
      const [, key, value = ""] = topLevel;
      if (key === "schema") schema = unquote(value.trim());
      else if (key === "people") section = "people";
      else if (key === "roles") section = "roles";
      else throw new Error(`Unsupported people.yaml key: ${key}`);
      currentPerson = undefined;
      currentCredential = undefined;
      currentRole = undefined;
      continue;
    }
    if (section === "people") {
      const started = /^  - personId:\s*(.+)$/u.exec(line);
      if (started) {
        currentPerson = { personId: unquote(started[1]), displayName: "", roles: [], credentials: [] };
        people.push(currentPerson);
        currentCredential = undefined;
        continue;
      }
      if (!currentPerson) throw new Error(`people entry must start with personId: ${line.trim()}`);
      const scalar = /^    ([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u.exec(line);
      if (scalar) {
        const [, key, value = ""] = scalar;
        assignPersonScalar(currentPerson, key, value.trim());
        currentCredential = undefined;
        continue;
      }
      const credentialStart = /^      - kind:\s*(.+)$/u.exec(line);
      if (credentialStart) {
        currentCredential = { kind: unquote(credentialStart[1]), issuer: "", subject: "" };
        currentPerson.credentials.push(currentCredential);
        continue;
      }
      const credentialScalar = /^        (issuer|subject):\s*(.+)$/u.exec(line);
      if (credentialScalar && currentCredential) {
        currentCredential[credentialScalar[1] as "issuer" | "subject"] = unquote(credentialScalar[2]);
        continue;
      }
    }
    if (section === "roles") {
      const started = /^  - roleId:\s*(.+)$/u.exec(line);
      if (started) {
        currentRole = { roleId: unquote(started[1]), commandClasses: [] };
        roles.push(currentRole);
        continue;
      }
      const commandClassesLine = /^    commandClasses:\s*(.+)$/u.exec(line);
      if (commandClassesLine && currentRole) {
        currentRole.commandClasses = parseInlineArray(commandClassesLine[1]) as DaemonCommandClass[];
        continue;
      }
    }
    throw new Error(`Unsupported people.yaml line: ${line.trim()}`);
  }
  return { schema, people: people as PersonProfile[], roles: roles as RolePolicy[] };
}

function assignPersonScalar(person: MutablePerson, key: string, rawValue: string): void {
  if (key === "displayName") person.displayName = unquote(rawValue);
  else if (key === "primaryEmail") person.primaryEmail = unquote(rawValue);
  else if (key === "roles") person.roles = parseInlineArray(rawValue);
  else if (key === "disabled") person.disabled = rawValue === "true";
  else if (key !== "credentials") throw new Error(`Unsupported person key: ${key}`);
}

function parseInlineArray(rawValue: string): string[] {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) throw new Error(`Expected inline array: ${rawValue}`);
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((item) => unquote(item.trim()));
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

interface MutableCredential {
  kind: string;
  issuer: string;
  subject: string;
}

interface MutablePerson {
  personId: string;
  displayName: string;
  primaryEmail?: string;
  roles: string[];
  credentials: MutableCredential[];
  disabled?: boolean;
}

interface MutableRole {
  roleId: string;
  commandClasses: DaemonCommandClass[];
}

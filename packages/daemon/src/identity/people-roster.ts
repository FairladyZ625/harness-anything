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
  type PeopleRoster,
  type PersonProfile,
  type RolePolicy,
} from "./types.ts";

const ROSTER_SCHEMA = "harness-people/v1";
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
  "api-token",
]);

export function loadPeopleRoster(rootInput: HarnessLayoutInput): PeopleRoster {
  const layout = resolveHarnessLayout(rootInput);
  const filePath = path.join(layout.authoredRoot, "people.yaml");
  if (!existsSync(filePath)) {
    throw new Error(`people.yaml not found: ${path.relative(layout.rootDir, filePath)}`);
  }
  return peopleRosterFromDocument(readFileSync(filePath, "utf8"));
}

export function peopleRosterFromDocument(body: string): PeopleRoster {
  const raw = parsePeopleYaml(body);
  if (raw.schema !== ROSTER_SCHEMA) throw new Error(`people.yaml schema must be ${ROSTER_SCHEMA}`);
  validateRoster(raw.people, raw.roles);
  const peopleByCredential = new Map<string, PersonProfile>();
  for (const person of raw.people) {
    for (const credential of person.credentials) {
      peopleByCredential.set(credentialKey(credential), person);
    }
  }
  const rolesById = new Map(raw.roles.map((role) => [role.roleId, role]));
  return {
    schema: "harness-people/v1",
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
    if (!person.displayName) throw new Error(`displayName is required for ${person.personId}`);
    for (const roleId of person.roles) {
      if (!roleIds.has(roleId)) throw new Error(`person ${person.personId} references unknown role ${roleId}`);
    }
    for (const credential of person.credentials) {
      if (!credentialKinds.has(credential.kind)) throw new Error(`unknown credential kind: ${credential.kind}`);
      const key = credentialKey(credential);
      if (credentialKeys.has(key))
        throw new Error(`duplicate credential binding: ${credential.kind}:${credential.issuer}:${credential.subject}`);
      credentialKeys.add(key);
    }
  }
}

export type PeopleRosterMerge =
  | { readonly ok: true; readonly body: string; readonly summary: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Union two `people.yaml` documents into one roster.
 *
 * A roster states who exists and what each person may do, so the two sides of a migration are not
 * two candidate values for one document: they are two partial statements about one set of people.
 * Set-valued facts (which people exist, which roles a person holds, which credentials bind to a
 * person) therefore union. Scalars (`displayName`, `primaryEmail`, `disabled`) and role authority
 * definitions (`commandClasses`) must agree, because a union has no meaning for a scalar and
 * widening a role's command classes would grant authority that neither side granted. When the two
 * sides genuinely contradict, this refuses and the caller falls back to an explicit operator choice.
 *
 * The result is serialized in the same JSON shape `ha init` writes, so re-running is idempotent.
 */
export function mergePeopleRosterDocuments(sourceBody: string, destinationBody: string): PeopleRosterMerge {
  let source: ParsedRoster;
  let destination: ParsedRoster;
  try {
    source = parsePeopleYaml(sourceBody);
    destination = parsePeopleYaml(destinationBody);
  } catch (error) {
    return { ok: false, reason: `people.yaml does not parse as a roster on both sides: ${describe(error)}` };
  }
  if (source.schema !== ROSTER_SCHEMA || destination.schema !== ROSTER_SCHEMA) {
    return {
      ok: false,
      reason: `people.yaml schema must be ${ROSTER_SCHEMA} on both sides; source=${label(source.schema)}, destination=${label(destination.schema)}`,
    };
  }
  for (const [side, roster] of [
    ["source", source],
    ["destination", destination],
  ] as const) {
    const shape = rosterShapeError(roster);
    if (shape) return { ok: false, reason: `${side} people.yaml is not a well-formed roster: ${shape}` };
  }

  const roles = [...destination.roles];
  const addedRoles: string[] = [];
  for (const role of source.roles) {
    const held = roles.find((candidate) => candidate.roleId === role.roleId);
    if (!held) {
      roles.push(role);
      addedRoles.push(role.roleId);
      continue;
    }
    const kept = [...held.commandClasses].sort().join(","),
      incoming = [...role.commandClasses].sort().join(",");
    if (kept !== incoming) {
      return {
        ok: false,
        reason: `role ${role.roleId} authorizes different command classes on each side (source=[${incoming}], destination=[${kept}]); merging would change what the role grants`,
      };
    }
  }

  const people: PersonProfile[] = [];
  const enriched: string[] = [];
  const addedPeople: string[] = [];
  for (const person of destination.people) {
    const counterpart = source.people.find((candidate) => candidate.personId === person.personId);
    if (!counterpart) {
      people.push(person);
      continue;
    }
    const merged = mergePerson(person, counterpart);
    if (!merged.ok) return merged;
    people.push(merged.person);
    if (merged.changed) enriched.push(person.personId);
  }
  for (const person of source.people) {
    if (destination.people.some((candidate) => candidate.personId === person.personId)) continue;
    people.push(person);
    addedPeople.push(person.personId);
  }

  try {
    validateRoster(people, roles);
  } catch (error) {
    return { ok: false, reason: `the union of both rosters is not a valid roster: ${describe(error)}` };
  }
  const summary = `${people.length} people (${addedPeople.length} carried from the source${addedPeople.length ? `: ${addedPeople.join(", ")}` : ""}, ${enriched.length} enriched in place${enriched.length ? `: ${enriched.join(", ")}` : ""}), ${roles.length} roles (${addedRoles.length} carried from the source${addedRoles.length ? `: ${addedRoles.join(", ")}` : ""})`;
  return { ok: true, body: serializeRoster(people, roles), summary };
}

function mergePerson(
  destination: PersonProfile,
  source: PersonProfile,
):
  | { readonly ok: true; readonly person: PersonProfile; readonly changed: boolean }
  | { readonly ok: false; readonly reason: string } {
  const scalars: { primaryEmail?: string; disabled?: boolean } = {};
  for (const field of ["displayName", "primaryEmail", "disabled"] as const) {
    const kept = destination[field],
      incoming = source[field];
    if (kept !== undefined && incoming !== undefined && kept !== incoming) {
      return {
        ok: false,
        reason: `person ${destination.personId} declares a different ${field} on each side (source=${JSON.stringify(incoming)}, destination=${JSON.stringify(kept)}); a roster union cannot choose between two values for one field`,
      };
    }
    if (field !== "displayName") {
      const resolved = kept ?? incoming;
      if (resolved !== undefined) Object.assign(scalars, { [field]: resolved });
    }
  }
  const roles = [...destination.roles];
  for (const roleId of source.roles) if (!roles.includes(roleId)) roles.push(roleId);
  const credentials = [...destination.credentials];
  const held = new Set(credentials.map(credentialKey));
  for (const credential of source.credentials) {
    if (held.has(credentialKey(credential))) continue;
    credentials.push(credential);
    held.add(credentialKey(credential));
  }
  const person: PersonProfile = {
    personId: destination.personId,
    displayName: destination.displayName || source.displayName,
    ...scalars,
    roles,
    credentials,
  };
  return { ok: true, person, changed: serializePerson(person) !== serializePerson(destination) };
}

function serializeRoster(people: ReadonlyArray<PersonProfile>, roles: ReadonlyArray<RolePolicy>): string {
  return `${JSON.stringify({ schema: ROSTER_SCHEMA, people: people.map(orderedPerson), roles: roles.map(({ roleId, commandClasses }) => ({ roleId, commandClasses: [...commandClasses] })) }, null, 2)}\n`;
}

function orderedPerson(person: PersonProfile): Readonly<Record<string, unknown>> {
  return {
    personId: person.personId,
    displayName: person.displayName,
    ...(person.primaryEmail === undefined ? {} : { primaryEmail: person.primaryEmail }),
    roles: [...person.roles],
    credentials: person.credentials.map(({ kind, issuer, subject }) => ({ kind, issuer, subject })),
    ...(person.disabled === undefined ? {} : { disabled: person.disabled }),
  };
}

function serializePerson(person: PersonProfile): string {
  return JSON.stringify(orderedPerson(person));
}

function rosterShapeError(roster: ParsedRoster): string | null {
  if (!Array.isArray(roster.people) || !Array.isArray(roster.roles)) return "people and roles must both be lists";
  for (const person of roster.people) {
    if (!person || typeof person.personId !== "string" || !person.personId) return "every person needs a personId";
    if (typeof person.displayName !== "string") return `person ${person.personId} needs a displayName`;
    if (!Array.isArray(person.roles) || !Array.isArray(person.credentials))
      return `person ${person.personId} needs list-valued roles and credentials`;
  }
  for (const role of roster.roles) {
    if (!role || typeof role.roleId !== "string" || !role.roleId) return "every role needs a roleId";
    if (!Array.isArray(role.commandClasses)) return `role ${role.roleId} needs list-valued commandClasses`;
  }
  return null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function label(schema: string): string {
  return schema ? JSON.stringify(schema) : "<missing>";
}

type ParsedRoster = { readonly schema: string; readonly people: PersonProfile[]; readonly roles: RolePolicy[] };

function parsePeopleYaml(body: string): {
  readonly schema: string;
  readonly people: PersonProfile[];
  readonly roles: RolePolicy[];
} {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{"))
    return JSON.parse(body) as {
      readonly schema: string;
      readonly people: PersonProfile[];
      readonly roles: RolePolicy[];
    };

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
      if (key === "schema") schema = unquoteRosterValue(value.trim());
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
        currentPerson = { personId: unquoteRosterValue(started[1]), displayName: "", roles: [], credentials: [] };
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
        currentCredential = { kind: unquoteRosterValue(credentialStart[1]), issuer: "", subject: "" };
        currentPerson.credentials.push(currentCredential);
        continue;
      }
      const credentialScalar = /^        (issuer|subject):\s*(.+)$/u.exec(line);
      if (credentialScalar && currentCredential) {
        currentCredential[credentialScalar[1] as "issuer" | "subject"] = unquoteRosterValue(credentialScalar[2]);
        continue;
      }
    }
    if (section === "roles") {
      const started = /^  - roleId:\s*(.+)$/u.exec(line);
      if (started) {
        currentRole = { roleId: unquoteRosterValue(started[1]), commandClasses: [] };
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
  if (key === "displayName") person.displayName = unquoteRosterValue(rawValue);
  else if (key === "primaryEmail") person.primaryEmail = unquoteRosterValue(rawValue);
  else if (key === "roles") person.roles = parseInlineArray(rawValue);
  else if (key === "disabled") person.disabled = rawValue === "true";
  else if (key !== "credentials") throw new Error(`Unsupported person key: ${key}`);
}

function parseInlineArray(rawValue: string): string[] {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) throw new Error(`Expected inline array: ${rawValue}`);
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((item) => unquoteRosterValue(item.trim()));
}

function unquoteRosterValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
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

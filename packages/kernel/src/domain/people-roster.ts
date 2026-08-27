import type { EntityDocumentJsonSchema } from "./entity-json-schema.ts";
import { parseDelegatedExecutionToken, type DelegatedExecutionToken } from "./delegated-execution-token.ts";
import {
  parseRoleBinding,
  roleBindingKey,
  validateRoleBinding,
  type RoleBinding,
  type RoleBindingActor,
} from "./role-binding.ts";

export const PEOPLE_ROSTER_SCHEMA = "harness-people/v1" as const;
export const PEOPLE_ROSTER_PATH = "people.yaml" as const;
export const personIdPattern = "^[A-Za-z][A-Za-z0-9_-]{0,62}$";

export const peopleCommandClasses = Object.freeze(["admin", "repo-write", "repo-read", "arbiter"] as const);
export type PeopleCommandClass = (typeof peopleCommandClasses)[number];

export const credentialKinds = Object.freeze([
  "unix-socket-owner-boundary",
  "windows-named-pipe-client",
  "ssh-username",
  "ssh-forced-command-person",
  "ssh-tunnel-token-subject",
  "email-address",
  "password-account",
  "oauth-subject",
  "api-token",
] as const);
export type CredentialKind = (typeof credentialKinds)[number];

export interface CredentialRef {
  readonly kind: CredentialKind;
  readonly issuer: string;
  readonly subject: string;
}

export interface PersonProfile {
  readonly personId: string;
  readonly displayName: string;
  readonly primaryEmail?: string;
  readonly roles: readonly string[];
  readonly credentials: readonly CredentialRef[];
  readonly disabled?: boolean;
}

export interface RolePolicy {
  readonly roleId: string;
  readonly commandClasses: readonly PeopleCommandClass[];
}

export interface PeopleRosterDocumentV1 {
  readonly schema: typeof PEOPLE_ROSTER_SCHEMA;
  readonly people: readonly PersonProfile[];
  readonly roles: readonly RolePolicy[];
  readonly bindings: readonly RoleBinding[];
  readonly delegatedExecutionTokens: readonly DelegatedExecutionToken[];
}

export const PERSON_V1_SCHEMA: EntityDocumentJsonSchema<PersonProfile> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "person/v1",
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["personId", "displayName", "roles", "credentials"]),
  properties: Object.freeze({
    personId: { type: "string", pattern: personIdPattern, minLength: 1 },
    displayName: { type: "string", minLength: 1 },
    primaryEmail: { type: "string", minLength: 1 },
    roles: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    },
    credentials: {
      type: "array",
      uniqueItems: true,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "issuer", "subject"],
        properties: {
          kind: { type: "string", enum: credentialKinds },
          issuer: { type: "string", minLength: 1 },
          subject: { type: "string", minLength: 1 },
        },
      },
    },
    disabled: { type: "boolean" },
  }),
};

export type PeopleRosterAction =
  | {
      readonly kind: "people-add";
      readonly person: PersonProfile;
      readonly rolePolicy?: RolePolicy;
    }
  | {
      readonly kind: "people-set-role";
      readonly personId: string;
      readonly rolePolicy: RolePolicy;
    }
  | {
      readonly kind: "people-bind";
      readonly binding: RoleBinding;
    }
  | {
      readonly kind: "people-delegate";
      readonly token: DelegatedExecutionToken;
    }
  | {
      readonly kind: "people-revoke-delegation";
      readonly tokenId: string;
      readonly issuerPersonId: string;
      readonly revokedAt: string;
    }
  | { readonly kind: "people-remove"; readonly personId: string }
  | { readonly kind: "people-reconcile"; readonly sourceBody: string }
  | { readonly kind: "people-replace"; readonly sourceBody: string };

export interface AppliedPeopleRosterAction {
  readonly action: PeopleRosterAction["kind"];
  readonly targetPersonId: string | null;
  readonly roster: PeopleRosterDocumentV1;
  readonly body: string;
  readonly changed: boolean;
  readonly summary: string;
}

export class PeopleRosterContractError extends Error {
  readonly code = "invalid_people_action";

  constructor(message: string) {
    super(message);
    this.name = "PeopleRosterContractError";
  }
}

export function parsePeopleRosterDocument(body: string): PeopleRosterDocumentV1 {
  const raw = parsePeopleYaml(body);
  if (raw.schema !== PEOPLE_ROSTER_SCHEMA)
    throw new PeopleRosterContractError(`people.yaml schema must be ${PEOPLE_ROSTER_SCHEMA}`);
  validatePeopleRoster(raw.people, raw.roles, raw.bindings, raw.delegatedExecutionTokens);
  return {
    schema: PEOPLE_ROSTER_SCHEMA,
    people: raw.people,
    roles: raw.roles,
    bindings: raw.bindings,
    delegatedExecutionTokens: raw.delegatedExecutionTokens,
  };
}

export function serializePeopleRosterDocument(roster: PeopleRosterDocumentV1): string {
  const bindings = roster.bindings ?? [];
  const delegatedExecutionTokens = roster.delegatedExecutionTokens ?? [];
  validatePeopleRoster(roster.people, roster.roles, bindings, delegatedExecutionTokens);
  return `${JSON.stringify(
    {
      schema: PEOPLE_ROSTER_SCHEMA,
      people: roster.people.map(orderedPerson),
      roles: roster.roles.map(({ roleId, commandClasses }) => ({
        roleId,
        commandClasses: [...commandClasses],
      })),
      ...(bindings.length ? { bindings: bindings.map(orderedBinding) } : {}),
      ...(delegatedExecutionTokens.length
        ? { delegatedExecutionTokens: delegatedExecutionTokens.map(orderedDelegatedExecutionToken) }
        : {}),
    },
    null,
    2,
  )}\n`;
}

export function applyPeopleRosterAction(
  currentBody: string | null,
  action: PeopleRosterAction,
): AppliedPeopleRosterAction {
  const current = currentBody === null ? emptyPeopleRoster() : parsePeopleRosterDocument(currentBody);
  let next: PeopleRosterDocumentV1;
  if (action.kind === "people-add") next = addPerson(current, action.person, action.rolePolicy);
  else if (action.kind === "people-set-role") next = setPersonRole(current, action.personId, action.rolePolicy);
  else if (action.kind === "people-bind") next = bindActorRole(current, action.binding);
  else if (action.kind === "people-delegate") next = issueDelegatedExecutionToken(current, action.token);
  else if (action.kind === "people-revoke-delegation")
    next = revokeDelegatedExecutionToken(current, action.tokenId, action.issuerPersonId, action.revokedAt);
  else if (action.kind === "people-remove") next = removePerson(current, action.personId);
  else if (action.kind === "people-replace") next = parsePeopleRosterDocument(action.sourceBody);
  else {
    const merged = mergePeopleRosterDocuments(action.sourceBody, serializePeopleRosterDocument(current));
    if (!merged.ok) throw new PeopleRosterContractError(merged.reason);
    next = parsePeopleRosterDocument(merged.body);
  }
  assertPeopleRosterActionInvariants(current, next, action);
  const body = serializePeopleRosterDocument(next),
    changed = currentBody === null || body !== currentBody,
    targetPersonId =
      action.kind === "people-add"
        ? action.person.personId
        : action.kind === "people-set-role" || action.kind === "people-remove"
          ? action.personId
          : action.kind === "people-bind" && action.binding.actor.kind === "person"
            ? action.binding.actor.id
            : action.kind === "people-delegate"
              ? action.token.issuer.personId
              : action.kind === "people-revoke-delegation"
                ? action.issuerPersonId
                : null;
  return {
    action: action.kind,
    targetPersonId,
    roster: next,
    body,
    changed,
    summary: peopleActionSummary(action, targetPersonId, changed),
  };
}

function addPerson(
  roster: PeopleRosterDocumentV1,
  person: PersonProfile,
  rolePolicy: RolePolicy | undefined,
): PeopleRosterDocumentV1 {
  if (roster.people.some((candidate) => candidate.personId === person.personId))
    throw new PeopleRosterContractError(`person ${person.personId} already exists`);
  if (roster.people.length > 0 && person.roles.includes("owner"))
    throw new PeopleRosterContractError("the owner role is reserved for the bootstrap creator");
  const roles = withRolePolicy(roster.roles, rolePolicy);
  validatePeopleRoster([...roster.people, person], roles, roster.bindings, roster.delegatedExecutionTokens);
  return {
    schema: PEOPLE_ROSTER_SCHEMA,
    people: [...roster.people, person],
    roles,
    bindings: roster.bindings,
    delegatedExecutionTokens: roster.delegatedExecutionTokens,
  };
}

function setPersonRole(
  roster: PeopleRosterDocumentV1,
  personId: string,
  rolePolicy: RolePolicy,
): PeopleRosterDocumentV1 {
  const held = roster.people.find((person) => person.personId === personId);
  if (!held) throw new PeopleRosterContractError(`person ${personId} does not exist`);
  if (rolePolicy.roleId === "owner" && !held.roles.includes("owner"))
    throw new PeopleRosterContractError("the owner role is reserved for the bootstrap creator");
  if (held.roles.includes("owner") && rolePolicy.roleId !== "owner")
    throw new PeopleRosterContractError(`bootstrap creator ${personId} must retain the owner role`);
  const roles = withRolePolicy(roster.roles, rolePolicy),
    people = roster.people.map((person) =>
      person.personId === personId ? { ...person, roles: [rolePolicy.roleId] } : person,
    );
  validatePeopleRoster(people, roles, roster.bindings, roster.delegatedExecutionTokens);
  return {
    schema: PEOPLE_ROSTER_SCHEMA,
    people,
    roles,
    bindings: roster.bindings,
    delegatedExecutionTokens: roster.delegatedExecutionTokens,
  };
}

function bindActorRole(roster: PeopleRosterDocumentV1, value: RoleBinding): PeopleRosterDocumentV1 {
  const binding = parseRosterRoleBinding(value);
  if (binding.source !== "declared")
    throw new PeopleRosterContractError("people.yaml may only persist declared RoleBindings");
  if (
    binding.actor.kind === "person" &&
    !roster.people.some((person) => person.personId === binding.actor.id && !person.disabled)
  )
    throw new PeopleRosterContractError(`RoleBinding actor ${binding.actor.id} is not an enabled person`);
  const key = roleBindingKey(binding),
    existing = roster.bindings.findIndex((candidate) => roleBindingKey(candidate) === key),
    bindings =
      existing < 0
        ? [...roster.bindings, binding]
        : roster.bindings.map((candidate, index) => (index === existing ? binding : candidate));
  validatePeopleRoster(roster.people, roster.roles, bindings, roster.delegatedExecutionTokens);
  return { ...roster, bindings };
}

function issueDelegatedExecutionToken(
  roster: PeopleRosterDocumentV1,
  value: DelegatedExecutionToken,
): PeopleRosterDocumentV1 {
  const token = parseRosterDelegatedExecutionToken(value),
    issuer = roster.people.find((person) => person.personId === token.issuer.personId && !person.disabled);
  if (!issuer)
    throw new PeopleRosterContractError(`DelegatedExecutionToken issuer ${token.issuer.personId} is not enabled`);
  const existing = roster.delegatedExecutionTokens.find((candidate) => candidate.tokenId === token.tokenId);
  if (existing) {
    const sameRequest =
      existing.revokedAt === null &&
      existing.issuer.personId === token.issuer.personId &&
      existing.delegate.runtimeSessionId === token.delegate.runtimeSessionId &&
      existing.expiresAt === token.expiresAt &&
      JSON.stringify(existing.allowedActions) === JSON.stringify(token.allowedActions);
    if (sameRequest) return roster;
    throw new PeopleRosterContractError(`DelegatedExecutionToken ${token.tokenId} already exists`);
  }
  const delegatedExecutionTokens = [...roster.delegatedExecutionTokens, token];
  validatePeopleRoster(roster.people, roster.roles, roster.bindings, delegatedExecutionTokens);
  return { ...roster, delegatedExecutionTokens };
}

function revokeDelegatedExecutionToken(
  roster: PeopleRosterDocumentV1,
  tokenId: string,
  issuerPersonId: string,
  revokedAt: string,
): PeopleRosterDocumentV1 {
  const existing = roster.delegatedExecutionTokens.find((token) => token.tokenId === tokenId);
  if (!existing) throw new PeopleRosterContractError(`DelegatedExecutionToken ${tokenId} does not exist`);
  if (existing.issuer.personId !== issuerPersonId)
    throw new PeopleRosterContractError(
      `Only DelegatedExecutionToken issuer ${existing.issuer.personId} may revoke it`,
    );
  if (existing.revokedAt !== null) return roster;
  const revoked = parseRosterDelegatedExecutionToken({ ...existing, revokedAt }),
    delegatedExecutionTokens = roster.delegatedExecutionTokens.map((token) =>
      token.tokenId === tokenId ? revoked : token,
    );
  validatePeopleRoster(roster.people, roster.roles, roster.bindings, delegatedExecutionTokens);
  return { ...roster, delegatedExecutionTokens };
}

function removePerson(roster: PeopleRosterDocumentV1, personId: string): PeopleRosterDocumentV1 {
  const held = roster.people.find((person) => person.personId === personId);
  if (!held) throw new PeopleRosterContractError(`person ${personId} does not exist`);
  if (held.roles.includes("owner"))
    throw new PeopleRosterContractError(`bootstrap creator ${personId} cannot be removed`);
  return {
    ...roster,
    people: roster.people.filter((person) => person.personId !== personId),
    bindings: roster.bindings.filter((binding) => binding.actor.kind !== "person" || binding.actor.id !== personId),
    delegatedExecutionTokens: roster.delegatedExecutionTokens.filter((token) => token.issuer.personId !== personId),
  };
}

function assertPeopleRosterActionInvariants(
  current: PeopleRosterDocumentV1,
  next: PeopleRosterDocumentV1,
  action: PeopleRosterAction,
): void {
  if (action.kind === "people-reconcile" || action.kind === "people-replace") {
    const currentOwners = current.people.filter((person) => person.roles.includes("owner"));
    for (const owner of currentOwners) {
      const retained = next.people.find((person) => person.personId === owner.personId);
      if (!retained?.roles.includes("owner"))
        throw new PeopleRosterContractError(`bootstrap creator ${owner.personId} must retain the owner role`);
    }
  }
  const adminRoleIds = new Set(
    next.roles.filter((role) => role.commandClasses.includes("admin")).map((role) => role.roleId),
  );
  if (!next.people.some((person) => !person.disabled && person.roles.some((roleId) => adminRoleIds.has(roleId))))
    throw new PeopleRosterContractError("people roster must retain at least one enabled person with admin authority");
}

function withRolePolicy(roles: readonly RolePolicy[], rolePolicy: RolePolicy | undefined): readonly RolePolicy[] {
  if (!rolePolicy) return roles;
  const index = roles.findIndex((role) => role.roleId === rolePolicy.roleId);
  return index < 0 ? [...roles, rolePolicy] : roles.map((role, candidate) => (candidate === index ? rolePolicy : role));
}

function peopleActionSummary(action: PeopleRosterAction, personId: string | null, changed: boolean): string {
  if (!changed) return "People roster already matches the requested state.";
  if (action.kind === "people-add") return `Added person ${personId}.`;
  if (action.kind === "people-set-role") return `Set person ${personId} role to ${action.rolePolicy.roleId}.`;
  if (action.kind === "people-bind")
    return (
      `Bound ${action.binding.actor.kind} ${action.binding.actor.id} as ` +
      `${action.binding.role} on ${action.binding.target}.`
    );
  if (action.kind === "people-delegate")
    return (
      `Delegated ${action.token.issuer.personId} Actions to RuntimeSession ` +
      `${action.token.delegate.runtimeSessionId} via ${action.token.tokenId}.`
    );
  if (action.kind === "people-revoke-delegation") return `Revoked DelegatedExecutionToken ${action.tokenId}.`;
  if (action.kind === "people-remove") return `Removed person ${personId}.`;
  return action.kind === "people-reconcile" ? "Reconciled the people roster." : "Replaced the people roster.";
}

function emptyPeopleRoster(): PeopleRosterDocumentV1 {
  return { schema: PEOPLE_ROSTER_SCHEMA, people: [], roles: [], bindings: [], delegatedExecutionTokens: [] };
}

export type PeopleRosterMerge =
  | { readonly ok: true; readonly body: string; readonly summary: string }
  | { readonly ok: false; readonly reason: string };

/** Union two person registries without widening contradictory scalar or authority declarations. */
export function mergePeopleRosterDocuments(sourceBody: string, destinationBody: string): PeopleRosterMerge {
  let source: ParsedRoster;
  let destination: ParsedRoster;
  try {
    source = parsePeopleYaml(sourceBody);
    destination = parsePeopleYaml(destinationBody);
  } catch (error) {
    return {
      ok: false,
      reason: `people.yaml does not parse as a roster on both sides: ${describe(error)}`,
    };
  }
  if (source.schema !== PEOPLE_ROSTER_SCHEMA || destination.schema !== PEOPLE_ROSTER_SCHEMA)
    return {
      ok: false,
      reason: [
        `people.yaml schema must be ${PEOPLE_ROSTER_SCHEMA} on both sides;`,
        `source=${label(source.schema)}, destination=${label(destination.schema)}`,
      ].join(" "),
    };
  for (const [side, roster] of [
    ["source", source],
    ["destination", destination],
  ] as const) {
    const shape = rosterShapeError(roster);
    if (shape)
      return {
        ok: false,
        reason: `${side} people.yaml is not a well-formed roster: ${shape}`,
      };
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
    if (kept !== incoming)
      return {
        ok: false,
        reason: [
          `role ${role.roleId} authorizes different command classes on each side`,
          `(source=[${incoming}], destination=[${kept}]); merging would change what the role grants`,
        ].join(" "),
      };
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

  const bindings = [...destination.bindings];
  for (const binding of source.bindings) {
    const index = bindings.findIndex((candidate) => roleBindingKey(candidate) === roleBindingKey(binding));
    if (index < 0) {
      bindings.push(binding);
      continue;
    }
    if (JSON.stringify(orderedBinding(bindings[index]!)) !== JSON.stringify(orderedBinding(binding)))
      return {
        ok: false,
        reason: [
          `RoleBinding ${roleBindingKey(binding).replaceAll("\0", ":")} has different validity on each side;`,
          "a roster union cannot choose which declaration is authoritative",
        ].join(" "),
      };
  }

  const delegatedExecutionTokens = [...destination.delegatedExecutionTokens];
  for (const token of source.delegatedExecutionTokens) {
    const existing = delegatedExecutionTokens.find((candidate) => candidate.tokenId === token.tokenId);
    if (!existing) {
      delegatedExecutionTokens.push(token);
      continue;
    }
    if (
      JSON.stringify(orderedDelegatedExecutionToken(existing)) !== JSON.stringify(orderedDelegatedExecutionToken(token))
    )
      return {
        ok: false,
        reason: [
          `DelegatedExecutionToken ${token.tokenId} differs on each side;`,
          "a roster union cannot choose which delegation is authoritative",
        ].join(" "),
      };
  }

  try {
    validatePeopleRoster(people, roles, bindings, delegatedExecutionTokens);
  } catch (error) {
    return {
      ok: false,
      reason: `the union of both rosters is not a valid roster: ${describe(error)}`,
    };
  }
  const addedPeopleNames = addedPeople.length ? `: ${addedPeople.join(", ")}` : "",
    enrichedNames = enriched.length ? `: ${enriched.join(", ")}` : "",
    addedRoleNames = addedRoles.length ? `: ${addedRoles.join(", ")}` : "",
    summary = [
      `${people.length} people (${addedPeople.length} carried from the source${addedPeopleNames},`,
      `${enriched.length} enriched in place${enrichedNames}),`,
      `${roles.length} roles (${addedRoles.length} carried from the source${addedRoleNames})`,
    ].join(" ");
  return {
    ok: true,
    body: serializePeopleRosterDocument({
      schema: PEOPLE_ROSTER_SCHEMA,
      people,
      roles,
      bindings,
      delegatedExecutionTokens,
    }),
    summary,
  };
}

function mergePerson(
  destination: PersonProfile,
  source: PersonProfile,
):
  | {
      readonly ok: true;
      readonly person: PersonProfile;
      readonly changed: boolean;
    }
  | { readonly ok: false; readonly reason: string } {
  const scalars: { primaryEmail?: string; disabled?: boolean } = {};
  for (const field of ["displayName", "primaryEmail", "disabled"] as const) {
    const kept = destination[field],
      incoming = source[field];
    if (kept !== undefined && incoming !== undefined && kept !== incoming)
      return {
        ok: false,
        reason: [
          `person ${destination.personId} declares a different ${field} on each side`,
          `(source=${JSON.stringify(incoming)}, destination=${JSON.stringify(kept)});`,
          "a roster union cannot choose between two values for one field",
        ].join(" "),
      };
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
  return {
    ok: true,
    person,
    changed: JSON.stringify(orderedPerson(person)) !== JSON.stringify(orderedPerson(destination)),
  };
}

export function validatePeopleRoster(
  people: readonly PersonProfile[],
  roles: readonly RolePolicy[],
  bindings: readonly RoleBinding[] = [],
  delegatedExecutionTokens: readonly DelegatedExecutionToken[] = [],
): void {
  const personIds = new Set<string>(),
    credentialKeys = new Set<string>(),
    roleIds = new Set<string>();
  for (const role of roles) {
    if (!role.roleId || roleIds.has(role.roleId))
      throw new PeopleRosterContractError(role.roleId ? `duplicate roleId: ${role.roleId}` : "roleId is required");
    roleIds.add(role.roleId);
    if (role.commandClasses.length === 0)
      throw new PeopleRosterContractError(`role ${role.roleId} must allow at least one command class`);
    if (new Set(role.commandClasses).size !== role.commandClasses.length)
      throw new PeopleRosterContractError(`role ${role.roleId} repeats a command class`);
    for (const commandClass of role.commandClasses)
      if (!(peopleCommandClasses as readonly string[]).includes(commandClass))
        throw new PeopleRosterContractError(`unknown command class: ${commandClass}`);
  }
  for (const person of people) {
    if (!new RegExp(personIdPattern, "u").test(person.personId))
      throw new PeopleRosterContractError(`invalid personId: ${person.personId || "<missing>"}`);
    if (personIds.has(person.personId)) throw new PeopleRosterContractError(`duplicate personId: ${person.personId}`);
    personIds.add(person.personId);
    if (!person.displayName.trim() || /[\r\n]/u.test(person.displayName))
      throw new PeopleRosterContractError(`displayName is required for ${person.personId}`);
    if (person.primaryEmail !== undefined && (!person.primaryEmail.trim() || /[\r\n]/u.test(person.primaryEmail)))
      throw new PeopleRosterContractError(`primaryEmail must be one non-empty line for ${person.personId}`);
    if (new Set(person.roles).size !== person.roles.length)
      throw new PeopleRosterContractError(`person ${person.personId} repeats a role`);
    for (const roleId of person.roles)
      if (!roleIds.has(roleId))
        throw new PeopleRosterContractError(`person ${person.personId} references unknown role ${roleId}`);
    for (const credential of person.credentials) {
      if (!(credentialKinds as readonly string[]).includes(credential.kind))
        throw new PeopleRosterContractError(`unknown credential kind: ${credential.kind}`);
      if (!credential.issuer || !credential.subject)
        throw new PeopleRosterContractError(`credential issuer and subject are required for ${person.personId}`);
      const key = credentialKey(credential);
      if (credentialKeys.has(key))
        throw new PeopleRosterContractError(
          `duplicate credential binding: ${credential.kind}:${credential.issuer}:${credential.subject}`,
        );
      credentialKeys.add(key);
    }
  }
  const bindingKeys = new Set<string>();
  for (const value of bindings) {
    const binding = parseRosterRoleBinding(value);
    if (binding.source !== "declared")
      throw new PeopleRosterContractError("people.yaml may only persist declared RoleBindings");
    if (binding.actor.kind === "person" && !personIds.has(binding.actor.id))
      throw new PeopleRosterContractError(`RoleBinding references unknown person ${binding.actor.id}`);
    const key = roleBindingKey(binding);
    if (bindingKeys.has(key))
      throw new PeopleRosterContractError(`duplicate RoleBinding: ${key.replaceAll("\0", ":")}`);
    bindingKeys.add(key);
  }
  const tokenIds = new Set<string>();
  for (const value of delegatedExecutionTokens) {
    const token = parseRosterDelegatedExecutionToken(value);
    if (tokenIds.has(token.tokenId))
      throw new PeopleRosterContractError(`duplicate DelegatedExecutionToken: ${token.tokenId}`);
    tokenIds.add(token.tokenId);
  }
}

function parseRosterRoleBinding(value: unknown): RoleBinding {
  try {
    return parseRoleBinding(value);
  } catch (error) {
    throw new PeopleRosterContractError(error instanceof Error ? error.message : String(error));
  }
}

function parseRosterDelegatedExecutionToken(value: unknown): DelegatedExecutionToken {
  try {
    return parseDelegatedExecutionToken(value);
  } catch (error) {
    throw new PeopleRosterContractError(error instanceof Error ? error.message : String(error));
  }
}

function orderedPerson(person: PersonProfile): Readonly<Record<string, unknown>> {
  return {
    personId: person.personId,
    displayName: person.displayName,
    ...(person.primaryEmail === undefined ? {} : { primaryEmail: person.primaryEmail }),
    roles: [...person.roles],
    credentials: person.credentials.map(({ kind, issuer, subject }) => ({
      kind,
      issuer,
      subject,
    })),
    ...(person.disabled === undefined ? {} : { disabled: person.disabled }),
  };
}

function orderedBinding(binding: RoleBinding): Readonly<Record<string, unknown>> {
  return {
    actor: { kind: binding.actor.kind, id: binding.actor.id },
    role: binding.role,
    target: binding.target,
    source: binding.source,
    expiresAt: binding.expiresAt,
  };
}

function orderedDelegatedExecutionToken(token: DelegatedExecutionToken): Readonly<Record<string, unknown>> {
  return {
    schema: token.schema,
    tokenId: token.tokenId,
    issuer: { personId: token.issuer.personId },
    delegate: { runtimeSessionId: token.delegate.runtimeSessionId },
    allowedActions: [...token.allowedActions],
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
  };
}

function credentialKey(credential: CredentialRef): string {
  return `${credential.kind}\0${credential.issuer}\0${credential.subject}`;
}

function rosterShapeError(roster: ParsedRoster): string | null {
  if (
    !Array.isArray(roster.people) ||
    !Array.isArray(roster.roles) ||
    !Array.isArray(roster.bindings) ||
    !Array.isArray(roster.delegatedExecutionTokens)
  )
    return "people, roles, bindings, and delegatedExecutionTokens must all be lists";
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
  for (const binding of roster.bindings) {
    const errors = validateRoleBinding(binding);
    if (errors.length) return errors.join("; ");
  }
  for (const token of roster.delegatedExecutionTokens) {
    try {
      parseDelegatedExecutionToken(token);
    } catch (error) {
      return describe(error);
    }
  }
  return null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function label(schema: string): string {
  return schema ? JSON.stringify(schema) : "<missing>";
}

type ParsedRoster = {
  readonly schema: string;
  readonly people: PersonProfile[];
  readonly roles: RolePolicy[];
  readonly bindings: RoleBinding[];
  readonly delegatedExecutionTokens: DelegatedExecutionToken[];
};

function parsePeopleYaml(body: string): ParsedRoster {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(body) as Omit<ParsedRoster, "bindings" | "delegatedExecutionTokens"> & {
      readonly bindings?: RoleBinding[];
      readonly delegatedExecutionTokens?: DelegatedExecutionToken[];
    };
    return {
      ...parsed,
      bindings: parsed.bindings ?? [],
      delegatedExecutionTokens: parsed.delegatedExecutionTokens ?? [],
    };
  }

  let schema = "";
  let section: "people" | "roles" | "bindings" | undefined;
  let currentPerson: MutablePerson | undefined;
  let currentCredential: MutableCredential | undefined;
  let currentRole: MutableRole | undefined;
  let currentBinding: MutableBinding | undefined;
  const people: MutablePerson[] = [];
  const roles: MutableRole[] = [];
  const bindings: MutableBinding[] = [];

  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "");
    if (!line.trim()) continue;
    const topLevel = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u.exec(line);
    if (topLevel) {
      const [, key, value = ""] = topLevel;
      if (key === "schema") schema = unquoteRosterValue(value.trim());
      else if (key === "people") section = "people";
      else if (key === "roles") section = "roles";
      else if (key === "bindings") section = "bindings";
      else throw new PeopleRosterContractError(`Unsupported people.yaml key: ${key}`);
      currentPerson = undefined;
      currentCredential = undefined;
      currentRole = undefined;
      currentBinding = undefined;
      continue;
    }
    if (section === "people") {
      const started = /^  - personId:\s*(.+)$/u.exec(line);
      if (started) {
        currentPerson = {
          personId: unquoteRosterValue(started[1]),
          displayName: "",
          roles: [],
          credentials: [],
        };
        people.push(currentPerson);
        currentCredential = undefined;
        continue;
      }
      if (!currentPerson) throw new PeopleRosterContractError(`people entry must start with personId: ${line.trim()}`);
      const scalar = /^    ([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u.exec(line);
      if (scalar) {
        const [, key, value = ""] = scalar;
        assignPersonScalar(currentPerson, key, value.trim());
        currentCredential = undefined;
        continue;
      }
      const credentialStart = /^      - kind:\s*(.+)$/u.exec(line);
      if (credentialStart) {
        currentCredential = {
          kind: unquoteRosterValue(credentialStart[1]),
          issuer: "",
          subject: "",
        };
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
        currentRole = {
          roleId: unquoteRosterValue(started[1]),
          commandClasses: [],
        };
        roles.push(currentRole);
        continue;
      }
      const commandClassesLine = /^    commandClasses:\s*(.+)$/u.exec(line);
      if (commandClassesLine && currentRole) {
        currentRole.commandClasses = parseInlineArray(commandClassesLine[1]) as PeopleCommandClass[];
        continue;
      }
    }
    if (section === "bindings") {
      const started = /^  - actor:\s*(.+)$/u.exec(line);
      if (started) {
        currentBinding = {
          actor: parseBindingActor(unquoteRosterValue(started[1])),
          role: "",
          target: "",
          source: "declared",
          expiresAt: null,
        };
        bindings.push(currentBinding);
        continue;
      }
      const scalar = /^    (role|target|source|expiresAt):\s*(.+)$/u.exec(line);
      if (scalar && currentBinding) {
        const value = unquoteRosterValue(scalar[2]);
        if (scalar[1] === "expiresAt") currentBinding.expiresAt = value === "null" ? null : value;
        else currentBinding[scalar[1] as "role" | "target" | "source"] = value;
        continue;
      }
    }
    throw new PeopleRosterContractError(`Unsupported people.yaml line: ${line.trim()}`);
  }
  return {
    schema,
    people: people as PersonProfile[],
    roles: roles as RolePolicy[],
    bindings: bindings as RoleBinding[],
    delegatedExecutionTokens: [],
  };
}

function parseBindingActor(value: string): RoleBindingActor {
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1)
    throw new PeopleRosterContractError("RoleBinding actor must use person:<id> or executor:<id>");
  return {
    kind: value.slice(0, separator) as RoleBindingActor["kind"],
    id: value.slice(separator + 1),
  };
}

function assignPersonScalar(person: MutablePerson, key: string, rawValue: string): void {
  if (key === "displayName") person.displayName = unquoteRosterValue(rawValue);
  else if (key === "primaryEmail") person.primaryEmail = unquoteRosterValue(rawValue);
  else if (key === "roles") person.roles = parseInlineArray(rawValue);
  else if (key === "disabled") person.disabled = rawValue === "true";
  else if (key !== "credentials") throw new PeopleRosterContractError(`Unsupported person key: ${key}`);
}

function parseInlineArray(rawValue: string): string[] {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]"))
    throw new PeopleRosterContractError(`Expected inline array: ${rawValue}`);
  const inner = trimmed.slice(1, -1).trim();
  return inner ? inner.split(",").map((item) => unquoteRosterValue(item.trim())) : [];
}

function unquoteRosterValue(value: string): string {
  const trimmed = value.trim();
  return (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ? trimmed.slice(1, -1)
    : trimmed;
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
  commandClasses: PeopleCommandClass[];
}

interface MutableBinding {
  actor: RoleBindingActor;
  role: string;
  target: string;
  source: string;
  expiresAt: string | null;
}

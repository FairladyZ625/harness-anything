import type {
  EntityActionContract,
  EntityActionInputContract,
  EntityActionInputField,
} from "./entity-kind-registry.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import {
  attributeEntityActionCriterion,
  type EntityActionCompileHook,
  type EntityActionCompileInput,
} from "./entity-action-execution.ts";
import { compilePeopleRosterActionEvent, type CompiledPeopleRosterAction } from "./people-event.ts";
import {
  applyPeopleRosterAction,
  credentialKinds,
  peopleCommandClasses,
  type CredentialKind,
  type PeopleCommandClass,
  type PeopleRosterAction,
  type PeopleRosterDocumentV1,
} from "./people-roster.ts";

export const personActionIds = Object.freeze([
  "add",
  "set-role",
  "bind",
  "delegate",
  "revoke-delegation",
  "remove",
] as const);
export type PersonActionId = (typeof personActionIds)[number];

export interface PersonActionDraft {
  readonly compiled: CompiledPeopleRosterAction;
}

export interface PersonActionCapabilityEvaluation {
  readonly criterionRef: string;
  readonly status: "met" | "unmet" | "invocation-required";
  readonly nextActions: readonly string[];
}

const noLease = Object.freeze({ authority: "not-applicable" }),
  noOccurrence = Object.freeze({ authority: "not-applicable" }),
  personConcurrency: EntityActionContract["concurrency"] = Object.freeze({
    expectedVersion: Object.freeze({
      authority: "people-event/v1 roster cut",
      required: false,
      default: "center-bound-current-revision",
      arbitration: "center-single-write-queue",
      conflict: "revision_conflict",
    }),
    leasePolicy: noLease,
    occurrenceClaim: noOccurrence,
    idempotency: Object.freeze({
      authority: "operation-id",
      input: "idempotencyKey",
      scope: "person/{id}/{action}",
      retry: "canonical-event-replay",
    }),
    artifactOwnership: Object.freeze({
      owner: "person/{id}",
      repositoryDocument: "people.yaml",
      event: "people-event/v1",
      arbitration: "center-single-write-queue",
    }),
  });

const input = (
    fields: readonly EntityActionInputField[],
    exactlyOneOf: readonly (readonly string[])[] = [],
  ): EntityActionInputContract =>
    Object.freeze({
      schema: "entity-action-input/v1",
      fields: Object.freeze(fields.map((candidate) => Object.freeze(candidate))),
      exactlyOneOf: Object.freeze(exactlyOneOf.map((group) => Object.freeze(group))),
    }),
  cli = (
    field: string,
    name: string,
    kind: "single" | "repeated",
    type: EntityActionInputField["type"] = "string",
    values?: readonly string[],
  ): EntityActionInputField =>
    Object.freeze({
      field,
      type,
      required: false,
      ...(values ? { enum: Object.freeze(values) } : {}),
      cli: Object.freeze({
        name,
        kind,
        error: Object.freeze({
          code: "missing_field",
          nextAction: `Supply ${name} directly or use --from-file with a complete People Action packet.`,
        }),
      }),
    }),
  fromFile = cli("fromFile", "--from-file", "single"),
  idempotencyKey = cli("idempotencyKey", "--idempotency-key", "single"),
  personId = cli("personId", "--person-id", "single"),
  role = cli("role", "--role", "single"),
  tokenId = cli("tokenId", "--token-id", "single"),
  actionInputs: Readonly<Record<PersonActionId, EntityActionInputContract>> = Object.freeze({
    add: input(
      [
        fromFile,
        personId,
        cli("displayName", "--display-name", "single"),
        cli("primaryEmail", "--primary-email", "single"),
        role,
        cli("commandClass", "--command-class", "repeated", "string-array", peopleCommandClasses),
        cli("credentialKind", "--credential-kind", "single", "string", credentialKinds),
        cli("credentialIssuer", "--credential-issuer", "single"),
        cli("credentialSubject", "--credential-subject", "single"),
        idempotencyKey,
      ],
      [["fromFile", "personId"]],
    ),
    "set-role": input(
      [
        fromFile,
        personId,
        role,
        cli("commandClass", "--command-class", "repeated", "string-array", peopleCommandClasses),
        idempotencyKey,
      ],
      [["fromFile", "personId"]],
    ),
    bind: input(
      [
        fromFile,
        cli("actor", "--actor", "single"),
        role,
        cli("target", "--target", "single"),
        cli("expiresAt", "--expires-at", "single"),
        idempotencyKey,
      ],
      [["fromFile", "actor"]],
    ),
    delegate: input(
      [
        fromFile,
        tokenId,
        cli("runtimeSessionId", "--runtime-session-id", "single"),
        cli("action", "--action", "repeated", "string-array"),
        cli("expiresAt", "--expires-at", "single"),
        idempotencyKey,
      ],
      [["fromFile", "tokenId"]],
    ),
    "revoke-delegation": input([fromFile, tokenId, idempotencyKey], [["fromFile", "tokenId"]]),
    remove: input([fromFile, personId, idempotencyKey], [["fromFile", "personId"]]),
  }),
  actionExplain: Readonly<Record<PersonActionId, string>> = Object.freeze({
    add: "Add one Person and its initial role policy through people-event/v1.",
    "set-role": "Replace one Person's role while preserving bootstrap-owner and administrator invariants.",
    bind: "Declare one Actor RoleBinding in the authoritative People roster.",
    delegate: "Issue one closed DelegatedExecutionToken from the authenticated Person to a RuntimeSession.",
    "revoke-delegation": "Revoke a DelegatedExecutionToken owned by the authenticated issuing Person.",
    remove: "Remove one non-owner Person while retaining an enabled administrator.",
  }),
  invariantExplain: Readonly<Record<PersonActionId, string>> = Object.freeze({
    add: "The Person identity is new and the resulting roster preserves owner and administrator authority.",
    "set-role": "The Person exists and the requested role preserves bootstrap-owner and administrator authority.",
    bind: "The RoleBinding is valid and any Person actor is enabled in the authoritative roster.",
    delegate: "The issuer is enabled and the DelegatedExecutionToken is valid, unique, and unexpired at issue time.",
    "revoke-delegation": "The DelegatedExecutionToken exists and is owned by the authenticated issuing Person.",
    remove: "The Person exists, is not the bootstrap owner, and removal retains an enabled administrator.",
  });

export function personActionCriterionRef(id: PersonActionId, criterion: "input" | "invariants"): string {
  return `people-roster/${id}.${criterion}`;
}

export function createPersonActionCatalog(
  baseAction: (id: PersonActionId) => EntityActionContract,
  actionResultContract: EntityActionContract["returns"],
) {
  return Object.freeze({
    ref: "kernel/person-action/v1",
    actions: Object.freeze(
      personActionIds.map((id): EntityActionContract => {
        const declared = baseAction(id);
        return Object.freeze({
          ...declared,
          input: actionInputs[id],
          policy: Object.freeze({ ref: "default@5", action: personActionIngress(id) }),
          criteria: Object.freeze([
            Object.freeze({
              ref: personActionCriterionRef(id, "input"),
              failureCode: "invalid_command",
              explain: "The invocation supplies one complete, closed People Action input.",
            }),
            Object.freeze({
              ref: personActionCriterionRef(id, "invariants"),
              failureCode: "invalid_people_action",
              explain: invariantExplain[id],
            }),
          ]),
          concurrency: personConcurrency,
          effects: Object.freeze([{ ref: "people-event/people_changed", projection: "PersonProjection" }]),
          returns: actionResultContract,
          explain: actionExplain[id],
          execution: Object.freeze({
            ingress: personActionIngress(id),
            compile: personActionCompiler(id),
            read: false,
            implementation: "catalog-runtime" as const,
            topology: "center-forward-write" as const,
            targetIdField: "personId",
          }),
        });
      }),
    ),
  });
}

export function personActionUsage(action: EntityActionContract, targetId = "<person-id>"): string {
  const ingress = action.execution?.ingress;
  if (!ingress?.startsWith("people-")) throw new Error(`Person Action ${action.id} has no People command ingress.`);
  return renderPersonActionUsage(ingress.slice("people-".length), action.input.fields, targetId);
}

function renderPersonActionUsage(verb: string, fields: readonly EntityActionInputField[], targetId: string): string {
  const flags = fields.flatMap((field) => {
    if (!field.cli) return [];
    const placeholder = field.field === "personId" ? targetId : `<${field.cli.name.slice(2)}>`,
      value = field.cli.kind === "repeated" ? ` ${placeholder}...` : ` ${placeholder}`;
    return [`[${field.cli.name}${value}]`];
  });
  return ["ha", "people", verb, ...flags].join(" ");
}

export function evaluatePersonActionCapability(input: {
  readonly action: EntityActionContract;
  readonly roster: PeopleRosterDocumentV1;
  readonly personId: string;
  readonly actorPersonId: string;
  readonly evaluatedAt: string;
  readonly invocation?: Readonly<Record<string, unknown>>;
}): readonly PersonActionCapabilityEvaluation[] {
  const id = personActionId(input.action),
    usage = personActionUsage(input.action, input.personId),
    invocation = input.invocation ?? defaultObjectInvocation(id, input.personId),
    parsed = invocation ? parseEvaluation(id, invocation, input.actorPersonId, input.evaluatedAt, usage) : null,
    inputEvaluation: PersonActionCapabilityEvaluation = parsed
      ? parsed.ok
        ? evaluation(personActionCriterionRef(id, "input"), "met")
        : evaluation(personActionCriterionRef(id, "input"), "unmet", parsed.nextActions)
      : evaluation(personActionCriterionRef(id, "input"), "invocation-required", [`Run ${usage}.`]),
    invariantEvaluation =
      parsed?.ok === true
        ? evaluateInvariant(id, input.roster, parsed.action, usage)
        : parsed?.ok === false
          ? evaluation(personActionCriterionRef(id, "invariants"), "invocation-required", [])
          : evaluateObjectInvariant(id, input.roster, input.personId, input.actorPersonId, usage);
  return Object.freeze([inputEvaluation, invariantEvaluation]);
}

function personActionCompiler(id: PersonActionId): EntityActionCompileHook {
  return (input) => ({ kind: "person", result: compilePersonAction(id, input) });
}

function compilePersonAction(id: PersonActionId, input: EntityActionCompileInput): PersonActionDraft {
  const usage = personActionUsageFromInput(id, input.action),
    parsed = parseEvaluation(id, input.action, input.actor.principal.personId, input.occurredAt, usage);
  if (!parsed.ok)
    throw attributeEntityActionCriterion(
      new PersonActionInputError(parsed.message),
      id,
      personActionCriterionRef(id, "input"),
      parsed.nextActions,
    );
  try {
    return {
      compiled: compilePeopleRosterActionEvent({
        currentBody: input.currentDocumentBody ?? null,
        action: parsed.action,
        eventId: `event-${sha256Text(input.opId)}`,
        opId: input.opId,
        workspaceRevision: input.workspaceRevision,
        actor: input.actor,
        source: input.source,
        occurredAt: input.occurredAt,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw attributeEntityActionCriterion(
      error instanceof Error ? error : new Error(message),
      id,
      personActionCriterionRef(id, "invariants"),
      invariantNextActions(message, usage),
    );
  }
}

function evaluateInvariant(
  id: PersonActionId,
  roster: PeopleRosterDocumentV1,
  action: PeopleRosterAction,
  usage: string,
): PersonActionCapabilityEvaluation {
  try {
    applyPeopleRosterAction(JSON.stringify(roster), action);
    return evaluation(personActionCriterionRef(id, "invariants"), "met");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return evaluation(personActionCriterionRef(id, "invariants"), "unmet", invariantNextActions(message, usage));
  }
}

function evaluateObjectInvariant(
  id: PersonActionId,
  roster: PeopleRosterDocumentV1,
  targetPersonId: string,
  actorPersonId: string,
  usage: string,
): PersonActionCapabilityEvaluation {
  const person = roster.people.find(({ personId: candidate }) => candidate === targetPersonId);
  if (id === "add")
    return evaluation(personActionCriterionRef(id, "invariants"), "unmet", [
      `Person ${targetPersonId} already exists; choose a new Person identity before running ${usage}.`,
    ]);
  if (!person)
    return evaluation(personActionCriterionRef(id, "invariants"), "unmet", [
      `Person ${targetPersonId} does not exist; choose an existing Person ref.`,
    ]);
  if ((id === "delegate" || id === "revoke-delegation") && actorPersonId !== targetPersonId)
    return evaluation(personActionCriterionRef(id, "invariants"), "unmet", [
      `Authenticate as Person ${targetPersonId} to ${id === "delegate" ? "issue" : "revoke"} that Person's delegation.`,
    ]);
  if (id === "remove") return evaluateInvariant(id, roster, { kind: "people-remove", personId: targetPersonId }, usage);
  if (id === "delegate" && person.disabled)
    return evaluation(personActionCriterionRef(id, "invariants"), "unmet", [
      `Person ${targetPersonId} is disabled and cannot issue a DelegatedExecutionToken.`,
    ]);
  return evaluation(personActionCriterionRef(id, "invariants"), "invocation-required", [`Run ${usage}.`]);
}

function parseEvaluation(
  id: PersonActionId,
  invocation: Readonly<Record<string, unknown>>,
  actorPersonId: string,
  occurredAt: string,
  usage: string,
):
  | { readonly ok: true; readonly action: PeopleRosterAction }
  | {
      readonly ok: false;
      readonly message: string;
      readonly nextActions: readonly string[];
    } {
  try {
    return { ok: true, action: parsePersonAction(id, invocation, actorPersonId, occurredAt) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message, nextActions: Object.freeze([`${message} Then retry ${usage}.`]) };
  }
}

function parsePersonAction(
  id: PersonActionId,
  action: Readonly<Record<string, unknown>>,
  issuerPersonId: string,
  occurredAt: string,
): PeopleRosterAction {
  if (id === "bind") {
    const actor = roleBindingActor(requiredText(action.actor, "actor"));
    return {
      kind: "people-bind",
      binding: {
        actor,
        role: requiredText(action.role, "role"),
        target: requiredText(action.target, "target") as never,
        source: "declared",
        expiresAt: action.expiresAt === null ? null : (text(action.expiresAt) ?? null),
      },
    };
  }
  if (id === "delegate")
    return {
      kind: "people-delegate",
      token: {
        schema: "delegated-execution-token/v1",
        tokenId: requiredText(action.tokenId, "token-id"),
        issuer: { personId: issuerPersonId },
        delegate: { runtimeSessionId: requiredText(action.runtimeSessionId, "runtime-session-id") },
        allowedActions: stringArray(action.action, "action"),
        issuedAt: occurredAt,
        expiresAt: requiredText(action.expiresAt, "expires-at"),
        revokedAt: null,
      },
    };
  if (id === "revoke-delegation")
    return {
      kind: "people-revoke-delegation",
      tokenId: requiredText(action.tokenId, "token-id"),
      issuerPersonId,
      revokedAt: occurredAt,
    };
  const targetPersonId = requiredText(action.personId, "person-id");
  if (id === "remove") return { kind: "people-remove", personId: targetPersonId };
  const roleId = requiredText(action.role, "role"),
    commandClasses = commandClassArray(action.commandClass),
    rolePolicy = { roleId, commandClasses };
  if (id === "set-role") return { kind: "people-set-role", personId: targetPersonId, rolePolicy };
  const displayName = requiredText(action.displayName, "display-name"),
    primaryEmail = text(action.primaryEmail),
    credentialKind = text(action.credentialKind),
    credentialIssuer = text(action.credentialIssuer),
    credentialSubject = text(action.credentialSubject),
    credentialFields = [credentialKind, credentialIssuer, credentialSubject];
  if (credentialFields.some(Boolean) && !credentialFields.every(Boolean))
    throw new PersonActionInputError(
      "credential-kind, credential-issuer, and credential-subject must be supplied together",
    );
  if (credentialKind && !(credentialKinds as readonly string[]).includes(credentialKind))
    throw new PersonActionInputError(`Unknown credential kind: ${credentialKind}`);
  return {
    kind: "people-add",
    person: {
      personId: targetPersonId,
      displayName,
      ...(primaryEmail ? { primaryEmail } : {}),
      roles: [roleId],
      credentials:
        credentialKind && credentialIssuer && credentialSubject
          ? [{ kind: credentialKind as CredentialKind, issuer: credentialIssuer, subject: credentialSubject }]
          : [],
    },
    rolePolicy,
  };
}

function defaultObjectInvocation(id: PersonActionId, personId: string): Readonly<Record<string, unknown>> | null {
  return id === "remove" ? { personId } : null;
}

function personActionId(action: EntityActionContract): PersonActionId {
  if ((personActionIds as readonly string[]).includes(action.id)) return action.id as PersonActionId;
  throw new Error(`Unknown Person Action ${action.id}.`);
}

function personActionIngress(id: PersonActionId): string {
  return `people-${id}`;
}

function personActionUsageFromInput(id: PersonActionId, action: Readonly<Record<string, unknown>>): string {
  const target = text(action.personId) ?? "<person-id>";
  return renderPersonActionUsage(id, actionInputs[id].fields, target);
}

function invariantNextActions(message: string, usage: string): readonly string[] {
  return Object.freeze([`${message} Then retry ${usage}.`]);
}

function evaluation(
  criterionRef: string,
  status: PersonActionCapabilityEvaluation["status"],
  nextActions: readonly string[] = [],
): PersonActionCapabilityEvaluation {
  return Object.freeze({ criterionRef, status, nextActions: Object.freeze([...nextActions]) });
}

function roleBindingActor(value: string): { readonly kind: "person" | "executor"; readonly id: string } {
  const separator = value.indexOf(":"),
    kind = value.slice(0, separator),
    id = value.slice(separator + 1);
  if ((kind !== "person" && kind !== "executor") || !id)
    throw new PersonActionInputError("--actor must use person:<id> or executor:<id>");
  return { kind, id };
}

function commandClassArray(value: unknown): readonly PeopleCommandClass[] {
  const values = stringArray(value, "command-class");
  for (const candidate of values)
    if (!(peopleCommandClasses as readonly string[]).includes(candidate))
      throw new PersonActionInputError(`Unknown command class: ${candidate}`);
  return values as readonly PeopleCommandClass[];
}

function stringArray(value: unknown, field: string): readonly string[] {
  const values = (Array.isArray(value) ? value : [value]).map(text).filter((entry): entry is string => !!entry);
  if (values.length === 0) throw new PersonActionInputError(`At least one --${field} is required`);
  if (new Set(values).size !== values.length) throw new PersonActionInputError(`--${field} values must be unique`);
  return values;
}

function requiredText(value: unknown, field: string): string {
  const valueText = text(value);
  if (!valueText) throw new PersonActionInputError(`--${field} is required`);
  return valueText;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

class PersonActionInputError extends Error {
  readonly code = "invalid_command";
}

import type {
  EntityActionContract,
  EntityActionInputContract,
  EntityActionInputField,
} from "./entity-kind-registry.ts";
import { type EntityActionCompileHook } from "./entity-action-execution.ts";
import type { EntityActionCriterionStatus } from "./entity-action-explanation.ts";
import { compileExecutionDelegation, type ExecutionDelegationDraft } from "./execution-delegation.ts";

export const personActionIds = Object.freeze(["delegate", "revoke-delegation"] as const);
export type PersonActionId = (typeof personActionIds)[number];

export type PersonActionDraft = ExecutionDelegationDraft;

export interface PersonActionCapabilityEvaluation {
  readonly criterionRef: string;
  readonly status: Exclude<EntityActionCriterionStatus, "not-evaluated">;
  readonly nextActions: readonly string[];
}

const noLease = Object.freeze({ authority: "not-applicable" }),
  noOccurrence = Object.freeze({ authority: "not-applicable" }),
  personConcurrency: EntityActionContract["concurrency"] = Object.freeze({
    expectedVersion: Object.freeze({
      authority: "repository-private execution record",
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
      retry: "private-operation-replay",
    }),
    artifactOwnership: Object.freeze({
      owner: "person/{id}",
      record: "execution-delegations/v1",
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
        }),
      }),
    }),
  fromFile = cli("fromFile", "--from-file", "single"),
  idempotencyKey = cli("idempotencyKey", "--idempotency-key", "single"),
  tokenId = cli("tokenId", "--token-id", "single"),
  actionInputs: Readonly<Record<PersonActionId, EntityActionInputContract>> = Object.freeze({
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
  }),
  actionExplain: Readonly<Record<PersonActionId, string>> = Object.freeze({
    delegate: "Issue one closed DelegatedExecutionToken from the authenticated Person to a RuntimeSession.",
    "revoke-delegation": "Revoke a DelegatedExecutionToken owned by the authenticated issuing Person.",
  }),
  invariantExplain: Readonly<Record<PersonActionId, string>> = Object.freeze({
    delegate: "The canonical runtime belongs to the issuer and the delegation is valid, unique, and unexpired.",
    "revoke-delegation": "The DelegatedExecutionToken exists and is owned by the authenticated issuing Person.",
  });

export function personActionCriterionRef(id: PersonActionId, criterion: "input" | "invariants"): string {
  return `execution-delegation/${id}.${criterion}`;
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
          effects: Object.freeze([{ ref: "execution-delegation/changed", projection: "repository-private" }]),
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
  readonly personId: string;
  readonly actorPersonId: string;
  readonly evaluatedAt: string;
}): readonly PersonActionCapabilityEvaluation[] {
  return input.action.criteria.map((criterion) => ({
    criterionRef: criterion.ref,
    status: "invocation-required" as const,
    nextActions: [`Run ${personActionUsage(input.action, input.personId)}.`],
  }));
}

function personActionIngress(id: PersonActionId): string {
  return `people-${id}`;
}
function personActionCompiler(id: PersonActionId): EntityActionCompileHook {
  return (input) => ({ kind: "person", result: compileExecutionDelegation(id, input) });
}

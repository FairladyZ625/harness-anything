import {
  ENTITY_ACTION_EXPLANATION_SCHEMA,
  getEntityKindContract,
  squadActionUsage,
  validateEntityActionExplanationSet,
  type ActorIdentity,
  type AuthorizationDecision,
  type BaseEntity,
  type EntityActionContract,
  type EntityActionCriterionExplanationV1,
  type EntityActionExplanationSetV1,
  type EntityActionExplanationV1,
  type EntityRef,
  type SquadDeclarationV1,
} from "../../kernel/src/index.ts";

export interface SquadActionExplanationAuthorizationInput {
  readonly action: EntityActionContract;
  readonly target: EntityRef;
  readonly evaluatedAtCut: string;
}

export interface SquadActionExplanationServiceDependencies {
  readonly actor: ActorIdentity;
  readonly authorize: (input: SquadActionExplanationAuthorizationInput) => AuthorizationDecision;
}

export interface SquadActionExplanationObjectInput {
  readonly entity: BaseEntity<"squad">;
  readonly declaration: SquadDeclarationV1;
  readonly installedAgentIds: ReadonlySet<string>;
  readonly evaluatedAtCut: string;
}

export interface SquadActionExplanationService {
  readonly catalog: () => EntityActionExplanationSetV1;
  readonly object: (input: SquadActionExplanationObjectInput) => EntityActionExplanationSetV1;
}

export function makeSquadActionExplanationService(
  dependencies: SquadActionExplanationServiceDependencies,
): SquadActionExplanationService {
  const catalog = squadActionCatalog();
  return Object.freeze({
    catalog: () =>
      squadChecked({
        schema: ENTITY_ACTION_EXPLANATION_SCHEMA.id,
        mode: "catalog",
        subjects: [
          {
            kind: "squad",
            ref: null,
            revision: null,
            actions: catalog.actions.map((action) => catalogRow(catalog.ref, action)),
            failure: null,
          },
        ],
        evaluatedAtCut: null,
      }),
    object: (input: SquadActionExplanationObjectInput) => {
      if (input.declaration.id !== input.entity.id)
        throw new Error("Squad Action explanation declaration and BaseEntity witness identities must match.");
      const target = input.entity.ref as EntityRef;
      return squadChecked({
        schema: ENTITY_ACTION_EXPLANATION_SCHEMA.id,
        mode: "object",
        subjects: [
          {
            kind: "squad",
            ref: target,
            revision: input.entity.revision,
            actions: catalog.actions.map((action) => squadObjectRow(catalog.ref, action, input, target, dependencies)),
            failure: null,
          },
        ],
        evaluatedAtCut: input.evaluatedAtCut,
      });
    },
  });
}

function squadActionCatalog(): { readonly ref: string; readonly actions: readonly EntityActionContract[] } {
  const catalog = getEntityKindContract("squad")?.actionCatalog;
  if (!catalog) throw new Error("The Squad Entity Action catalog is unavailable.");
  return catalog;
}

function descriptor(catalogRef: string, action: EntityActionContract): EntityActionExplanationV1["action"] {
  return Object.freeze({
    kind: "squad",
    id: action.id,
    catalogRef,
    contractVersion: `${action.version.major}.${action.version.minor}`,
    explain: action.explain,
    syntax: Object.freeze({ usage: squadActionUsage(action), inputs: action.input.fields }),
  });
}

function catalogRow(catalogRef: string, action: EntityActionContract): EntityActionExplanationV1 {
  return Object.freeze({
    action: descriptor(catalogRef, action),
    target: null,
    available: null,
    criteria: Object.freeze(
      action.criteria.map((criterion) =>
        Object.freeze({ ...criterion, status: "not-evaluated" as const, nextActions: Object.freeze([]) }),
      ),
    ),
    unmetCriteria: Object.freeze([]),
    authorizationDecision: null,
    nextActions: Object.freeze([]),
    evaluatedAtCut: null,
  });
}

function squadObjectRow(
  catalogRef: string,
  action: EntityActionContract,
  input: SquadActionExplanationObjectInput,
  target: EntityRef,
  dependencies: SquadActionExplanationServiceDependencies,
): EntityActionExplanationV1 {
  const members = [input.declaration.leader, ...input.declaration.workers],
    missingMembers = [...new Set(members.filter((id) => !input.installedAgentIds.has(id)))],
    criteria = Object.freeze(
      action.criteria.map((criterion): EntityActionCriterionExplanationV1 => {
        const evaluation = evaluateCriterion(action, criterion.ref, input, missingMembers);
        return Object.freeze({ ...criterion, ...evaluation });
      }),
    ),
    unmetCriteria = Object.freeze(
      criteria
        .filter(({ status }) => status === "unmet")
        .map(({ ref, failureCode, explain }) => Object.freeze({ ref, failureCode, explain })),
    ),
    authorizationDecision = dependencies.authorize({ action, target, evaluatedAtCut: input.evaluatedAtCut }),
    nextActions = Object.freeze([
      ...new Set([
        ...criteria.flatMap(({ status, nextActions: next }) => (status === "met" ? [] : next)),
        ...(authorizationDecision.outcome === "denied" ? authorizationDecision.nextActions : []),
      ]),
    ]);
  if (
    authorizationDecision.subject !== target ||
    authorizationDecision.evaluatedAtCut !== input.evaluatedAtCut ||
    authorizationDecision.actor.principal.personId !== dependencies.actor.principal.personId ||
    authorizationDecision.actor.executor?.id !== dependencies.actor.executor?.id
  )
    throw new Error("Squad Action authorization decision does not match the actor, target, and canonical cut.");
  return Object.freeze({
    action: descriptor(catalogRef, action),
    target: Object.freeze({ ref: target, revision: input.entity.revision }),
    available: authorizationDecision.outcome === "allowed" && unmetCriteria.length === 0,
    criteria,
    unmetCriteria,
    authorizationDecision,
    nextActions,
    evaluatedAtCut: input.evaluatedAtCut,
  });
}

function evaluateCriterion(
  action: EntityActionContract,
  criterionRef: string,
  input: SquadActionExplanationObjectInput,
  missingMembers: readonly string[],
): Pick<EntityActionCriterionExplanationV1, "status" | "nextActions"> {
  if (criterionRef === "squad/entity-present" || criterionRef === "squad/declaration-schema")
    return { status: "met", nextActions: [] };
  if (criterionRef === "squad/roster-ready")
    return input.declaration.roster.trim()
      ? { status: "met", nextActions: [] }
      : { status: "unmet", nextActions: [`Author the roster for squad/${input.declaration.id}, then reinstall it.`] };
  if (criterionRef === "squad/member-declarations")
    return missingMembers.length === 0
      ? { status: "met", nextActions: [] }
      : {
          status: "unmet",
          nextActions: missingMembers.map(
            (id) => `Install agent/${id}, then retry ${squadActionUsage(action, input.entity.id)}.`,
          ),
        };
  if (criterionRef === "squad/entity-revision")
    return {
      status: "invocation-required",
      nextActions: [`Use expectedVersion ${input.entity.revision} when replacing squad/${input.entity.id}.`],
    };
  if (
    criterionRef === "squad/task-mission-ready" ||
    criterionRef === "squad/execution-lease-holder" ||
    criterionRef === "squad/execution-lease-reacquisition" ||
    criterionRef === "squad/leader-dispatch"
  )
    return {
      status: "invocation-required",
      nextActions: [`Supply a task and runtime instance, then run ${squadActionUsage(action, input.entity.id)}.`],
    };
  if (
    criterionRef === "squad/run-id" ||
    criterionRef === "squad/run-present" ||
    criterionRef === "squad/cancellation-complete"
  )
    return {
      status: "invocation-required",
      nextActions: [
        criterionRef === "squad/cancellation-complete"
          ? "Invoke cancellation with a concrete squad run handle to evaluate runtime settlement."
          : "Use the squad run handle returned by ha squad run to evaluate this predicate.",
      ],
    };
  throw new Error(`Squad Action ${action.id} criterion ${criterionRef} has no capability classification.`);
}

function squadChecked(value: EntityActionExplanationSetV1): EntityActionExplanationSetV1 {
  const issues = validateEntityActionExplanationSet(value);
  if (issues.length) throw new Error(`Invalid Squad Action explanation: ${issues.join("; ")}`);
  return Object.freeze(value);
}

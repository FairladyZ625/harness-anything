import {
  ENTITY_ACTION_EXPLANATION_SCHEMA,
  evaluatePersonActionCapability,
  getEntityKindContract,
  personActionUsage,
  validateEntityActionExplanationSet,
  type ActorIdentity,
  type AuthorizationDecision,
  type BaseEntity,
  type EntityActionContract,
  type EntityActionCriterionExplanationV1,
  type EntityActionExplanationSetV1,
  type EntityActionExplanationV1,
  type EntityRef,
  type PeopleRosterDocumentV1,
} from "../../kernel/src/index.ts";

export interface PersonActionExplanationServiceDependencies {
  readonly actor: ActorIdentity;
  readonly authorize: (input: {
    readonly action: EntityActionContract;
    readonly target: EntityRef;
    readonly evaluatedAtCut: string;
  }) => AuthorizationDecision;
}

export function makePersonActionExplanationService(dependencies: PersonActionExplanationServiceDependencies) {
  const catalog = personCatalog();
  return Object.freeze({
    catalog: (): EntityActionExplanationSetV1 =>
      personChecked({
        schema: ENTITY_ACTION_EXPLANATION_SCHEMA.id,
        mode: "catalog",
        subjects: [
          {
            kind: "person",
            ref: null,
            revision: null,
            actions: catalog.actions.map((action) => catalogRow(catalog.ref, action)),
            failure: null,
          },
        ],
        evaluatedAtCut: null,
      }),
    object: (input: {
      readonly entity: BaseEntity<"person">;
      readonly roster: PeopleRosterDocumentV1;
      readonly evaluatedAtCut: string;
      readonly evaluatedAt: string;
    }): EntityActionExplanationSetV1 => {
      const target = input.entity.ref as EntityRef,
        person = input.roster.people.find(({ personId }) => personId === input.entity.id);
      if (!person) throw new Error("Person Action explanation requires its Person in the same-cut People roster.");
      return personChecked({
        schema: ENTITY_ACTION_EXPLANATION_SCHEMA.id,
        mode: "object",
        subjects: [
          {
            kind: "person",
            ref: target,
            revision: input.entity.revision,
            actions: catalog.actions.map((action) => personObjectRow(catalog.ref, action, input, target, dependencies)),
            failure: null,
          },
        ],
        evaluatedAtCut: input.evaluatedAtCut,
      });
    },
  });
}

function personCatalog(): { readonly ref: string; readonly actions: readonly EntityActionContract[] } {
  const catalog = getEntityKindContract("person")?.actionCatalog;
  if (!catalog) throw new Error("The Person Entity Action catalog is unavailable.");
  return catalog;
}

function descriptor(catalogRef: string, action: EntityActionContract): EntityActionExplanationV1["action"] {
  return Object.freeze({
    kind: "person",
    id: action.id,
    catalogRef,
    contractVersion: `${action.version.major}.${action.version.minor}`,
    explain: action.explain,
    syntax: Object.freeze({ usage: personActionUsage(action), inputs: action.input.fields }),
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

function personObjectRow(
  catalogRef: string,
  action: EntityActionContract,
  input: {
    readonly entity: BaseEntity<"person">;
    readonly roster: PeopleRosterDocumentV1;
    readonly evaluatedAtCut: string;
    readonly evaluatedAt: string;
  },
  target: EntityRef,
  dependencies: PersonActionExplanationServiceDependencies,
): EntityActionExplanationV1 {
  const evaluated = new Map(
      evaluatePersonActionCapability({
        action,
        roster: input.roster,
        personId: input.entity.id,
        actorPersonId: dependencies.actor.principal.personId,
        evaluatedAt: input.evaluatedAt,
      }).map((criterion) => [criterion.criterionRef, criterion]),
    ),
    criteria = Object.freeze(
      action.criteria.map((criterion): EntityActionCriterionExplanationV1 => {
        const result = evaluated.get(criterion.ref);
        if (!result) throw new Error(`Person Action criterion ${criterion.ref} has no evaluation result.`);
        return Object.freeze({ ...criterion, status: result.status, nextActions: result.nextActions });
      }),
    ),
    unmetCriteria = Object.freeze(
      criteria
        .filter(({ status }) => status === "unmet")
        .map(({ ref, failureCode, explain }) => Object.freeze({ ref, failureCode, explain })),
    ),
    authorizationDecision = dependencies.authorize({ action, target, evaluatedAtCut: input.evaluatedAtCut }),
    nextActions = stableUnique([
      ...criteria.flatMap((criterion) => (criterion.status === "met" ? [] : criterion.nextActions)),
      ...(authorizationDecision.outcome === "denied" ? authorizationDecision.nextActions : []),
    ]);
  if (
    authorizationDecision.subject !== target ||
    authorizationDecision.evaluatedAtCut !== input.evaluatedAtCut ||
    authorizationDecision.actor.principal.personId !== dependencies.actor.principal.personId ||
    authorizationDecision.actor.executor?.id !== dependencies.actor.executor?.id
  )
    throw new Error("Person Action authorization decision does not match the actor, target, and canonical cut.");
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

function stableUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function personChecked(value: EntityActionExplanationSetV1): EntityActionExplanationSetV1 {
  const issues = validateEntityActionExplanationSet(value);
  if (issues.length > 0) throw new Error(`Invalid Person Action explanation: ${issues.join("; ")}`);
  return Object.freeze(value);
}

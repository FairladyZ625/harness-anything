import {
  ENTITY_ACTION_EXPLANATION_SCHEMA,
  evaluateTaskActionCapability,
  getEntityKindContract,
  taskActionUsage,
  validateEntityActionExplanationSet,
  type ActorIdentity,
  type AuthorizationDecision,
  type BaseEntity,
  type EntityActionContract,
  type EntityActionCriterionExplanationV1,
  type EntityActionExplanationSetV1,
  type EntityActionExplanationV1,
  type EntityRef,
  type TaskLifecycleSnapshot,
} from "../../kernel/src/index.ts";

export interface TaskActionExplanationAuthorizationInput {
  readonly action: EntityActionContract;
  readonly target: EntityRef;
  readonly evaluatedAtCut: string;
}

export interface TaskActionExplanationServiceDependencies {
  readonly actor: ActorIdentity;
  readonly authorize: (input: TaskActionExplanationAuthorizationInput) => AuthorizationDecision;
}

export interface TaskActionExplanationObjectInput {
  readonly entity: BaseEntity<"task">;
  readonly snapshot: TaskLifecycleSnapshot;
  readonly evaluatedAtCut: string;
}

export interface TaskActionExplanationService {
  readonly catalog: () => EntityActionExplanationSetV1;
  readonly object: (input: TaskActionExplanationObjectInput) => EntityActionExplanationSetV1;
}

export function makeTaskActionExplanationService(
  dependencies: TaskActionExplanationServiceDependencies,
): TaskActionExplanationService {
  const catalog = taskActionCatalog();
  return Object.freeze({
    catalog: () =>
      checked({
        schema: ENTITY_ACTION_EXPLANATION_SCHEMA.id,
        mode: "catalog",
        subjects: [
          {
            kind: "task",
            ref: null,
            revision: null,
            actions: catalog.actions.map((action) => catalogRow(catalog.ref, action)),
            failure: null,
          },
        ],
        evaluatedAtCut: null,
      }),
    object: (input: TaskActionExplanationObjectInput) => {
      const target = input.entity.ref as EntityRef;
      if (input.snapshot.task?.taskId !== input.entity.id || input.snapshot.revision !== input.entity.revision)
        throw new Error(
          "Task Action explanation requires one Task snapshot and BaseEntity witness at the same revision.",
        );
      return checked({
        schema: ENTITY_ACTION_EXPLANATION_SCHEMA.id,
        mode: "object",
        subjects: [
          {
            kind: "task",
            ref: target,
            revision: input.entity.revision,
            actions: catalog.actions.map((action) => objectRow(catalog.ref, action, input, target, dependencies)),
            failure: null,
          },
        ],
        evaluatedAtCut: input.evaluatedAtCut,
      });
    },
  });
}

function taskActionCatalog(): { readonly ref: string; readonly actions: readonly EntityActionContract[] } {
  const catalog = getEntityKindContract("task")?.actionCatalog;
  if (!catalog) throw new Error("The Task Entity Action catalog is unavailable.");
  return catalog;
}

function descriptor(catalogRef: string, action: EntityActionContract): EntityActionExplanationV1["action"] {
  return Object.freeze({
    kind: "task" as const,
    id: action.id,
    catalogRef,
    contractVersion: `${action.version.major}.${action.version.minor}`,
    explain: action.explain,
    syntax: Object.freeze({
      usage: taskActionUsage(action),
      inputs: action.input.fields,
    }),
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

function objectRow(
  catalogRef: string,
  action: EntityActionContract,
  input: TaskActionExplanationObjectInput,
  target: EntityRef,
  dependencies: TaskActionExplanationServiceDependencies,
): EntityActionExplanationV1 {
  const evaluated = new Map(
      evaluateTaskActionCapability({ action, snapshot: input.snapshot, actor: dependencies.actor }).map((criterion) => [
        criterion.criterionRef,
        criterion,
      ]),
    ),
    criteria = Object.freeze(
      action.criteria.map((criterion): EntityActionCriterionExplanationV1 => {
        const result = evaluated.get(criterion.ref);
        if (!result) throw new Error(`Task Action criterion ${criterion.ref} has no evaluation result.`);
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
    throw new Error("Task Action authorization decision does not match the actor, target, and canonical cut.");
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

function checked(value: EntityActionExplanationSetV1): EntityActionExplanationSetV1 {
  const issues = validateEntityActionExplanationSet(value);
  if (issues.length > 0) throw new Error(`Invalid Entity Action explanation: ${issues.join("; ")}`);
  return Object.freeze(value);
}

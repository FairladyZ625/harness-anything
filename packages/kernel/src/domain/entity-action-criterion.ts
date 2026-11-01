// Criterion attribution for rejected entity actions. Kept in a leaf module: both the action
// compilers and the decision document attribution use it, and neither owns the other.
const ENTITY_ACTION_CRITERION_FAILURE = Symbol("entity-action-criterion-failure");

export interface EntityActionCriterionFailure {
  readonly actionId: string;
  readonly criterionRef: string;
  readonly nextActions: readonly string[];
}

type CriterionError = Error & {
  readonly [ENTITY_ACTION_CRITERION_FAILURE]?: EntityActionCriterionFailure;
};

export function attributeEntityActionCriterion(
  error: Error,
  actionId: string,
  criterionRef: string,
  nextActions: readonly string[] = [],
): Error {
  Object.defineProperty(error as CriterionError, ENTITY_ACTION_CRITERION_FAILURE, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ actionId, criterionRef, nextActions: Object.freeze([...nextActions]) }),
  });
  return error;
}

export function entityActionCriterionFailure(error: unknown): EntityActionCriterionFailure | null {
  if (!(error instanceof Error)) return null;
  return (error as CriterionError)[ENTITY_ACTION_CRITERION_FAILURE] ?? null;
}

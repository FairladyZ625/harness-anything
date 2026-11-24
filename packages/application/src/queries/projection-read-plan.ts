/** A read plan expresses the same ordered projection calls for local sync and remote async readers. */
export type AsyncProjection<Projection> = {
  readonly [Method in keyof Projection]: Projection[Method] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promise<Result>
    : never;
};

type Step<Projection> = (projection: Projection | AsyncProjection<Projection>) => unknown;
export type ProjectionReadPlan<Projection, Result> = Generator<Step<Projection>, Result, unknown>;

export function* projectionRead<Projection, Result>(
  step: (projection: Projection | AsyncProjection<Projection>) => Result | Promise<Result>,
): ProjectionReadPlan<Projection, Result> {
  // The runners resume this step only with the returned value of this exact call.
  return (yield step) as Result;
}

export function runProjectionRead<Projection, Result>(
  plan: ProjectionReadPlan<Projection, Result>,
  projection: Projection,
): Result {
  let step = plan.next();
  while (!step.done) step = plan.next(step.value(projection));
  return step.value;
}

export async function runAsyncProjectionRead<Projection, Result>(
  plan: ProjectionReadPlan<Projection, Result>,
  projection: AsyncProjection<Projection>,
): Promise<Result> {
  let step = plan.next();
  while (!step.done) step = plan.next(await step.value(projection));
  return step.value;
}

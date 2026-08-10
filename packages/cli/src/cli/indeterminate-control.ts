import { Effect } from "effect";
import {
  isIndeterminateFlushControlOutcome,
  type IndeterminateFlushControlOutcome
} from "@harness-anything/kernel";

/** Keep an unknown terminal write outcome on the typed control channel. */
export function mapFailurePreservingIndeterminate<Error, Result>(
  error: Error,
  mapFailure: (error: Exclude<Error, IndeterminateFlushControlOutcome>) => Result
): Effect.Effect<Result, IndeterminateFlushControlOutcome> {
  return isIndeterminateFlushControlOutcome(error)
    ? Effect.fail(error)
    : Effect.succeed(mapFailure(error as Exclude<Error, IndeterminateFlushControlOutcome>));
}

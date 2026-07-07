import { Effect } from "effect";
import type { Exit } from "effect";

export async function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await runEffectExit(effect);
  if (exit._tag === "Success") return exit.value;
  throw new Error(String(exit.cause));
}

export function runEffectExit<A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> {
  return new Promise((resolve) => {
    Effect.runCallback(effect, { onExit: resolve });
  });
}

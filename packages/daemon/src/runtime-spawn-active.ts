import type { ActiveRuntime, ResumeProcessObservation } from "./runtime-spawn-types.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";

type ActiveRuntimeBase = Omit<
  ActiveRuntime,
  | "buffer"
  | "durableOutputCount"
  | "stdoutObserved"
  | "errorBuffer"
  | "errorOverflowed"
  | "providerSessionId"
  | "finalText"
  | "failureText"
  | "providerOutcome"
  | "writeItemObserved"
  | "planObserved"
  | "planIncomplete"
  | "protocolError"
  | "cancelRequested"
  | "cancelBinding"
  | "cancelOpId"
  | "lossReason"
  | "lossSignal"
  | "lossExitCode"
  | "toolCallObserved"
  | "providerFault"
  | "fallbackAttempt"
> & { readonly providerSessionId?: string | null; readonly fallbackAttempt?: ActiveRuntime["fallbackAttempt"] };

export function createActiveRuntime(base: ActiveRuntimeBase): ActiveRuntime {
  return {
    ...base,
    fallbackAttempt: base.fallbackAttempt ?? null,
    buffer: "",
    durableOutputCount: 0,
    stdoutObserved: false,
    errorBuffer: "",
    errorOverflowed: false,
    providerSessionId: base.providerSessionId ?? null,
    finalText: null,
    failureText: null,
    providerOutcome: null,
    writeItemObserved: false,
    planObserved: false,
    planIncomplete: false,
    protocolError: false,
    cancelRequested: false,
    cancelBinding: null,
    cancelOpId: null,
    lossReason: null,
    lossSignal: null,
    lossExitCode: null,
    toolCallObserved: false,
    providerFault: null,
  };
}

export function attachActiveRuntime(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  resumeObservation?: ResumeProcessObservation,
): void {
  const runtimeSessionId = active.runtimeSessionId,
    handlers = {
      output: (chunk: string, persisted = false) => {
        if (context.processes.get(runtimeSessionId) === active)
          context.input.schedule(async () => {
            if (context.processes.get(runtimeSessionId) === active) {
              active.stdoutObserved ||= chunk.length > 0;
              await context.consumeChunk(active, chunk, false, persisted);
            }
          });
      },
      error: (chunk: string) => {
        if (context.processes.get(runtimeSessionId) === active) {
          context.input.schedule(() => context.captureErrorOutput(active, chunk));
        }
      },
      exit: (code: number | null) => {
        if (context.processes.get(runtimeSessionId) === active)
          context.input.schedule(async () => {
            if (context.processes.get(runtimeSessionId) !== active) return;
            await context.consumeChunk(active, "", true);
            await context.publishExit(active, code);
          });
      },
    };
  if (resumeObservation) resumeObservation.activate(handlers);
  else {
    active.process.onOutput(handlers.output);
    active.process.onErrorOutput(handlers.error);
    active.process.onExit(handlers.exit);
  }
}

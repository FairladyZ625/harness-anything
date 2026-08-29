import type { AgentRuntimeEventV1, CanonicalEventStore, SessionIdentity } from "../../kernel/src/index.ts";
import type { readDispatchStream } from "./dispatch-stream.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { RuntimeAttemptOutcome } from "./runtime-fallback-contract.ts";
import type { RuntimeSpawnerInput } from "./runtime-spawner.ts";
import type { ActiveRuntime, RuntimeBinding, RuntimeAttemptTerminal } from "./runtime-spawn-types.ts";
import type { launchExitNotification } from "./runtime-spawn-process.ts";
import type { requiredRuntimeProjection, requiredRuntimeStore } from "./runtime-spawn-process.ts";
import type { runtimeSpawnError } from "./runtime-spawn-errors.ts";
import type { parseProviderFrame } from "./runtime-spawn-provider-frames.ts";
import type { isStructuredSuccessResult } from "./runtime-spawn-provider-frames.ts";

type RuntimeEventMap = {
  [Event in AgentRuntimeEventV1 as Event["type"]]: Event;
};

export type RuntimeEventType = keyof RuntimeEventMap;
export type RuntimeEventOf<T extends RuntimeEventType> = RuntimeEventMap[T];

export function runtimeEventHasType<T extends RuntimeEventType>(
  event: AgentRuntimeEventV1,
  type: T,
): event is RuntimeEventOf<T> {
  return event.type === type;
}

export interface RuntimeEventPublication<T extends RuntimeEventType> {
  readonly event: RuntimeEventOf<T>;
  readonly publication?: ReturnType<CanonicalEventStore["append"]>;
  readonly receipt?: JsonObject;
}

/** Closed composition contract shared by the runtime spawner's extracted helpers. */
export interface RuntimeSpawnerContext {
  readonly input: RuntimeSpawnerInput;
  readonly requiredRuntimeStore: typeof requiredRuntimeStore;
  readonly requiredRuntimeProjection: typeof requiredRuntimeProjection;
  readonly runtimeSpawnError: typeof runtimeSpawnError;
  readonly consumeChunk: (active: ActiveRuntime, chunk: string, flush: boolean, persisted?: boolean) => Promise<void>;
  readonly consumeLine: (
    active: ActiveRuntime,
    line: string,
    persisted?: boolean,
    publishSignals?: boolean,
  ) => Promise<void>;
  readonly markProtocolError: (active: ActiveRuntime) => void;
  readonly parseProviderFrame: typeof parseProviderFrame;
  readonly bindProvider: (active: ActiveRuntime, identity: SessionIdentity) => Promise<void>;
  readonly isStructuredSuccessResult: typeof isStructuredSuccessResult;
  readonly processes: Map<string, ActiveRuntime>;
  readonly providerErrorLimit: number;
  readonly publishRuntimeEvent: <T extends RuntimeEventType>(
    type: T,
    payload: RuntimeEventOf<T>["payload"],
    opId: string,
    binding: RuntimeBinding,
    resultBody?: string,
  ) => Promise<RuntimeEventPublication<T>>;
  readonly exiting: Set<string>;
  readonly runtimeResultText: (
    active: ActiveRuntime,
    code: number | null,
    outcome: "succeeded" | "failed" | "unknown" | "cancelled",
  ) => string;
  readonly resultMediaType: "text/plain; charset=utf-8";
  readonly launchExitNotification: typeof launchExitNotification;
  readonly publishExit: (active: ActiveRuntime, code: number | null) => Promise<void>;
  readonly controlReceipt: (opId: string, runtimeSessionId: string, detail?: string) => JsonObject;
  readonly captureErrorOutput: (active: ActiveRuntime, chunk: string) => void;
  readonly prepareWorkerGitEnvironment: (instanceId: string) => Promise<NodeJS.ProcessEnv | undefined>;
  readonly settleFallback: (
    active: ActiveRuntime,
    outcome: RuntimeAttemptOutcome,
    terminal: RuntimeAttemptTerminal,
  ) => Promise<void>;
  readonly reconcileFallback: (stream: ReturnType<typeof readDispatchStream>) => void;
}

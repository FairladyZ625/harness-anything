import {
  issueRuntimeExecutionCredential,
  runtimeExecutionLifetimeMs,
  type RuntimeExecutionPrincipal,
} from "./runtime-execution-credential.ts";
import type { PreparedRuntimeLaunch } from "./agent-runtime-instances.ts";
import type { RuntimeDaemonRoute, RuntimeCallbackRelay, TrustedScheduleRuntime } from "./runtime-spawn-types.ts";
import path from "node:path";
import type { AgentRuntimeEventV1, CanonicalEventStore, SessionIdentity } from "@harness-anything/kernel";
import type { readDispatchStream } from "./dispatch-stream.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { RuntimeAttemptOutcome } from "./runtime-fallback-contract.ts";
import type { RuntimeSpawnerInput } from "./runtime-spawn-types.ts";
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

export async function prepareTaskWorkerGitEnvironment(
  input: RuntimeSpawnerInput,
  instanceId: string,
): Promise<NodeJS.ProcessEnv | undefined> {
  const credentialEnvironment = await input.prepareWorkerGitEnvironment?.(instanceId);
  return credentialEnvironment
    ? {
        ...credentialEnvironment,
        GIT_ASKPASS: path.join(input.rootDir, "tools", "git-hooks", "git-askpass"),
        HARNESS_TASK_BOUND: "1",
      }
    : undefined;
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
  readonly publishExit: (active: ActiveRuntime, code: number | null, resumePublishedExit?: boolean) => Promise<void>;
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

/** The bound worker environment is the sole delivery point for its short-lived execution secret. */
export async function prepareBoundRuntimeLaunch(args: {
  readonly input: RuntimeSpawnerInput;
  readonly prepared: PreparedRuntimeLaunch;
  readonly daemonRoute?: RuntimeDaemonRoute;
  readonly callbackRelay?: RuntimeCallbackRelay;
  readonly workerGitEnvironment?: NodeJS.ProcessEnv | null;
  readonly workerIdentityEnvironment: NodeJS.ProcessEnv;
  readonly runtimeActor: string;
  readonly taskId: string | null;
  readonly trustedSchedule?: TrustedScheduleRuntime;
  readonly reviewerBinding: boolean;
  readonly execution?: Omit<RuntimeExecutionPrincipal, "expiresAt">;
}): Promise<PreparedRuntimeLaunch> {
  const { input, prepared, daemonRoute, callbackRelay, taskId, trustedSchedule } = args;
  if (!(taskId || trustedSchedule || args.reviewerBinding) || !daemonRoute) return prepared;
  const expiresAt = new Date(Date.parse(input.now()) + runtimeExecutionLifetimeMs).toISOString(),
    credential =
      args.execution && input.keycloakCenter
        ? await issueRuntimeExecutionCredential(await input.keycloakCenter(), { ...args.execution, expiresAt })
        : undefined;
  return {
    ...prepared,
    env: {
      ...prepared.env,
      ...args.workerGitEnvironment,
      ...args.workerIdentityEnvironment,
      HARNESS_CANONICAL_ROOT: input.rootDir,
      PATH: [path.join(input.rootDir, "tools", "git-hooks"), prepared.env.PATH ?? process.env.PATH ?? ""]
        .filter(Boolean)
        .join(path.delimiter),
      HARNESS_DAEMON_USER_ROOT: daemonRoute.userRoot,
      HARNESS_DAEMON_ID: daemonRoute.daemonId,
      HARNESS_DAEMON_ENDPOINT: callbackRelay?.path ?? daemonRoute.endpoint,
      HARNESS_DAEMON_RELAY: callbackRelay ? "1" : undefined,
      HARNESS_DAEMON_REPO_ID: input.repoId,
      HARNESS_ACTOR: args.runtimeActor,
      HARNESS_EXECUTION_CREDENTIAL: credential,
      HARNESS_EXECUTION_EXPIRES_AT: credential ? expiresAt : undefined,
      ...(taskId ? { HARNESS_TASK_BOUND: "1" } : {}),
      ...(trustedSchedule
        ? {
            HARNESS_SCHEDULE_ID: trustedSchedule.scheduleId,
            HARNESS_SCHEDULE_CLAIM_FENCE: trustedSchedule.claimFence,
            HARNESS_SCHEDULE_MODE: trustedSchedule.mode,
          }
        : {}),
    },
  };
}

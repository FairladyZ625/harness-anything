import type {
  AuthorityFenceStage,
  AuthorityFenceWitness,
  DaemonLogService
} from "@harness-anything/application";
import {
  DaemonGenerationWitnessLostError,
  type DaemonGenerationWitness
} from "../lifecycle/daemon-generation.ts";

export const daemonGenerationFencedCode = "DAEMON_GENERATION_FENCED" as const;
export const daemonGenerationWriteRejectionSchema = "daemon-generation-write-rejection/v1" as const;

export interface DaemonGenerationWriteRejectionV1 {
  readonly schema: typeof daemonGenerationWriteRejectionSchema;
  readonly machineId: string;
  readonly attemptedDaemonGeneration: number;
  readonly currentDaemonGeneration?: number;
  readonly runtimeRegistrationId?: string;
  readonly connectionId?: string;
  readonly workspaceId: string;
  readonly opId?: string;
  readonly stage: AuthorityFenceStage;
}

export class DaemonGenerationFencedError extends Error {
  readonly code = daemonGenerationFencedCode;
  readonly context: DaemonGenerationWriteRejectionV1;

  constructor(context: DaemonGenerationWriteRejectionV1, cause?: unknown) {
    super(JSON.stringify(context), cause === undefined ? undefined : { cause });
    this.name = "DaemonGenerationFencedError";
    this.context = context;
  }
}

export function createDaemonGenerationAuthorityFence(input: {
  readonly authorityFence: AuthorityFenceWitness;
  readonly generationWitness: DaemonGenerationWitness;
  readonly workspaceId: string;
  readonly repo: { readonly repoId: string; readonly canonicalRoot: string };
  readonly runtimeRegistrationId?: () => string | undefined;
  readonly connectionId?: string;
  readonly logService?: DaemonLogService;
}): AuthorityFenceWitness {
  const generationFence = createDaemonGenerationWitnessFence(input);
  return {
    assertHeld: async (stage, operation) => {
      await input.authorityFence.assertHeld(stage, operation);
      await generationFence.assertHeld(stage, operation);
    }
  };
}

function createDaemonGenerationWitnessFence(input: Omit<
  Parameters<typeof createDaemonGenerationAuthorityFence>[0],
  "authorityFence"
>): AuthorityFenceWitness {
  return {
    assertHeld: async (stage = "before-prepare", operation) => {
      try {
        input.generationWitness.assertCurrent();
      } catch (cause) {
        const runtimeRegistrationId = input.runtimeRegistrationId?.();
        const context: DaemonGenerationWriteRejectionV1 = {
          schema: daemonGenerationWriteRejectionSchema,
          machineId: input.generationWitness.machineId,
          attemptedDaemonGeneration: input.generationWitness.daemonGeneration,
          ...(cause instanceof DaemonGenerationWitnessLostError && cause.observed
            ? { currentDaemonGeneration: cause.observed.daemonGeneration }
            : {}),
          ...(runtimeRegistrationId ? { runtimeRegistrationId } : {}),
          ...(input.connectionId ? { connectionId: input.connectionId } : {}),
          workspaceId: input.workspaceId,
          ...(operation?.opId ? { opId: operation.opId } : {}),
          stage
        };
        await recordGenerationRejection(input, context);
        throw new DaemonGenerationFencedError(context, cause);
      }
    }
  };
}

export function createRuntimeDaemonGenerationAuthorityFence(input: {
  readonly runtime: {
    readonly daemonGenerationContext?: () => {
      readonly witness: DaemonGenerationWitness;
      readonly machineId: string;
      readonly daemonGeneration: number;
      readonly runtimeRegistrationId?: string;
    } | undefined;
  };
  readonly authorityFence: AuthorityFenceWitness;
  readonly workspaceId: string;
  readonly repo: { readonly repoId: string; readonly canonicalRoot: string };
  readonly connectionId?: string;
  readonly logService?: DaemonLogService;
}): AuthorityFenceWitness | undefined {
  const generation = input.runtime.daemonGenerationContext?.();
  if (!generation) return undefined;
  return createDaemonGenerationAuthorityFence({
    authorityFence: input.authorityFence,
    generationWitness: generation.witness,
    workspaceId: input.workspaceId,
    repo: input.repo,
    runtimeRegistrationId: () => input.runtime.daemonGenerationContext?.()?.runtimeRegistrationId,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.logService ? { logService: input.logService } : {})
  });
}

export function createRuntimeDaemonGenerationWitnessFence(input: Omit<
  Parameters<typeof createRuntimeDaemonGenerationAuthorityFence>[0],
  "authorityFence"
>): AuthorityFenceWitness | undefined {
  const generation = input.runtime.daemonGenerationContext?.();
  if (!generation) return undefined;
  return createDaemonGenerationWitnessFence({
    generationWitness: generation.witness,
    workspaceId: input.workspaceId,
    repo: input.repo,
    runtimeRegistrationId: () => input.runtime.daemonGenerationContext?.()?.runtimeRegistrationId,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.logService ? { logService: input.logService } : {})
  });
}

export function daemonGenerationAxes(input: Parameters<typeof createRuntimeDaemonGenerationAuthorityFence>[0]["runtime"]): {
  readonly machineId: string;
  readonly daemonGeneration: number;
  readonly runtimeRegistrationId?: string;
} {
  const generation = input.daemonGenerationContext?.();
  if (!generation) throw new Error("DAEMON_GENERATION_CONTEXT_REQUIRED");
  return {
    machineId: generation.machineId,
    daemonGeneration: generation.daemonGeneration,
    ...(generation.runtimeRegistrationId ? { runtimeRegistrationId: generation.runtimeRegistrationId } : {})
  };
}

async function recordGenerationRejection(
  input: Pick<Parameters<typeof createDaemonGenerationAuthorityFence>[0], "logService" | "repo">,
  context: DaemonGenerationWriteRejectionV1
): Promise<void> {
  if (!input.logService) return;
  try {
    await input.logService.append({
      level: "warn",
      source: "daemon",
      component: "daemon.generation",
      event: "daemon.generation.write-rejected",
      message: "Rejected a terminal write from a stale daemon generation.",
      errorCode: daemonGenerationFencedCode,
      hint: JSON.stringify(context),
      ...(context.opId ? { requestId: context.opId } : {})
    }, { repo: input.repo });
  } catch {
    // Logging is best effort; a logging failure must never admit the stale write.
  }
}

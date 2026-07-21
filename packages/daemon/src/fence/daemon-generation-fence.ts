import type {
  AuthorityFenceStage,
  AuthorityFenceWitness,
  AuthorityGenerationFence,
  DaemonGenerationWriteRejectionV1
} from "@harness-anything/application";
import {
  DaemonGenerationWitnessLostError,
  type DaemonGenerationWitness
} from "../lifecycle/daemon-generation.ts";

export const daemonGenerationFencedCode = "DAEMON_GENERATION_FENCED" as const;
export const daemonGenerationWriteRejectionSchema = "daemon-generation-write-rejection/v1" as const;
export type { DaemonGenerationWriteRejectionV1 } from "@harness-anything/application";

export class DaemonGenerationFencedError extends Error {
  readonly code = daemonGenerationFencedCode;
  readonly context: DaemonGenerationWriteRejectionV1;

  constructor(context: DaemonGenerationWriteRejectionV1, cause?: unknown) {
    super("The daemon generation is stale; query the current daemon for the durable outcome.", cause === undefined ? undefined : { cause });
    this.name = "DaemonGenerationFencedError";
    this.context = context;
  }
}

interface GenerationFenceInput {
  readonly generationWitness: DaemonGenerationWitness;
  readonly workspaceId: string;
  readonly repo: { readonly repoId: string; readonly canonicalRoot: string };
  readonly runtimeRegistrationId?: () => string | undefined;
  readonly connectionId?: string;
}

export function createDaemonGenerationAuthorityFence(
  input: GenerationFenceInput & { readonly authorityFence: AuthorityFenceWitness }
): AuthorityGenerationFence {
  const generationFence = createDaemonGenerationWitnessFence(input);
  return {
    assertHeld: async (stage, operation) => {
      await input.authorityFence.assertHeld(stage, operation);
      await generationFence.assertHeld(stage, operation);
    },
    runExclusive: (stage, context, operation) => generationFence.runExclusive(stage, context, async () => {
      await input.authorityFence.assertHeld(stage, context);
      return operation();
    })
  };
}

function createDaemonGenerationWitnessFence(input: GenerationFenceInput): AuthorityGenerationFence {
  let stale: DaemonGenerationFencedError | undefined;
  const fenced = (
    stage: AuthorityFenceStage,
    operation: { readonly workspaceId: string; readonly opId: string } | undefined,
    cause: DaemonGenerationWitnessLostError
  ): DaemonGenerationFencedError => {
    if (stale) return stale;
    const runtimeRegistrationId = input.runtimeRegistrationId?.();
    stale = new DaemonGenerationFencedError({
      schema: daemonGenerationWriteRejectionSchema,
      machineId: input.generationWitness.machineId,
      attemptedDaemonGeneration: input.generationWitness.daemonGeneration,
      ...(cause.observed ? { currentDaemonGeneration: cause.observed.daemonGeneration } : {}),
      ...(runtimeRegistrationId ? { runtimeRegistrationId } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      workspaceId: input.workspaceId,
      ...(operation?.opId ? { opId: operation.opId } : {}),
      stage
    }, cause);
    return stale;
  };
  return {
    assertHeld: async (stage = "before-prepare", operation) => {
      if (stale) throw stale;
      try {
        input.generationWitness.assertCurrent();
      } catch (cause) {
        if (!(cause instanceof DaemonGenerationWitnessLostError)) throw cause;
        throw fenced(stage, operation, cause);
      }
    },
    runExclusive: async (stage, operation, persist) => {
      if (stale) throw stale;
      try {
        return await input.generationWitness.runExclusive(persist);
      } catch (cause) {
        if (!(cause instanceof DaemonGenerationWitnessLostError)) throw cause;
        throw fenced(stage, operation, cause);
      }
    }
  };
}

interface RuntimeGenerationFenceInput {
  readonly runtime: {
    readonly daemonGenerationContext?: () => {
      readonly witness: DaemonGenerationWitness;
      readonly machineId: string;
      readonly daemonGeneration: number;
      readonly runtimeRegistrationId?: string;
    } | undefined;
    readonly daemonGenerationCapability?: () =>
      | { readonly mode: "generation" }
      | { readonly mode: "legacy"; readonly platform: "win32"; readonly diagnostic: "DAEMON_GENERATION_DURABILITY_UNSUPPORTED" }
      | { readonly mode: "unconfigured" };
  };
  readonly workspaceId: string;
  readonly repo: { readonly repoId: string; readonly canonicalRoot: string };
  readonly connectionId?: string;
}

export function createRuntimeDaemonGenerationAuthorityFence(
  input: RuntimeGenerationFenceInput & { readonly authorityFence: AuthorityFenceWitness }
): AuthorityGenerationFence | undefined {
  const generation = input.runtime.daemonGenerationContext?.();
  if (!generation) return missingGenerationContext(input.runtime);
  return createDaemonGenerationAuthorityFence({
    authorityFence: input.authorityFence,
    generationWitness: generation.witness,
    workspaceId: input.workspaceId,
    repo: input.repo,
    runtimeRegistrationId: () => input.runtime.daemonGenerationContext?.()?.runtimeRegistrationId,
    ...(input.connectionId ? { connectionId: input.connectionId } : {})
  });
}

export function createRuntimeDaemonGenerationWitnessFence(
  input: RuntimeGenerationFenceInput
): AuthorityGenerationFence | undefined {
  const generation = input.runtime.daemonGenerationContext?.();
  if (!generation) return missingGenerationContext(input.runtime);
  return createDaemonGenerationWitnessFence({
    generationWitness: generation.witness,
    workspaceId: input.workspaceId,
    repo: input.repo,
    runtimeRegistrationId: () => input.runtime.daemonGenerationContext?.()?.runtimeRegistrationId,
    ...(input.connectionId ? { connectionId: input.connectionId } : {})
  });
}

function missingGenerationContext(
  runtime: RuntimeGenerationFenceInput["runtime"]
): undefined {
  const capability = runtime.daemonGenerationCapability?.();
  if (capability?.mode === "legacy"
    && capability.platform === "win32"
    && capability.diagnostic === "DAEMON_GENERATION_DURABILITY_UNSUPPORTED") return undefined;
  throw new Error("DAEMON_GENERATION_CONTEXT_REQUIRED_FOR_PRODUCTION_AUTHORITY");
}

export function daemonGenerationAxes(input: RuntimeGenerationFenceInput["runtime"]): {
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

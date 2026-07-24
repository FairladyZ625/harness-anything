import type { DaemonRuntimePolicy } from "./runtime-policy.ts";
import { makeRepoWriteStrictCodec } from "./repo-write-strict-codec.ts";

const {
  record,
  exactKeys,
  text,
  nonNegativeInteger,
  invalid
} = makeRepoWriteStrictCodec("REPO_WRITE_CHILD_LAUNCH_CONFIG_INVALID");

export const repoWriteChildLaunchConfigSchema =
  "repo-write-child-launch/v1" as const;

export interface RepoWriteChildLaunchConfigV1 {
  readonly schema: typeof repoWriteChildLaunchConfigSchema;
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly authoredRoot?: string;
  readonly authorityManifest: string;
  readonly userRoot: string;
  readonly endpointIdentity: string;
  readonly machineId: string;
  readonly generation: number;
  readonly runtimePolicy: DaemonRuntimePolicy;
  readonly admissionMaxBytes?: number;
}

export function encodeRepoWriteChildLaunchConfig(
  config: RepoWriteChildLaunchConfigV1
): string {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
}

export function decodeRepoWriteChildLaunchConfig(
  encoded: string
): RepoWriteChildLaunchConfigV1 {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (error) {
    throw new Error("REPO_WRITE_CHILD_LAUNCH_CONFIG_INVALID", { cause: error });
  }
  const config = record(value, "$");
  exactKeys(config, [
    "schema", "repoId", "canonicalRoot", "authorityManifest", "userRoot",
    "endpointIdentity", "machineId", "generation", "runtimePolicy"
  ], "$", ["authoredRoot", "admissionMaxBytes"]);
  if (config.schema !== repoWriteChildLaunchConfigSchema) invalid("$.schema");
  const runtime = record(config.runtimePolicy, "$.runtimePolicy");
  exactKeys(
    runtime,
    ["write", "materializer", "projection", "registry"],
    "$.runtimePolicy"
  );
  const write = record(runtime.write, "$.runtimePolicy.write");
  exactKeys(write, [
    "lockTtlMs", "interactiveMicroBatchMs", "maxInteractiveOpsPerCommit"
  ], "$.runtimePolicy.write");
  const materializer = record(
    runtime.materializer,
    "$.runtimePolicy.materializer"
  );
  exactKeys(
    materializer,
    ["pollMs", "maxBranchesPerBatch"],
    "$.runtimePolicy.materializer"
  );
  const projection = record(runtime.projection, "$.runtimePolicy.projection");
  exactKeys(
    projection,
    ["reconcileIntervalMs"],
    "$.runtimePolicy.projection"
  );
  const registry = record(runtime.registry, "$.runtimePolicy.registry");
  exactKeys(
    registry,
    ["reconcileIntervalMs"],
    "$.runtimePolicy.registry"
  );
  return {
    schema: repoWriteChildLaunchConfigSchema,
    repoId: text(config.repoId, "$.repoId"),
    canonicalRoot: text(config.canonicalRoot, "$.canonicalRoot"),
    ...(config.authoredRoot === undefined ? {} : {
      authoredRoot: text(config.authoredRoot, "$.authoredRoot")
    }),
    authorityManifest: text(config.authorityManifest, "$.authorityManifest"),
    userRoot: text(config.userRoot, "$.userRoot"),
    endpointIdentity: text(config.endpointIdentity, "$.endpointIdentity"),
    machineId: text(config.machineId, "$.machineId"),
    generation: positiveInteger(config.generation, "$.generation"),
    runtimePolicy: {
      write: {
        lockTtlMs: positiveInteger(
          write.lockTtlMs,
          "$.runtimePolicy.write.lockTtlMs"
        ),
        interactiveMicroBatchMs: nonNegativeInteger(
          write.interactiveMicroBatchMs,
          "$.runtimePolicy.write.interactiveMicroBatchMs"
        ),
        maxInteractiveOpsPerCommit: positiveInteger(
          write.maxInteractiveOpsPerCommit,
          "$.runtimePolicy.write.maxInteractiveOpsPerCommit"
        )
      },
      materializer: {
        pollMs: positiveInteger(
          materializer.pollMs,
          "$.runtimePolicy.materializer.pollMs"
        ),
        maxBranchesPerBatch: positiveInteger(
          materializer.maxBranchesPerBatch,
          "$.runtimePolicy.materializer.maxBranchesPerBatch"
        )
      },
      projection: {
        reconcileIntervalMs: positiveInteger(
          projection.reconcileIntervalMs,
          "$.runtimePolicy.projection.reconcileIntervalMs"
        )
      },
      registry: {
        reconcileIntervalMs: positiveInteger(
          registry.reconcileIntervalMs,
          "$.runtimePolicy.registry.reconcileIntervalMs"
        )
      }
    },
    ...(config.admissionMaxBytes === undefined ? {} : {
      admissionMaxBytes: positiveInteger(
        config.admissionMaxBytes,
        "$.admissionMaxBytes"
      )
    })
  };
}

function positiveInteger(value: unknown, path: string): number {
  const integer = nonNegativeInteger(value, path);
  if (integer === 0) invalid(path);
  return integer;
}

import {
  makeJournaledWriteCoordinator,
  makeOperationalJournaledWriteCoordinator,
  type DaemonGlobalLock,
  type HarnessLayoutOverrides,
  type OperationalActor,
  type ProjectionChangeEvent
} from "@harness-anything/kernel";
import type { HarnessDaemonRuntime } from "./repo-runtime-options.ts";
import type { InteractiveWriteAttribution } from "./write-queue.ts";
import {
  reportFlushGitCommitPhase,
  reportFlushPostCommitPhase,
  reportFlushProjectionFingerprintDiagnostic,
  reportFlushProjectionFingerprintPhase
} from "./repo-write-materializer-telemetry.ts";

export function makeStartedRepoWriteCoordinator(input: {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly operationalActor: OperationalActor;
  readonly lockTtlMs: number;
  readonly lock: DaemonGlobalLock;
  readonly onProjectionChange: (event: ProjectionChangeEvent) => void;
  readonly versionControlSystem: NonNullable<Parameters<typeof makeJournaledWriteCoordinator>[0]["versionControlSystem"]>;
  readonly request: InteractiveWriteAttribution & Partial<Parameters<HarnessDaemonRuntime["createAttributedCoordinator"]>[0]>;
}): ReturnType<typeof makeJournaledWriteCoordinator> {
  const common = {
    rootDir: input.rootDir,
    layoutOverrides: input.layoutOverrides,
    operationalActor: input.operationalActor,
    lockTtlMs: input.lockTtlMs,
    heldGlobalLock: input.lock,
    autoMaterialize: false,
    onProjectionChange: input.onProjectionChange,
    onCommitPhase: reportFlushGitCommitPhase,
    onProjectionFingerprintPhase: reportFlushProjectionFingerprintPhase,
    onProjectionFingerprintDiagnostic: reportFlushProjectionFingerprintDiagnostic,
    onPostCommitPhase: reportFlushPostCommitPhase,
    versionControlSystem: input.versionControlSystem,
    ...(input.request.sessionId ? { sessionId: input.request.sessionId } : {}),
    ...(input.request.commitAuthor ? { commitAuthor: input.request.commitAuthor } : {}),
    ...(input.request.exactWriteScope ? { exactWriteScope: input.request.exactWriteScope } : {})
  };
  return input.request.attribution
    ? makeJournaledWriteCoordinator({ ...common, attribution: input.request.attribution })
    : makeOperationalJournaledWriteCoordinator({ ...common, operationalActor: input.request.operationalActor });
}

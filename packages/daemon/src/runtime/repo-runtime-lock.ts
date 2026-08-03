import {
  createHarnessRuntimeContext,
  type OperationalActor
} from "@harness-anything/kernel";
import {
  acquireDaemonGlobalLock,
  type DaemonGlobalLock
} from "@harness-anything/kernel/daemon-runtime-support";
import type { DaemonRuntimeOptions } from "./repo-runtime-options.ts";

export function acquireRepoRuntimeGlobalLock(input: {
  readonly rootDir: string;
  readonly runtimeContext: ReturnType<typeof createHarnessRuntimeContext>;
  readonly journalPath: string;
  readonly operationalActor: OperationalActor;
  readonly lockTtlMs: number;
  readonly repoId: string;
  readonly lockProvenance?: DaemonRuntimeOptions["lockProvenance"];
}): DaemonGlobalLock {
  return acquireDaemonGlobalLock(
    input.rootDir,
    input.runtimeContext,
    input.journalPath,
    input.operationalActor,
    input.lockTtlMs,
    {
      repoId: input.lockProvenance?.repoId ?? input.repoId,
      canonicalRoot: input.lockProvenance?.canonicalRoot ?? input.rootDir,
      ...(input.lockProvenance?.userRoot ? { userRoot: input.lockProvenance.userRoot } : {}),
      ...(input.lockProvenance?.endpoint ? { endpoint: input.lockProvenance.endpoint } : {})
    }
  );
}

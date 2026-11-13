import type { OntologyPolicyDeclaration } from "./ontology-source.ts";

/** Resource lifetime belongs to the host; writer epochs and domain admission remain unchanged. */
export const writerLifecyclePolicy = {
  id: "writer-idle-retirement",
  ownerRef: "host",
  unit: "milliseconds / indexed rows",
  bounds:
    "Retire after 30000ms without admitted work; inspect one active dispatch row; cap the young generation at 8 MiB without capping the old generation.",
  defaultValue: { idleTimeoutMs: 30_000, activeProbeLimit: 1, maxYoungGenerationSizeMb: 8 },
  version: 1,
  scope: "daemon process repository writer lifecycle",
  reason:
    "Retain the recent active write working set and all background owners; release idle isolates while the host retains its repository lock and writer epoch.",
  fixtures: [
    "packages/daemon/test/writer-supervisor-idle.test.ts",
    "packages/daemon/test/writer-supervisor-memory.integration.test.ts",
  ],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/writer-lifecycle-policy.ts#writerLifecyclePolicy.defaultValue.idleTimeoutMs:f8b2424845a33c0065288aff43880e78",
      route: "daemon:bin",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/writer-lifecycle-policy.ts#writerLifecyclePolicy.defaultValue.activeProbeLimit:b08728d69483af7cc532562c05460881",
      route: "daemon:bin",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/repo-writer-worker.ts#startRepoWriterWorker.handleRequest.retainAuthorization.released:c634ea4f4d8960a8ac39fbdbce66e15c",
      route: "writerLifecyclePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/writer-supervisor.ts#openWriterSupervisor.restartAttempt:4236c9df89dea3d0ad7b4f484ddc3e0d",
      route: "writerLifecyclePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/writer-supervisor.ts#openWriterSupervisor.startWriterWorker:bc703d8da08ba38c2a8af202bcca6814",
      route: "writerLifecyclePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/writer-supervisor.ts#statusWithCurrentRetryElapsed:fadb527a4770a02b0d2941f836b808ac",
      route: "writerLifecyclePolicy",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;

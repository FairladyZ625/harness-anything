import type { TaskLifecycleSnapshot } from "./task-lifecycle.contract.ts";
import type { TaskProgressEventV1 } from "./task-progress-event.ts";
import type { RuntimeSession } from "./agent-runtime.ts";
import { isSamePerson } from "./actor-domain-services.ts";
import type { OntologyPolicyDeclaration, OntologyJudgmentDeclaration } from "./ontology-source.ts";

export const storageReplayPolicy = {
  id: "storage-replay",
  ownerRef: "host",
  unit: "historical replay decode options",
  bounds:
    "Historical projection replay accepts terminal events before a session and tolerates invalid legacy frontmatter arrays.",
  defaultValue: { runtime: { allowPreSessionTerminal: true }, frontmatter: { tolerateInvalidArrays: true } },
  version: 1,
  scope: "Canonical historical storage replay",
  reason: "Preserve the explicit historical decode mode without duplicating its configuration in storage readers.",
  fixtures: [
    "packages/storage/test/store/runtime-lease-history-replay.test.ts",
    "packages/storage/test/store/attach-migrations.test.ts",
  ],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/storage-replay-policy.ts#storageReplayPolicy.defaultValue.runtime.allowPreSessionTerminal:34eece318cfaa4bd36b70efd9e5efdf9",
    "policy:packages/kernel:packages/kernel/src/domain/storage-replay-policy.ts#storageReplayPolicy.defaultValue.frontmatter.tolerateInvalidArrays:86295cca9ed826b10d9b3750cf89a6fe",
    "policy:packages/kernel:packages/kernel/src/domain/storage-replay-policy.ts#assertTaskProgressReferences:238f6854ccf4d19e85e7b6a5bef77079",
  ].map((candidateId) => ({ candidateId, route: "storageReplayPolicy" })),
} as const satisfies OntologyPolicyDeclaration;

export function assertTaskProgressReferences(
  snapshot: TaskLifecycleSnapshot,
  event: TaskProgressEventV1,
  packagePath: unknown,
  runtime: Pick<RuntimeSession, "taskBindings"> | null,
): void {
  const taskId = event.payload.taskId,
    claim = event.payload.resultDocumentClaim,
    runtimeSessionIdValue = event.payload.runtimeSessionId;
  if (
    snapshot.task === null ||
    !(event.payload.executionId === ""
      ? snapshot.task.taskClass === "work" && isSamePerson(snapshot.task.createdBy, event.actor)
      : snapshot.executions.some((execution) => execution.executionId === event.payload.executionId)) ||
    !packagePath ||
    claim.path !== `${packagePath}/progress.md` ||
    (runtimeSessionIdValue !== undefined && !runtime?.taskBindings.some((binding) => binding.taskId === taskId))
  )
    throw new Error(`progress event task, execution, or runtime reference mismatch for task ${taskId}`);
}

export const storageReplayJudgments = [
  {
    id: "assertTaskProgressReferences",
    symbol: "packages/kernel/src/domain/storage-replay-policy.ts#assertTaskProgressReferences",
    inputs: ["task lifecycle snapshot, progress event, package path and runtime bindings"],
    output: "void or original reference mismatch error",
    failureCodes: [],
    explain: "Preserve the existing assertTaskProgressReferences verdict at one canonical definition.",
    consumers: ["packages/storage/src/projection/rebuildable-task-projection-write-model.ts"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/storage-replay-policy.ts#assertTaskProgressReferences:5b5ebce493ee6c2344100afded86f644",
        route: "storage-replay-policy",
      },
    ],
  },
] as const satisfies readonly OntologyJudgmentDeclaration[];

import { isNativeCommitSha } from "./execution.ts";
import { canonicalCodeDocPaths, codeDocRecordId, currentCodeDocRecord, sameCodeDocPaths } from "./code-doc-witness.ts";
import type { CodeDocRepointV1 } from "./code-doc-witness.ts";
import type { ExecutionV1 } from "./execution.ts";
import { isSameExecution } from "./actor-domain-services.ts";
import { ACTION_COORDINATION_DISABLED } from "./action-envelope.ts";
import type { TaskV1 } from "./task.ts";
import { isNonEmptyString } from "./write-chain.contract.ts";
import type { CodeDocRepointedEvent } from "./task-lifecycle-event.ts";
import type {
  RepointCodeDocCommand,
  RepointCodeDocProof,
  Transition,
} from "./task-lifecycle-contract-internal-types.ts";
import { envelope, execution, lifecycleContractIssue, revisionIssues } from "./task-lifecycle-contract-support.ts";

export const repoint: Transition = {
  id: "repoint_code_doc",
  commandType: "RepointCodeDoc",
  coordination: ACTION_COORDINATION_DISABLED,
  from: "done",
  proof: ["actorBinding", "code-doc-repoint@v1", "commitPaths"],
  eventType: "code_doc_repointed",
  matches: (command) => command.type === "RepointCodeDoc",
  validate: (snapshot, raw, rawProof) => {
    const command = raw as RepointCodeDocCommand,
      proof = rawProof as Partial<RepointCodeDocProof>,
      target = snapshot.codeDocWitnesses.find((value) => codeDocRecordId(value) === command.record),
      current = target ? execution(snapshot, target.executionId) : undefined,
      active = target ? currentCodeDocRecord(snapshot.codeDocWitnesses, target.executionId) : undefined,
      issues = revisionIssues(snapshot, command);
    if (snapshot.task?.status !== "done" || !current?.submission)
      issues.push(lifecycleContractIssue("invalid_transition", "code-doc repoint requires a completed task"));
    if (
      !target ||
      active !== target ||
      target.taskId !== command.taskId ||
      target.iteration !== current?.iteration ||
      !isNonEmptyString(command.record) ||
      !isNonEmptyString(command.repointId) ||
      snapshot.codeDocWitnesses.some((value) => codeDocRecordId(value) === command.repointId)
    )
      issues.push(
        lifecycleContractIssue(
          "invalid_transition",
          "code-doc repoint requires one existing active record and a new record identifier",
        ),
      );
    if (
      !isNativeCommitSha(command.commitSha) ||
      !canonicalCodeDocPaths(command.paths, true) ||
      !isNonEmptyString(command.reason) ||
      !proof.actorBinding ||
      !isSameExecution(command.actor, proof.actorBinding) ||
      proof.capability !== "code-doc-repoint@v1" ||
      !isNonEmptyString(proof.capabilityRef) ||
      proof.commitPaths?.commitSha !== command.commitSha ||
      !sameCodeDocPaths(proof.commitPaths?.paths, command.paths, true)
    )
      issues.push(
        lifecycleContractIssue(
          "invalid_proof",
          "code-doc repoint must bind one verified replacement or an explicit known-invalid record",
        ),
      );
    return issues;
  },
  reduce: (snapshot, raw) => {
    const command = raw as RepointCodeDocCommand,
      target = snapshot.codeDocWitnesses.find((value) => codeDocRecordId(value) === command.record)!,
      current = execution(snapshot, target.executionId) as ExecutionV1,
      record: CodeDocRepointV1 = {
        schema: "code-doc-witness-repoint/v1",
        recordId: command.repointId,
        supersedes: command.record,
        taskId: command.taskId,
        executionId: target.executionId,
        commitSha: command.commitSha,
        iteration: target.iteration,
        paths: [...new Set(command.paths)].sort(),
        disposition: command.paths.length ? "repointed" : "known-invalid",
        reason: command.reason,
        actor: command.actor,
        source: command.source,
        repointedAt: command.occurredAt,
      };
    return {
      snapshot: {
        ...snapshot,
        revision: command.workspaceRevision,
        codeDocWitnesses: [...snapshot.codeDocWitnesses, record],
      },
      event: envelope<CodeDocRepointedEvent>(command, "code_doc_repointed", {
        task: snapshot.task as TaskV1,
        execution: current,
        record,
      }),
    };
  },
};

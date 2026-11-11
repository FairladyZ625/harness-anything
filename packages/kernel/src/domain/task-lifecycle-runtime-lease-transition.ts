import { isSamePerson } from "./actor-domain-services.ts";
import type { LeaseReleasedEvent } from "./task-lifecycle-event.ts";
import type { ReleaseRuntimeLeaseCommand, Transition } from "./task-lifecycle-contract-internal-types.ts";
import { envelope, execution, lifecycleContractIssue, revisionIssues } from "./task-lifecycle-contract-support.ts";
import { isNonEmptyString, sameWriteSource } from "./write-chain.contract.ts";

/** The runtime settlement writer for the existing task lifecycle event stream. */
export const releaseRuntimeLease: Transition = {
  offline: true,
  actionId: "release",
  matches: (command) => command.type === "ReleaseRuntimeLease",
  validate: (snapshot, raw) => {
    const command = raw as ReleaseRuntimeLeaseCommand,
      lease = snapshot.lease,
      issues = revisionIssues(snapshot, command);
    if (
      !snapshot.task ||
      snapshot.task.taskId !== command.taskId ||
      !lease ||
      lease.executionId !== command.executionId ||
      lease.version !== command.leaseVersion ||
      !isSamePerson(lease.actor, command.actor) ||
      !sameWriteSource(lease.source, command.source) ||
      !execution(snapshot, command.executionId)
    )
      issues.push(lifecycleContractIssue("invalid_transition", "runtime settlement requires its current lease"));
    if (!isNonEmptyString(command.reason)) issues.push(lifecycleContractIssue("missing_field", "reason is required"));
    return issues;
  },
  reduce: (snapshot, raw) => {
    const command = raw as ReleaseRuntimeLeaseCommand,
      event = envelope<LeaseReleasedEvent>(command, "lease_released", {
        task: snapshot.task!,
        execution: execution(snapshot, command.executionId)!,
        releasedLease: snapshot.lease!,
        mutation: { command: "release", reason: command.reason, fields: ["lease"] },
      });
    return {
      snapshot: { ...snapshot, revision: command.workspaceRevision, lease: null },
      event,
    };
  },
};

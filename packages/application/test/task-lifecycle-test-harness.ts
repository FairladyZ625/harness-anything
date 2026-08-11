import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TaskLifecycleKillpoint } from "../src/task-lifecycle-service.ts";
import { makeJournaledWriteCoordinator, normalizeTaskLifecycleCommand } from "../../kernel/src/index.ts";
import { makeTaskEventStore, makeTaskLeaseStore, makeTaskProjection } from "../../kernel/test/store/task-lifecycle-runtime.ts";
import { makeTaskLifecycleService, runTaskLifecycleEffect } from "../src/task-lifecycle-service.ts";

export const owner = { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "codex" } };
export const reviewer = { principal: { personId: "person-reviewer" }, executor: { kind: "agent" as const, id: "reviewer" } };
export const commitSha = "a".repeat(40);
export const replayGraph = {
  template: "replay/v1" as const,
  nodes: [
    { id: "implementation", kind: "work" },
    { id: "anti_entropy", kind: "adversarial" },
    { id: "review", kind: "review" }
  ] as const,
  edges: [
    { id: "implementation-submitted", from: "implementation", to: "anti_entropy", on: "submitted", actorRole: "executor", kind: "forward" },
    { id: "anti-entropy-approved", from: "anti_entropy", to: "review", on: "approved", actorRole: "anti_entropy", kind: "forward" },
    { id: "anti-entropy-changes-requested", from: "anti_entropy", to: "implementation", on: "changes_requested", actorRole: "anti_entropy", kind: "return" }
  ] as const,
  maxIterations: 1 as const
};

export function lifecycleHarness() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-"));
  const coordinator = makeJournaledWriteCoordinator({ rootDir });
  const eventStore = makeTaskEventStore({ rootDir, coordinator });
  const realProjection = makeTaskProjection({ rootDir, eventStore });
  const leases = makeTaskLeaseStore({ rootDir, coordinator, runEffect: runTaskLifecycleEffect, now: () => "2026-08-11T00:00:00.000Z" });
  let killAt: TaskLifecycleKillpoint | null = null;
  let failProjection = false;
  const projection = {
    read: realProjection.read,
    apply: (event: Parameters<typeof realProjection.apply>[0]) => {
      if (failProjection) {
        failProjection = false;
        throw new Error("projection unavailable");
      }
      realProjection.apply(event);
    }
  };
  const service = makeTaskLifecycleService({
    eventStore,
    projection,
    leases,
    killpoint: (point) => {
      if (point === killAt) {
        killAt = null;
        throw new Error(`killpoint:${point}`);
      }
    }
  });
  const revision = () => eventStore.read().revision;
  const at = (next: number) => `2026-08-11T00:${String(next).padStart(2, "0")}:00.000Z`;
  const command = <C extends Parameters<typeof normalizeTaskLifecycleCommand>[2]>(actor: typeof owner | typeof reviewer, next: number, intent: C, tag: string) => ({
    ...normalizeTaskLifecycleCommand(rootDir, actor, intent), eventId: `event-${tag}`, workspaceRevision: next, occurredAt: at(next)
  });
  return {
    rootDir,
    eventStore,
    projection: realProjection,
    leases,
    service,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
    kill: (point: TaskLifecycleKillpoint) => { killAt = point; },
    failNextProjection: () => { failProjection = true; },
    create: (opId = "op-create") => {
      const next = revision() + 1;
      return service.execute(command(owner, next, {
        type: "CreateReplayTask", taskId: "task-1", title: "Replay task", graph: replayGraph, completionGateIds: []
      }, opId), { taskIdUnique: true, actorBinding: owner });
    },
    start: (executionId = `execution-${revision() + 1}`, opId = `op-start-${revision() + 1}`) => {
      const next = revision() + 1;
      return service.execute(command(owner, next, { type: "StartExecution", taskId: "task-1", executionId }, opId), {
        actorBinding: owner, expectedRevision: next - 1,
        reservation: { taskId: "task-1", executionId, expiresAt: "2026-08-11T01:00:00.000Z", version: 0 }
      });
    },
    submit: async (executionId: string, opId = `op-submit-${revision() + 1}`, claim = "implemented") => {
      const next = revision() + 1;
      const leaseVersion = (await service.read("task-1")).snapshot.lease?.version;
      if (leaseVersion === undefined) throw new Error(`execution ${executionId} has no active lease`);
      return service.execute(command(owner, next, {
        type: "SubmitExecution", taskId: "task-1", executionId,
        submission: { claim, deliverables: [], evidenceRefs: [], verification: ["tests"], knownGaps: [], residualRisks: [], commitSha }
      }, opId), { expectedRevision: next - 1, actorBinding: owner, leaseVersion, sessionDisposition: "complete" });
    },
    review: async (executionId: string, kind: "anti_entropy" | "acceptance", verdict: "approved" | "changes_requested" | "dismissed", opId = `op-review-${revision() + 1}`) => {
      const next = revision() + 1;
      const snapshot = (await service.read("task-1")).snapshot;
      return service.execute(command(reviewer, next, {
        type: "RecordReview", taskId: "task-1", executionId, reviewId: `review-${opId}`, kind, verdict,
        actorRole: kind, reason: `${kind} ${verdict}`, evidenceChecked: [], commitSha,
        iteration: snapshot.task?.iteration ?? 0, archiveWarningsAcknowledged: false
      }, opId), {
        expectedRevision: next - 1, actorBinding: reviewer,
        capability: kind === "anti_entropy" ? "anti-entropy@v1" : "acceptance-review@v1",
        capabilityRef: `cap-${opId}`, archiveWarningsPresent: false
      });
    },
    complete: (executionId: string, opId = `op-complete-${revision() + 1}`) => {
      const next = revision() + 1;
      return service.execute(command(owner, next, { type: "CompleteTask", taskId: "task-1", executionId }, opId), {
        expectedRevision: next - 1, capability: "task-complete@v1", capabilityRef: `cap-${opId}`,
        actorRole: "owner", noActiveLease: true, gateReceipts: []
      });
    }
  };
}

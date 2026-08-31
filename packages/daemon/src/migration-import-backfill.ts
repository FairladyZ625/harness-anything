import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MIGRATION_IMPORT_SOURCE,
  canonicalEventWritePlan,
  compileEntityUpsert,
  compileScheduleDefinitionEvent,
  consumeKnownError,
  sha256Text,
  stableStringify,
  validateCurrentCanonicalEvent,
  validateScheduleV1,
  type AgentRuntimeEventV1,
  type CanonicalContentBlob,
  type RuntimeSession,
  type ScheduleV1,
} from "../../kernel/src/index.ts";
import type { MigrationImportContext } from "./migration-import-run.ts";
import type { Prepared } from "./migration-import-types.ts";

export function prepareEntityBackfills(
  context: MigrationImportContext,
  initialRevision: number,
): { readonly prepared: readonly Prepared[]; readonly revision: number } {
  const prepared: Prepared[] = [];
  let revision = initialRevision;
  const append = (bundle: Prepared): boolean => {
    const held = context.input.store.readEvent(bundle.event.opId);
    if (held !== null) {
      if (
        held.schema !== bundle.event.schema ||
        held.type !== bundle.event.type ||
        stableStringify(held.payload) !== stableStringify(bundle.event.payload)
      )
        throw context.migrationImportError(
          "migration_source_operation_conflict",
          `Backfill operation ${bundle.event.opId} is already bound to different canonical bytes.`,
        );
      return false;
    }
    prepared.push({ ...bundle, event: { ...bundle.event, workspaceRevision: revision + 1 } });
    revision += 1;
    return true;
  };

  for (const source of context.oracle.agents.values()) {
    const existing = context.existingAgents.get(source.agentId),
      sourceAnchor = source.sourceAnchor.source;
    if (existing !== undefined) {
      const same = stableStringify(existing) === stableStringify(source.value);
      context.backfillRows.push({
        entityType: "agent",
        entityId: source.agentId,
        action: same ? "unchanged" : "conflict",
        sourceAnchor,
      });
      if (same) {
        context.agentMap.set(source.agentId, source.agentId);
        context.alreadyImported.agent += 1;
      } else {
        context.skips.push({
          entityType: "agent",
          migratedFrom: source.agentId,
          sourcePath: sourceAnchor,
          reason: "destination agent id contains a different declaration",
        });
      }
      continue;
    }
    try {
      const opId = context.migrationOperationId(context.sourceKey, "agent", source.agentId),
        bundle = compileEntityUpsert({
          entityKind: "agent",
          entity: source.value,
          eventId: `event-${sha256Text(opId)}`,
          opId,
          workspaceRevision: revision + 1,
          actor: context.actorFor(`agent/${source.agentId}`),
          source: MIGRATION_IMPORT_SOURCE,
          occurredAt: source.sourceAnchor.occurredAt,
        });
      context.agentMap.set(source.agentId, source.agentId);
      context.backfillRows.push({ entityType: "agent", entityId: source.agentId, action: "create", sourceAnchor });
      if (!append(bundle)) {
        context.alreadyImported.agent += 1;
        context.backfillRows[context.backfillRows.length - 1] = {
          entityType: "agent",
          entityId: source.agentId,
          action: "unchanged",
          sourceAnchor,
        };
      }
    } catch (error) {
      consumeKnownError(error);
      context.agentMap.delete(source.agentId);
      markConflict(context, "agent", source.agentId, sourceAnchor);
      context.skips.push({
        entityType: "agent",
        migratedFrom: source.agentId,
        sourcePath: sourceAnchor,
        reason: context.message(error),
      });
    }
  }

  for (const source of context.oracle.schedules.values()) {
    const existing = context.existingSchedules.get(source.scheduleId),
      sourceAnchor = source.sourceAnchor.source;
    if (existing !== undefined) {
      const same = stableStringify(existing) === stableStringify(source.value);
      context.backfillRows.push({
        entityType: "schedule",
        entityId: source.scheduleId,
        action: same ? "unchanged" : "conflict",
        sourceAnchor,
      });
      if (same) {
        context.scheduleMap.set(source.scheduleId, source.scheduleId);
        context.alreadyImported.schedule += 1;
      } else {
        context.skips.push({
          entityType: "schedule",
          migratedFrom: source.scheduleId,
          sourcePath: sourceAnchor,
          reason: "destination schedule id contains a different projection",
        });
      }
      continue;
    }
    try {
      const schedule = remapScheduleAgents(context, source.value),
        errors = validateScheduleV1(schedule);
      if (errors.length) throw new Error(errors.join("; "));
      const opId = context.migrationOperationId(context.sourceKey, "schedule", source.scheduleId),
        bundle = compileScheduleDefinitionEvent({
          type: "schedule_created",
          schedule,
          eventId: `event-${sha256Text(opId)}`,
          opId,
          workspaceRevision: revision + 1,
          actor: context.actorFor(`schedule/${source.scheduleId}`),
          source: MIGRATION_IMPORT_SOURCE,
          occurredAt: source.sourceAnchor.occurredAt,
        });
      context.scheduleMap.set(source.scheduleId, source.scheduleId);
      context.backfillRows.push({
        entityType: "schedule",
        entityId: source.scheduleId,
        action: "create",
        sourceAnchor,
      });
      if (!append(bundle)) {
        context.alreadyImported.schedule += 1;
        context.backfillRows[context.backfillRows.length - 1] = {
          entityType: "schedule",
          entityId: source.scheduleId,
          action: "unchanged",
          sourceAnchor,
        };
      }
    } catch (error) {
      consumeKnownError(error);
      context.scheduleMap.delete(source.scheduleId);
      markConflict(context, "schedule", source.scheduleId, sourceAnchor);
      context.skips.push({
        entityType: "schedule",
        migratedFrom: source.scheduleId,
        sourcePath: sourceAnchor,
        reason: context.message(error),
      });
    }
  }

  for (const source of context.oracle.runtimeSessions.values()) {
    const existing = context.existingRuntimeSessions.get(source.runtimeSessionId),
      sourceAnchor = source.sourceAnchor.source;
    if (existing !== undefined) {
      const same = stableStringify(existing) === stableStringify(source.value);
      context.backfillRows.push({
        entityType: "runtime-session",
        entityId: source.runtimeSessionId,
        action: same ? "unchanged" : "conflict",
        sourceAnchor,
      });
      if (same) {
        context.runtimeSessionMap.set(source.runtimeSessionId, source.runtimeSessionId);
        context.alreadyImported["runtime-session"] += 1;
      } else {
        context.skips.push({
          entityType: "runtime-session",
          migratedFrom: source.runtimeSessionId,
          sourcePath: sourceAnchor,
          reason: "destination runtime-session id contains a different projection",
        });
      }
      continue;
    }
    try {
      const bundles = runtimeSessionBundles(context, source.value, source.startedAt, source.outcome, revision);
      context.runtimeSessionMap.set(source.runtimeSessionId, source.runtimeSessionId);
      context.backfillRows.push({
        entityType: "runtime-session",
        entityId: source.runtimeSessionId,
        action: "create",
        sourceAnchor,
      });
      let added = false;
      for (const bundle of bundles) added = append(bundle) || added;
      if (!added) {
        context.alreadyImported["runtime-session"] += 1;
        context.backfillRows[context.backfillRows.length - 1] = {
          entityType: "runtime-session",
          entityId: source.runtimeSessionId,
          action: "unchanged",
          sourceAnchor,
        };
      }
    } catch (error) {
      consumeKnownError(error);
      context.runtimeSessionMap.delete(source.runtimeSessionId);
      markConflict(context, "runtime-session", source.runtimeSessionId, sourceAnchor);
      context.skips.push({
        entityType: "runtime-session",
        migratedFrom: source.runtimeSessionId,
        sourcePath: sourceAnchor,
        reason: context.message(error),
      });
    }
  }
  return { prepared, revision };
}

function runtimeSessionBundles(
  context: MigrationImportContext,
  session: RuntimeSession,
  startedAt: string,
  outcome: {
    readonly result: { readonly sha256: string; readonly size: number; readonly mediaType: string };
    readonly reasonCode?: string;
  } | null,
  initialRevision: number,
): readonly Prepared[] {
  const base = context.migrationOperationId(context.sourceKey, "runtime-session", session.runtimeSessionId),
    specs: Array<{
      readonly suffix: string;
      readonly type: AgentRuntimeEventV1["type"];
      readonly payload: Readonly<Record<string, unknown>>;
      readonly occurredAt: string;
      readonly blobs?: readonly CanonicalContentBlob[];
    }> = [
      {
        suffix: "started",
        type: "runtime_session_started",
        occurredAt: startedAt,
        payload: {
          runtimeSessionId: session.runtimeSessionId,
          instanceId: session.instanceId,
          installationId: session.installationId,
          kindId: session.kindId,
          definitionSnapshotRef: session.definitionSnapshotRef,
          launchGeneration: session.launchGeneration,
          attachable: session.attachable,
        },
      },
    ];
  if ((session.providerSessionId === null) !== (session.transcriptRef === null))
    throw new Error("runtime session provider identity and transcript reference are incomplete");
  if (session.providerSessionId !== null && session.transcriptRef !== null)
    specs.push({
      suffix: "provider",
      type: "runtime_session_provider_bound",
      occurredAt: startedAt,
      payload: {
        runtimeSessionId: session.runtimeSessionId,
        providerSessionId: session.providerSessionId,
        transcriptRef: session.transcriptRef,
      },
    });
  for (const [index, binding] of session.taskBindings.entries()) {
    const taskId =
      context.taskMap.get(binding.taskId) ?? (context.existingTasks.has(binding.taskId) ? binding.taskId : null);
    if (taskId === null) throw new Error(`runtime task binding ${binding.taskId} has no imported destination task`);
    specs.push({
      suffix: `task-${index}`,
      type: "runtime_session_task_bound",
      occurredAt: binding.boundAt,
      payload: {
        runtimeSessionId: session.runtimeSessionId,
        taskId,
        executionId: binding.executionId,
        providerSessionId: binding.providerSessionId,
        transcriptRef: binding.transcriptRef,
      },
    });
  }
  if (session.liveness === "exited")
    specs.push({
      suffix: "exited",
      type: "runtime_session_exited",
      occurredAt: session.lastObservedAt,
      payload: { runtimeSessionId: session.runtimeSessionId },
    });
  else if (session.liveness !== "live")
    specs.push({
      suffix: "liveness",
      type: "runtime_session_liveness_changed",
      occurredAt: session.lastObservedAt,
      payload: { runtimeSessionId: session.runtimeSessionId, liveness: session.liveness },
    });
  if (session.outcome !== null) {
    if (outcome === null) throw new Error("runtime outcome projection has no source result claim");
    if (
      outcome.result.sha256 !== session.resultRef?.slice("artifact:runtime-result/sha256/".length) ||
      outcome.result.mediaType !== "text/plain; charset=utf-8"
    )
      throw new Error("runtime outcome source claim does not match the projected result reference");
    const body = readSourceResult(context, outcome.result.sha256),
      bytes = Buffer.byteLength(body);
    if (bytes !== outcome.result.size || sha256Text(body) !== outcome.result.sha256)
      throw new Error(`runtime result blob ${outcome.result.sha256} is missing or corrupt`);
    specs.push({
      suffix: "outcome",
      type: "runtime_session_outcome_observed",
      occurredAt: session.lastObservedAt,
      payload: {
        runtimeSessionId: session.runtimeSessionId,
        outcome: session.outcome,
        exitCode: session.exitCode,
        resultRef: session.resultRef,
        result: outcome.result,
        ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
      },
      blobs: [{ ...outcome.result, body }],
    });
  }
  let revision = initialRevision;
  const actor = context.actorFor(`runtime-session/${session.runtimeSessionId}`);
  return specs.map((spec) => {
    const opId = `${base}-${spec.suffix}`,
      event = {
        schema: "agent-runtime-event/v1",
        eventId: `event-${sha256Text(opId)}`,
        workspaceRevision: ++revision,
        opId,
        type: spec.type,
        actor,
        source: MIGRATION_IMPORT_SOURCE,
        occurredAt: spec.occurredAt,
        payload: spec.payload,
      } as AgentRuntimeEventV1,
      errors = validateCurrentCanonicalEvent(event);
    if (errors.length) throw new Error(errors.join("; "));
    return {
      event,
      plan: canonicalEventWritePlan(event, "agent-runtime/v1", session.runtimeSessionId),
      blobs: spec.blobs ?? [],
    };
  });
}

function remapScheduleAgents(context: MigrationImportContext, schedule: ScheduleV1): ScheduleV1 {
  if (schedule.spec.target.kind !== "agent") return schedule;
  const sourceAgentId = schedule.spec.target.agentId,
    mapped = context.agentMap.get(sourceAgentId);
  if (context.oracle.agents.has(sourceAgentId) && mapped === undefined)
    throw new Error(`schedule target agent ${sourceAgentId} was not imported`);
  const targetAgentId = mapped ?? sourceAgentId;
  return targetAgentId === sourceAgentId
    ? schedule
    : { ...schedule, spec: { ...schedule.spec, target: { ...schedule.spec.target, agentId: targetAgentId } } };
}

function markConflict(
  context: MigrationImportContext,
  entityType: "agent" | "schedule" | "runtime-session",
  entityId: string,
  sourceAnchor: string,
): void {
  const index = context.backfillRows.findLastIndex((row) => row.entityType === entityType && row.entityId === entityId);
  const value = { entityType, entityId, action: "conflict" as const, sourceAnchor };
  if (index === -1) context.backfillRows.push(value);
  else context.backfillRows[index] = value;
}

function readSourceResult(context: MigrationImportContext, sha256: string): string {
  for (const target of [
    path.join(context.sourceLayout.authoredRoot, "objects", "sha256", sha256.slice(0, 2), sha256.slice(2)),
    path.join(context.sourceLayout.authoredRoot, "objects", "sha256", sha256),
  ])
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(target));
    } catch (error) {
      consumeKnownError(error);
      // Try the other supported ledger object layout before reporting one source-row failure.
    }
  throw new Error(`runtime result blob ${sha256} is unavailable in the source ledger`);
}

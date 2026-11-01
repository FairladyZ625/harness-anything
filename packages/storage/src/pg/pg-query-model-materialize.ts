import { interpretReplayDeclaration } from "../projection/entity-declaration-replay.ts";
import type { PoolClient } from "pg";
import type {
  EntityProjectionRow,
  LeaseInterval,
  PinnedEntityProjectionRow,
  RuntimeInstallation,
  RuntimeSession,
  SquadRunProjectionRow,
} from "@harness-anything/kernel";
import {
  isAgentRuntimeEvent,
  reduceRuntimeInstallation,
  reduceRuntimeSession,
  runtimeSessionId,
  runtimeSessionEntityV1,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { isEntityEvent, isEntityDeclarationEvent } from "@harness-anything/kernel/internal/domain/entity-event.ts";
import { isEntityPinEvent } from "@harness-anything/kernel/internal/domain/entity-pin-event.ts";
import {
  isTaskEvent,
  isDocEvent,
  type DocumentState,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import {
  reduceArtifactEntityState,
  type ArtifactEntityState,
} from "@harness-anything/kernel/internal/domain/artifact-entity-state.ts";
import { entityKindContracts } from "@harness-anything/kernel/internal/domain/entity-kind-registry.ts";
import {
  deriveEntityProjection,
  interpretEntityValue,
  interpretEmbeddedEntityProjections,
  type InterpretedEntityProjection,
} from "@harness-anything/kernel/internal/domain/entity-kind-projection.ts";
import {
  canonicalDocumentClaims,
  canonicalDocumentRetirements,
} from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
import {
  RAW_ARTIFACT_POLICY_ID,
  OPAQUE_TEXTUAL_POLICY_ID,
} from "@harness-anything/kernel/internal/domain/artifact-text-classification.ts";
import { ENTITY_CONTENT_POLICY_ID } from "@harness-anything/kernel/internal/domain/entity-owned-content.ts";
import { normalizeHistoricalPresetSnapshot } from "@harness-anything/kernel/internal/domain/historical-event-normalization.ts";
import { reduceSquadRunProjection } from "../projection/rebuildable-task-projection-squad-runs.ts";
import {
  putPgProjectionValue,
  deletePgProjectionValue,
  getPgProjectionValue,
  listPgProjectionValues,
} from "./pg-projection-values.ts";
import type { PgProjectionEventInput, PgProjectionScope } from "./pg-task-event-materialize.ts";
import type { TaskLifecycleSnapshot } from "@harness-anything/kernel";

/** Extend the A3 transaction with the remaining port read models; reducers stay in their shared owners. */
export async function materializePgQueryModels(
  client: PoolClient,
  scope: PgProjectionScope,
  input: PgProjectionEventInput,
  snapshot: TaskLifecycleSnapshot | null,
): Promise<void> {
  const event = input.event,
    revision = event.workspaceRevision,
    sourcePath = `event:${event.opId}`;
  const put = (model: string, id: string, value: unknown, owner = "") =>
    putPgProjectionValue(client, scope, model, id, owner, revision, value);
  const get = <Value>(model: string, id: string, owner = "") =>
    getPgProjectionValue<Value>(client, scope, model, id, owner);
  const drop = (model: string, id: string, owner = "") => deletePgProjectionValue(client, scope, model, id, owner);
  const entityRow = async (
    projection: InterpretedEntityProjection | null,
    currentVersion: EntityProjectionRow["currentVersion"] = revision,
  ) => {
    if (!projection) return;
    await put(
      `entity:${projection.kind}`,
      projection.id,
      {
        kind: projection.kind,
        id: projection.id,
        ownerId: projection.ownerId,
        workspaceRevision: revision,
        freshness: "current",
        currentVersion,
        value: projection.value,
      } satisfies EntityProjectionRow,
      projection.ownerId ?? "",
    );
  };
  for (const contract of entityKindContracts)
    for (const projection of interpretEmbeddedEntityProjections(contract, event)) await entityRow(projection);

  if (isEntityEvent(event)) {
    const { entityKind, entityId } = event.payload,
      model = `entity:${entityKind}`;
    await put(
      `artifact:${entityKind}`,
      entityId,
      reduceArtifactEntityState(await get<ArtifactEntityState>(`artifact:${entityKind}`, entityId), event),
    );
    if (event.type === "entity_deleted") await drop(model, entityId);
    else if (event.type === "agent_retired") {
      const current = await get<EntityProjectionRow>(model, entityId);
      if (current)
        await put(model, entityId, {
          ...current,
          workspaceRevision: revision,
          value: {
            ...current.value,
            lifecycleState: "retired",
            retirement: {
              retiredAt: event.payload.retiredAt,
              reason: event.payload.reason,
              ...(event.payload.successor === undefined ? {} : { successor: event.payload.successor }),
            },
          },
        });
    } else if (isEntityDeclarationEvent(event)) {
      const contract = entityKindContracts.find(({ kind }) => kind === entityKind);
      if (!contract) throw new Error(`EntityKindContract is unavailable for ${entityKind}`);
      let raw: unknown;
      if (event.type === "entity_reference_declared") raw = event.payload.descriptor;
      else {
        const bytes = await input.readContentBlob?.(event.payload.declarationDocumentClaim.sha256);
        if (!bytes)
          throw new Error(`entity declaration blob ${event.payload.declarationDocumentClaim.sha256} is unavailable`);
        raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      }
      const entity =
        event.type === "entity_reference_declared"
          ? interpretEntityValue(contract, raw)
          : interpretReplayDeclaration(contract, raw, entityId);
      if (entity === null) {
        await put(model, entityId, {
          kind: entityKind,
          id: entityId,
          ownerId: null,
          workspaceRevision: revision,
          freshness: "unknown",
          currentVersion: null,
          value: raw,
        });
      }
      const projection = entity === null ? null : deriveEntityProjection(contract, entity, revision, sourcePath);
      await entityRow(
        projection,
        event.type === "entity_reference_declared"
          ? `reference:${event.payload.declaredContentVersion ?? "unobserved"}`
          : event.type === "entity_content_observed" || event.type === "entity_updated"
            ? event.payload.observedContentVersion
            : revision,
      );
    } else {
      const current = await get<EntityProjectionRow>(model, entityId);
      if (current)
        await put(model, entityId, {
          ...current,
          workspaceRevision: revision,
          freshness: "orphaned",
          currentVersion: null,
        });
    }
  }
  const pin = (entityRef: string) =>
    put("pin", entityRef, {
      entityRef,
      pinnedAt: event.occurredAt,
      pinnedBy: event.actor.principal.personId,
    } satisfies PinnedEntityProjectionRow);
  if (isEntityPinEvent(event)) {
    if (event.type === "entity_pinned") await pin(event.payload.entityRef);
    else await drop("pin", event.payload.entityRef);
  } else if (snapshot?.task) {
    if (snapshot.task.pinned) await pin(`task/${snapshot.task.taskId}`);
    else await drop("pin", `task/${snapshot.task.taskId}`);
  }

  if (isAgentRuntimeEvent(event)) {
    const installation = reduceRuntimeInstallation(
      event.type === "runtime_installation_observed"
        ? await get<RuntimeInstallation>("runtime-installation", event.payload.installationId)
        : null,
      event,
    );
    if (installation) await put("runtime-installation", installation.installationId, installation);
    const id = runtimeSessionId(event);
    if (id) {
      const session = reduceRuntimeSession(await get<RuntimeSession>("runtime-session", id), event);
      if (session) {
        await put("runtime-session", id, session);
        const contract = entityKindContracts.find(({ kind }) => kind === "runtime-session")!;
        await entityRow(
          deriveEntityProjection(
            contract,
            interpretEntityValue(contract, runtimeSessionEntityV1(session)),
            revision,
            sourcePath,
          ),
        );
      }
    }
    const runId =
      event.type === "runtime_squad_run_observed"
        ? event.payload.squadRunId
        : event.type === "runtime_dispatch_requested"
          ? event.payload.squadRun?.squadRunId
          : undefined;
    if (runId) {
      const run = reduceSquadRunProjection(await get<SquadRunProjectionRow>("squad-run", runId), event);
      if (run) await put("squad-run", runId, run);
    }
  }

  for (const claim of canonicalDocumentClaims(event)) {
    const bytes = await input.readContentBlob?.(claim.sha256);
    if (!bytes) throw new Error(`projection document blob ${claim.sha256} is unavailable`);
    const carried = isDocEvent(event)
      ? event.payload.changes
      : "carriedDocumentClaims" in event.payload
        ? (event.payload.carriedDocumentClaims ?? [])
        : [];
    const policyId =
      (claim as { readonly policyId?: string }).policyId ?? carried.find(({ path }) => path === claim.path)?.policyId;
    const opaque = policyId === RAW_ARTIFACT_POLICY_ID || policyId === ENTITY_CONTENT_POLICY_ID;
    const document = {
      path: claim.path,
      blobSha256: claim.sha256,
      size: claim.size,
      mediaType: claim.mediaType,
      policyId,
      workspaceRevision: revision,
      body: opaque
        ? ""
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: policyId === OPAQUE_TEXTUAL_POLICY_ID }).decode(bytes),
    };
    await put("document", claim.path, document as DocumentState);
  }
  for (const retirement of canonicalDocumentRetirements(event)) await drop("document", retirement.path);
  if ("presetSnapshotClaim" in event.payload) {
    const claim = event.payload.presetSnapshotClaim as { readonly digest: string; readonly sha256: string },
      bytes = await input.readContentBlob?.(claim.sha256);
    if (!bytes) throw new Error(`preset snapshot blob ${claim.sha256} is unavailable`);
    await put(
      "preset",
      claim.digest,
      normalizeHistoricalPresetSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
    );
  }
  if (isTaskEvent(event)) {
    const intervals = await listPgProjectionValues<LeaseInterval>(client, scope, "lease-interval", event.taskId);
    if (event.type === "execution_started") {
      const lease = event.payload.lease;
      await put(
        "lease-interval",
        String(revision),
        {
          taskId: event.taskId,
          executionId: lease.executionId,
          acquiredRevision: revision,
          releasedRevision: null,
          holder: { taskId: lease.taskId, executionId: lease.executionId, actor: lease.actor, source: lease.source },
          previousHolder: event.payload.previousHolder,
          leaseExpiresAt: event.payload.leaseExpiresAt,
          reason: event.payload.reason,
        } satisfies LeaseInterval,
        event.taskId,
      );
    } else if (event.type === "lease_renewed") {
      for (const interval of intervals)
        if (interval.executionId === event.payload.lease.executionId && interval.releasedRevision === null)
          await put(
            "lease-interval",
            String(interval.acquiredRevision),
            { ...interval, leaseExpiresAt: event.payload.lease.expiresAt },
            event.taskId,
          );
    } else if (
      (event.type === "execution_submitted" && event.payload.supersedesSubmissionId === undefined) ||
      event.type === "lease_released" ||
      event.type === "task_completion_generation_retired"
    ) {
      for (const interval of intervals)
        if (interval.executionId === event.payload.execution.executionId && interval.releasedRevision === null)
          await put(
            "lease-interval",
            String(interval.acquiredRevision),
            { ...interval, releasedRevision: revision },
            event.taskId,
          );
    }
  }
}

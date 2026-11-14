import { storageReplayPolicy } from "@harness-anything/kernel/internal/domain/storage-replay-policy.ts";
import { materializePgEntityDeclaration } from "./pg-entity-declarations.ts";
import { artifactRetirementEntry, artifactTimelineEntry, flushPgArtifactDocuments } from "./pg-artifact-timeline.ts";
import { assertPgReadIndexReady } from "./pg-read-index-migration.ts";
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
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import {
  isAgentRuntimeEvent,
  reduceRuntimeInstallation,
  reduceRuntimeSession,
  runtimeSessionId,
  runtimeSessionEntityV1,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import {
  isEntityEvent,
  isEntityDeclarationEvent,
  contractForDeclarationEvent,
} from "@harness-anything/kernel/internal/domain/entity-event.ts";
import { isEntityPinEvent } from "@harness-anything/kernel/internal/domain/entity-pin-event.ts";
import {
  isTaskEvent,
  isDocEvent,
  isFactEvent,
  isDecisionEvent,
  type DocumentState,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { docByteLength } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
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
  archivedFactDocumentPreimage,
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
import { putPgProjectionValue, deletePgProjectionValue, getPgProjectionValue } from "./pg-projection-values.ts";
import type { PgProjectionEventInput, PgProjectionScope } from "./pg-task-event-materialize.ts";
import type { TaskLifecycleSnapshot } from "@harness-anything/kernel";
import {
  activeMaterializationHolds,
  materializationEntityRef,
  terminalDecisionMaterializationStates,
  type MaterializationEntityState,
  type MaterializationRelation,
} from "@harness-anything/kernel/internal/domain/entity-relation.ts";

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
    await materializePgEntityDeclaration(client, scope, event);
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
      const contract = contractForDeclarationEvent(event);
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
    if (event.type === "runtime_dispatch_requested") {
      const payload = event.payload as typeof event.payload & { readonly idempotencyKey?: string },
        key = payload.dispatchKey ?? payload.idempotencyKey;
      // Keep each revision and its readers: lookup selects the first visible dispatch,
      // including when several historical events carry the same normalized key. The pre-rename
      // `idempotencyKey` spelling lands in the same column.
      if (key !== undefined) await put("runtime-dispatch-key", key, revision, String(revision));
    }
    const installation = reduceRuntimeInstallation(
      event.type === "runtime_installation_observed"
        ? await get<RuntimeInstallation>("runtime-installation", event.payload.installationId)
        : null,
      event,
    );
    if (installation) await put("runtime-installation", installation.installationId, installation);
    const id = runtimeSessionId(event);
    if (id) {
      const session = reduceRuntimeSession(
        await get<RuntimeSession>("runtime-session", id),
        event,
        storageReplayPolicy.defaultValue.runtime,
      );
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
      size: docByteLength(claim.size),
      mediaType: claim.mediaType,
      policyId,
      workspaceRevision: revision,
      body: opaque
        ? ""
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: policyId === OPAQUE_TEXTUAL_POLICY_ID }).decode(bytes),
    };
    await drop("document-history", claim.path);
    await put("document", claim.path, document as DocumentState);
    const artifact = artifactTimelineEntry(scope, claim.path, document, event.occurredAt);
    if (artifact !== null) {
      if (input.artifacts) input.artifacts.set(claim.path, artifact);
      else await flushPgArtifactDocuments(client, scope, [artifact]);
    }
  }
  for (const retirement of canonicalDocumentRetirements(event)) {
    const historicalClaim = documentClaimForPath(event, retirement.path),
      historical = historicalClaim
        ? await readDocumentClaim(historicalClaim)
        : await get<DocumentState>("document", retirement.path);
    const owner = materializationOwnerForPath(retirement.path),
      state = owner ? await pgMaterializationEntityState(client, scope, owner) : null;
    if (state && !isDocEvent(event) && (await pgMaterializationHeld(client, scope, state))) {
      if (historical) await put("document", retirement.path, historical);
      continue;
    }
    if (historical && state && !isDocEvent(event)) await put("document-history", retirement.path, historical);
    else await drop("document-history", retirement.path);
    await drop("document", retirement.path);
    const artifact = artifactRetirementEntry(retirement.path);
    if (artifact !== null) {
      if (input.artifacts) input.artifacts.set(retirement.path, artifact);
      else await flushPgArtifactDocuments(client, scope, [artifact]);
    }
  }
  await settlePgTerminalMaterialization(client, scope, event);
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
    const openIntervals = async (executionId: string): Promise<readonly LeaseInterval[]> => {
      await assertPgReadIndexReady(client, scope, "lease-interval");
      const rows = await client.query<{ value: string }>(
        `SELECT value FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
          AND model='lease-interval' AND owner_id=$4 AND execution_id=$5 AND interval_open
          AND (cardinality($6::text[])=0 OR readers && $6::text[]) ORDER BY order_revision`,
        [scope.tenantId, scope.projectId, scope.policyEpoch, event.taskId, executionId, [...(scope.readers ?? [])]],
      );
      return rows.rows.map(({ value }) => JSON.parse(value) as LeaseInterval);
    };
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
      for (const interval of await openIntervals(event.payload.lease.executionId))
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
      for (const interval of await openIntervals(event.payload.execution.executionId))
        await put(
          "lease-interval",
          String(interval.acquiredRevision),
          { ...interval, releasedRevision: revision },
          event.taskId,
        );
    }
  }

  async function readDocumentClaim(claim: {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly policyId?: string;
  }): Promise<DocumentState> {
    const bytes = await input.readContentBlob?.(claim.sha256);
    if (!bytes || bytes.byteLength !== claim.size)
      throw new Error(`projection document blob ${claim.sha256} is unavailable`);
    const opaque = claim.policyId === RAW_ARTIFACT_POLICY_ID || claim.policyId === ENTITY_CONTENT_POLICY_ID;
    return {
      path: claim.path as DocumentState["path"],
      blobSha256: claim.sha256,
      size: claim.size,
      mediaType: claim.mediaType,
      policyId: claim.policyId ?? "document",
      workspaceRevision: revision,
      body: opaque
        ? ""
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: claim.policyId === OPAQUE_TEXTUAL_POLICY_ID }).decode(
            bytes,
          ),
    } as DocumentState;
  }
}

function materializationOwnerForPath(path: string): string | null {
  const fact = /^facts\/(F-[0-9A-HJKMNP-TV-Z]{8})\.md$/u.exec(path)?.[1],
    decision = /^decisions\/decision-([^/]+)\//u.exec(path)?.[1];
  return fact ? `fact/${fact}` : decision ? `decision/${decision}` : null;
}

async function pgMaterializationEntityState(
  client: PoolClient,
  scope: PgProjectionScope,
  ref: string,
): Promise<MaterializationEntityState | null> {
  const [kind, id] = ref.split("/"),
    parameters = [scope.tenantId, scope.projectId, scope.policyEpoch, id];
  if (kind === "decision") {
    const result = await client.query<{ state: string }>(
      "SELECT value->>'state' AS state FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND decision_id=$4",
      parameters,
    );
    return result.rows[0] ? { ref, kind, state: result.rows[0].state } : null;
  }
  if (kind === "task") {
    const result = await client.query<{ state: string }>(
      "SELECT CASE WHEN snapshot#>>'{task,packageDisposition}'='archived' THEN 'archived' ELSE snapshot#>>'{task,status}' END AS state FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id=$4",
      parameters,
    );
    return result.rows[0] ? { ref, kind, state: result.rows[0].state } : null;
  }
  if (kind !== "fact") return null;
  const result = await client.query<{ archived: boolean }>(
    "SELECT (value->>'archived')::boolean AS archived FROM ha_facts WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND fact_id=$4",
    parameters,
  );
  if (!result.rows[0]) return null;
  const supersedes = await client.query(
    "SELECT 1 FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND target_ref=$4 AND relation_type='supersedes-fact' AND relation_state='active' LIMIT 1",
    [scope.tenantId, scope.projectId, scope.policyEpoch, ref],
  );
  return {
    ref,
    kind,
    state: result.rows[0].archived ? "archived" : supersedes.rows.length ? "superseded_fact" : "standing",
  };
}

async function pgIncidentMaterializationRelations(client: PoolClient, scope: PgProjectionScope, ref: string) {
  const result = await client.query<{
    relation_id: string;
    source_ref: string;
    target_ref: string;
    relation_type: MaterializationRelation["type"];
    relation_state: string;
  }>(
    `SELECT relation_id,source_ref,target_ref,relation_type,relation_state FROM ha_relations
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND
       (source_ref=$4 OR target_ref=$4 OR
        (source_ref COLLATE "C">=$5 AND source_ref COLLATE "C"<$6) OR
        (target_ref COLLATE "C">=$5 AND target_ref COLLATE "C"<$6))`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, ref, `${ref}/`, `${ref}0`],
  );
  return result.rows.map((row) => ({
    relationId: row.relation_id,
    source: row.source_ref,
    target: row.target_ref,
    type: row.relation_type,
    state: row.relation_state,
  }));
}

async function pgMaterializationHeld(client: PoolClient, scope: PgProjectionScope, entity: MaterializationEntityState) {
  const relations = await pgIncidentMaterializationRelations(client, scope, entity.ref),
    states = new Map<string, MaterializationEntityState>([[entity.ref, entity]]);
  for (const ref of new Set(
    relations.flatMap(({ source, target }) => [source, target]).map(materializationEntityRef),
  )) {
    if (states.has(ref)) continue;
    const state = await pgMaterializationEntityState(client, scope, ref);
    if (state) states.set(ref, state);
  }
  return activeMaterializationHolds(entity, relations, states).length > 0;
}

/** Endpoint lifecycle and relation updates unlock only their indexed neighborhood, in the accepting transaction. */
async function settlePgTerminalMaterialization(
  client: PoolClient,
  scope: PgProjectionScope,
  event: PersistedCanonicalEventV1,
) {
  const changed = new Set<string>();
  if (isFactEvent(event)) changed.add(`fact/${event.factId}`);
  if (isDecisionEvent(event)) changed.add(`decision/${event.decisionId}`);
  if (isTaskEvent(event)) changed.add(`task/${event.taskId}`);
  if (event.schema === "entity-document-event/v1")
    for (const ref of event.payload.entityRefs) changed.add(materializationEntityRef(ref));
  const relationIds =
    event.schema === "relation-event/v1"
      ? [event.relationId, ...(event.type === "relation_replaced" ? [event.payload.previousRelationId] : [])]
      : isDecisionEvent(event) &&
          (event.type === "decision_relation_retired" || event.type === "decision_relation_replaced")
        ? [
            event.payload.relationId,
            ...(event.type === "decision_relation_replaced" ? [event.payload.replacement.relation_id] : []),
          ]
        : [];
  if (relationIds.length) {
    const rows = await client.query<{ source_ref: string; target_ref: string }>(
      "SELECT source_ref,target_ref FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND relation_id=ANY($4::text[])",
      [scope.tenantId, scope.projectId, scope.policyEpoch, relationIds],
    );
    for (const row of rows.rows)
      for (const ref of [row.source_ref, row.target_ref]) changed.add(materializationEntityRef(ref));
  }
  if (event.schema === "doc-event/v1") {
    for (const { path } of event.payload.changes) {
      const owner = materializationOwnerForPath(path);
      if (owner) changed.add(owner);
    }
    const packages = [...new Set(event.payload.changes.map(({ path }) => path.split("/").slice(0, 2).join("/")))];
    const rows = await client.query<{ task_id: string }>(
      "SELECT task_id FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND package_path=ANY($4::text[])",
      [scope.tenantId, scope.projectId, scope.policyEpoch, packages],
    );
    for (const { task_id } of rows.rows) changed.add(`task/${task_id}`);
  }
  if (isFactEvent(event) && event.payload.supersedes) changed.add(event.payload.supersedes.factRef);
  const candidates = await refreshPgMaterializationHolds(client, scope, [...changed], event.workspaceRevision);
  await settlePgMaterializationCandidates(client, scope, candidates, event.workspaceRevision);
}

async function refreshPgMaterializationHolds(
  client: PoolClient,
  scope: PgProjectionScope,
  refs: readonly string[],
  revision: number,
) {
  const edges = new Map<string, Awaited<ReturnType<typeof pgIncidentMaterializationRelations>>[number]>(),
    candidates = new Set(refs),
    states = new Map<string, MaterializationEntityState>();
  for (const ref of refs)
    for (const edge of await pgIncidentMaterializationRelations(client, scope, ref)) edges.set(edge.relationId, edge);
  for (const edge of edges.values()) {
    const entityRefs = [...new Set([edge.source, edge.target].map(materializationEntityRef))];
    for (const ref of entityRefs) {
      candidates.add(ref);
      if (states.has(ref)) continue;
      const state = await pgMaterializationEntityState(client, scope, ref);
      if (state) states.set(ref, state);
    }
    await client.query(
      "DELETE FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='materialization-hold' AND entity_id=$4",
      [scope.tenantId, scope.projectId, scope.policyEpoch, edge.relationId],
    );
    for (const ref of entityRefs) {
      const state = states.get(ref);
      if (state && activeMaterializationHolds(state, [edge], states).length)
        await putPgProjectionValue(client, scope, "materialization-hold", edge.relationId, ref, revision, {});
    }
  }
  return [...candidates];
}

async function settlePgMaterializationCandidates(
  client: PoolClient,
  scope: PgProjectionScope,
  candidates: readonly string[],
  revision: number,
) {
  for (const ref of candidates) {
    const state = await pgMaterializationEntityState(client, scope, ref);
    if (!state) continue;
    const held =
        (
          await client.query(
            "SELECT 1 FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='materialization-hold' AND owner_id=$4 LIMIT 1",
            [scope.tenantId, scope.projectId, scope.policyEpoch, ref],
          )
        ).rows.length > 0,
      terminal =
        state.kind === "fact"
          ? ["archived", "superseded_fact"].includes(state.state)
          : state.kind === "decision"
            ? (terminalDecisionMaterializationStates as readonly string[]).includes(state.state)
            : ["archived", "cancelled"].includes(state.state);
    const active = !terminal || held,
      model = active ? "document-history" : "document";
    let prefix = state.kind === "decision" ? `decisions/decision-${ref.slice(9)}/` : `facts/${ref.slice(5)}.md`;
    if (state.kind === "task") {
      const row = (
        await client.query<{ package_path: string }>(
          "SELECT package_path FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id=$4",
          [scope.tenantId, scope.projectId, scope.policyEpoch, ref.slice(5)],
        )
      ).rows[0];
      if (!row?.package_path) continue;
      prefix = `${row.package_path}/`;
    }
    const subtree = state.kind !== "fact",
      rows = await client.query<{ entity_id: string; value: string }>(
        `SELECT entity_id,value FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
        AND model=$4 AND owner_id='' AND (entity_id=$5 OR (entity_id COLLATE "C">=$5 AND entity_id COLLATE "C"<$6))`,
        [
          scope.tenantId,
          scope.projectId,
          scope.policyEpoch,
          model,
          prefix,
          subtree ? `${prefix.slice(0, -1)}0` : prefix,
        ],
      );
    for (const row of rows.rows) {
      await putPgProjectionValue(
        client,
        scope,
        active ? "document" : "document-history",
        row.entity_id,
        "",
        revision,
        JSON.parse(row.value),
      );
      await deletePgProjectionValue(client, scope, model, row.entity_id);
    }
  }
}

/** Existing projections are upgraded from their current rows; event history is never scanned. */
export async function initializePgTerminalMaterialization(
  client: PoolClient,
  scope: PgProjectionScope,
  revision: number,
): Promise<void> {
  if (!(await getPgProjectionValue(client, scope, "materialization-index", "v1"))) {
    const rows = await client.query<{ ref: string }>(
      `SELECT 'fact/'||fact_id AS ref FROM ha_facts WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
      UNION ALL SELECT 'decision/'||decision_id FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
      UNION ALL SELECT 'task/'||task_id FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3`,
      [scope.tenantId, scope.projectId, scope.policyEpoch],
    );
    const refs = rows.rows.map(({ ref }) => ref),
      candidates = await refreshPgMaterializationHolds(client, scope, refs, revision);
    await settlePgMaterializationCandidates(client, scope, candidates, revision);
    await putPgProjectionValue(client, scope, "materialization-index", "v1", "", revision, { version: 1 });
  }
  if (await getPgProjectionValue(client, scope, "materialization-index", "history-v1")) return;
  const missing = await client.query<{ fact_id: string; workspace_revision: string; readers: string[] }>(
    `SELECT f.fact_id,f.workspace_revision,f.readers FROM ha_facts AS f
      WHERE f.tenant_id=$1 AND f.project_id=$2 AND f.policy_epoch=$3 AND f.value->>'archived'='true'
      AND NOT EXISTS (SELECT 1 FROM ha_projection_values AS d WHERE d.tenant_id=f.tenant_id
        AND d.project_id=f.project_id AND d.policy_epoch=f.policy_epoch AND d.owner_id=''
        AND d.model IN ('document','document-history') AND d.entity_id='facts/'||f.fact_id||'.md')`,
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
  for (const row of missing.rows) {
    const history = await client.query<{ event_json: string }>(
        `SELECT e.event_json FROM ha_event_entity_refs AS r JOIN ha_events AS e
          ON e.tenant_id=r.tenant_id AND e.project_id=r.project_id AND e.repo_id=r.repo_id AND e.revision=r.revision
          WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.policy_epoch=$3 AND r.entity_ref=$4 AND r.revision<=$5
          ORDER BY r.revision DESC`,
        [scope.tenantId, scope.projectId, scope.policyEpoch, `fact/${row.fact_id}`, row.workspace_revision],
      ),
      preimage = archivedFactDocumentPreimage(
        history.rows.map(({ event_json }) => JSON.parse(event_json) as PersistedCanonicalEventV1),
        row.fact_id,
      );
    if (!preimage) throw new Error(`archived Fact ${row.fact_id} has no retained document descriptor`);
    const blob = await client.query<{ body: Buffer }>(
      "SELECT body FROM ha_content_blobs WHERE tenant_id=$1 AND project_id=$2 AND sha256=$3",
      [scope.tenantId, scope.projectId, preimage.document.blobSha256],
    );
    if (!blob.rows[0]) throw new Error(`projection document blob ${preimage.document.blobSha256} is unavailable`);
    const held = await client.query(
      "SELECT 1 FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='materialization-hold' AND owner_id=$4 LIMIT 1",
      [scope.tenantId, scope.projectId, scope.policyEpoch, `fact/${row.fact_id}`],
    );
    await putPgProjectionValue(
      client,
      { ...scope, readers: row.readers },
      held.rows.length ? "document" : "document-history",
      preimage.document.path,
      "",
      preimage.retiredAt,
      {
        ...preimage.document,
        body: new TextDecoder("utf-8", { fatal: true }).decode(blob.rows[0].body),
      },
    );
  }
  await putPgProjectionValue(client, scope, "materialization-index", "history-v1", "", revision, { version: 1 });
}

function documentClaimForPath(
  event: PersistedCanonicalEventV1,
  path: string,
): {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly policyId?: string;
} | null {
  if (isFactEvent(event)) {
    const claims = [event.payload.factsDocumentClaim, event.payload.supersededFactsDocumentClaim];
    return claims.find((claim) => claim?.path === path) ?? null;
  }
  if (isDecisionEvent(event)) {
    const claims = [
      event.payload.decisionDocumentClaim,
      ...(event.type === "decision_review_recorded"
        ? (event.payload.carriedDocumentClaims ?? []).map(({ path: target, candidate }) => ({
            path: target,
            ...candidate,
          }))
        : []),
    ];
    return claims.find((claim) => claim.path === path) ?? null;
  }
  return null;
}

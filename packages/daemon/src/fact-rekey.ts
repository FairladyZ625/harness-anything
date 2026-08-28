import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  compileEntityUpsert,
  compileFactWrite,
  canonicalDocumentClaims,
  canonicalDocumentRetirements,
  consumeKnownError,
  contentObjectRelativePath,
  deriveRelationId,
  decisionMachineDigest,
  docSyncWritePlan,
  documentPath,
  eventObjectRelativePath,
  isFactEvent,
  isEntityEvent,
  isMigrationImportEvent,
  localGitObjectRefStore,
  OPAQUE_TEXTUAL_POLICY_ID,
  ledgerGitPath,
  migrationImportWritePlan,
  readLegacyMigrationSource,
  reduceDecisionDocument,
  renderFactsDocument,
  reviewDigest,
  resolveHarnessLayout,
  resolveLedgerGitLayout,
  serializePersistedCanonicalEvent,
  sha256Text,
  stableStringify,
  type CanonicalEventV1,
  type DecisionDocumentState,
  type DecisionEventV1,
  type DocEventV1,
  type MigrationImportEventV1,
  type PublicationFile,
  type TaskEventV1,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import type { DocEventChange } from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

interface LegacyFact {
  readonly legacyRef: string;
  readonly canonicalRef: string;
  readonly row: any;
}
interface MappedLegacyFact extends LegacyFact {
  readonly mapId: string;
}
interface EntityDeclarationClaimSnapshot {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly policyId: string;
}
interface LegacyEntityEventSnapshot {
  readonly schema: "agent-entity-event/v1";
  readonly payload: {
    readonly entityKind: string;
    readonly entityId: string;
    readonly declarationDocumentClaim: EntityDeclarationClaimSnapshot;
  };
}
interface MigrationDocumentState {
  readonly blobSha256: string;
}
interface RewrittenEntityBlob {
  readonly sha256: string;
  readonly body: string;
}

interface FactRekeyPlan {
  readonly facts: readonly LegacyFact[];
  readonly map: ReadonlyMap<string, string>;
  readonly relationMap: ReadonlyMap<string, string>;
  readonly eventRewrites: readonly { readonly event: CanonicalEventV1; readonly body: string }[];
  readonly authoredRewrites: readonly {
    readonly path: string;
    readonly body: string;
    readonly baseBlobSha256: string | null;
  }[];
  readonly authoredDeletes: readonly {
    readonly path: string;
    readonly body: string;
    readonly baseBlobSha256: string | null;
  }[];
  readonly newFactDocuments: readonly { readonly path: string; readonly body: string }[];
  readonly rewrittenEntityBlobs: readonly RewrittenEntityBlob[];
  readonly rewrittenEntityDocuments: readonly { readonly path: string; readonly body: string }[];
  readonly rewrittenAgentEvents: number;
  readonly rewrittenSettingsEvents: number;
  readonly docsOnly: readonly MappedLegacyFact[];
}

export function runFactRekey(input: {
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly rootDir: string;
  readonly store: any;
  readonly projection: any;
  readonly now: () => string;
}): WriteReceipt {
  const plan = buildPlan(input.rootDir, input.store);
  const mapBody = idMapBody(plan);
  const digest = sha256Text(mapBody);
  const markerOpId = `op_${sha256Text(`fact-rekey\0${digest}`)}`;
  const existingMarker = migrationEvents(input.rootDir, input.store).find(
    (event: CanonicalEventV1) =>
      isMigrationImportEvent(event) &&
      event.payload.entity.kind === "id-map" &&
      event.payload.entity.importId === `fact-rekey-${digest.slice(0, 16)}`,
  );
  if (existingMarker || !hasChanges(plan))
    return {
      outcome: "no_changes",
      opId: `noop:fact-rekey:${digest.slice(0, 16)}`,
      revision: input.store.readHead()?.revision ?? 0,
      code: "no_changes",
      origin: "fact-rekey",
      evidence: JSON.stringify({ schema: "fact-rekey-id-map/v1", maps: Object.fromEntries(plan.map) }),
      visibility: "center",
      proof: {
        committedRevision: input.store.readHead()?.revision ?? 0,
        appliedCut: input.store.readHead()?.revision ?? 0,
        durable: true,
        canonicalVisible: true,
        worktreeVisible: true,
      },
      nextAction: "All migrated records already use current fact, entity, and settings shapes.",
    };
  if (input.action.dryRun === true)
    return {
      outcome: "pending",
      opId: `preview:${markerOpId}`,
      revision: input.store.readHead()?.revision ?? 0,
      evidence: JSON.stringify({
        schema: "fact-rekey-id-map/v1",
        maps: Object.fromEntries(plan.map),
        counts: counts(plan),
        markerOpId,
      }),
      visibility: "center",
      proof: {
        committedRevision: input.store.readHead()?.revision ?? 0,
        // Legacy event bytes are intentionally unreadable by the resident projection
        // until the migration publication replaces them.
        appliedCut: 0,
        durable: false,
        canonicalVisible: false,
        worktreeVisible: false,
      },
      nextAction: "Remove --dry-run to publish the fact rekey through the canonical event store.",
    };

  const ledger = resolveLedgerGitLayout(input.rootDir),
    eventLayout = input.store.layout();
  if (eventLayout === "mixed") throw new Error("fact rekey requires a single flat or sharded event layout");

  const currentCut = input.store.currentCut(),
    docsOnly = buildDocsOnlyBundles(plan, input, currentCut.revision),
    docRewrites = buildAuthoredRekeyEvents(plan, input, currentCut.revision + docsOnly.length + 1),
    preceding = [...docsOnly, ...docRewrites];
  const additional = new Map<string, PublicationFile>();
  const addWrite = (relativePath: string, body: string): void => {
    const target = ledgerGitPath(ledger, relativePath);
    additional.set(target, { target, body, mode: "100644" });
  };
  for (const rewrite of plan.eventRewrites)
    additional.set(ledgerGitPath(ledger, eventObjectRelativePath(rewrite.event.opId, eventLayout)), {
      target: ledgerGitPath(ledger, eventObjectRelativePath(rewrite.event.opId, eventLayout)),
      body: rewrite.body,
      mode: "100644",
    });
  for (const document of plan.newFactDocuments) addWrite(document.path, document.body);
  for (const document of plan.newFactDocuments) {
    const sha256 = sha256Text(document.body),
      target = ledgerGitPath(ledger, contentObjectRelativePath(sha256, eventLayout));
    additional.set(target, { target, body: document.body, mode: "100644" });
  }
  for (const blob of plan.rewrittenEntityBlobs) {
    const target = ledgerGitPath(ledger, contentObjectRelativePath(blob.sha256, eventLayout));
    additional.set(target, { target, body: blob.body, mode: "100644" });
  }
  for (const document of plan.rewrittenEntityDocuments) addWrite(document.path, document.body);
  const revision = currentCut.revision + preceding.length + 1,
    marker: MigrationImportEventV1 = {
      schema: "migration-import-event/v1",
      eventId: `event-${sha256Text(markerOpId)}`,
      workspaceRevision: revision,
      opId: markerOpId,
      type: "entity_migrated",
      actor: input.binding.actor,
      source: "migration-import/v1",
      occurredAt: input.now(),
      payload: {
        migratedFrom: `fact-rekey:${digest}`,
        generation: "v0",
        entity: {
          kind: "id-map",
          importId: `fact-rekey-${digest.slice(0, 16)}`,
          documentClaim: {
            path: `migrations/fact-rekey/${digest.slice(0, 16)}/id-map.json`,
            sha256: sha256Text(mapBody),
            size: Buffer.byteLength(mapBody),
            mediaType: "application/json",
            policyId: "typed-migration-import/v1",
          },
        },
      },
    };
  const blob = {
      sha256: sha256Text(mapBody),
      size: Buffer.byteLength(mapBody),
      mediaType: "application/json",
      body: mapBody,
    },
    appended = input.store.append(
      {
        event: marker,
        plan: migrationImportWritePlan(marker),
        blobs: [blob],
        preceding,
      },
      [...additional.values()],
    );
  input.projection.rebuild();
  const cut = input.store.currentCut(),
    projected = input.projection.list(),
    receipt: WriteReceipt = {
      outcome: "applied",
      opId: marker.opId,
      revision: appended.revision,
      evidence: JSON.stringify({
        schema: "fact-rekey-id-map/v1",
        maps: Object.fromEntries(plan.map),
        counts: counts(plan),
      }),
      visibility: "center",
      proof: {
        committedRevision: appended.revision,
        appliedCut: projected.watermark,
        durable: true,
        canonicalVisible: projected.watermark >= appended.revision,
        worktreeVisible: true,
      },
      commitSha: appended.commitSha?.sha ?? null,
      cut,
      nextAction: "Fact refs are canonical; verify with ha fact search and ha fact show.",
    };
  return receipt;
}

function buildPlan(rootDir: string, store: any): FactRekeyPlan {
  const events = migrationEvents(rootDir, store),
    cold = readLegacyMigrationSource(rootDir),
    legacyEventRevisions = new Map<string, number>(),
    rows = new Map(cold.facts.map((row: any) => [`fact/${row.taskId}/${row.factId}`, row]));
  for (const event of events) {
    if (isFactEvent(event) && event.taskId && event.payload.factsDocumentClaim.path !== `facts/${event.factId}.md`)
      legacyEventRevisions.set(`fact/${event.taskId}/${event.factId}`, event.workspaceRevision);
    if (isMigrationImportEvent(event) && event.payload.entity.kind === "fact" && event.payload.entity.fact.taskId) {
      const entity = event.payload.entity,
        legacyRef = `fact/${entity.fact.taskId}/${entity.fact.factId}`;
      if (event.payload.migratedFrom === legacyRef || entity.documentClaim.path !== `facts/${entity.fact.factId}.md`)
        legacyEventRevisions.set(legacyRef, event.workspaceRevision);
    }
  }
  const legacyEventRefs = new Set(legacyEventRevisions.keys()),
    layout = resolveHarnessLayout(rootDir);
  const legacyDocumentRefs = new Set(
    cold.facts
      .filter((row: any) => {
        if (!row.taskId) return false;
        const factsPath = layout.taskDocumentPath(row.taskId, legacyFactsDocumentName());
        if (!existsSync(factsPath)) return false;
        return new RegExp(`fact_id\\s*:\\s*${row.factId}\\b`, "u").test(readFileSync(factsPath, "utf8"));
      })
      .map((row: any) => `fact/${row.taskId}/${row.factId}`),
  );
  const legacyEntries = [...cold.legacyFactRefs.entries()].filter(
    ([legacy]) => /^fact\/[^/]+\/F-/u.test(legacy) && (legacyEventRefs.has(legacy) || legacyDocumentRefs.has(legacy)),
  );
  const facts: LegacyFact[] = legacyEntries.flatMap(([legacyRef, canonicalRef]) => {
    const row = rows.get(legacyRef);
    return row ? [{ legacyRef, canonicalRef, row }] : [];
  });
  const occupied = new Set(
    cold.facts
      .filter((row: any) => !facts.some((fact) => fact.legacyRef === `fact/${row.taskId}/${row.factId}`))
      .map((row: any) => row.factId),
  );
  const duplicateCounts = new Map<string, number>();
  for (const fact of facts) duplicateCounts.set(fact.row.factId, (duplicateCounts.get(fact.row.factId) ?? 0) + 1);
  const used = new Set(occupied),
    map = new Map<string, string>();
  for (const fact of facts.sort((a, b) => a.legacyRef.localeCompare(b.legacyRef))) {
    let id = fact.row.factId;
    if (used.has(id) || (duplicateCounts.get(id) ?? 0) > 1)
      id = `F-${sha256Text(fact.legacyRef).slice(0, 8).toUpperCase()}`;
    while (used.has(id)) id = `F-${sha256Text(`${fact.legacyRef}\0${id}`).slice(0, 8).toUpperCase()}`;
    used.add(id);
    map.set(fact.legacyRef, `fact/${id}`);
  }
  const canonicalToNew = new Map(facts.map((fact) => [fact.canonicalRef, map.get(fact.legacyRef)!]));
  const mapRef = (value: string): string => map.get(value) ?? canonicalToNew.get(value) ?? value;
  const relationMap = new Map(cold.legacyRelationIds);
  const factByLegacyRef = new Map(facts.map((fact) => [fact.legacyRef, fact]));
  const currentSquadClaims = new Map<string, EntityDeclarationClaimSnapshot>();
  for (const event of events)
    if (event.schema === "entity-event/v1" && event.payload.entityKind === "squad")
      currentSquadClaims.set(event.payload.entityId, event.payload.declarationDocumentClaim);
  const eventRewrites: { event: CanonicalEventV1; body: string }[] = [],
    rewrittenEntityBlobs = new Map<string, RewrittenEntityBlob>(),
    rewrittenEntityPaths = new Set<string>(),
    decisionStates = new Map<string, DecisionDocumentState>(),
    decisionRelations = new Map<string, DecisionDocumentState["relations"]>(),
    rewriteCounts = { agent: 0, settings: 0 },
    legacyEvents = new Set(
      events
        .filter(
          (event) =>
            isFactEvent(event) && event.taskId && event.payload.factsDocumentClaim.path !== `facts/${event.factId}.md`,
        )
        .map((event) => event.opId),
    );
  for (const event of events) {
    const agentRewrite = rewriteRetiredAgentEntity(event, store);
    let next: any;
    if (agentRewrite !== null) {
      next = transform(agentRewrite.event, mapRef, relationMap);
      rewrittenEntityBlobs.set(agentRewrite.blob.sha256, agentRewrite.blob);
      rewrittenEntityPaths.add(agentRewrite.path);
      rewriteCounts.agent += 1;
    } else if (isFactEvent(event) && event.taskId && legacyEvents.has(event.opId)) {
      const target = map.get(`fact/${event.taskId}/${event.factId}`);
      if (!target) continue;
      const factId = target.slice("fact/".length),
        { factsDocumentClaim: _claim, ...payload } = event.payload;
      next = compileFactWrite({
        event: {
          ...event,
          factId,
          payload: {
            ...payload,
            provenance: canonicalProvenance(payload.provenance),
            supersedes: payload.supersedes
              ? { ...payload.supersedes, factRef: mapRef(payload.supersedes.factRef) }
              : undefined,
          },
        } as any,
      }).event;
    } else if (isMigrationImportEvent(event) && event.payload.entity.kind === "fact") {
      const entity = event.payload.entity,
        legacyRef = entity.fact.taskId ? `fact/${entity.fact.taskId}/${entity.fact.factId}` : "",
        target = map.get(legacyRef),
        fact = factByLegacyRef.get(legacyRef);
      if (target && fact) {
        const factId = target.slice("fact/".length),
          document = factDocument(fact, factId, event.workspaceRevision);
        next = transform(
          {
            ...event,
            payload: {
              ...event.payload,
              entity: {
                ...entity,
                fact: { ...entity.fact, factId },
                documentClaim: {
                  path: document.path,
                  sha256: sha256Text(document.body),
                  size: Buffer.byteLength(document.body),
                  mediaType: "text/markdown",
                  policyId: "typed-migration-import/v1",
                },
              },
            },
          },
          mapRef,
          relationMap,
        );
      } else next = transform(event, mapRef, relationMap);
    } else next = transform(event, mapRef, relationMap);
    if (next?.schema === "settings-event/v1" && Object.hasOwn(next.payload.settings, "locale")) {
      const { locale: _locale, ...settings } = next.payload.settings;
      next = { ...next, payload: { ...next.payload, settings } };
      rewriteCounts.settings += 1;
    }
    if (next?.schema === "migration-import-event/v1" && next.payload.entity.kind === "decision") {
      const decision = next.payload.entity.decision,
        importedRelations = decisionRelations.get(decision.decisionId) ?? [];
      decisionStates.set(decision.decisionId, {
        ...decision,
        relations: mergeDecisionRelations(decision.relations, importedRelations),
      });
    }
    if (next?.schema === "migration-import-event/v1" && next.payload.entity.kind === "relation") {
      const decisionId = /^decision\/([^/]+)$/u.exec(next.payload.entity.ownerRef)?.[1];
      if (decisionId) {
        const relation = next.payload.entity.relation,
          relations = [...(decisionRelations.get(decisionId) ?? [])];
        if (!relations.some((entry) => entry.relation_id === relation.relation_id)) relations.push(relation);
        decisionRelations.set(decisionId, relations);
        const current = decisionStates.get(decisionId);
        if (current)
          decisionStates.set(decisionId, {
            ...current,
            relations: mergeDecisionRelations(current.relations, [relation]),
          });
      }
    }
    if (next?.schema === "agent-entity-event/v1" && next.payload.entityKind === "squad") {
      const claim = currentSquadClaims.get(next.payload.entityId);
      if (claim) next = rekeySupersededLegacyEntityClaim(next, claim);
    }
    if (next?.schema === "decision-event/v1") {
      const current = decisionStates.get(next.decisionId) ?? null;
      next = rekeyDecisionProofs(next as DecisionEventV1, current);
      try {
        decisionStates.set(next.decisionId, reduceDecisionDocument(current, next));
      } catch (error) {
        consumeKnownError(error);
      }
    }
    if (next?.schema === "task-event/v1" && next.type === "review_consent_recorded")
      next = rekeyReviewConsentProof(next);
    if (stableStringify(next) !== stableStringify(event))
      eventRewrites.push({ event: next, body: serializePersistedCanonicalEvent(next) });
  }
  const docsOnly: readonly MappedLegacyFact[] = facts
    .filter((fact) => !legacyEventRefs.has(fact.legacyRef))
    .map((fact) => ({ ...fact, mapId: map.get(fact.legacyRef)!.slice("fact/".length) }));
  const newFactDocuments = facts
    .filter((fact) => !docsOnly.some((candidate) => candidate.legacyRef === fact.legacyRef))
    .map((fact) => {
      const id = map.get(fact.legacyRef)!.slice("fact/".length),
        revision = legacyEventRevisions.get(fact.legacyRef) ?? 0;
      return factDocument(fact, id, revision);
    });
  const eventRewriteByOpId = new Map(eventRewrites.map(({ event }) => [event.opId, event])),
    projectedDocuments = projectDocumentStates(events.map((event) => eventRewriteByOpId.get(event.opId) ?? event)),
    authoredRoot = layout.authoredRoot,
    legacyTaskFacts = new Map(
      facts
        .map((fact) => layout.taskDocumentPath(fact.row.taskId, legacyFactsDocumentName()))
        .filter((file) => existsSync(file))
        .map(
          (file) => [path.relative(authoredRoot, file).split(path.sep).join("/"), readFileSync(file, "utf8")] as const,
        ),
    ),
    legacyTaskFactPaths = new Set(legacyTaskFacts.keys()),
    authoredRewrites = authoredFiles(authoredRoot).flatMap(({ relativePath, body }) => {
      if (relativePath.startsWith("events/")) return [];
      if (legacyTaskFactPaths.has(relativePath)) return [];
      const replaced = replaceRefs(body, map, relationMap);
      return replaced === body
        ? []
        : [
            {
              path: relativePath,
              body: replaced,
              baseBlobSha256: projectedDocuments.get(relativePath)?.blobSha256 ?? null,
            },
          ];
    }),
    rewrittenEntityDocuments = [...rewrittenEntityPaths]
      .map((documentPath) => {
        const state = projectedDocuments.get(documentPath);
        if (state === undefined) return null;
        const rewritten = rewrittenEntityBlobs.get(state.blobSha256),
          bytes = rewritten === undefined ? store.readContentBlob(state.blobSha256) : null,
          body = rewritten?.body ?? (bytes === null ? null : new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (body === null) throw new Error(`rewritten entity document ${state.blobSha256} is unavailable`);
        return { path: documentPath, body };
      })
      .filter((document): document is { readonly path: string; readonly body: string } => document !== null);
  return {
    facts,
    map,
    relationMap,
    eventRewrites,
    authoredRewrites,
    authoredDeletes: [...legacyTaskFacts]
      .map(([path]) => ({
        path,
        body: committedDocumentBody(rootDir, store, path),
        baseBlobSha256: projectedDocuments.get(path)?.blobSha256 ?? null,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    newFactDocuments,
    rewrittenEntityBlobs: [...rewrittenEntityBlobs.values()],
    rewrittenEntityDocuments,
    rewrittenAgentEvents: rewriteCounts.agent,
    rewrittenSettingsEvents: rewriteCounts.settings,
    docsOnly,
  };
}

function committedDocumentBody(rootDir: string, store: any, logicalPath: string): string {
  const ledger = resolveLedgerGitLayout(rootDir),
    bytes = localGitObjectRefStore.readPath(
      ledger.rootDir,
      store.currentCommit().sha,
      ledgerGitPath(ledger, logicalPath),
    );
  if (bytes === null) throw new Error(`legacy document ${logicalPath} is unavailable at the canonical cut`);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function projectDocumentStates(events: readonly CanonicalEventV1[]): ReadonlyMap<string, MigrationDocumentState> {
  const states = new Map<string, MigrationDocumentState>();
  for (const event of events) {
    for (const retirement of canonicalDocumentRetirements(event)) states.delete(retirement.path);
    for (const claim of canonicalDocumentClaims(event)) states.set(claim.path, { blobSha256: claim.sha256 });
  }
  return states;
}

function rewriteRetiredAgentEntity(
  event: CanonicalEventV1,
  store: any,
): { readonly event: CanonicalEventV1; readonly path: string; readonly blob: RewrittenEntityBlob } | null {
  if (!isEntityEvent(event) || event.payload.entityKind !== "agent") return null;
  const claim = event.payload.declarationDocumentClaim,
    bytes = store.readContentBlob(claim.sha256);
  if (bytes === null || bytes.byteLength !== claim.size)
    throw new Error(`agent declaration blob ${claim.sha256} is unavailable`);
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (sha256Text(body) !== claim.sha256) throw new Error(`agent declaration blob ${claim.sha256} hash mismatch`);
  const value = JSON.parse(body) as unknown,
    rewritten = removeRetiredAgentFields(value);
  if (rewritten === value) return null;
  const compiled = compileEntityUpsert({
    entityKind: "agent",
    entity: rewritten,
    eventId: event.eventId,
    opId: event.opId,
    workspaceRevision: event.workspaceRevision,
    actor: event.actor,
    source: event.source,
    occurredAt: event.occurredAt,
  });
  return {
    event: compiled.event,
    path: compiled.event.payload.declarationDocumentClaim.path,
    blob: { sha256: compiled.blobs[0].sha256, body: compiled.blobs[0].body },
  };
}

function removeRetiredAgentFields(value: unknown): unknown {
  if (!isRekeyRecord(value) || !isRekeyRecord(value.fallback)) return value;
  const fallback = value.fallback,
    backoff = fallback.backoff,
    hasEnabled = Object.hasOwn(fallback, "enabled"),
    hasMaxAttempts = isRekeyRecord(backoff) && Object.hasOwn(backoff, "maxAttempts");
  if (!hasEnabled && !hasMaxAttempts) return value;
  const rewrittenFallback = { ...fallback };
  delete rewrittenFallback.enabled;
  if (hasMaxAttempts) {
    const rewrittenBackoff = { ...backoff };
    delete rewrittenBackoff.maxAttempts;
    rewrittenFallback.backoff = rewrittenBackoff;
  }
  return { ...value, fallback: rewrittenFallback };
}

function isRekeyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasChanges(plan: FactRekeyPlan): boolean {
  return (
    plan.facts.length > 0 ||
    plan.eventRewrites.length > 0 ||
    plan.authoredRewrites.length > 0 ||
    plan.authoredDeletes.length > 0 ||
    plan.newFactDocuments.length > 0 ||
    plan.rewrittenEntityBlobs.length > 0
  );
}

function mergeDecisionRelations(
  current: DecisionDocumentState["relations"],
  imported: DecisionDocumentState["relations"],
): DecisionDocumentState["relations"] {
  return [...current, ...imported]
    .filter(
      (relation, index, all) => all.findIndex((candidate) => candidate.relation_id === relation.relation_id) === index,
    )
    .sort((left, right) => left.relation_id.localeCompare(right.relation_id));
}

function legacyFactsDocumentName(): string {
  return ["facts", "md"].join(".");
}

function migrationEvents(rootDir: string, store: any): CanonicalEventV1[] {
  const ledger = resolveLedgerGitLayout(rootDir),
    commit = store.currentCommit().sha,
    prefix = ledgerGitPath(ledger, "events/");
  const entries = localGitObjectRefStore
    .listTree(ledger.rootDir, commit, ledger.authoredPrefix || undefined)
    .filter(({ target }) => target.startsWith(prefix) && !target.endsWith("/head.json") && target.endsWith(".json"));
  if (entries.length === 0) return [];
  const output = localGitObjectRefStore.batch(ledger.rootDir, `${entries.map(({ oid }) => oid).join("\n")}\n`);
  const events: CanonicalEventV1[] = [];
  let cursor = 0;
  for (const _entry of entries) {
    const headerEnd = output.indexOf(10, cursor);
    if (headerEnd < 0) break;
    const size = Number(output.subarray(cursor, headerEnd).toString("utf8").split(" ").at(-1)),
      start = headerEnd + 1,
      body = output.subarray(start, start + size).toString("utf8");
    cursor = start + size + 1;
    try {
      events.push(JSON.parse(body) as CanonicalEventV1);
    } catch (error) {
      consumeKnownError(error);
      continue;
    }
  }
  return events.sort((left, right) => left.workspaceRevision - right.workspaceRevision);
}

function buildAuthoredRekeyEvents(
  plan: FactRekeyPlan,
  input: {
    readonly binding: RepoCellBinding;
    readonly now: () => string;
    readonly store: any;
    readonly rootDir: string;
  },
  firstRevision: number,
): readonly {
  readonly event: DocEventV1;
  readonly plan: ReturnType<typeof docSyncWritePlan>;
  readonly blobs: readonly {
    readonly body: string;
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
  }[];
}[] {
  const rewriteChanges: DocEventV1["payload"]["changes"] = plan.authoredRewrites.map(
      (document) =>
        ({
          path: documentPath(document.path),
          baseBlobSha256: document.baseBlobSha256,
          candidate: {
            sha256: sha256Text(document.body),
            size: Buffer.byteLength(document.body),
            mediaType: document.path.endsWith(".md") ? ("text/markdown" as const) : ("text/plain" as const),
          },
          policyId: OPAQUE_TEXTUAL_POLICY_ID,
          regionProofs: [],
        }) as unknown as DocEventChange,
    ),
    bundles: ReturnType<typeof docEventBundle>[] = [];
  let revision = firstRevision;
  if (rewriteChanges.length > 0) {
    bundles.push(docEventBundle(input, revision, rewriteChanges, plan.authoredRewrites, undefined));
    revision += 1;
  }
  for (const document of plan.authoredDeletes) {
    const candidateBlobSha256 = sha256Text(document.body);
    let baseBlobSha256 = document.baseBlobSha256;
    if (baseBlobSha256 !== candidateBlobSha256) {
      bundles.push(
        docEventBundle(
          input,
          revision,
          [
            {
              path: documentPath(document.path),
              baseBlobSha256,
              candidate: {
                sha256: candidateBlobSha256,
                size: Buffer.byteLength(document.body),
                mediaType: "text/markdown",
              },
              policyId: OPAQUE_TEXTUAL_POLICY_ID,
              regionProofs: [],
            } as unknown as DocEventChange,
          ],
          [document],
          undefined,
        ),
      );
      revision += 1;
      baseBlobSha256 = candidateBlobSha256;
    }
    bundles.push(
      docEventBundle(
        input,
        revision,
        [
          {
            path: documentPath(document.path),
            baseBlobSha256,
            candidate: null,
            policyId: OPAQUE_TEXTUAL_POLICY_ID,
            regionProofs: [],
          } as unknown as DocEventChange,
        ],
        [],
        "fact records were re-keyed",
      ),
    );
    revision += 1;
  }
  return bundles;
}

function docEventBundle(
  input: {
    readonly binding: RepoCellBinding;
    readonly now: () => string;
    readonly store: any;
  },
  revision: number,
  changes: DocEventV1["payload"]["changes"],
  documents: readonly { readonly path: string; readonly body: string }[],
  retirementReason: string | undefined,
) {
  const event: DocEventV1 = {
    schema: "doc-event/v1",
    eventId: `event-${sha256Text(`fact-rekey-docs\\0${revision}`)}`,
    workspaceRevision: revision,
    opId: `op_${sha256Text(`fact-rekey-docs\\0${revision}`)}`,
    type: "documents_written",
    actor: input.binding.actor,
    source: input.binding.source,
    occurredAt: input.now(),
    payload: {
      executionId: null,
      baseLedgerSha: input.store.currentCut(),
      changes,
      ...(retirementReason === undefined ? {} : { retirementReason }),
    },
  };
  const blobs = documents.map((document) => ({
    body: document.body,
    sha256: sha256Text(document.body),
    size: Buffer.byteLength(document.body),
    mediaType: document.path.endsWith(".md") ? "text/markdown" : "text/plain",
  }));
  return { event, plan: docSyncWritePlan(event), blobs };
}

function buildDocsOnlyBundles(
  plan: FactRekeyPlan,
  input: {
    readonly binding: RepoCellBinding;
  },
  revision: number,
) {
  return plan.docsOnly.map((fact, index) =>
    compileFactWrite({
      event: {
        schema: "fact-event/v1",
        eventId: `event-${sha256Text(`fact-rekey\0${fact.legacyRef}`)}`,
        workspaceRevision: revision + index + 1,
        opId: `op_${sha256Text(`fact-rekey\0${fact.legacyRef}`)}`,
        type: "fact_recorded",
        actor: input.binding.actor,
        source: input.binding.source,
        occurredAt: fact.row.observedAt,
        ...(fact.row.taskId ? { taskId: fact.row.taskId } : {}),
        factId: fact.mapId,
        payload: {
          statement: fact.row.statement,
          evidenceSource: fact.row.source,
          observedAt: fact.row.observedAt,
          confidence: fact.row.confidence,
          memoryClass: fact.row.memoryClass,
          memoryTags: fact.row.memoryTags,
          provenance: canonicalProvenance(fact.row.provenance),
        },
      },
    }),
  );
}

function factDocument(
  fact: LegacyFact,
  factId: string,
  workspaceRevision: number,
): { readonly path: string; readonly body: string } {
  return {
    path: `facts/${factId}.md`,
    body: renderFactsDocument([
      {
        factId,
        statement: fact.row.statement,
        evidenceSource: fact.row.source,
        observedAt: fact.row.observedAt,
        confidence: fact.row.confidence,
        state: "standing",
        workspaceRevision,
      },
    ]),
  };
}

function transform(
  value: unknown,
  mapRef: (value: string) => string,
  relationMap: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") return relationMap.get(value) ?? mapRef(value);
  if (Array.isArray(value)) return value.map((entry) => transform(entry, mapRef, relationMap));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, transform(entry, mapRef, relationMap)]),
  );
  if (
    typeof output.source === "string" &&
    typeof output.target === "string" &&
    typeof output.type === "string" &&
    output.direction === "directed"
  )
    output.relation_id = deriveRelationId({
      source: output.source,
      target: output.target,
      type: output.type as any,
      direction: output.direction,
    });
  return output;
}

export function rekeyDecisionProofs(event: DecisionEventV1, current: DecisionDocumentState | null): DecisionEventV1 {
  if (current === null) return event;
  const sourcePayload = event.payload as any,
    payload: Record<string, unknown> = { ...sourcePayload };
  if (event.type === "decision_accepted" || event.type === "decision_rejected" || event.type === "decision_deferred")
    payload.judgmentConsent = {
      ...sourcePayload.judgmentConsent,
      machineDigest: decisionMachineDigest(current),
    };
  if (
    sourcePayload.contentPin !== undefined &&
    (event.type === "decision_accepted" ||
      event.type === "decision_rejected" ||
      event.type === "decision_deferred" ||
      event.type === "decision_superseded" ||
      event.type === "decision_retired" ||
      event.type === "decision_amended" ||
      event.type === "decision_repinned")
  ) {
    const reduced = reduceDecisionDocument(current, event);
    payload.contentPin = {
      ...sourcePayload.contentPin,
      state: reduced.state,
      digest: decisionMachineDigest(reduced),
    };
  }
  return { ...event, payload } as DecisionEventV1;
}

export function rekeyReviewConsentProof(
  event: Extract<TaskEventV1, { readonly type: "review_consent_recorded" }>,
): Extract<TaskEventV1, { readonly type: "review_consent_recorded" }> {
  return {
    ...event,
    payload: {
      ...event.payload,
      consent: {
        ...event.payload.consent,
        reviewDigest: reviewDigest(event.payload.review),
      },
    },
  };
}

export function rekeySupersededLegacyEntityClaim<T extends LegacyEntityEventSnapshot>(
  event: T,
  claim: EntityDeclarationClaimSnapshot,
): T {
  return {
    ...event,
    payload: {
      ...event.payload,
      declarationDocumentClaim: claim,
    },
  };
}

function replaceRefs(body: string, map: ReadonlyMap<string, string>, relationMap: ReadonlyMap<string, string>): string {
  const replacements = new Map([...map, ...relationMap]);
  return body.replace(
    /fact\/[^/\s"'<>()[\]{}]+\/F-[0-9A-HJKMNP-TV-Z]{8}\b|rel_[0-9a-f]{16}\b/gu,
    (value) => replacements.get(value) ?? value,
  );
}

function canonicalProvenance(
  values: readonly {
    readonly runtime: string;
    readonly sessionId: string | null;
    readonly boundAt: string;
    readonly transcriptReachability?: string;
  }[],
): readonly {
  readonly runtime: string;
  readonly sessionId: string | null;
  readonly boundAt: string;
  readonly transcriptReachability: "by_session_id" | "dispatch_stream_only" | "unavailable";
}[] {
  return values.map((value) => ({
    ...value,
    transcriptReachability:
      value.transcriptReachability === "dispatch_stream_only" || value.transcriptReachability === "unavailable"
        ? value.transcriptReachability
        : "by_session_id",
  }));
}

function authoredFiles(root: string): readonly { readonly relativePath: string; readonly body: string }[] {
  const output: { relativePath: string; body: string }[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name),
        stat = lstatSync(file);
      if (stat.isDirectory()) {
        if (directory === root && (name === "events" || name === "objects")) continue;
        visit(file);
      } else if (stat.isFile() && /\.(?:md|json|ya?ml|txt)$/u.test(name))
        output.push({
          relativePath: path.relative(root, file).split(path.sep).join("/"),
          body: readFileSync(file, "utf8"),
        });
    }
  };
  visit(root);
  return output;
}

function idMapBody(plan: FactRekeyPlan): string {
  return `${stableStringify({
    schema: "fact-rekey-id-map/v1",
    maps: {
      fact: Object.fromEntries(plan.map),
      relation: Object.fromEntries(plan.relationMap),
    },
    counts: counts(plan),
  })}\n`;
}

function counts(plan: FactRekeyPlan): Record<string, number> {
  return {
    rekeyedFacts: plan.facts.length,
    factEvents: plan.eventRewrites.filter(({ event }) => isFactEvent(event)).length + plan.docsOnly.length,
    producesEdges: plan.facts.filter((fact) => fact.row.taskId).length,
    retargetedRelations: [...plan.relationMap].filter(([from, to]) => from !== to).length,
    rewrittenAgentEvents: plan.rewrittenAgentEvents,
    rewrittenSettingsEvents: plan.rewrittenSettingsEvents,
  };
}

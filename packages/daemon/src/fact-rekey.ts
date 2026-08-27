import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  compileFactWrite,
  contentObjectRelativePath,
  deriveRelationId,
  eventObjectRelativePath,
  isFactEvent,
  isMigrationImportEvent,
  ledgerGitPath,
  migrationImportWritePlan,
  readLegacyMigrationSource,
  renderFactsDocument,
  resolveHarnessLayout,
  resolveLedgerGitLayout,
  serializePersistedCanonicalEvent,
  sha256Text,
  stableStringify,
  type CanonicalEventV1,
  type MigrationImportEventV1,
  type PublicationFile,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

interface LegacyFact {
  readonly legacyRef: string;
  readonly canonicalRef: string;
  readonly row: any;
}
interface MappedLegacyFact extends LegacyFact {
  readonly mapId: string;
}

interface FactRekeyPlan {
  readonly facts: readonly LegacyFact[];
  readonly map: ReadonlyMap<string, string>;
  readonly relationMap: ReadonlyMap<string, string>;
  readonly eventRewrites: readonly { readonly event: CanonicalEventV1; readonly body: string }[];
  readonly authoredRewrites: readonly { readonly path: string; readonly body: string }[];
  readonly authoredDeletes: readonly string[];
  readonly newFactDocuments: readonly { readonly path: string; readonly body: string }[];
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
  const existingMarker = input.store
    .read()
    .events.find(
      (event: CanonicalEventV1) =>
        isMigrationImportEvent(event) &&
        event.payload.entity.kind === "id-map" &&
        event.payload.entity.importId === `fact-rekey-${digest.slice(0, 16)}`,
    );
  if (existingMarker || plan.facts.length === 0)
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
        appliedCut: input.projection.list().watermark,
        durable: true,
        canonicalVisible: true,
        worktreeVisible: true,
      },
      nextAction: "All facts already use fact/F-* refs and canonical facts documents.",
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
        appliedCut: input.projection.list().watermark,
        durable: false,
        canonicalVisible: false,
        worktreeVisible: false,
      },
      nextAction: "Remove --dry-run to publish the fact rekey through the canonical event store.",
    };

  const ledger = resolveLedgerGitLayout(input.rootDir),
    eventLayout = input.store.layout();
  if (eventLayout === "mixed") throw new Error("fact rekey requires a single flat or sharded event layout");

  // Facts found only in legacy task documents become native Fact events first. The
  // final marker publication then rewrites old event objects and authored references atomically.
  for (const fact of plan.docsOnly) {
    const event = compileFactWrite({
      event: {
        schema: "fact-event/v1",
        eventId: `event-${sha256Text(`fact-rekey\0${fact.legacyRef}`)}`,
        workspaceRevision: (input.store.readHead()?.revision ?? 0) + 1,
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
    });
    const existing = input.store.readEvent(event.event.opId);
    if (existing === null) input.store.append(event);
  }

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
  for (const document of plan.authoredRewrites) addWrite(document.path, document.body);
  for (const document of plan.authoredDeletes)
    additional.set(ledgerGitPath(ledger, document), { delete: ledgerGitPath(ledger, document) });

  const revision = (input.store.readHead()?.revision ?? 0) + 1,
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
    appended = input.store.append({ event: marker, plan: migrationImportWritePlan(marker), blobs: [blob] }, [
      ...additional.values(),
    ]);
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
  const events = store.read().events as readonly CanonicalEventV1[],
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
        const factsPath = layout.taskDocumentPath(row.taskId, "facts.md");
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
  const eventRewrites: { event: CanonicalEventV1; body: string }[] = [],
    legacyEvents = new Set(
      events
        .filter(
          (event) =>
            isFactEvent(event) && event.taskId && event.payload.factsDocumentClaim.path !== `facts/${event.factId}.md`,
        )
        .map((event) => event.opId),
    );
  for (const event of events) {
    let next: any;
    if (isFactEvent(event) && event.taskId && legacyEvents.has(event.opId)) {
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
  const authoredRoot = layout.authoredRoot,
    legacyTaskFactPaths = new Set(
      facts
        .map((fact) => layout.taskDocumentPath(fact.row.taskId, "facts.md"))
        .filter((file) => existsSync(file))
        .map((file) => path.relative(authoredRoot, file).split(path.sep).join("/")),
    ),
    authoredRewrites = authoredFiles(authoredRoot).flatMap(({ relativePath, body }) => {
      if (relativePath.startsWith("events/")) return [];
      if (legacyTaskFactPaths.has(relativePath)) return [];
      const replaced = replaceRefs(body, map, relationMap);
      return replaced === body ? [] : [{ path: relativePath, body: replaced }];
    });
  return {
    facts,
    map,
    relationMap,
    eventRewrites,
    authoredRewrites,
    authoredDeletes: [...legacyTaskFactPaths].sort(),
    newFactDocuments,
    docsOnly,
  };
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
  };
}

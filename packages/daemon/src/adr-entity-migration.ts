/**
 * One-time ADR Artifact Entity migration for the software/coding vertical. `Decision 锚` is that
 * vertical's authored Markdown convention, not a generic Artifact Entity field. After the canonical
 * migration is executed and recorded as a Fact, a follow-up task must delete this command.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  canonicalSourceIdentity,
  compiledRelationDirections,
  deriveArtifactEntityId,
  deriveRelationId,
  MIGRATION_IMPORT_SOURCE,
  migrationImportWritePlan,
  normalizeRelativeDocumentPath,
  relationStrengthForType,
  resolveHarnessLayout,
  sha256Text,
  stableStringify,
  type AuthorizationDecision,
  type CanonicalEventStore,
  type CompiledArtifactKindContract,
  type EntityRelationRecord,
  type GovernedRelationRegistryWitness,
  type MigrationImportEventV1,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { defaultAssets } from "../../preset/src/preset-resolver-common.ts";
import { loadCanonicalAssets } from "../../preset/src/preset-assets.ts";
import { runArtifactEntityImport } from "./artifact-entity-action.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

const ADR_KIND = "software/coding/architecture-decision-record@1";
const ADR_FILE = /^(ADR-[0-9]{4})-[A-Za-z0-9][A-Za-z0-9._-]*\.md$/u;
const DECISION_ANCHOR_LINE = /Decision 锚(?:\*\*)?\s*[:：][^\r\n]*/gu;
const DECISION_REF = /\bdec_[A-Za-z0-9_]+\b/gu;

interface AdrDecisionAnchor {
  readonly decisionId: string;
  readonly decisionPackageExists: boolean;
}

interface AdrCandidate {
  readonly adrId: string;
  readonly locator: string;
  readonly entityId: string;
  readonly expectedVersion: number;
  readonly candidateContentVersion: string;
  readonly resolvedFreshness: "current";
  readonly operationId: string;
  readonly decisionAnchors: readonly AdrDecisionAnchor[];
}

interface AdrRelationCandidate {
  readonly adrId: string;
  readonly locator: string;
  readonly decisionId: string;
  readonly record: EntityRelationRecord;
}

interface AdrScan {
  readonly candidates: readonly AdrCandidate[];
  readonly nonNumberedFiles: readonly string[];
}

interface AdrSkippedRelation {
  readonly adrId: string;
  readonly decisionId: string | null;
  readonly reason: "no-decision-anchor" | "decision-package-absent";
}

interface AdrMigrationReport {
  readonly schema: "adr-entity-migration-report/v1";
  readonly migrationOpId: string;
  readonly registryRevision: string;
  readonly batchDigest: `sha256:${string}`;
  readonly dryRun: boolean;
  readonly scan: {
    readonly numberedMarkdownCount: number;
    readonly expectedCount: number | null;
    readonly nonNumberedFiles: readonly string[];
    readonly locators: readonly string[];
  };
  readonly reconciliation: {
    readonly markdownMissingFromDescriptors: readonly string[];
    readonly unresolvableDescriptorLocators: readonly string[];
    readonly nonCurrentEntityIds: readonly string[];
    readonly duplicateIds: readonly string[];
    readonly unexpectedDescriptorLocators: readonly string[];
  };
  readonly descriptors: {
    readonly count: number;
    readonly entityIds: readonly string[];
  };
  readonly relations: {
    readonly count: number;
    readonly imported: readonly {
      readonly adrId: string;
      readonly source: string;
      readonly target: string;
      readonly relationId: string;
    }[];
    readonly skipped: readonly {
      readonly adrId: string;
      readonly decisionId: string | null;
      readonly reason: "no-decision-anchor" | "decision-package-absent";
    }[];
  };
}

export function adrMigrationRegistryRevision(): `sha256:${string}` {
  return `sha256:${loadCanonicalAssets(defaultAssets).verticalSha256}`;
}

export async function runAdrEntityMigration(input: {
  readonly rootDir: string;
  readonly repositoryId: string;
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  readonly authorizationDecision: AuthorizationDecision;
}): Promise<WriteReceipt> {
  const migrationOpId = requiredMigrationOpId(input.action.migrationOpId),
    assets = loadCanonicalAssets(defaultAssets),
    registryRevision = `sha256:${assets.verticalSha256}` as const,
    requestedRevision = requiredRegistryRevision(input.action.registryRevision);
  if (requestedRevision !== registryRevision)
    migrationError(
      "stale_vertical_registry_revision",
      `ADR migration registry revision is stale: expected ${requestedRevision}, current ${registryRevision}.`,
    );
  const contract = requiredAdrContract(assets.compiledVertical.artifactKinds),
    direction = compiledRelationDirections(assets.compiledVertical).find(
      (row) => row.sourceKind === ADR_KIND && row.type === "relates" && row.targetKind === "decision",
    );
  if (!direction || direction.strength !== "weak" || !direction.governance)
    migrationError("invalid_vertical_contract", "The ADR relates Decision direction is not governed and compiled.");
  const registry: GovernedRelationRegistryWitness = Object.freeze({
      schema: "governed-relation-registry-witness/v1",
      registryRevision,
      artifactEndpoints: Object.freeze([
        Object.freeze({
          kind: contract.typeIdentity,
          idPattern: contract.entityTypeContract.id.pattern,
          refTemplate: contract.entityTypeContract.id.refTemplate,
        }),
      ]),
      direction,
    }),
    scan = await scanCandidates(input, contract),
    candidates = scan.candidates,
    relations = relationCandidates(candidates),
    skipped = skippedRelations(candidates),
    batchDigest = migrationBatchDigest(registryRevision, input.repositoryId, candidates, relations),
    markerRef = `adr-cutover:${batchDigest}`,
    markerRelation = relations[0];
  const preflight = reconcileAdrMigration(input.rootDir, input.projection, candidates, false);
  assertReconciled(preflight);
  if (input.action.dryRun === true) {
    const report = reportFor({
      input,
      migrationOpId,
      registryRevision,
      batchDigest,
      candidates,
      nonNumberedFiles: scan.nonNumberedFiles,
      relations,
      skipped,
      reconciliation: preflight,
      dryRun: true,
    });
    return previewAdrMigrationReceipt(report, input.store, input.authorizationDecision);
  }
  for (const candidate of candidates)
    await runArtifactEntityImport({
      rootDir: input.rootDir,
      repositoryId: input.repositoryId,
      contracts: assets.compiledVertical.artifactKinds,
      action: {
        kind: "entity-import",
        entityKind: ADR_KIND,
        locator: candidate.locator,
        expectedVersion: candidate.expectedVersion,
      },
      binding: input.binding,
      store: input.store,
      projection: input.projection,
      now: input.now,
      authorizationDecision: input.authorizationDecision,
    });
  const postImport = reconcileAdrMigration(input.rootDir, input.projection, candidates, true);
  assertReconciled(postImport);
  for (const relation of relations.slice(1))
    appendRelationMigration(input, relation.record, registry, `${markerRef}/relation/${relation.record.relation_id}`);
  const marker = markerRelation
    ? appendRelationMigration(input, markerRelation.record, registry, markerRef)
    : descriptorMarker(input.store, candidates, batchDigest);
  const finalReconciliation = reconcileAdrMigration(input.rootDir, input.projection, candidates, true);
  assertReconciled(finalReconciliation);
  return appliedReceipt(
    reportFor({
      input,
      migrationOpId,
      registryRevision,
      batchDigest,
      candidates,
      nonNumberedFiles: scan.nonNumberedFiles,
      relations,
      skipped,
      reconciliation: finalReconciliation,
      dryRun: false,
    }),
    marker,
    input.authorizationDecision,
  );
}

async function scanCandidates(
  input: Parameters<typeof runAdrEntityMigration>[0],
  contract: CompiledArtifactKindContract,
): Promise<AdrScan> {
  const layout = resolveHarnessLayout(input.rootDir),
    adrDir = path.join(input.rootDir, requiredSourceRoot(input.action.sourceRoot)),
    decisionsDir = layout.decisionsRoot,
    entries = readdirSync(adrDir, { withFileTypes: true }),
    names = entries
      .filter((entry) => entry.isFile() && ADR_FILE.test(entry.name))
      .map(({ name }) => name)
      .sort(),
    nonNumberedFiles = entries
      .filter((entry) => entry.isFile() && !ADR_FILE.test(entry.name))
      .map(({ name }) => name)
      .sort(),
    duplicateIds = duplicateValues(names.map((name) => ADR_FILE.exec(name)![1]!)),
    expectedCount = optionalExpectedCount(input.action.expectCount);
  if (expectedCount !== null && names.length !== expectedCount)
    migrationError(
      "adr_migration_reconciliation_failed",
      `ADR migration expected ${expectedCount} numbered Markdown files; found ${names.length}.`,
    );
  if (duplicateIds.length)
    migrationError(
      "adr_migration_reconciliation_failed",
      `Numbered ADR filenames contain duplicate ids: ${duplicateIds.join(", ")}.`,
    );
  const candidates: AdrCandidate[] = [];
  for (const name of names) {
    const sourcePath = path.join(adrDir, name),
      locator = repositoryLocator(input.rootDir, sourcePath),
      adrId = ADR_FILE.exec(name)![1]!,
      body = readFileSync(sourcePath, "utf8"),
      anchors = decisionAnchors(body);
    const sourceIdentity = canonicalSourceIdentity({
        kind: "repository-path",
        repositoryId: input.repositoryId,
        path: locator,
      }),
      entityId = deriveArtifactEntityId({
        idPrefix: contract.declaration.idPrefix,
        typeIdentity: contract.typeIdentity,
        sourceIdentity,
      }),
      current = input.projection.getEntity(contract.typeIdentity, entityId),
      preview = await runArtifactEntityImport({
        rootDir: input.rootDir,
        repositoryId: input.repositoryId,
        contracts: [contract],
        action: {
          kind: "entity-import",
          entityKind: ADR_KIND,
          locator,
          expectedVersion: current?.workspaceRevision ?? 0,
          dryRun: true,
        },
        binding: input.binding,
        store: input.store,
        projection: input.projection,
        now: input.now,
        authorizationDecision: input.authorizationDecision,
      }),
      evidence = JSON.parse(String(preview.evidence)) as {
        readonly candidateContentVersion: string | null;
        readonly entityId: string;
        readonly eventType: string;
        readonly operationId: string;
      },
      resolution = freshnessFromResolvedPreview(evidence, locator);
    if (evidence.entityId !== entityId)
      migrationError("adr_migration_reconciliation_failed", `${locator} did not resolve to an observed descriptor.`);
    candidates.push({
      adrId,
      locator,
      entityId,
      expectedVersion: current?.workspaceRevision ?? 0,
      candidateContentVersion: resolution.contentVersion,
      resolvedFreshness: resolution.freshness,
      operationId: evidence.operationId,
      decisionAnchors: anchors.map((decisionId) => ({
        decisionId,
        decisionPackageExists: isDirectory(path.join(decisionsDir, `decision-${decisionId}`)),
      })),
    });
  }
  return { candidates, nonNumberedFiles };
}

function relationCandidates(candidates: readonly AdrCandidate[]): readonly AdrRelationCandidate[] {
  return candidates.flatMap((candidate) =>
    candidate.decisionAnchors
      .filter(({ decisionPackageExists }) => decisionPackageExists)
      .map(({ decisionId }) => {
        const source = `${ADR_KIND}/${candidate.entityId}`,
          target = `decision/${decisionId}`,
          identity = { source, target, type: "relates" as const, direction: "directed" as const },
          record: EntityRelationRecord = {
            relation_id: deriveRelationId(identity),
            ...identity,
            strength: relationStrengthForType("relates"),
            origin: "imported_snapshot",
            rationale: `Imported from Decision anchor in ${candidate.locator}.`,
            state: "active",
          };
        return { adrId: candidate.adrId, locator: candidate.locator, decisionId, record };
      }),
  );
}

function skippedRelations(candidates: readonly AdrCandidate[]) {
  const skipped: AdrSkippedRelation[] = [];
  for (const { adrId, decisionAnchors } of candidates) {
    if (decisionAnchors.length === 0) skipped.push({ adrId, decisionId: null, reason: "no-decision-anchor" });
    for (const { decisionId, decisionPackageExists } of decisionAnchors)
      if (!decisionPackageExists) skipped.push({ adrId, decisionId, reason: "decision-package-absent" });
  }
  return skipped;
}

function reconcileAdrMigration(
  rootDir: string,
  projection: TaskProjection,
  candidates: readonly AdrCandidate[],
  applied: boolean,
) {
  const descriptors = new Map(
    projection.listEntities(ADR_KIND).map((row) => [
      row.id,
      {
        entityId: row.id,
        locator: descriptorLocator(row.value),
        freshness: row.freshness,
      },
    ]),
  );
  for (const candidate of candidates)
    descriptors.set(candidate.entityId, {
      entityId: candidate.entityId,
      locator: candidate.locator,
      freshness: applied
        ? (projection.getEntity(ADR_KIND, candidate.entityId)?.freshness ?? "unknown")
        : candidate.resolvedFreshness,
    });
  const values = [...descriptors.values()],
    candidateLocators = new Set(candidates.map(({ locator }) => locator)),
    locatorSet = new Set(values.map(({ locator }) => locator).filter((locator): locator is string => locator !== null)),
    markdownMissingFromDescriptors = candidates
      .map(({ locator }) => locator)
      .filter((locator) => !locatorSet.has(locator)),
    unresolvableDescriptorLocators = values
      .filter(({ locator }) => locator === null || !isRegularFile(path.join(rootDir, locator)))
      .map(({ entityId, locator }) => locator ?? `entity:${entityId}:missing-repository-path-locator`),
    nonCurrentEntityIds = values.filter(({ freshness }) => freshness !== "current").map(({ entityId }) => entityId),
    duplicateIds = duplicateDescriptorIds(values),
    unexpectedDescriptorLocators = values
      .filter(({ locator }) => locator === null || !candidateLocators.has(locator))
      .map(({ entityId, locator }) => locator ?? `entity:${entityId}:missing-repository-path-locator`);
  return {
    markdownMissingFromDescriptors: markdownMissingFromDescriptors.sort(),
    unresolvableDescriptorLocators: unresolvableDescriptorLocators.sort(),
    nonCurrentEntityIds: nonCurrentEntityIds.sort(),
    duplicateIds,
    unexpectedDescriptorLocators: unexpectedDescriptorLocators.sort(),
    descriptorEntityIds: values.map(({ entityId }) => entityId).sort(),
  };
}

function descriptorLocator(value: Readonly<Record<string, unknown>>): string | null {
  const locator = value.locator;
  return locator && typeof locator === "object" && (locator as { readonly kind?: unknown }).kind === "repository-path"
    ? String((locator as { readonly value?: unknown }).value ?? "")
    : null;
}

function duplicateDescriptorIds(
  descriptors: readonly { readonly entityId: string; readonly locator: string | null }[],
): readonly string[] {
  const ids = descriptors.flatMap(({ locator }) => {
    const name = locator ? path.posix.basename(locator) : "",
      match = ADR_FILE.exec(name);
    return match ? [match[1]!] : [];
  });
  return duplicateValues(ids);
}

function assertReconciled(result: ReturnType<typeof reconcileAdrMigration>): void {
  const failures = [
    ...result.markdownMissingFromDescriptors.map((locator) => `missing descriptor:${locator}`),
    ...result.unresolvableDescriptorLocators.map((locator) => `unresolvable locator:${locator}`),
    ...result.nonCurrentEntityIds.map((entityId) => `non-current entity:${entityId}`),
    ...result.duplicateIds.map((adrId) => `duplicate id:${adrId}`),
    ...result.unexpectedDescriptorLocators.map((locator) => `unexpected descriptor:${locator}`),
  ];
  if (failures.length)
    migrationError(
      "adr_migration_reconciliation_failed",
      `ADR migration reconciliation failed: ${failures.join("; ")}.`,
    );
}

function appendRelationMigration(
  input: Parameters<typeof runAdrEntityMigration>[0],
  record: EntityRelationRecord,
  registry: GovernedRelationRegistryWitness,
  migratedFrom: string,
): MigrationImportEventV1 {
  const opId = `w1e-adr-rel-${sha256Text(`${migratedFrom}\0${record.relation_id}`).slice(0, 32)}`,
    existing = input.store.readEvent(opId);
  if (existing) {
    assertMigrationEvent(existing, migratedFrom, record, registry);
    return existing as MigrationImportEventV1;
  }
  const event: MigrationImportEventV1 = {
      schema: "migration-import-event/v1",
      eventId: `event-${sha256Text(opId)}`,
      workspaceRevision: (input.store.readHead()?.revision ?? 0) + 1,
      opId,
      type: "entity_migrated",
      actor: input.binding.actor,
      source: MIGRATION_IMPORT_SOURCE,
      occurredAt: input.now(),
      payload: {
        migratedFrom,
        generation: "v0",
        entity: { kind: "relation", relation: record, ownerRef: record.source, registry },
      },
    },
    plan = migrationImportWritePlan(event);
  input.store.append({ event, plan, blobs: [] });
  input.projection.apply(event, plan);
  return event;
}

function assertMigrationEvent(
  event: NonNullable<ReturnType<CanonicalEventStore["readEvent"]>>,
  migratedFrom: string,
  record: EntityRelationRecord,
  registry: GovernedRelationRegistryWitness,
): asserts event is MigrationImportEventV1 {
  if (
    event.schema !== "migration-import-event/v1" ||
    event.type !== "entity_migrated" ||
    event.source !== MIGRATION_IMPORT_SOURCE ||
    event.payload.migratedFrom !== migratedFrom ||
    event.payload.entity.kind !== "relation" ||
    stableStringify(event.payload.entity.relation) !== stableStringify(record) ||
    stableStringify(event.payload.entity.registry) !== stableStringify(registry)
  )
    migrationError("migration_source_operation_conflict", `Migration operation ${event.opId} has different bytes.`);
}

function migrationBatchDigest(
  registryRevision: string,
  repositoryId: string,
  candidates: readonly AdrCandidate[],
  relations: readonly AdrRelationCandidate[],
): `sha256:${string}` {
  return `sha256:${sha256Text(
    stableStringify({
      registryRevision,
      repositoryId,
      descriptors: candidates.map(({ adrId, locator, entityId, candidateContentVersion }) => ({
        adrId,
        locator,
        entityId,
        candidateContentVersion,
      })),
      relations: relations.map(({ adrId, decisionId, record }) => ({
        adrId,
        decisionId,
        relationId: record.relation_id,
      })),
    }),
  )}`;
}

function reportFor(input: {
  readonly input: Parameters<typeof runAdrEntityMigration>[0];
  readonly migrationOpId: string;
  readonly registryRevision: string;
  readonly batchDigest: `sha256:${string}`;
  readonly candidates: readonly AdrCandidate[];
  readonly nonNumberedFiles: readonly string[];
  readonly relations: readonly AdrRelationCandidate[];
  readonly skipped: ReturnType<typeof skippedRelations>;
  readonly reconciliation: ReturnType<typeof reconcileAdrMigration>;
  readonly dryRun: boolean;
}): AdrMigrationReport {
  return {
    schema: "adr-entity-migration-report/v1",
    migrationOpId: input.migrationOpId,
    registryRevision: input.registryRevision,
    batchDigest: input.batchDigest,
    dryRun: input.dryRun,
    scan: {
      numberedMarkdownCount: input.candidates.length,
      expectedCount: optionalExpectedCount(input.input.action.expectCount),
      nonNumberedFiles: input.nonNumberedFiles,
      locators: input.candidates.map(({ locator }) => locator),
    },
    reconciliation: {
      markdownMissingFromDescriptors: input.reconciliation.markdownMissingFromDescriptors,
      unresolvableDescriptorLocators: input.reconciliation.unresolvableDescriptorLocators,
      nonCurrentEntityIds: input.reconciliation.nonCurrentEntityIds,
      duplicateIds: input.reconciliation.duplicateIds,
      unexpectedDescriptorLocators: input.reconciliation.unexpectedDescriptorLocators,
    },
    descriptors: {
      count: input.reconciliation.descriptorEntityIds.length,
      entityIds: input.reconciliation.descriptorEntityIds,
    },
    relations: {
      count: input.relations.length,
      imported: input.relations.map(({ adrId, record }) => ({
        adrId,
        source: record.source,
        target: record.target,
        relationId: record.relation_id,
      })),
      skipped: input.skipped,
    },
  };
}

function previewAdrMigrationReceipt(
  report: AdrMigrationReport,
  store: CanonicalEventStore,
  authorizationDecision: AuthorizationDecision,
): WriteReceipt {
  const revision = store.readHead()?.revision ?? 0;
  return {
    outcome: "pending",
    opId: `preview:${report.migrationOpId}`,
    revision,
    evidence: JSON.stringify(report),
    visibility: "center",
    proof: {
      committedRevision: revision,
      appliedCut: revision,
      durable: false,
      canonicalVisible: false,
      worktreeVisible: false,
    },
    authorizationDecision,
    nextAction: `Remove --dry-run to execute ADR migration ${report.migrationOpId}.`,
  };
}

function appliedReceipt(
  report: AdrMigrationReport,
  marker: { readonly opId: string; readonly workspaceRevision: number },
  authorizationDecision: AuthorizationDecision,
): WriteReceipt {
  return {
    outcome: "applied",
    opId: marker.opId,
    revision: marker.workspaceRevision,
    evidence: JSON.stringify(report),
    visibility: "center",
    proof: {
      committedRevision: marker.workspaceRevision,
      appliedCut: marker.workspaceRevision,
      durable: true,
      canonicalVisible: true,
      worktreeVisible: true,
    },
    authorizationDecision,
  };
}

function requiredAdrContract(contracts: readonly CompiledArtifactKindContract[]): CompiledArtifactKindContract {
  const contract = contracts.find(({ typeIdentity }) => typeIdentity === ADR_KIND);
  if (!contract) migrationError("invalid_vertical_contract", `Artifact kind ${ADR_KIND} is not compiled.`);
  return contract;
}

function requiredMigrationOpId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(value))
    migrationError("invalid_command", "migrationOpId must be a portable 3-128 character operation id.");
  return value;
}

function requiredRegistryRevision(value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value))
    migrationError("invalid_command", "registryRevision must be sha256:<64 lowercase hex>.");
  return value as `sha256:${string}`;
}

function requiredSourceRoot(value: unknown): string {
  if (typeof value !== "string") {
    migrationError("invalid_command", "sourceRoot must be a repository-relative path.");
  }
  try {
    return normalizeRelativeDocumentPath(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw Object.assign(new Error(`sourceRoot must be a portable repository-relative path: ${detail}.`), {
      code: "invalid_command",
    });
  }
}

function optionalExpectedCount(value: unknown): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    migrationError("invalid_command", "expectCount must be a non-negative integer when supplied.");
  return Number(value);
}

function decisionAnchors(body: string): readonly string[] {
  return [
    ...new Set(
      [...body.matchAll(DECISION_ANCHOR_LINE)].flatMap((line) =>
        [...line[0].matchAll(DECISION_REF)].map((match) => match[0]),
      ),
    ),
  ];
}

function repositoryLocator(rootDir: string, target: string): string {
  return normalizeRelativeDocumentPath(path.relative(rootDir, target).split(path.sep).join("/"));
}

function freshnessFromResolvedPreview(
  preview: { readonly candidateContentVersion: string | null; readonly eventType: string },
  locator: string,
): { readonly freshness: "current"; readonly contentVersion: string } {
  if (!preview.candidateContentVersion || preview.eventType !== "entity_content_observed")
    migrationError("adr_migration_reconciliation_failed", `${locator} did not resolve to current content.`);
  return { freshness: "current", contentVersion: preview.candidateContentVersion };
}

function descriptorMarker(
  store: CanonicalEventStore,
  candidates: readonly AdrCandidate[],
  batchDigest: `sha256:${string}`,
): { readonly opId: string; readonly workspaceRevision: number } {
  const operationId = candidates[candidates.length - 1]?.operationId;
  if (!operationId)
    return {
      opId: `w1e-adr-batch-${batchDigest.slice("sha256:".length, "sha256:".length + 32)}`,
      workspaceRevision: store.readHead()?.revision ?? 0,
    };
  const event = store.readEvent(operationId);
  if (!event) migrationError("adr_migration_reconciliation_failed", `Descriptor operation ${operationId} is absent.`);
  return event;
}

function duplicateValues(values: readonly string[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

function isDirectory(target: string): boolean {
  return existsSync(target) && lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink();
}

function isRegularFile(target: string): boolean {
  return existsSync(target) && lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink();
}

function migrationError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

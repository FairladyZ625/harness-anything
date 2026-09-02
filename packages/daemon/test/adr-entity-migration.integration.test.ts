// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskEventStore, makeTaskProjection } from "../../kernel/src/index.ts";
import { adrMigrationRegistryRevision } from "../src/adr-entity-migration.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";

const kind = "software/coding/architecture-decision-record@1",
  relationAdrNumbers = new Set([1, 2, 3, 4, 5, 6, 7, 10, 20]),
  binding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-adr-migration" },
        executor: { kind: "agent" as const, id: "adr-migration-edge-a" },
      },
      source: "local" as const,
    },
    "repo-write",
  ),
  secondBinding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-adr-migration" },
        executor: { kind: "agent" as const, id: "adr-migration-edge-b" },
      },
      source: "local" as const,
    },
    "repo-write",
  );

test("ADR migration imports 30 descriptors and nine anchored Decision relations once", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-adr-migration-")),
    repoId = workspaceId("adr-migration"),
    sourceBodies = seedAdrSources(rootDir);
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "adr-migration-center",
      now: () => "2026-09-02T12:00:00.000Z",
    });
    const store = () => makeTaskEventReader({ repoId, rootDir }),
      initialCount = store().read().events.length,
      migrationOpId = "w1e-adr-cutover-test",
      request = {
        kind: "entity-migrate-adrs",
        registryRevision: adrMigrationRegistryRevision(),
        migrationOpId,
      } as const;
    const firstLocator = sourceBodies.keys().next().value as string,
      firstPath = path.join(rootDir, firstLocator),
      hiddenFirstPath = `${firstPath}.disabled`,
      readmePath = path.join(rootDir, "harness", "adr", "README.md"),
      hiddenReadmePath = `${readmePath}.disabled`;
    renameSync(firstPath, hiddenFirstPath);
    const shortScan = await cell.run(request, binding);
    assert.equal(shortScan.outcome, "op_rejected", JSON.stringify(shortScan));
    assert.equal(shortScan.code, "adr_migration_reconciliation_failed");
    assert.equal(store().read().events.length, initialCount);
    renameSync(hiddenFirstPath, firstPath);
    renameSync(readmePath, hiddenReadmePath);
    const missingReadme = await cell.run(request, binding);
    assert.equal(missingReadme.outcome, "op_rejected", JSON.stringify(missingReadme));
    assert.equal(missingReadme.code, "adr_migration_reconciliation_failed");
    assert.equal(store().read().events.length, initialCount);
    renameSync(hiddenReadmePath, readmePath);
    const duplicatePath = path.join(rootDir, "harness", "adr", "ADR-0001-duplicate.md");
    writeFileSync(duplicatePath, "# Duplicate ADR identity\n");
    const duplicate = await cell.run(request, binding);
    assert.equal(duplicate.outcome, "op_rejected", JSON.stringify(duplicate));
    assert.equal(duplicate.code, "adr_migration_reconciliation_failed");
    assert.equal(store().read().events.length, initialCount);
    rmSync(duplicatePath);
    const stale = await cell.run({ ...request, registryRevision: `sha256:${"0".repeat(64)}` }, binding);
    assert.equal(stale.outcome, "op_rejected", JSON.stringify(stale));
    assert.equal(stale.code, "stale_vertical_registry_revision");
    assert.equal(store().read().events.length, initialCount);

    const preview = await cell.run({ ...request, dryRun: true }, binding),
      previewReport = migrationReport(preview);
    assert.equal(preview.outcome, "pending", JSON.stringify(preview));
    assert.equal(previewReport.dryRun, true);
    assert.equal(previewReport.scan.numberedMarkdownCount, 30);
    assert.equal(previewReport.scan.readmePreserved, true);
    assert.equal(previewReport.descriptors.count, 30);
    assert.equal(previewReport.relations.count, 9);
    assert.deepEqual(previewReport.reconciliation, emptyReconciliation());
    assert.equal(store().read().events.length, initialCount, "dry-run must not append migration events");

    const [first, replay] = await Promise.all([cell.run(request, binding), cell.run(request, secondBinding)]),
      firstReport = migrationReport(first),
      replayReport = migrationReport(replay);
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    assert.equal(replay.outcome, "applied", JSON.stringify(replay));
    assert.equal(first.opId, migrationOpId);
    assert.equal(replay.opId, first.opId);
    assert.equal(replay.revision, first.revision);
    assert.deepEqual(replayReport, firstReport);
    assert.equal(firstReport.dryRun, false);
    assert.deepEqual(firstReport.reconciliation, emptyReconciliation());
    assert.equal(firstReport.relations.skipped.length, 21);
    assert.equal(store().read().events.length, initialCount + 39);
    const migrationEvents = store().read().events.slice(initialCount);
    assert.equal(
      migrationEvents.filter((event) => event.schema === "entity-event/v1" && event.type === "entity_content_observed")
        .length,
      30,
    );
    assert.equal(
      migrationEvents.filter(
        (event) => event.schema === "migration-import-event/v1" && event.payload.entity.kind === "relation",
      ).length,
      9,
    );
    assert.match(
      firstReport.relations.skipped.find(({ adrId }) => adrId === "ADR-0008")?.reason ?? "",
      /decision-dec_ADR_0008_MISSING.*absent/u,
    );

    const entityReceipt = await cell.run({ kind: "entity-list", entityKind: kind }, binding),
      entities = (
        JSON.parse(String(entityReceipt.evidence)) as {
          readonly entities: readonly {
            readonly id: string;
            readonly freshness: string;
            readonly value: Readonly<Record<string, unknown>> & {
              readonly locator: { readonly value: string };
            };
          }[];
        }
      ).entities,
      relationReceipt = await cell.run({ kind: "relation-list", relationType: "relates" }, binding),
      onlineRelations = relationRows(relationReceipt);
    assert.equal(entities.length, 30);
    assert.equal(
      entities.every(({ freshness }) => freshness === "current"),
      true,
    );
    assert.equal(
      entities.every(({ value }) => !Object.hasOwn(value, "body") && !Object.hasOwn(value, "summary")),
      true,
    );
    assert.equal(
      entities.some(({ value }) => value.locator.value === "harness/adr/README.md"),
      false,
    );
    assert.equal(onlineRelations.length, 9);
    assert.equal(
      onlineRelations.every(
        ({ sourceRef, targetRef, relationType, strength, origin }) =>
          sourceRef.startsWith(`${kind}/ADR-`) &&
          targetRef.startsWith("decision/dec_ADR_") &&
          relationType === "relates" &&
          strength === "weak" &&
          origin === "imported_snapshot",
      ),
      true,
    );
    assert.equal(
      onlineRelations.some(({ targetRef }) => targetRef.includes("SCAFFOLD_SELFDOC")),
      false,
      "a non-dec_ADR Decision anchor must not become an edge",
    );
    for (const [locator, body] of sourceBodies) assert.equal(readFileSync(path.join(rootDir, locator), "utf8"), body);

    await cell.close();
    cell = undefined;
    const rebuildStore = makeTaskEventStore({ repoId, rootDir }),
      rebuilt = makeTaskProjection({
        rootDir,
        eventStore: rebuildStore,
        now: () => "2026-09-02T12:01:00.000Z",
      });
    try {
      const receipt = rebuilt.rebuild(),
        rebuiltEntities = rebuilt.listEntities(kind),
        rebuiltRelations = rebuilt.readRelationTruth().edges.filter(({ relationType }) => relationType === "relates");
      assert.equal(receipt.watermark, rebuildStore.readHead()?.revision);
      assert.equal(rebuiltEntities.length, 30);
      assert.deepEqual(
        rebuiltRelations.map(relationIdentity).sort(byRelationId),
        onlineRelations.map(relationIdentity).sort(byRelationId),
      );
    } finally {
      rebuilt.close();
    }
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function seedAdrSources(rootDir: string): ReadonlyMap<string, string> {
  initRepo(rootDir);
  mkdirSync(path.join(rootDir, "harness", "adr"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(path.join(rootDir, "harness", "adr", "README.md"), "# ADR index retained as a regular file\n");
  const bodies = new Map<string, string>();
  for (let number = 1; number <= 30; number += 1) {
    const adrId = `ADR-${String(number).padStart(4, "0")}`,
      locator = `harness/adr/${adrId}-test-decision.md`,
      decisionId = `dec_ADR_${String(number).padStart(4, "0")}_TEST`,
      anchor =
        number === 8
          ? "\nDecision 锚：`dec_ADR_0008_MISSING`\n"
          : number === 21
            ? "\nDecision 锚：`dec_SCAFFOLD_SELFDOC_AGENTS_LAYERING`\n"
            : relationAdrNumbers.has(number)
              ? `\nDecision 锚：\`${decisionId}\`\n`
              : "",
      body = `# ${adrId} test decision\n${anchor}\nBody ${number}.\n`;
    writeFileSync(path.join(rootDir, locator), body);
    bodies.set(locator, body);
    if (relationAdrNumbers.has(number)) {
      const decisionDir = path.join(rootDir, "harness", "decisions", `decision-${decisionId}`);
      mkdirSync(decisionDir, { recursive: true });
      writeFileSync(path.join(decisionDir, "decision.md"), `# ${decisionId}\n`);
    }
  }
  git(rootDir, "add", ".");
  git(rootDir, "commit", "-qm", "seed ADR migration fixture");
  return bodies;
}

function migrationReport(receipt: { readonly evidence?: unknown }) {
  return JSON.parse(String(receipt.evidence)) as {
    readonly dryRun: boolean;
    readonly scan: { readonly numberedMarkdownCount: number; readonly readmePreserved: boolean };
    readonly reconciliation: ReturnType<typeof emptyReconciliation>;
    readonly descriptors: { readonly count: number };
    readonly relations: {
      readonly count: number;
      readonly skipped: readonly { readonly adrId: string; readonly reason: string }[];
    };
  };
}

function emptyReconciliation() {
  return {
    markdownMissingFromDescriptors: [],
    unresolvableDescriptorLocators: [],
    nonCurrentEntityIds: [],
    duplicateIds: [],
    unexpectedDescriptorLocators: [],
  };
}

function relationRows(receipt: { readonly evidence?: unknown }) {
  return (
    JSON.parse(String(receipt.evidence)) as {
      readonly rows: readonly {
        readonly relationId: string;
        readonly sourceRef: string;
        readonly targetRef: string;
        readonly relationType: string;
        readonly strength: string;
        readonly origin: string;
      }[];
    }
  ).rows;
}

function relationIdentity(row: ReturnType<typeof relationRows>[number]) {
  return {
    relationId: row.relationId,
    sourceRef: row.sourceRef,
    targetRef: row.targetRef,
    relationType: row.relationType,
    strength: row.strength,
    origin: row.origin,
  };
}

function byRelationId(left: { readonly relationId: string }, right: { readonly relationId: string }): number {
  return left.relationId.localeCompare(right.relationId);
}

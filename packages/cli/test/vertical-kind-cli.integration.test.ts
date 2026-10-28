// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { openBootstrappedRepoCell as openRepoCell } from "../../daemon/test/repo-settings.fixture.ts";
import { withPolicyGroup } from "../../daemon/test/keycloak-policy.fixtures.ts";
import { initRepo } from "../../daemon/test/task-surface.fixtures.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";

const canonicalDecisionPin = "sha256:f8ccb58e91a8da7c67fe57d1e02e78bdb1bf1972abc721d4a542d27f5919ffdb",
  binding = withPolicyGroup(
    {
      actor: {
        principal: { personId: "person-vertical-kind-cli" },
        executor: { kind: "agent" as const, id: "vertical-kind-cli-edge" },
      },
      source: "local" as const,
    },
    "contributor",
  );

/**
 * `external-document` is the owner's motivating sample: a category enum plus declared relations to
 * a task and a decision. It exists only in the declaration, so a passing run proves the CLI can
 * declare an arbitrary Kind without a source-code branch.
 */
const externalDocument = {
  id: "external-document",
  entityType: "artifact",
  idPrefix: "EXTDOC",
  display: { singular: "External Document", plural: "External Documents" },
  descriptorSchemaRef: "schema://artifact-descriptor",
  store: { pathTemplate: "docs/external/{id}.json" },
  locatorKinds: ["repository-path", "url", "external-key"],
  relations: [
    {
      type: "relates",
      sourceKind: "external-document",
      targetKind: "task",
      reads: "The external document supports the task it is attached to.",
      strength: "weak",
      decisionClaimRef: "decision/dec_29CCC98CD0241D0C9806AC1CF1/CH1",
      decisionContentPin: canonicalDecisionPin,
    },
    {
      type: "relates",
      sourceKind: "external-document",
      targetKind: "decision",
      reads: "The external document records the decision it was cited by.",
      strength: "weak",
      decisionClaimRef: "decision/dec_29CCC98CD0241D0C9806AC1CF1/CH1",
      decisionContentPin: canonicalDecisionPin,
    },
  ],
  attributes: { category: { type: "string", enum: ["meeting-minutes", "technical-note"], required: true } },
};

test("CLI declares external-document, publishes schema v2, imports an entity, relates it, and retires the Kind", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-vertical-kind-cli-e2e-")),
    repoId = workspaceId("vertical-kind-cli-e2e"),
    sourcePath = "docs/external/kickoff.md";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    mkdirSync(path.join(root, "docs/external"), { recursive: true });
    writeFileSync(path.join(root, sourcePath), "# Kickoff minutes\n\nExternal document source.\n");
    git(root, "add", sourcePath);
    git(root, "commit", "-qm", "add external document source");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: "vertical-kind-cli-center",
      now: monotonicClock(),
    });

    // 1. Create the Kind through the CLI's upsert command. Version 1 knows only `category`.
    const created = await runCli(cell, root, [
      "vertical",
      "kind",
      "upsert",
      "--declaration",
      JSON.stringify(externalDocument),
      "--expected-version",
      "0",
    ]);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const createdEvidence = evidence(created) as { kindRef: string; kindVersion: number },
      kindRef = createdEvidence.kindRef,
      kindRevision = Number(created.revision);
    assert.match(kindRef, /^entity-kind\/KND-[0-9a-f]{32}$/u);
    assert.equal(createdEvidence.kindVersion, 1);

    // 2. The read side reports the same identity and the fence the next write must present.
    const listed = await runCli(cell, root, ["vertical", "kind", "list"]),
      listedRow = (evidence(listed) as { kinds: readonly { kindId: string; revision: number }[] }).kinds.find(
        (row) => `entity-kind/${row.kindId}` === kindRef,
      );
    assert.equal(listedRow?.revision, kindRevision, JSON.stringify(listed));

    // 3. A declaration the center cannot accept is refused at the command that introduced it, with
    //    the field or the immutable facet named, and leaves the accepted declaration untouched.
    const missingClaim = await runCli(cell, root, [
      "vertical",
      "kind",
      "upsert",
      "--declaration",
      JSON.stringify({
        ...externalDocument,
        id: "external-document-missing-claim",
        // A distinct prefix keeps each negative case on the failure it names: the compiler rejects a
        // reused idPrefix before the field this assertion is about is reached.
        idPrefix: "EXTDM",
        relations: [
          {
            ...externalDocument.relations[0],
            sourceKind: "external-document-missing-claim",
            decisionClaimRef: undefined,
          },
        ],
      }),
      "--expected-version",
      "0",
    ]);
    assert.equal(missingClaim.outcome, "op_rejected", JSON.stringify(missingClaim));
    assert.equal(missingClaim.code, "vertical_declaration_invalid", JSON.stringify(missingClaim));
    assert.match(
      String(missingClaim.rejectionExplanation),
      /relations\.0\.decisionClaimRef/u,
      JSON.stringify(missingClaim),
    );

    const badPin = await runCli(cell, root, [
      "vertical",
      "kind",
      "upsert",
      "--declaration",
      JSON.stringify({
        ...externalDocument,
        id: "external-document-bad-pin",
        // Distinct identity facets keep this case about the pin: the compiler rejects a reused
        // idPrefix or pathTemplate first, and that would mask the refusal this assertion names.
        idPrefix: "EXTDB",
        store: { pathTemplate: "docs/external-bad-pin/{id}.json" },
        relations: [
          {
            ...externalDocument.relations[0],
            sourceKind: "external-document-bad-pin",
            decisionContentPin: `sha256:${"f".repeat(64)}`,
          },
        ],
      }),
      "--expected-version",
      "0",
    ]);
    assert.equal(badPin.outcome, "op_rejected", JSON.stringify(badPin));
    assert.equal(badPin.code, "vertical_declaration_invalid", JSON.stringify(badPin));
    assert.match(String(badPin.rejectionExplanation), /pin mismatch/iu, JSON.stringify(badPin));

    const renamedPrefix = await runCli(cell, root, [
      "vertical",
      "kind",
      "upsert",
      "--kind",
      kindRef,
      "--declaration",
      JSON.stringify({ ...externalDocument, idPrefix: "OTHER" }),
      "--expected-version",
      String(kindRevision),
    ]);
    assert.equal(renamedPrefix.outcome, "op_rejected", JSON.stringify(renamedPrefix));
    assert.equal(renamedPrefix.code, "destructive_kind_change", JSON.stringify(renamedPrefix));
    assert.match(String(renamedPrefix.rejectionExplanation), /idPrefix is immutable/u, JSON.stringify(renamedPrefix));

    const movedStore = await runCli(cell, root, [
      "vertical",
      "kind",
      "upsert",
      "--kind",
      kindRef,
      "--declaration",
      JSON.stringify({ ...externalDocument, store: { pathTemplate: "docs/moved/{id}.json" } }),
      "--expected-version",
      String(kindRevision),
    ]);
    assert.equal(movedStore.outcome, "op_rejected", JSON.stringify(movedStore));
    assert.equal(movedStore.code, "destructive_kind_change", JSON.stringify(movedStore));
    assert.match(String(movedStore.rejectionExplanation), /pathTemplate is immutable/u, JSON.stringify(movedStore));

    // Identity facets that shape every stored descriptor are immutable for the same reason: changing
    // them would leave already-imported instances unable to update or archive.
    const movedDescriptor = await runCli(cell, root, [
      "vertical",
      "kind",
      "upsert",
      "--kind",
      kindRef,
      "--declaration",
      JSON.stringify({ ...externalDocument, descriptorSchemaRef: "schema://task-frontmatter" }),
      "--expected-version",
      String(kindRevision),
    ]);
    assert.equal(movedDescriptor.outcome, "op_rejected", JSON.stringify(movedDescriptor));
    assert.equal(movedDescriptor.code, "destructive_kind_change", JSON.stringify(movedDescriptor));
    assert.match(
      String(movedDescriptor.rejectionExplanation),
      /descriptorSchemaRef is immutable/u,
      JSON.stringify(movedDescriptor),
    );

    const movedLocators = await runCli(cell, root, [
      "vertical",
      "kind",
      "upsert",
      "--kind",
      kindRef,
      "--declaration",
      JSON.stringify({ ...externalDocument, locatorKinds: ["url"] }),
      "--expected-version",
      String(kindRevision),
    ]);
    assert.equal(movedLocators.outcome, "op_rejected", JSON.stringify(movedLocators));
    assert.equal(movedLocators.code, "destructive_kind_change", JSON.stringify(movedLocators));
    assert.match(
      String(movedLocators.rejectionExplanation),
      /locatorKinds are immutable/u,
      JSON.stringify(movedLocators),
    );

    const lifecycleViaUpsert = await runCli(cell, root, [
      "vertical",
      "kind",
      "upsert",
      "--kind",
      kindRef,
      "--declaration",
      JSON.stringify({ ...externalDocument, retired: false }),
      "--expected-version",
      String(kindRevision),
    ]);
    assert.equal(lifecycleViaUpsert.outcome, "op_rejected", JSON.stringify(lifecycleViaUpsert));
    assert.equal(lifecycleViaUpsert.code, "destructive_kind_change", JSON.stringify(lifecycleViaUpsert));
    assert.match(
      String(lifecycleViaUpsert.rejectionExplanation),
      /Retirement is not an upsert facet/u,
      JSON.stringify(lifecycleViaUpsert),
    );

    const duplicateCreate = await runCli(cell, root, [
      "vertical",
      "kind",
      "upsert",
      "--declaration",
      JSON.stringify(externalDocument),
      "--expected-version",
      "0",
    ]);
    assert.equal(duplicateCreate.outcome, "op_rejected", JSON.stringify(duplicateCreate));
    assert.equal(duplicateCreate.code, "kind_exists", JSON.stringify(duplicateCreate));

    const stillV1 = await runCli(cell, root, ["vertical", "kind", "show", kindRef]);
    assert.equal(
      (evidence(stillV1) as { kind: { revision: number } }).kind.revision,
      kindRevision,
      "rejected declarations do not move the Kind's fence",
    );

    // 4. A version-1 instance cannot use the attribute v2 will introduce.
    const undeclared = await runCli(cell, root, [
      "entity",
      "import",
      "--kind",
      kindRef,
      "--locator",
      sourcePath,
      "--expected-version",
      "0",
      "--attributes",
      JSON.stringify({ category: "meeting-minutes", owner: "qa" }),
    ]);
    assert.equal(undeclared.outcome, "op_rejected", JSON.stringify(undeclared));
    assert.equal(undeclared.code, "invalid_entity_contract", JSON.stringify(undeclared));

    // 5. A stale fence is refused; the same command at the shown revision publishes v2.
    const stalePublish = await runCli(cell, root, [
      "vertical",
      "kind",
      "publish-schema",
      kindRef,
      "--attributes",
      JSON.stringify({
        category: { type: "string", enum: ["meeting-minutes", "technical-note"], required: true },
        owner: { type: "string" },
      }),
      "--expected-version",
      "0",
    ]);
    assert.equal(stalePublish.outcome, "op_rejected", JSON.stringify(stalePublish));
    assert.equal(stalePublish.code, "revision_conflict", JSON.stringify(stalePublish));

    const shown = await runCli(cell, root, ["vertical", "kind", "show", kindRef]),
      shownKind = (evidence(shown) as { kind: { revision: number; schemaVersions: readonly { version: number }[] } })
        .kind;
    assert.equal(shownKind.revision, kindRevision);
    assert.equal(shownKind.schemaVersions.at(-1)?.version, 1);

    const published = await runCli(cell, root, [
      "vertical",
      "kind",
      "publish-schema",
      kindRef,
      "--attributes",
      JSON.stringify({
        category: { type: "string", enum: ["meeting-minutes", "technical-note"], required: true },
        owner: { type: "string" },
      }),
      "--expected-version",
      String(shownKind.revision),
    ]);
    assert.equal(published.outcome, "applied", JSON.stringify(published));
    assert.equal((evidence(published) as { kindVersion: number }).kindVersion, 2);
    const v2Revision = Number(published.revision);

    // 6. Import an instance at v2 and read back the pinned version and pure attributes.
    const imported = await runCli(cell, root, [
      "entity",
      "import",
      "--kind",
      kindRef,
      "--locator",
      sourcePath,
      "--expected-version",
      "0",
      "--title",
      "Kickoff minutes",
      "--attributes",
      JSON.stringify({ category: "meeting-minutes", owner: "qa" }),
    ]);
    assert.equal(imported.outcome, "applied", JSON.stringify(imported));
    const entityId = String(imported.entityId);
    assert.ok(entityId.length > 0, JSON.stringify(imported));
    const readBack = await runCli(cell, root, ["entity", "get", kindRef, "--id", entityId]),
      entity = (evidence(readBack) as { entity: { value: { kindVersion: number; attributes: unknown } } }).entity;
    assert.equal(entity.value.kindVersion, 2);
    assert.deepEqual(entity.value.attributes, { category: "meeting-minutes", owner: "qa" });

    // A facet change is refused after instances exist too, and the stored instance keeps updating
    // under the descriptor it was imported with instead of becoming permanently unmaintainable.
    const locatorsAfterImport = await runCli(cell, root, [
      "vertical",
      "kind",
      "upsert",
      "--kind",
      kindRef,
      "--declaration",
      JSON.stringify({ ...externalDocument, locatorKinds: ["url"] }),
      "--expected-version",
      String(v2Revision),
    ]);
    assert.equal(locatorsAfterImport.code, "destructive_kind_change", JSON.stringify(locatorsAfterImport));
    const updatedEntity = await runCli(cell, root, [
      "entity",
      "update",
      kindRef,
      "--id",
      entityId,
      "--expected-version",
      String(imported.revision),
      "--attributes",
      JSON.stringify({ category: "meeting-minutes", owner: "lead" }),
    ]);
    assert.equal(updatedEntity.outcome, "applied", JSON.stringify(updatedEntity));
    const reread = await runCli(cell, root, ["entity", "get", kindRef, "--id", entityId]),
      rereadEntity = (evidence(reread) as { entity: { value: { attributes: unknown } } }).entity;
    assert.deepEqual(rereadEntity.value.attributes, { category: "meeting-minutes", owner: "lead" });

    // 7. Attach a real Relation from the imported entity to a task, using only the CLI command shape.
    const task = await cell.run(
      { kind: "task-create", taskId: "task_external_document", title: "External document relation target" },
      binding,
    );
    assert.equal(task.outcome, "applied", JSON.stringify(task));
    const related = await runCli(cell, root, [
      "relation",
      "relate",
      "--source-ref",
      `${kindRef}/${entityId}`,
      "--target-ref",
      "task/task_external_document",
      "--type",
      "relates",
      "--rationale",
      "The kickoff minutes support this task.",
      "--expected-version",
      "0",
    ]);
    assert.equal(related.outcome, "applied", JSON.stringify(related));
    assert.match(String(related.relationId), /^rel_[0-9a-f]{16}$/u);

    // 8. Retire under the Kind's own fence; a stale fence is refused first.
    const staleRetire = await runCli(cell, root, [
      "vertical",
      "kind",
      "retire",
      kindRef,
      "--reason",
      "Sample retired after acceptance",
      "--expected-version",
      String(kindRevision),
    ]);
    assert.equal(staleRetire.outcome, "op_rejected", JSON.stringify(staleRetire));
    assert.equal(staleRetire.code, "revision_conflict", JSON.stringify(staleRetire));
    const retired = await runCli(cell, root, [
      "vertical",
      "kind",
      "retire",
      kindRef,
      "--reason",
      "Sample retired after acceptance",
      "--expected-version",
      String(v2Revision),
    ]);
    assert.equal(retired.outcome, "applied", JSON.stringify(retired));

    // Retirement is not an upsert facet: the archived Kind cannot be resurrected or have its reason
    // rewritten, and it stays closed to new imports.
    const resurrection = await runCli(cell, root, [
      "vertical",
      "kind",
      "upsert",
      "--kind",
      kindRef,
      "--declaration",
      JSON.stringify({ ...externalDocument, retired: false }),
      "--expected-version",
      String(retired.revision),
    ]);
    assert.equal(resurrection.outcome, "op_rejected", JSON.stringify(resurrection));
    assert.equal(resurrection.code, "destructive_kind_change", JSON.stringify(resurrection));
    const reasonRewrite = await runCli(cell, root, [
      "vertical",
      "kind",
      "upsert",
      "--kind",
      kindRef,
      "--declaration",
      JSON.stringify({ ...externalDocument, reason: "rewritten reason" }),
      "--expected-version",
      String(retired.revision),
    ]);
    assert.equal(reasonRewrite.code, "destructive_kind_change", JSON.stringify(reasonRewrite));
    const importAfterRetire = await runCli(cell, root, [
      "entity",
      "import",
      "--kind",
      kindRef,
      "--locator",
      sourcePath,
      "--expected-version",
      "0",
      "--attributes",
      JSON.stringify({ category: "meeting-minutes", owner: "qa" }),
    ]);
    assert.equal(importAfterRetire.outcome, "op_rejected", JSON.stringify(importAfterRetire));

    const active = await runCli(cell, root, ["vertical", "kind", "list"]),
      activeKinds = (evidence(active) as { kinds: readonly { kindRef?: string; id: string }[] }).kinds;
    assert.equal(
      activeKinds.some((row) => row.id === "external-document"),
      false,
      "retired kinds leave the default list",
    );
    const all = await runCli(cell, root, ["vertical", "kind", "list", "--include-retired"]),
      allKinds = (evidence(all) as { kinds: readonly { id: string; retired?: boolean }[] }).kinds,
      retiredRow = allKinds.find((row) => row.id === "external-document");
    assert.equal(retiredRow?.retired, true);
    const shownRetired = await runCli(cell, root, ["vertical", "kind", "show", kindRef]),
      retiredKind = (evidence(shownRetired) as { kind: { retired?: boolean; revision: number } }).kind;
    assert.equal(retiredKind.retired, true);
    assert.equal(retiredKind.revision, Number(retired.revision));
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function runCli(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  root: string,
  argv: readonly string[],
): Promise<Record<string, unknown>> {
  const parsed = parseThinCommand(argv, root);
  assert.equal(parsed.ok, true, `${argv.join(" ")}\n${JSON.stringify(parsed)}`);
  if (!parsed.ok) throw new Error("unreachable");
  const receipt = await cell.run(parsed.command.action, binding);
  assert.equal(typeof receipt, "object", JSON.stringify(receipt));
  return receipt as unknown as Record<string, unknown>;
}

function evidence(receipt: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(String(receipt.evidence)) as Record<string, unknown>;
}

function monotonicClock(): () => string {
  let second = 0;
  return () => `2026-10-28T00:00:${String(second++).padStart(2, "0")}.000Z`;
}

function git(root: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

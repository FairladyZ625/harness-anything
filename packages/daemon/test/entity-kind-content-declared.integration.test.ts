// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_ENTITY_CONTENT_OBJECT_BYTES, makeTaskEventReader } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

const binding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-declared-kind-content" },
        executor: { kind: "agent" as const, id: "declared-kind-content-edge" },
      },
      source: "local" as const,
    },
    "repo-write",
  ),
  // A remote edge with no role binding: neither a declared repo-write role nor the local default binding
  // holds for it, so the policy is the only thing standing between this caller and a durable Kind write.
  unauthorized = {
    actor: {
      principal: { personId: "person-declared-kind-content-reader" },
      executor: { kind: "agent" as const, id: "declared-kind-content-reader-edge" },
    },
    source: "remote_direct" as const,
    roleBindings: [],
  };

const surveyKind = {
    id: "field-survey",
    entityType: "artifact",
    idPrefix: "SRV",
    display: { singular: "Field Survey", plural: "Field Surveys" },
    descriptorSchemaRef: "schema://artifact-descriptor",
    store: { pathTemplate: "entities/field-surveys/{id}.json" },
    locatorKinds: ["repository-path"],
    attributes: { region: { type: "string", required: true } },
  },
  ledgerKind = {
    id: "grant-ledger",
    entityType: "artifact",
    idPrefix: "GRL",
    display: { singular: "Grant Ledger", plural: "Grant Ledgers" },
    descriptorSchemaRef: "schema://artifact-descriptor",
    store: { pathTemplate: "entities/grant-ledgers/{id}.json" },
    locatorKinds: ["repository-path"],
    attributes: { fiscalYear: { type: "integer", required: true } },
  };

/**
 * Nothing below names a Kind that exists in source. Two Kinds are declared at runtime and then carry a file, a
 * directory with an empty directory in it, binary bytes, an update that retires a dropped file, and a delete
 * that retires the rest — all through the same production actions the built-in kinds use.
 */
test("Two Kinds declared at runtime carry file and directory content through the same production path", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-declared-kind-content-")),
    repoId = workspaceId("declared-kind-content"),
    binary = Buffer.concat([Buffer.from("%PDF-1.7\n%"), Buffer.from([0, 255, 10, 128, 1]), Buffer.from("\n%%EOF\n")]);
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "surveys", "north", "raw"), { recursive: true });
    mkdirSync(path.join(rootDir, "surveys", "north", "unfiled"), { recursive: true });
    mkdirSync(path.join(rootDir, "ledgers"), { recursive: true });
    writeFileSync(path.join(rootDir, "surveys", "north", "README.md"), "# North survey\n");
    writeFileSync(path.join(rootDir, "surveys", "north", "raw", "scan.pdf"), binary);
    writeFileSync(path.join(rootDir, "surveys", "north", "raw", "draft.txt"), "draft\n");
    writeFileSync(path.join(rootDir, "ledgers", "2026.md"), "# Grants 2026\n");
    git(rootDir, "add", "surveys", "ledgers");
    git(rootDir, "commit", "-qm", "add sources for runtime-declared kinds");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "declared-kind-content-center",
      now: () => "2026-09-09T07:00:00.000Z",
    });

    const declare = async (declaration: Record<string, unknown>) => {
      const created = await cell!.run(
        { kind: "vertical-kind-upsert", kindId: String(declaration.id), expectedVersion: 0, declaration },
        binding,
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      const kindRef = (JSON.parse(String(created.evidence)) as { kindRef: string }).kindRef;
      assert.match(kindRef, /^entity-kind\/KND-[0-9a-f]{32}$/u);
      return kindRef;
    };

    const surveyRef = await declare(surveyKind),
      ledgerRef = await declare(ledgerKind);
    assert.notEqual(surveyRef, ledgerRef);

    // Kind one: a directory source with binary bytes and an empty directory.
    const surveyImport = await cell.run(
        {
          kind: "entity-import",
          entityKind: surveyRef,
          locator: "surveys/north",
          expectedVersion: 0,
          attributes: { region: "north" },
        },
        binding,
      ),
      surveyId = (JSON.parse(String(surveyImport.evidence)) as { preview: { entityId: string } }).preview.entityId,
      surveyRoot = `entities/field-surveys/${surveyId}`;
    assert.equal(surveyImport.outcome, "applied", JSON.stringify(surveyImport));
    assert.match(surveyId, /^SRV-[a-f0-9]{32}$/u);
    await waitForFixturePublication(cell, surveyImport.opId, binding);

    // Kind two: a single file source. Two kinds, two id spaces, one code path.
    const ledgerImport = await cell.run(
        {
          kind: "entity-import",
          entityKind: ledgerRef,
          locator: "ledgers/2026.md",
          expectedVersion: 0,
          attributes: { fiscalYear: 2026 },
        },
        binding,
      ),
      ledgerId = (JSON.parse(String(ledgerImport.evidence)) as { preview: { entityId: string } }).preview.entityId,
      ledgerRoot = `entities/grant-ledgers/${ledgerId}`;
    assert.equal(ledgerImport.outcome, "applied", JSON.stringify(ledgerImport));
    assert.match(ledgerId, /^GRL-[a-f0-9]{32}$/u);
    await waitForFixturePublication(cell, ledgerImport.opId, binding);

    // Every read below is of published state; the sources are gone.
    rmSync(path.join(rootDir, "surveys"), { recursive: true });
    rmSync(path.join(rootDir, "ledgers"), { recursive: true });
    assert.deepEqual(readFileSync(path.join(rootDir, "harness", surveyRoot, "raw/scan.pdf")), binary);
    assert.equal(readFileSync(path.join(rootDir, "harness", surveyRoot, "raw/draft.txt"), "utf8"), "draft\n");
    assert.ok(statSync(path.join(rootDir, "harness", surveyRoot, "unfiled")).isDirectory());
    assert.equal(readFileSync(path.join(rootDir, "harness", ledgerRoot, "2026.md"), "utf8"), "# Grants 2026\n");
    assert.deepEqual(
      execFileSync("git", ["-C", rootDir, "show", `HEAD:harness/${surveyRoot}/raw/scan.pdf`], { maxBuffer: 1 << 24 }),
      binary,
      "a runtime-declared kind must publish original bytes through Git like any other",
    );

    // Update on a runtime-declared kind: the dropped file is retired, the rest is carried forward.
    mkdirSync(path.join(rootDir, "surveys", "north", "raw"), { recursive: true });
    mkdirSync(path.join(rootDir, "surveys", "north", "unfiled"), { recursive: true });
    writeFileSync(path.join(rootDir, "surveys", "north", "README.md"), "# North survey\n");
    writeFileSync(path.join(rootDir, "surveys", "north", "raw", "scan.pdf"), binary);
    const updated = await cell.run(
      {
        kind: "entity-import",
        entityKind: surveyRef,
        locator: "surveys/north",
        expectedVersion: surveyImport.revision,
      },
      binding,
    );
    assert.equal(updated.outcome, "applied", JSON.stringify(updated));
    await waitForFixturePublication(cell, updated.opId, binding);
    assert.equal(existsSync(path.join(rootDir, "harness", surveyRoot, "raw/draft.txt")), false);
    assert.deepEqual(readFileSync(path.join(rootDir, "harness", surveyRoot, "raw/scan.pdf")), binary);

    // Delete on a runtime-declared kind retires every path it still binds.
    const deleted = await cell.run(
      {
        kind: "entity-delete",
        entityKind: surveyRef,
        entityId: surveyId,
        expectedVersion: updated.revision,
        reason: "survey withdrawn",
      },
      binding,
    );
    assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));
    await waitForFixturePublication(cell, deleted.opId, binding);
    assert.equal(existsSync(path.join(rootDir, "harness", `${surveyRoot}.json`)), false);
    assert.equal(existsSync(path.join(rootDir, "harness", surveyRoot, "raw/scan.pdf")), false);
    assert.equal(
      readFileSync(path.join(rootDir, "harness", ledgerRoot, "2026.md"), "utf8"),
      "# Grants 2026\n",
      "deleting one kind's instance must not touch another kind's material",
    );

    // The withdrawn bytes are still reachable from the event that carried them.
    const store = makeTaskEventReader({ repoId, rootDir }),
      imported = store.read().events.find((event) => event.opId === surveyImport.opId) as unknown as {
        payload: { ownedContent: { bindings: readonly { path: string; contentSha256: string }[] } };
      },
      scan = imported.payload.ownedContent.bindings.find(({ path: bound }) => bound.endsWith("/raw/scan.pdf"));
    assert.ok(scan, "the accepted import must still name the object it bound");
    assert.deepEqual(Buffer.from(store.readContentBlob(scan.contentSha256) ?? []), binary);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/**
 * The per-object ceiling is a real refusal at the ingress, not a manifest-level check reached after the bytes
 * are already inside: the file above the limit is never paged in, and the whole snapshot is refused with it.
 */
test("A source object above the per-object ceiling is refused and the exact boundary is accepted", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-content-ceiling-")),
    repoId = workspaceId("entity-content-ceiling"),
    researchKind = "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "oversize"), { recursive: true });
    mkdirSync(path.join(rootDir, "boundary"), { recursive: true });
    // One byte over, and exactly at, the ceiling. Written once and read back through the real ingress.
    writeFileSync(path.join(rootDir, "oversize", "too-big.bin"), Buffer.alloc(MAX_ENTITY_CONTENT_OBJECT_BYTES + 1));
    writeFileSync(path.join(rootDir, "oversize", "small.txt"), "collateral\n");
    writeFileSync(path.join(rootDir, "boundary", "exact.bin"), Buffer.alloc(MAX_ENTITY_CONTENT_OBJECT_BYTES));
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-content-ceiling-center",
      now: () => "2026-09-09T08:00:00.000Z",
    });

    const refused = await cell.run(
      { kind: "entity-import", entityKind: researchKind, locator: "oversize", expectedVersion: 0 },
      binding,
    );
    assert.equal(refused.outcome, "op_rejected", JSON.stringify(refused));
    assert.equal(refused.code, "invalid_command");
    assert.match(String(refused.rejectionExplanation), /50000001 bytes, above the 50000000-byte per-file limit/u);
    assert.equal(
      makeTaskEventReader({ repoId, rootDir })
        .read()
        .events.filter((event) => event.schema === "entity-event/v1").length,
      0,
      "an oversized object must refuse the whole snapshot rather than land part of it",
    );

    const accepted = await cell.run(
      { kind: "entity-import", entityKind: researchKind, locator: "boundary", expectedVersion: 0 },
      binding,
    );
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    const entityId = (JSON.parse(String(accepted.evidence)) as { preview: { entityId: string } }).preview.entityId,
      manifest = (
        makeTaskEventReader({ repoId, rootDir })
          .read()
          .events.find((event) => event.opId === accepted.opId) as unknown as {
          payload: { ownedContent: { content: readonly { byteLength: number }[] } };
        }
      ).payload.ownedContent;
    assert.ok(entityId.startsWith("RES-"));
    assert.deepEqual(
      manifest.content.map(({ byteLength }) => byteLength).filter((size) => size === MAX_ENTITY_CONTENT_OBJECT_BYTES),
      [MAX_ENTITY_CONTENT_OBJECT_BYTES],
      "the exact ceiling is an accepted object, not a rejected one",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/** Publishing a Kind schema version is a durable repository write, so an unauthorized caller is refused. */
test("Publishing a Kind schema version is refused for a caller with no repository write role", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-kind-publish-authorization-")),
    repoId = workspaceId("kind-publish-authorization");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "kind-publish-authorization-center",
      now: () => "2026-09-09T09:00:00.000Z",
    });
    const created = await cell.run(
      { kind: "vertical-kind-upsert", kindId: surveyKind.id, expectedVersion: 0, declaration: surveyKind },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const kindRef = (JSON.parse(String(created.evidence)) as { kindRef: string }).kindRef,
      fence = async () => {
        const row = (await cell!.read("repo.vertical.declaration.read", {}, binding)).declaration.entityKinds.find(
          (candidate: Record<string, unknown>) => `entity-kind/${String(candidate.kindId)}` === kindRef,
        ) as { readonly revision?: number } | undefined;
        assert.ok(row, `declaration has no row for ${kindRef}`);
        return Number(row.revision);
      };

    const attributes = { region: { type: "string", required: true }, surveyor: { type: "string" } },
      refused = await cell.run(
        { kind: "vertical-kind-publish-schema", kindId: kindRef, expectedVersion: await fence(), attributes },
        unauthorized,
      );
    assert.equal(refused.outcome, "op_rejected", JSON.stringify(refused));
    assert.equal(refused.authorizationDecision?.outcome, "denied", JSON.stringify(refused.authorizationDecision));
    assert.equal(
      refused.authorizationDecision?.policyRef,
      "default@5",
      "the refusal must come from the declared policy, not from an ad hoc check",
    );

    // The same call with the repository write role goes through: the action is governed, not disabled.
    const allowed = await cell.run(
      { kind: "vertical-kind-publish-schema", kindId: kindRef, expectedVersion: await fence(), attributes },
      binding,
    );
    assert.equal(allowed.outcome, "applied", JSON.stringify(allowed));
    assert.equal((JSON.parse(String(allowed.evidence)) as { kindVersion: number }).kindVersion, 2);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

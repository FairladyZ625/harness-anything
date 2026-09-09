// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { validateDaemonRpcCall } from "../src/protocol/daemon-protocol-rpc-validation.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

const binding = withRoleBinding(
  {
    actor: {
      principal: { personId: "person-entity-consumer" },
      executor: { kind: "agent" as const, id: "entity-consumer-edge" },
    },
    source: "local" as const,
  },
  "repo-write",
);

const surveyKind = {
  id: "consumer-survey",
  entityType: "artifact",
  idPrefix: "CSV",
  display: { singular: "Consumer Survey", plural: "Consumer Surveys" },
  descriptorSchemaRef: "schema://artifact-descriptor",
  store: { pathTemplate: "entities/consumer-surveys/{id}.json" },
  locatorKinds: ["repository-path"],
  attributes: { region: { type: "string", required: true } },
};

const dossierKind = {
  id: "consumer-dossier",
  entityType: "artifact",
  idPrefix: "CDS",
  display: { singular: "Consumer Dossier", plural: "Consumer Dossiers" },
  descriptorSchemaRef: "schema://artifact-descriptor",
  store: { pathTemplate: "entities/consumer-dossiers/{id}.json" },
  locatorKinds: ["repository-path"],
  attributes: {},
};

/** Gap 1: the runtime reads `action.attributes`, but no declared ingress contract admits the field. */
test("the declared entity action input admits attributes at the JSON-RPC ingress", () => {
  const taskRun = {
    jsonrpc: "2.0",
    id: 1,
    method: "repo.task.run",
    params: {
      repo: { repoId: "workspace-consumer" },
      payload: {
        action: {
          kind: "entity-import",
          entityKind: "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16",
          locator: "surveys/north",
          expectedVersion: 0,
          attributes: { region: "north" },
        },
      },
    },
  };
  assert.deepEqual(validateDaemonRpcCall(taskRun), [], "the CLI action ingress must carry stated attributes");

  const guiImport = {
    jsonrpc: "2.0",
    id: 2,
    method: "repo.entity.import",
    params: {
      repo: { repoId: "workspace-consumer" },
      payload: {
        entityKind: "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16",
        locator: "surveys/north",
        expectedVersion: 0,
        attributes: { region: "north" },
      },
    },
  };
  assert.deepEqual(validateDaemonRpcCall(guiImport), [], "the GUI action ingress must carry stated attributes");
});

/**
 * Gap 1, through the production action rather than a helper: stated attributes reach the descriptor, are judged
 * against the schema version the instance is pinned to, survive an update that does not restate them, and are
 * refused when they name something the Kind never declared.
 */
test("stated attributes are judged against the version the instance is pinned to", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-consumer-attributes-")),
    repoId = workspaceId("entity-consumer-attributes");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "surveys"), { recursive: true });
    writeFileSync(path.join(rootDir, "surveys", "north.md"), "# North\n");
    writeFileSync(path.join(rootDir, "surveys", "south.md"), "# South\n");
    writeFileSync(path.join(rootDir, "surveys", "east.md"), "# East\n");
    git(rootDir, "add", "surveys");
    git(rootDir, "commit", "-qm", "add attribute-bearing sources");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-consumer-attributes-center",
      now: () => "2026-09-09T20:00:00.000Z",
    });

    const created = await cell.run(
      { kind: "vertical-kind-upsert", kindId: surveyKind.id, expectedVersion: 0, declaration: surveyKind },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const surveyRef = (JSON.parse(String(created.evidence)) as { kindRef: string }).kindRef;

    const imported = await cell.run(
      {
        kind: "entity-import",
        entityKind: surveyRef,
        locator: "surveys/north.md",
        expectedVersion: 0,
        attributes: { region: "north" },
      },
      binding,
    );
    assert.equal(imported.outcome, "applied", JSON.stringify(imported));
    await waitForFixturePublication(cell, imported.opId, binding);
    const entityId = String(imported.entityId),
      descriptor = () =>
        JSON.parse(
          readFileSync(path.join(rootDir, "harness", "entities", "consumer-surveys", `${entityId}.json`), "utf8"),
        ) as { readonly kindVersion: number; readonly attributes: Record<string, unknown>; readonly title: string };
    assert.deepEqual(descriptor().attributes, { region: "north" });
    assert.equal(descriptor().kindVersion, 1);

    // A required attribute the caller never stated, and one the Kind never declared: both refused at the action.
    const missing = await cell.run(
      { kind: "entity-import", entityKind: surveyRef, locator: "surveys/south.md", expectedVersion: 0 },
      binding,
    );
    assert.equal(missing.outcome, "op_rejected", JSON.stringify(missing));
    const undeclared = await cell.run(
      {
        kind: "entity-import",
        entityKind: surveyRef,
        locator: "surveys/south.md",
        expectedVersion: 0,
        attributes: { region: "south", district: "coastal" },
      },
      binding,
    );
    assert.equal(undeclared.outcome, "op_rejected", JSON.stringify(undeclared));
    const wrongType = await cell.run(
      {
        kind: "entity-import",
        entityKind: surveyRef,
        locator: "surveys/south.md",
        expectedVersion: 0,
        attributes: { region: 5 },
      },
      binding,
    );
    assert.equal(wrongType.outcome, "op_rejected", JSON.stringify(wrongType));

    // Publishing version 2 adds a required attribute. The instance accepted against version 1 keeps version 1.
    const published = await cell.run(
      {
        kind: "vertical-kind-publish-schema",
        kindId: surveyKind.id,
        expectedVersion: created.revision,
        attributes: { region: { type: "string", required: true }, fiscalYear: { type: "integer", required: true } },
      },
      binding,
    );
    assert.equal(published.outcome, "applied", JSON.stringify(published));

    const renamed = await cell.run(
      {
        kind: "entity-update",
        entityKind: surveyRef,
        entityId,
        expectedVersion: imported.revision,
        title: "North survey, restated",
      },
      binding,
    );
    assert.equal(renamed.outcome, "applied", JSON.stringify(renamed));
    await waitForFixturePublication(cell, renamed.opId, binding);
    assert.equal(descriptor().kindVersion, 1, "an instance keeps the schema version it was accepted against");
    assert.equal(descriptor().title, "North survey, restated");
    assert.deepEqual(
      descriptor().attributes,
      { region: "north" },
      "an update that states no attributes restates the values the entity already holds",
    );

    // A new instance pins version 2, so version 2's required attribute is the one it has to satisfy.
    const underV1Only = await cell.run(
      {
        kind: "entity-import",
        entityKind: surveyRef,
        locator: "surveys/east.md",
        expectedVersion: 0,
        attributes: { region: "east" },
      },
      binding,
    );
    assert.equal(underV1Only.outcome, "op_rejected", JSON.stringify(underV1Only));
    const underV2 = await cell.run(
      {
        kind: "entity-import",
        entityKind: surveyRef,
        locator: "surveys/east.md",
        expectedVersion: 0,
        attributes: { region: "east", fiscalYear: 2026 },
      },
      binding,
    );
    assert.equal(underV2.outcome, "applied", JSON.stringify(underV2));
    await waitForFixturePublication(cell, underV2.opId, binding);
    const second = JSON.parse(
      readFileSync(
        path.join(rootDir, "harness", "entities", "consumer-surveys", `${String(underV2.entityId)}.json`),
        "utf8",
      ),
    ) as { readonly kindVersion: number; readonly attributes: Record<string, unknown> };
    assert.equal(second.kindVersion, 2);
    assert.deepEqual(second.attributes, { region: "east", fiscalYear: 2026 });
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/** Gap 3: one source imported into two Kinds must be two intents, not one collided operation. */
test("the same source imported into a second Kind is a separate import intent", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-consumer-kind-")),
    repoId = workspaceId("entity-consumer-kind");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "shared"), { recursive: true });
    writeFileSync(path.join(rootDir, "shared", "note.md"), "# shared source\n");
    git(rootDir, "add", "shared");
    git(rootDir, "commit", "-qm", "add the one source both kinds observe");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-consumer-kind-center",
      now: () => "2026-09-09T18:00:00.000Z",
    });

    const declare = async (declaration: Record<string, unknown>) => {
      const created = await cell!.run(
        { kind: "vertical-kind-upsert", kindId: String(declaration.id), expectedVersion: 0, declaration },
        binding,
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      return (JSON.parse(String(created.evidence)) as { kindRef: string }).kindRef;
    };
    const surveyRef = await declare(surveyKind),
      dossierRef = await declare(dossierKind);

    const first = await cell.run(
      {
        kind: "entity-import",
        entityKind: surveyRef,
        locator: "shared/note.md",
        expectedVersion: 0,
        attributes: { region: "north" },
      },
      binding,
    );
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    await waitForFixturePublication(cell, first.opId, binding);

    const second = await cell.run(
      { kind: "entity-import", entityKind: dossierRef, locator: "shared/note.md", expectedVersion: 0 },
      binding,
    );
    assert.equal(
      second.outcome,
      "applied",
      `a second Kind observing the same source must mint its own instance: ${JSON.stringify(second)}`,
    );
    assert.notEqual(second.opId, first.opId, "two Kinds must not share one import operation");

    const firstId = String(first.entityId),
      secondId = String(second.entityId);
    assert.match(firstId, /^CSV-[a-f0-9]{32}$/u);
    assert.match(secondId, /^CDS-[a-f0-9]{32}$/u);

    // A retry inside the same Kind is still the same intent and replays the accepted outcome.
    const retry = await cell.run(
      {
        kind: "entity-import",
        entityKind: surveyRef,
        locator: "shared/note.md",
        expectedVersion: 0,
        attributes: { region: "north" },
      },
      binding,
    );
    assert.equal(retry.opId, first.opId, JSON.stringify(retry));
    assert.equal(retry.outcome, "no_changes", JSON.stringify(retry));
    assert.equal(String(retry.entityId), firstId, "a same-Kind retry must return the original instance");

    // Scoping the intent by Kind must not disturb the release/rebind rule: deleting one Kind's instance
    // releases that Kind's binding only, and re-importing there mints a new instance rather than replaying.
    const deleted = await cell.run(
      {
        kind: "entity-delete",
        entityKind: surveyRef,
        entityId: firstId,
        expectedVersion: first.revision,
        reason: "survey withdrawn",
      },
      binding,
    );
    assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));
    await waitForFixturePublication(cell, deleted.opId, binding);
    const reimported = await cell.run(
      {
        kind: "entity-import",
        entityKind: surveyRef,
        locator: "shared/note.md",
        expectedVersion: 0,
        attributes: { region: "north" },
      },
      binding,
    );
    assert.equal(reimported.outcome, "applied", JSON.stringify(reimported));
    assert.notEqual(String(reimported.entityId), firstId, "a released source must mint a new instance");
    assert.notEqual(reimported.opId, first.opId);
    assert.equal(
      String(second.entityId),
      secondId,
      "deleting one Kind's instance must not disturb another Kind's binding on the same source",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/** Gap 2: accepted owned content must be readable by entity identity, under a configured authored root. */
test("owned content is readable by entity identity after the source is gone", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-consumer-content-")),
    repoId = workspaceId("entity-consumer-content");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    // A configured authored root: nothing in the read path may assume `harness/`.
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "layout:\n  authoredRoot: ledger\n");
    mkdirSync(path.join(rootDir, "shared", "raw"), { recursive: true });
    mkdirSync(path.join(rootDir, "shared", "unfiled"), { recursive: true });
    writeFileSync(path.join(rootDir, "shared", "README.md"), "# dossier\n");
    writeFileSync(
      path.join(rootDir, "shared", "raw", "scan.pdf"),
      Buffer.concat([Buffer.from("%PDF-1.7\n%"), Buffer.from([0, 255, 10, 128, 1]), Buffer.from("\n%%EOF\n")]),
    );
    git(rootDir, "add", "harness", "shared");
    git(rootDir, "commit", "-qm", "add a source under a configured authored root");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-consumer-content-center",
      now: () => "2026-09-09T19:00:00.000Z",
    });

    const created = await cell.run(
      { kind: "vertical-kind-upsert", kindId: dossierKind.id, expectedVersion: 0, declaration: dossierKind },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const dossierRef = (JSON.parse(String(created.evidence)) as { kindRef: string }).kindRef;

    const imported = await cell.run(
      { kind: "entity-import", entityKind: dossierRef, locator: "shared", expectedVersion: 0 },
      binding,
    );
    assert.equal(imported.outcome, "applied", JSON.stringify(imported));
    await waitForFixturePublication(cell, imported.opId, binding);
    const entityId = String(imported.entityId);

    // The source is gone; the accepted bytes must stay readable.
    rmSync(path.join(rootDir, "shared"), { recursive: true });

    const root = (await cell.read("repo.entity.content.read", { entityKind: dossierRef, entityId }, binding)) as {
      readonly outcome: string;
      readonly entries: readonly { readonly path: string; readonly directory: boolean }[];
    };
    assert.equal(root.outcome, "directory", JSON.stringify(root));
    assert.deepEqual(
      root.entries.map(({ path: entry }) => entry).sort(),
      ["README.md", "raw", "unfiled"],
      "the declared empty directory is part of what the entity owns",
    );

    const readme = (await cell.read(
      "repo.entity.content.read",
      { entityKind: dossierRef, entityId, path: "README.md" },
      binding,
    )) as { readonly outcome: string; readonly content: string | null; readonly repositoryPath: string };
    assert.equal(readme.outcome, "file");
    assert.equal(readme.content, "# dossier\n");
    assert.equal(
      readme.repositoryPath,
      `ledger/entities/consumer-dossiers/${entityId}/README.md`,
      "the read must report the configured authored root, never a hardcoded one",
    );

    const scan = (await cell.read(
      "repo.entity.content.read",
      { entityKind: dossierRef, entityId, path: "raw/scan.pdf" },
      binding,
    )) as {
      readonly outcome: string;
      readonly sizeBytes: number | null;
      readonly mediaType: string | null;
      readonly content: string | null;
    };
    // Bytes the center never interpreted: the read states what it holds and how long it is, and hands the
    // renderer no text it would have to guess at.
    assert.equal(scan.outcome, "binary");
    assert.equal(scan.content, null);
    assert.equal(scan.sizeBytes, 22);
    assert.equal(scan.mediaType, "application/octet-stream");

    // The read addresses owned content and nothing else: a path that climbs out of the entity is refused
    // outright rather than becoming a door onto arbitrary repository files.
    await assert.rejects(
      () => cell!.read("repo.entity.content.read", { entityKind: dossierRef, entityId, path: "../../.." }, binding),
      /must stay inside/u,
    );
    // A path that stays inside but names nothing the entity owns is simply absent.
    const absent = (await cell.read(
      "repo.entity.content.read",
      { entityKind: dossierRef, entityId, path: "raw/never-imported.txt" },
      binding,
    )) as { readonly outcome: string; readonly content: string | null };
    assert.equal(absent.outcome, "missing", JSON.stringify(absent));
    assert.equal(absent.content, null);

    // A retired entity owns nothing, and the read says so instead of showing bytes it no longer holds.
    const removed = await cell.run(
      {
        kind: "entity-delete",
        entityKind: dossierRef,
        entityId,
        expectedVersion: imported.revision,
        reason: "dossier withdrawn",
      },
      binding,
    );
    assert.equal(removed.outcome, "applied", JSON.stringify(removed));
    await waitForFixturePublication(cell, removed.opId, binding);
    const afterDelete = (await cell.read(
      "repo.entity.content.read",
      { entityKind: dossierRef, entityId, path: "README.md" },
      binding,
    )) as { readonly outcome: string };
    assert.equal(afterDelete.outcome, "missing", JSON.stringify(afterDelete));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function git(rootDir: string, ...args: readonly string[]): void {
  execFileSync("git", ["-C", rootDir, ...args], { stdio: "pipe" });
}

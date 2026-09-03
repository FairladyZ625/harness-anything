// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { evidence, git, initRepo } from "./task-surface.fixtures.ts";

const owner = {
    actor: {
      principal: { personId: "person-squad-migration" },
      executor: { kind: "agent" as const, id: "squad-migration-worker" },
    },
    source: "local" as const,
  },
  leader = {
    schema: "agent-declaration/v1",
    id: "migration-leader",
    name: "Migration Leader",
    instructions: "Coordinate the migration fixture workers.",
    runtime_type: "codex",
  },
  worker = {
    schema: "agent-declaration/v1",
    id: "migration-worker",
    name: "Migration Worker",
    instructions: "Complete one migration fixture assignment.",
    runtime_type: "codex",
  },
  squadIds = ["ci-triage-squad", "debug-squad", "gui-squad", "ledger-squad", "ontology-squad"] as const;

test("five legacy Squad declarations dry-run, install, and surface through canonical CLI and GUI reads", async () => {
  const rootDir = workspace("five"),
    repoId = workspaceId("squad-entity-migration-five"),
    declarations = squadIds.map((id, index) => squad(id, index + 4)),
    sources = declarations.map((declaration) => writeLegacySquad(rootDir, declaration));
  git(rootDir, "add", "harness/squads");
  git(rootDir, "commit", "-qm", "seed legacy Squad declarations");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "squad-entity-migration-five" });
    for (const declaration of [leader, worker])
      assert.equal((await cell.run({ kind: "agent-install", declaration }, owner)).outcome, "applied");

    assert.deepEqual((evidence(await cell.run({ kind: "squad-list" }, owner)).squads as unknown[]).length, 0);
    const revisionBefore = makeTaskEventStore({ repoId, rootDir, mutable: false }).read().revision,
      preview = await cell.run({ kind: "entity-migrate-squads", sourcePaths: sources, dryRun: true }, owner),
      previewReport = evidence(preview) as unknown as MigrationReport;
    assert.equal(preview.outcome, "pending", JSON.stringify(preview));
    assert.equal(previewReport.mode, "dry-run");
    assert.deepEqual(previewReport.packageShape, { manifest: "squad.json", schema: "squad-declaration/v1" });
    assert.deepEqual(previewReport.summary, {
      requested: 5,
      installs: 5,
      replacements: 0,
      alreadyInstalled: 0,
    });
    assert.equal(
      makeTaskEventStore({ repoId, rootDir, mutable: false }).read().revision,
      revisionBefore,
      "dry-run must not append Squad entity events",
    );

    const applied = await cell.run({ kind: "entity-migrate-squads", sourcePaths: sources }, owner),
      appliedReport = evidence(applied) as unknown as MigrationReport;
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    assert.equal(appliedReport.mode, "apply");
    assert.deepEqual(
      appliedReport.squads.map(({ entityId, result }) => ({ entityId, result })),
      declarations.map(({ id }) => ({ entityId: id, result: "installed" })),
    );

    const listed = evidence(await cell.run({ kind: "squad-list" }, owner)).squads as Array<{
        id: string;
        leader: string;
        workers: string[];
      }>,
      generic = evidence(await cell.run({ kind: "entity-list", entityKind: "squad" }, owner)).entities as Array<{
        id: string;
        value: Record<string, unknown>;
      }>,
      gui = await cell.read("repo.squad.entities.list", {}, owner),
      detail = await cell.read("repo.squad.entity.read", { squadId: "ledger-squad" }, owner);
    assert.deepEqual(
      listed.map(({ id }) => id),
      [...squadIds].sort(),
    );
    assert.deepEqual(
      generic.map(({ id }) => id),
      [...squadIds].sort(),
    );
    assert.deepEqual(
      generic.map(({ value }) => value),
      [...declarations].sort((left, right) => left.id.localeCompare(right.id)),
    );
    assert.deepEqual(
      gui.squads.map(({ id }) => id),
      [...squadIds].sort(),
    );
    const { schema: _schema, ...ledgerSquad } = declarations.find(({ id }) => id === "ledger-squad")!;
    assert.deepEqual(detail.squad, ledgerSquad);
    for (const declaration of declarations)
      assert.equal(
        readFileSync(path.join(rootDir, `harness/squads/${declaration.id}.json`), "utf8"),
        `${JSON.stringify(declaration, null, 2)}\n`,
      );

    const revisionAfter = makeTaskEventStore({ repoId, rootDir, mutable: false }).read().revision,
      repeated = await cell.run({ kind: "entity-migrate-squads", sourcePaths: sources }, owner),
      repeatedReport = evidence(repeated) as unknown as MigrationReport;
    assert.equal(repeated.outcome, "applied", JSON.stringify(repeated));
    assert.equal(repeatedReport.summary.alreadyInstalled, 5);
    assert.equal(makeTaskEventStore({ repoId, rootDir, mutable: false }).read().revision, revisionAfter);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Squad migration rejects a declaration missing leader before appending any entity event", async () => {
  const rootDir = workspace("missing-leader"),
    repoId = workspaceId("squad-entity-migration-missing-leader"),
    declaration = squad("invalid-squad", 4),
    { leader: _leader, ...missingLeader } = declaration,
    source = writeLegacySquad(rootDir, missingLeader);
  git(rootDir, "add", "harness/squads");
  git(rootDir, "commit", "-qm", "seed invalid legacy Squad declaration");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "squad-entity-migration-missing-leader",
    });
    const before = makeTaskEventStore({ repoId, rootDir, mutable: false }).read().revision,
      rejected = await cell.run({ kind: "entity-migrate-squads", sourcePaths: [source] }, owner);
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "invalid_manifest");
    assert.match(String(rejected.nextAction), /missing required field "leader"/u);
    assert.equal(makeTaskEventStore({ repoId, rootDir, mutable: false }).read().revision, before);
    assert.deepEqual(
      evidence(await cell.run({ kind: "entity-list", entityKind: "squad" }, owner)).entities as unknown[],
      [],
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

interface MigrationReport {
  readonly mode: "dry-run" | "apply";
  readonly packageShape: { readonly manifest: string; readonly schema: string };
  readonly summary: {
    readonly requested: number;
    readonly installs: number;
    readonly replacements: number;
    readonly alreadyInstalled: number;
  };
  readonly squads: readonly { readonly entityId: string; readonly result: string }[];
}

function squad(id: string, leaderTurnBudget: number) {
  return {
    schema: "squad-declaration/v1",
    id,
    name: `${id} migration fixture`,
    leader: leader.id,
    workers: [worker.id],
    leaderTurnBudget,
    roster: `${id}: migration-worker handles the bounded fixture.\n\nSummary -> artifacts/reports/{squadRunId}.md`,
  };
}

function writeLegacySquad(rootDir: string, declaration: { readonly id: string }): string {
  const directory = path.join(rootDir, "harness", "squads"),
    relative = `harness/squads/${declaration.id}.json`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(rootDir, relative), `${JSON.stringify(declaration, null, 2)}\n`);
  return relative;
}

function workspace(name: string): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-squad-entity-migration-${name}-`));
  initRepo(rootDir);
  return rootDir;
}

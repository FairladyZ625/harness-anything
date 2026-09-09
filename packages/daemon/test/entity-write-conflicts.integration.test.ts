// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, openSqliteEventStore } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { connectSocket, JsonRpcLineClient } from "../src/client/local-json-rpc-client.ts";
import { fatalCellError } from "../src/repo-cell-errors.ts";
import { ArtifactEntityServiceError } from "../../application/src/artifact-entity-service.ts";
import { startDaemon, type RunningDaemon } from "../src/runtime.ts";
import {
  openBootstrappedRepoCell,
  registerSettledBootstrappedDaemonRepo,
  waitForFixturePublication,
} from "./repo-settings.fixture.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";

const binding = withRoleBinding(
  {
    actor: { principal: { personId: "writer" }, executor: null },
    source: "local" as const,
  },
  "repo-write",
);
const declaration = {
  id: "conflict-note",
  entityType: "artifact",
  idPrefix: "CFN",
  display: { singular: "Conflict Note", plural: "Conflict Notes" },
  descriptorSchemaRef: "schema://artifact-descriptor",
  store: { pathTemplate: "entities/conflict-notes/{id}.json" },
  locatorKinds: ["repository-path"],
  attributes: { region: { type: "string" }, checked: { type: "boolean" } },
};

test("two edges at the same entity fence distinguish new intent from an exact retry", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-conflicts-")),
    repoId = workspaceId("entity-conflicts");
  initRepo(rootDir);
  writeFileSync(path.join(rootDir, "source.md"), "accepted bytes\n");
  let cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "center" });
  try {
    const kind = await cell.run(
      { kind: "vertical-kind-upsert", kindId: declaration.id, expectedVersion: 0, declaration },
      binding,
    );
    assert.equal(kind.outcome, "applied", JSON.stringify(kind));
    const entityKind = JSON.parse(String(kind.evidence)).kindRef as string;
    const imported = await cell.run(
      { kind: "entity-import", entityKind, locator: "source.md", expectedVersion: 0 },
      binding,
    );
    assert.equal(imported.outcome, "applied", JSON.stringify(imported));
    const entityId = String(imported.entityId),
      update = {
        kind: "entity-update",
        entityKind,
        entityId,
        expectedVersion: imported.revision,
        title: "edge one",
        attributes: { region: "north", checked: true },
      };
    const [winner, loser] = await Promise.all([
      cell.run(update, binding),
      cell.run({ ...update, title: "edge two" }, binding),
    ]);
    t.diagnostic(JSON.stringify({ winner, loser }));
    assert.equal(winner.outcome, "applied", JSON.stringify(winner));
    assert.equal(loser.code, "revision_conflict", JSON.stringify(loser));
    assert.equal(loser.outcome, "op_rejected");
    assert.equal(cell.status().state, "attached");
    const retry = await cell.run({ ...update, attributes: { checked: true, region: "north" } }, binding);
    assert.equal(retry.opId, winner.opId);
    assert.equal(retry.outcome, "no_changes", JSON.stringify(retry));
    for (const changed of [
      { attributes: { region: "south", checked: true } },
      { locator: "elsewhere.md" },
      { contentVersion: "sha256:" + "b".repeat(64) },
    ]) {
      const rejected = await cell.run({ ...update, ...changed }, binding);
      assert.equal(rejected.code, "revision_conflict", JSON.stringify(rejected));
    }
    await waitForFixturePublication(cell, winner.opId, binding);
    const descriptorPath = `harness/entities/conflict-notes/${entityId}.json`;
    assert.equal(JSON.parse(readFileSync(path.join(rootDir, descriptorPath), "utf8")).title, "edge one");
    assert.equal(JSON.parse(git(rootDir, "show", `HEAD:${descriptorPath}`)).title, "edge one");
    rmSync(path.join(rootDir, "source.md"));
    await cell.close();
    cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "recovered-center" });
    assert.equal((await cell.run(update, binding)).opId, winner.opId);
    const content = await cell.read("repo.entity.content.read", { entityKind, entityId, path: "source.md" }, binding);
    assert.equal(content.content, "accepted bytes\n");
    const events = makeTaskEventReader({ repoId, rootDir }).read().events;
    assert.equal(events.filter((event) => event.type === "entity_updated").length, 1);
    const archive = {
      kind: "entity-archive",
      entityKind,
      entityId,
      expectedVersion: winner.revision,
      reason: "retire accepted note",
    };
    const archived = await cell.run(archive, binding);
    assert.equal(archived.outcome, "applied", JSON.stringify(archived));
    assert.equal((await cell.run(archive, binding)).opId, archived.opId);
    const changedReason = await cell.run({ ...archive, reason: "different retirement intent" }, binding);
    assert.equal(changedReason.code, "revision_conflict", JSON.stringify(changedReason));
    const deletion = {
      kind: "entity-delete",
      entityKind,
      entityId,
      expectedVersion: archived.revision,
      reason: "delete accepted note",
    };
    const deleted = await cell.run(deletion, binding);
    assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));
    const deleteRetry = await cell.run(deletion, binding);
    assert.equal(deleteRetry.outcome, "no_changes", JSON.stringify(deleteRetry));
    assert.equal(deleteRetry.opId, deleted.opId);
    await cell.close();
    cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "deleted-recovery" });
    assert.equal((await cell.run(deletion, binding)).opId, deleted.opId);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("JSON-RPC returns domain conflicts during concurrent reads without recovering the writer", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-entity-conflict-rpc-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "entity-conflict-rpc";
  mkdirSync(rootDir);
  initRepo(rootDir);
  mkdirSync(path.join(rootDir, "harness"));
  writeFileSync(path.join(rootDir, "source.md"), "RPC accepted bytes\n");
  writeFileSync(
    path.join(rootDir, "harness/people.yaml"),
    JSON.stringify({
      schema: "harness-people/v1",
      people: [
        {
          personId: "writer",
          displayName: "Writer",
          roles: ["writer"],
          credentials: [
            {
              kind: "unix-socket-owner-boundary",
              issuer: `host:${hostname()}`,
              subject: String(process.getuid?.() ?? 0),
            },
          ],
        },
      ],
      roles: [{ roleId: "writer", commandClasses: ["repo-read", "repo-write", "admin"] }],
    }),
  );
  const prepared = await openBootstrappedRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(rootDir),
    ownerId: "prepare-rpc",
  });
  await prepared.close();
  await registerSettledBootstrappedDaemonRepo({
    canonicalRoot: rootDir,
    repoId,
    userRoot,
    createConvenienceLinks: false,
  });
  let daemon: RunningDaemon | undefined, client: JsonRpcLineClient | undefined;
  try {
    const started = await startDaemon({ daemonId: repoId, userRoot });
    assert.ok(!("pid" in started));
    daemon = started;
    const socket = await connectSocket(daemon.endpoint, 2000);
    client = new JsonRpcLineClient(socket, socket);
    const rpc = client;
    await rpc.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion });
    const run = (action: Record<string, unknown>) => {
      const { kind, ...payload } = action;
      return rpc.request(kind === "vertical-kind-upsert" ? "repo.vertical.kind.upsert" : "repo.entity.import", {
        repo: { repoId },
        payload,
      } as Parameters<typeof rpc.request>[1]);
    };
    const kind = await run({ kind: "vertical-kind-upsert", kindId: declaration.id, expectedVersion: 0, declaration });
    assert.equal(kind.outcome, "applied", JSON.stringify(kind));
    const entityKind = JSON.parse(String(kind.evidence)).kindRef as string;
    const imported = await run({ kind: "entity-import", entityKind, locator: "source.md", expectedVersion: 0 });
    assert.equal(imported.outcome, "applied", JSON.stringify(imported));
    const importRetry = await run({ kind: "entity-import", entityKind, locator: "source.md", expectedVersion: 0 });
    assert.equal(importRetry.outcome, "no_changes", JSON.stringify(importRetry));
    assert.equal(importRetry.entityId, imported.entityId);
    assert.equal(importRetry.opId, imported.opId);
    const acceptedPayload = {
      entityKind,
      entityId: String(imported.entityId),
      expectedVersion: Number(imported.revision),
      title: "RPC winner",
    };
    const winner = await rpc.request("repo.entity.update", { repo: { repoId }, payload: acceptedPayload });
    assert.equal(winner.outcome, "applied", JSON.stringify(winner));
    const retry = await rpc.request("repo.entity.update", { repo: { repoId }, payload: acceptedPayload });
    assert.equal(retry.outcome, "no_changes", JSON.stringify(retry));
    assert.equal(retry.opId, winner.opId);
    const payload = { ...acceptedPayload, title: "RPC competing draft" };
    const before = await rpc.request("daemon.status", {});
    // First the single-client observation, then the same socket with the GUI's concurrent read shape.
    const direct = await rpc.request("repo.entity.update", { repo: { repoId }, payload });
    t.diagnostic(`direct=${JSON.stringify(direct)}`);
    assert.equal(direct.code, "revision_conflict");
    const results = await Promise.allSettled([
      rpc.request("repo.entity.update", { repo: { repoId }, payload }),
      ...Array.from({ length: 8 }, () =>
        rpc.request("repo.entity.content.read", {
          repo: { repoId },
          payload: { entityKind, entityId: payload.entityId, path: "source.md" },
        }),
      ),
    ]);
    t.diagnostic(`concurrent=${JSON.stringify(results)}`);
    for (const result of results) assert.equal(result.status, "fulfilled", JSON.stringify(result));
    const conflict = (results[0] as PromiseFulfilledResult<Record<string, unknown>>).value;
    assert.equal(conflict.code, "revision_conflict");
    for (const result of results.slice(1)) {
      assert.equal((result as PromiseFulfilledResult<Record<string, unknown>>).value.content, "RPC accepted bytes\n");
    }
    const after = await rpc.request("daemon.status", {});
    t.diagnostic(`status before=${JSON.stringify(before.repos)} after=${JSON.stringify(after.repos)}`);
    const rows = after.repos as { state: string; generation: number }[];
    assert.equal(rows[0]?.state, "attached");
    assert.equal(rows[0]?.generation, (before.repos as { generation: number }[])[0]?.generation);
    const subsequent = await rpc.request("repo.entity.content.read", {
      repo: { repoId },
      payload: { entityKind, entityId: payload.entityId, path: "source.md" },
    });
    assert.equal(subsequent.content, "RPC accepted bytes\n");
    const queried = await rpc.request("repo.entity.rows.read", { repo: { repoId } });
    const entity = (queried.rows as { entityId: string; title: string; revision: number }[]).find(
      (row) => row.entityId === payload.entityId,
    );
    assert.equal(entity?.title, "RPC winner");
    assert.equal(entity?.revision, winner.revision);
  } finally {
    client?.close();
    await daemon?.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("real SQLite writer divergence remains fatal while rejected entity CAS is recoverable", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-conflict-storage-")),
    store = openSqliteEventStore({ repoId: "storage-conflict", databasePath: path.join(root, "ledger.sqlite") });
  try {
    store.claimWriter({ repoId: "storage-conflict", holder: "current", epoch: 2 });
    assert.throws(
      () => store.claimWriter({ repoId: "storage-conflict", holder: "stale", epoch: 1 }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "revision_conflict" && fatalCellError(error),
    );
    assert.equal(fatalCellError(new ArtifactEntityServiceError("revision_conflict", "stale entity revision")), false);
    assert.equal(
      fatalCellError(Object.assign(new Error("unclassified revision divergence"), { code: "revision_conflict" })),
      true,
    );
    assert.equal(
      fatalCellError(Object.assign(new Error("unreadable canonical store"), { code: "invalid_store" })),
      true,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

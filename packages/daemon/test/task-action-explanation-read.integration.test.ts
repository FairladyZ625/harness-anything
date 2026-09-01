// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection } from "../../kernel/src/index.ts";
import { canonicalRoot, validateDaemonRpcCall, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./task-surface.fixtures.ts";

const method = "repo.entity.actions.explain" as const,
  requestSchema = "entity-action-explain-request/v1" as const,
  fixedNow = "2026-08-31T01:00:00.000Z";

test("typed Entity Action read preserves one cut for 1..500 refs and has no write side effects", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-action-explain-")),
    repoId = workspaceId("action-explain"),
    binding = { actor, source: "local" as const };
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "action-explain-local",
      now: () => fixedNow,
    });
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task-explain", title: "Explain typed daemon read" }, binding))
        .outcome,
      "applied",
    );
    await cell.read("repo.tasks.list");

    const observerStore = makeTaskEventStore({ repoId, rootDir }),
      observerProjection = makeTaskProjection({ rootDir, eventStore: observerStore, now: () => fixedNow }),
      beforeStream = observerStore.read(),
      beforeHead = observerStore.readHead(),
      beforeLease = observerProjection.currentLease("task-explain", fixedNow),
      beforeDigest = observerProjection.readStateDigest(),
      beforeStatus = cell.status(),
      beforeWorktree = git(rootDir, "status", "--porcelain=v1"),
      one = await cell.read(
        method,
        { schema: requestSchema, mode: "object", entityKind: null, refs: ["task/task-explain"] },
        binding,
      ),
      fiveHundred = await cell.read(
        method,
        {
          schema: requestSchema,
          mode: "object",
          entityKind: null,
          refs: Array.from({ length: 500 }, () => "task/task-explain"),
        },
        binding,
      );
    assert.equal(one.schema, "entity-action-explanation/v1");
    assert.equal(one.mode, "object");
    assert.equal(fiveHundred.subjects.length, 500);
    assert.equal(fiveHundred.evaluatedAtCut, one.evaluatedAtCut);
    assert.equal(
      new Set(fiveHundred.subjects.flatMap(({ actions }) => actions.map(({ evaluatedAtCut }) => evaluatedAtCut))).size,
      1,
    );
    assert.equal(one.subjects[0]!.actions.length, 11);
    assert.deepEqual(one.subjects[0]!.actions[0]!.authorizationDecision?.actor, actor);
    assert.doesNotThrow(() => parseDaemonGuiReadResult(method, fiveHundred));

    const failures = await cell.read(
      method,
      {
        schema: requestSchema,
        mode: "object",
        entityKind: null,
        refs: ["not-a-ref", "task/task-missing", "fact/F-ABCDEFGH", "other:task/task-explain"],
      },
      binding,
    );
    assert.equal(failures.mode, "failure");
    assert.deepEqual(
      failures.subjects.map(({ failure }) => failure?.code),
      ["invalid_entity_ref", "entity_not_found", "unsupported_explain_target", "unsupported_explain_target"],
    );
    assert.equal(failures.subjects[0]!.kind, null);
    assert.equal(failures.evaluatedAtCut, one.evaluatedAtCut);

    const catalog = await cell.read(
      method,
      { schema: requestSchema, mode: "catalog", entityKind: "task", refs: [] },
      binding,
    );
    assert.equal(catalog.evaluatedAtCut, null);
    assert.equal(
      catalog.subjects[0]!.actions.every(({ available }) => available === null),
      true,
    );
    assert.equal(
      catalog.subjects[0]!.actions.every(({ criteria }) => criteria.every(({ status }) => status === "not-evaluated")),
      true,
    );

    assert.deepEqual(observerStore.read(), beforeStream);
    assert.deepEqual(observerStore.readHead(), beforeHead);
    assert.deepEqual(observerProjection.currentLease("task-explain", fixedNow), beforeLease);
    assert.equal(observerProjection.readStateDigest(), beforeDigest);
    assert.equal(cell.status().queueDepth, beforeStatus.queueDepth);
    assert.equal(git(rootDir, "status", "--porcelain=v1"), beforeWorktree);
    observerProjection.close();

    await cell.close();
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "action-explain-edge",
      mode: "remote-edge",
      now: () => fixedNow,
    });
    const edgeFirst = await cell.read(
        method,
        { schema: requestSchema, mode: "object", entityKind: null, refs: ["task/task-explain"] },
        binding,
      ),
      edgeSecond = await cell.read(
        method,
        { schema: requestSchema, mode: "object", entityKind: null, refs: ["task/task-explain"] },
        binding,
      );
    assert.equal(edgeFirst.subjects[0]!.actions[0]!.available, edgeSecond.subjects[0]!.actions[0]!.available);
    assert.equal(edgeFirst.evaluatedAtCut, edgeSecond.evaluatedAtCut);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("RPC contract rejects actor and cut overrides at the wire shape", () => {
  const params = {
    repo: { repoId: "action-explain" },
    payload: { schema: requestSchema, mode: "object", entityKind: null, refs: ["task/task-explain"] },
  } as const;
  assert.deepEqual(validateDaemonRpcCall({ method, params }), []);
  assert.match(
    validateDaemonRpcCall({
      method,
      params: { ...params, payload: { ...params.payload, actor } },
    }).join("\n"),
    /unknown field/u,
  );
  assert.match(
    validateDaemonRpcCall({
      method,
      params: { ...params, payload: { ...params.payload, cut: "canonical:1" } },
    }).join("\n"),
    /unknown field/u,
  );
});

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  actionDeclarations,
  compileEntityDocumentRematerialization,
  compileRelationCreatedEvent,
  relationEventWritePlan,
  resolveHarnessLayout,
  taskLifecycleWritePlan,
} from "@harness-anything/kernel";
import { makeTaskEventStore, makeTaskProjection } from "@harness-anything/storage";
import { taskCreated, relation } from "../../storage/test/store/relation-graph-projection.fixtures.ts";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";

const actor = { principal: { personId: "person-one" }, executor: null } as const;

async function fixture(t: TestContext) {
  const plans = new Map<string, string>();
  const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true, {}, async (rootDir) => {
    const store = makeTaskEventStore({ rootDir, repoId: "lease-repo" }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    try {
      projection.catchUp();
      for (const [taskId, status] of [
        ["task_done_mirror", "done"],
        ["task_active_mirror", "planned"],
        ["task_held_mirror", "done"],
      ] as const) {
        const base = taskCreated(store.currentCut().revision + 1, taskId),
          event = {
            ...base,
            payload: { ...base.payload, task: { ...base.payload.task, status, packageDisposition: "active" as const } },
          },
          plan = taskLifecycleWritePlan(event);
        store.append({ event, plan, blobs: [] });
        projection.apply(event, plan);
        const logical = `${projection.read(taskId).packagePath!}/task_plan.md`;
        plans.set(taskId, logical);
        const docs = compileEntityDocumentRematerialization({
          actor,
          source: "local",
          occurredAt: "2026-11-15T00:00:00.000Z",
          opId: `docs-${taskId}`,
          workspaceRevision: store.currentCut().revision + 1,
          entityRefs: [`task/${taskId}`],
          rationale: "mirror fixture",
          updates: [
            {
              path: logical,
              body: realizedTaskPlan(taskId),
              mediaType: "text/markdown",
              policyId: "markdown-body-replaceable/v1",
            },
          ],
        });
        store.append(docs);
        projection.apply(docs.event, docs.plan);
      }
      const { strength: _strength, ...record } = relation({
          source: "task/task_active_mirror",
          target: "task/task_held_mirror",
          type: "depends-on",
        }),
        event = compileRelationCreatedEvent({
          record: { ...record, targetObservedVersion: null },
          actor,
          source: "local",
          occurredAt: "2026-11-15T00:00:00.000Z",
          opId: "mirror-held",
          workspaceRevision: store.currentCut().revision + 1,
        }),
        plan = relationEventWritePlan(event);
      store.append({ event, plan, blobs: [] });
      projection.apply(event, plan);
      store.materialize();
    } finally {
      projection.close();
      await store.drain();
    }
  });
  const edge = async (nodeId: "node-one" | "node-two") => {
    const viewRoot = path.join(f.root, nodeId);
    await catchUpReplica({ ...f.peer(nodeId), viewRoot, diskQuotaBytes: 64 * 1024 * 1024 });
    const e = await fleetEdgeHostFixture(t, f, { viewRoot, nodeId, name: nodeId });
    const file = (taskId: string) => path.join(resolveHarnessLayout(e.edgeRoot).authoredRoot, plans.get(taskId)!);
    return { ...e, file };
  };
  return { f, edge, plans };
}

test(
  "real replica mirrors reconcile node policy and subsequent pulls preserve that policy and other nodes",
  { timeout: 180_000 },
  async (t) => {
    const { f, edge } = await fixture(t),
      one = await edge("node-one"),
      two = await edge("node-two");
    for (const e of [one, two])
      assert.equal(
        (await e.command({ kind: "settings-update", taskMaterializationPolicy: "include_done" })).outcome,
        "applied",
      );
    const done = one.file("task_done_mirror"),
      initialCenterYaml = readFileSync(path.join(f.repo, "harness/harness.yaml"), "utf8"),
      twoSettings = readFileSync(resolveHarnessLayout(two.edgeRoot).settingsLocalPath, "utf8"),
      initialRevision = f.eventCount();
    assert.ok(existsSync(done));
    assert.ok(existsSync(two.file("task_done_mirror")));
    assert.equal(
      (await one.command({ kind: "settings-update", taskMaterializationPolicy: "in_flight" })).outcome,
      "applied",
    );
    assert.equal(existsSync(done), false, "unheld done files must be withdrawn from the actual mirror");
    assert.equal(existsSync(path.dirname(done)), false, "an empty managed done package is withdrawn");
    assert.ok(existsSync(one.file("task_active_mirror")));
    assert.ok(existsSync(one.file("task_held_mirror")));
    assert.equal(f.eventCount(), initialRevision, "policy changes must not append center events");
    assert.equal(readFileSync(path.join(f.repo, "harness/harness.yaml"), "utf8"), initialCenterYaml);
    // An unrelated center settings event advances the live stream without creating another
    // connection for this node. Node policy must hold on both that callback and a full pull.
    const added = await f.command("node-one", { kind: "settings-update", reviewReturnBudget: 3 });
    assert.equal(added.outcome, "applied", JSON.stringify(added));
    await f.host.settleMaterialization("lease-repo", "fixture center advance");
    const revision = f.eventCount(),
      nextView = one.viewRoot,
      centerYaml = readFileSync(path.join(f.repo, "harness/harness.yaml"), "utf8");
    await catchUpReplica({ ...f.peer("node-one"), viewRoot: nextView, diskQuotaBytes: 64 * 1024 * 1024 });
    applyFleetMirrorCut(nextView, "lease-repo", one.edgeRoot, "pull");
    assert.equal(existsSync(done), false, "a later full replica pull must not restore skipped done files");
    assert.equal(
      (await one.command({ kind: "settings-update", taskMaterializationPolicy: "include_done" })).outcome,
      "applied",
    );
    assert.ok(existsSync(done));
    const unowned = path.join(path.dirname(done), "personal-notes.txt");
    writeFileSync(unowned, "Keep this local file\n");
    assert.equal(
      (await one.command({ kind: "settings-update", taskMaterializationPolicy: "in_flight" })).outcome,
      "applied",
    );
    assert.equal(existsSync(done), false);
    assert.equal(readFileSync(unowned, "utf8"), "Keep this local file\n");
    assert.equal(
      (await one.command({ kind: "settings-update", taskMaterializationPolicy: "include_done" })).outcome,
      "applied",
    );
    unlinkSync(unowned);
    const original = readFileSync(done, "utf8");
    writeFileSync(done, original + "\nLocal edit\n");
    const pending = await one.command({ kind: "settings-update", taskMaterializationPolicy: "none" });
    assert.equal(pending.outcome, "pending");
    assert.match(JSON.stringify(pending.warnings), /task_done_mirror/u);
    assert.equal(readFileSync(done, "utf8"), original + "\nLocal edit\n");
    writeFileSync(done, original);
    assert.equal(
      (await one.command({ kind: "settings-update", taskMaterializationPolicy: "none" })).outcome,
      "no_changes",
    );
    assert.equal(existsSync(done), false);
    assert.equal(existsSync(path.dirname(done)), false);
    assert.ok(existsSync(one.file("task_active_mirror")));
    assert.ok(existsSync(one.file("task_held_mirror")));
    applyFleetMirrorCut(nextView, "lease-repo", one.edgeRoot, "pull");
    assert.equal(existsSync(done), false);
    assert.equal(f.eventCount(), revision, "node filtering must not append canonical retirements or settings");
    assert.equal(readFileSync(path.join(f.repo, "harness/harness.yaml"), "utf8"), centerYaml);
    assert.equal(readFileSync(resolveHarnessLayout(two.edgeRoot).settingsLocalPath, "utf8"), twoSettings);
    assert.ok(existsSync(two.file("task_done_mirror")));
  },
);

test(
  "the real edge GUI materialize route uses replica bytes, preserves edits and reauthorizes viewer refusal",
  { timeout: 180_000 },
  async (t) => {
    const { f, edge } = await fixture(t),
      e = await edge("node-one"),
      done = e.file("task_done_mirror");
    await e.command({ kind: "settings-update", taskMaterializationPolicy: "none" });
    if (existsSync(done)) unlinkSync(done);
    const skipped = await e.command({ kind: "task-show", taskId: "task_done_mirror" });
    assert.equal(JSON.parse(String(skipped.evidence)).materializationState, "skipped_by_node_policy");
    const active = e.file("task_active_mirror");
    if (existsSync(active)) unlinkSync(active);
    const marker = path.join(resolveHarnessLayout(e.edgeRoot).localRoot, "fleet-materialized.json");
    if (existsSync(marker)) unlinkSync(marker);
    mkdirSync(path.dirname(done), { recursive: true });
    writeFileSync(done, "Unowned local notes\n");
    const initialConflict = await e.command({ kind: "doc-materialize", taskId: "task_done_mirror", paths: [] });
    assert.equal(initialConflict.outcome, "pending", JSON.stringify(initialConflict));
    assert.equal(readFileSync(done, "utf8"), "Unowned local notes\n");
    unlinkSync(done);
    const explain = () =>
      e.host.read(
        "lease-repo",
        "repo.entity.actions.explain",
        {
          schema: "entity-action-explain-request/v1",
          mode: "object",
          entityKind: null,
          refs: ["task/task_done_mirror"],
        },
        { transportKind: "unix-socket" },
      );
    const available = await explain();
    assert.equal(available.subjects[0]?.actions.find(({ action }) => action.id === "materialize")?.available, true);
    const revision = f.eventCount();
    const response = await e.rpc.handle({
      jsonrpc: "2.0",
      id: 400,
      method: "repo.task.materialize",
      params: { repo: { repoId: "lease-repo" }, payload: { taskId: "task_done_mirror" } },
    });
    assert.ok(response && !Array.isArray(response) && "result" in response);
    const receipt = response.result as Record<string, unknown>;
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.equal(receipt.proof, undefined);
    assert.match(readFileSync(done, "utf8"), /task_done_mirror/u);
    assert.equal(existsSync(active), false, "a named restore must not materialize unrelated tasks");
    const restored = await e.command({ kind: "task-show", taskId: "task_done_mirror" });
    assert.equal(JSON.parse(String(restored.evidence)).materializationState, "materialized");
    const original = readFileSync(done, "utf8");
    writeFileSync(done, original + "\nKeep my bytes\n");
    const pending = await e.command({ kind: "doc-materialize", taskId: "task_done_mirror", paths: [] });
    assert.equal(pending.outcome, "pending");
    assert.match(JSON.stringify(pending.warnings), /task_done_mirror/u);
    assert.match(JSON.stringify(pending.guidance), /ha doc status/u);
    assert.equal(readFileSync(done, "utf8"), original + "\nKeep my bytes\n");
    const writes = actionDeclarations
      .filter(({ executionClass }) => executionClass !== "repo-read")
      .map(({ policyAction }) => policyAction);
    f.owners.keycloak.revoke("person-one", "lease-repo", writes);
    const refused = await e.command({ kind: "doc-materialize", taskId: "task_done_mirror", paths: [] });
    assert.equal(refused.code, "authorization_denied", JSON.stringify(refused));
    const policyRefused = await e.command({ kind: "settings-update", taskMaterializationPolicy: "include_done" });
    assert.equal(policyRefused.code, "authorization_denied", JSON.stringify(policyRefused));
    const unavailable = await explain();
    assert.equal(unavailable.subjects[0]?.actions.find(({ action }) => action.id === "materialize")?.available, false);
    assert.equal(f.eventCount(), revision);
    assert.equal(readFileSync(done, "utf8"), original + "\nKeep my bytes\n");
  },
);

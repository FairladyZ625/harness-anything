// harness-test-tier: integration
import {
  makeDaemonCommandReceipt,
  validateDaemonGuiCommandReceipt,
} from "../src/protocol/daemon-protocol-validate-results.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  INITIAL_SETTINGS_V1,
  localSettings,
  resolveHarnessLayout,
  serializeLocalSettings,
  taskLifecycleWritePlan,
  compileEntityDocumentRematerialization,
  compileRelationCreatedEvent,
  relationEventWritePlan,
} from "@harness-anything/kernel";
import { makeTaskEventReader, makeTaskProjection } from "@harness-anything/storage";
import { taskCreated, relation } from "../../storage/test/store/relation-graph-projection.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, seedSettingsEvent } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { nodeMaterializationStorage } from "../src/node-materialization-settings.ts";

const actor = { principal: { personId: "materialization-owner" }, executor: null } as const;

test("local policy changes reconcile done packages without canonical writes and reads see the new policy", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-node-policy-"));
  mkdirSync(path.join(root, "harness"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "fixture"], { cwd: root });
  const rootDir = canonicalRoot(root),
    repoId = workspaceId("node-policy-settings"),
    seed = seedSettingsEvent({ rootDir, repoId, keepOpen: true })!,
    projection = makeTaskProjection({ rootDir, eventStore: seed });
  const packages: string[] = [];
  try {
    for (const [id, status] of [
      ["task_done_policy", "done"],
      ["task_active_policy", "planned"],
      ["task_held_policy", "done"],
    ] as const) {
      const base = taskCreated(seed.currentCut().revision + 1, id),
        event = {
          ...base,
          payload: { ...base.payload, task: { ...base.payload.task, status, packageDisposition: "active" as const } },
        },
        bundle = { event, plan: taskLifecycleWritePlan(event), blobs: [] };
      seed.append(bundle);
      projection.apply(event, bundle.plan);
      const packagePath = projection.read(id).packagePath!;
      packages.push(packagePath);
      const documents = compileEntityDocumentRematerialization({
        opId: `docs-${id}`,
        workspaceRevision: seed.currentCut().revision + 1,
        actor,
        source: "local",
        occurredAt: "2026-11-15T00:00:00.000Z",
        entityRefs: [`task/${id}`],
        rationale: "fixture documents",
        updates: [
          {
            path: `${packagePath}/task_plan.md`,
            body: `# ${id}\n`,
            mediaType: "text/markdown",
            policyId: "markdown-body-replaceable/v1",
          },
        ],
      });
      seed.append(documents);
      projection.apply(documents.event, documents.plan);
    }
    const { strength: _strength, ...record } = relation({
        source: "task/task_active_policy",
        target: "task/task_held_policy",
        type: "depends-on",
      }),
      held = compileRelationCreatedEvent({
        record: { ...record, targetObservedVersion: null },
        actor,
        source: "local",
        opId: "held-policy",
        workspaceRevision: seed.currentCut().revision + 1,
        occurredAt: "2026-11-15T00:00:00.000Z",
      }),
      heldPlan = relationEventWritePlan(held);
    seed.append({ event: held, plan: heldPlan, blobs: [] });
    projection.apply(held, heldPlan);
    seed.materialize();
  } finally {
    projection.close();
    await seed.drain();
  }
  let queueDepth = 0;
  const cell = await openBootstrappedRepoCell({
      repoId,
      rootDir,
      ownerId: "node-policy-settings",
      onQueueDepthChange: (depth) => {
        queueDepth = depth;
      },
      killpoint: (point) => {
        if (point === "before_worktree_rename")
          assert.equal(queueDepth, 0, "follower IO stays outside the write queue");
      },
    }),
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
    viewer = withPolicyGroup(
      { actor: { principal: { personId: "materialization-viewer" }, executor: null }, source: "local" as const },
      "viewer",
    ),
    reader = makeTaskEventReader({ rootDir, repoId });
  const beforeInitialization = reader.currentCut();
  const localBeforeSettings = await cell.run(
    { kind: "settings-update", taskMaterializationPolicy: "include_done" },
    binding,
  );
  assert.equal(localBeforeSettings.outcome, "applied", JSON.stringify(localBeforeSettings));
  assert.deepEqual(reader.currentCut(), beforeInitialization, "node settings never mint missing shared Settings");
  // Explicit repository Settings initialization is fixture setup, before freezing the no-write baseline.
  const initialized = await cell.run({ kind: "settings-update", locale: "en-US" }, binding);
  assert.ok(["applied", "no_changes"].includes(initialized.outcome), JSON.stringify(initialized));
  const beforeCut = reader.currentCut(),
    beforeYaml = readFileSync(path.join(rootDir, "harness/harness.yaml"), "utf8");
  try {
    assert.ok(existsSync(path.join(rootDir, "harness", packages[0]!, "task_plan.md")));
    for (const taskMaterializationPolicy of ["in_flight", "include_done", "none", "include_done"] as const) {
      const receipt = await cell.run({ kind: "settings-update", taskMaterializationPolicy }, binding);
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      assert.deepEqual(
        reader.currentCut(),
        beforeCut,
        `a node preference must not publish a canonical event: ${JSON.stringify(reader.readEventAtRevision(beforeCut.revision + 1))}`,
      );
      assert.equal(readFileSync(path.join(rootDir, "harness/harness.yaml"), "utf8"), beforeYaml);
      const settings = await cell.run({ kind: "settings-read" }, binding);
      assert.equal(
        (settings.settings as { nodeTaskMaterializationPolicy: string }).nodeTaskMaterializationPolicy,
        taskMaterializationPolicy,
      );
      assert.equal(
        existsSync(path.join(rootDir, "harness", packages[0]!, "task_plan.md")),
        taskMaterializationPolicy === "include_done",
      );
      assert.equal(
        existsSync(path.join(rootDir, "harness", packages[1]!, "task_plan.md")),
        true,
        "switching to none preserves existing in-flight context",
      );
      assert.equal(
        existsSync(path.join(rootDir, "harness", packages[0]!)),
        taskMaterializationPolicy === "include_done",
        "unheld done directories are pruned",
      );
      assert.ok(
        existsSync(path.join(rootDir, "harness", packages[2]!, "task_plan.md")),
        "active dependency anchors remain local",
      );
      const shown = await cell.run({ kind: "task-show", taskId: "task_done_policy" }, binding);
      assert.equal(
        JSON.parse(String(shown.evidence)).materializationState,
        taskMaterializationPolicy === "include_done" ? "materialized" : "skipped_by_node_policy",
      );
    }
    for (const action of [
      { kind: "settings-update", taskMaterializationPolicy: "none" },
      { kind: "doc-materialize", taskId: "task_done_policy" },
    ]) {
      const denied = await cell.run(action, viewer);
      assert.equal(denied.outcome, "op_rejected", JSON.stringify(denied));
      assert.equal(denied.authorizationDecision?.outcome, "denied");
    }
    const availability = await cell.read(
      "repo.entity.actions.explain",
      { schema: "entity-action-explain-request/v1", mode: "object", entityKind: null, refs: ["task/task_done_policy"] },
      viewer,
    );
    const materializeAction = availability.subjects[0]?.actions.find(({ action }) => action.id === "materialize");
    assert.equal(materializeAction?.available, false);
    assert.equal(materializeAction?.authorizationDecision?.outcome, "denied");
    assert.deepEqual(reader.currentCut(), beforeCut);
    await cell.run({ kind: "settings-update", taskMaterializationPolicy: "in_flight" }, binding);
    const restored = await cell.run({ kind: "doc-materialize", taskId: "task_done_policy" }, binding);
    assert.equal(restored.outcome, "applied", JSON.stringify(restored));
    assert.ok(existsSync(path.join(rootDir, "harness", packages[0]!, "task_plan.md")));
    assert.deepEqual(reader.currentCut(), beforeCut);
    const edited = path.join(rootDir, "harness", packages[0]!, "task_plan.md");
    writeFileSync(edited, "operator edit\n");
    for (let attempt = 0; attempt < 2; attempt++) {
      const conflict = await cell.run({ kind: "settings-update", taskMaterializationPolicy: "none" }, binding);
      assert.equal(conflict.outcome, "pending", JSON.stringify(conflict));
      assert.equal(conflict.status, "unknown");
      assert.deepEqual(validateDaemonGuiCommandReceipt(makeDaemonCommandReceipt("settings-update", conflict)), []);
      assert.equal(readFileSync(edited, "utf8"), "operator edit\n");
      assert.deepEqual(reader.currentCut(), beforeCut);
    }
  } finally {
    await cell.close();
    await reader.drain();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live storage policy observes independent preference replacements and deletion", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-live-node-policy-")),
    rootDir = canonicalRoot(root),
    localPath = resolveHarnessLayout(rootDir).settingsLocalPath,
    storage = nodeMaterializationStorage({ rootDir, mode: "remote-edge" });
  try {
    assert.equal(storage.nodeTaskMaterializationPolicy, "in_flight");
    for (const policy of ["none", "include_done", "in_flight"] as const) {
      const body = serializeLocalSettings(
        localSettings({ ...INITIAL_SETTINGS_V1, nodeTaskMaterializationPolicy: policy }),
      );
      execFileSync(process.execPath, [
        "--input-type=module",
        "-e",
        `
        import { mkdirSync, writeFileSync, renameSync, utimesSync } from "node:fs";
        import path from "node:path";
        const target = process.argv[1];
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target + ".replacement", process.argv[2].padEnd(256));
        renameSync(target + ".replacement", target);
        utimesSync(target, 1, 1);
      `,
        localPath,
        body,
      ]);
      assert.equal(
        storage.nodeTaskMaterializationPolicy,
        policy,
        "same size and mtime must not hide a durable replacement",
      );
      assert.equal(storage.nodeTaskMaterializationPolicy, policy);
    }
    rmSync(localPath);
    assert.equal(storage.nodeTaskMaterializationPolicy, "in_flight", "deletion restores this node's role default");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

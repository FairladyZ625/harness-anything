// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { OPAQUE_TEXTUAL_POLICY_ID, sha256Text } from "@harness-anything/kernel";
import { makeTaskEventReader } from "@harness-anything/storage";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { parseThinCommand } from "@harness-anything/cli/internal/cli/thin-command";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { readEdgeDocWorkspace } from "../src/daemon-host/fleet-edge-doc-read.ts";
import { applyFleetMirrorCut, type FleetMirrorView } from "../src/daemon-host/fleet-edge-mirror.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { actor, initRepo, write } from "./doc-sync-slice-a.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

// The acceptance form of the unified coordinate: a path printed by `ha doc status` can be pasted
// straight into `ha doc show --path` (and every other doc --path command) from the same root.
test("a doc status row path pastes back into doc show --path from the same workspace root", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-path-round-trip-"));
  initRepo(rootDir);
  const repoId = workspaceId("doc-path-round-trip"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "round-trip" }),
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
    logical = "context/pasted.md",
    body = "# Pasted\n\nround trip\n";
  try {
    write(rootDir, logical, body);
    // Both calls carry the marker the CLI puts on its actions: this test exercises the CLI
    // coordinate, not the authored key a daemon-internal caller still uses.
    const submitted = await cell.run(
      { kind: "doc-submit", paths: [`harness/${logical}`], pathCoordinate: "workspace" },
      binding,
    );
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));

    const status = (await cell.run(
      { kind: "doc-status", paths: [`harness/${logical}`], pathCoordinate: "workspace" },
      binding,
    )) as {
      readonly detail?: { readonly paths: readonly { readonly path: string }[] };
    };
    const printed = status.detail?.paths[0]?.path;
    assert.equal(printed, `harness/${logical}`, "the receipt prints the workspace-relative spelling");

    const parsed = parseThinCommand(["doc", "show", "--path", String(printed)], rootDir);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const action = parsed.command.action as { readonly path?: string; readonly pathCoordinate?: string };
    assert.equal(action.path, printed, "the parser hands the pasted spelling to the doc action unchanged");
    assert.equal(action.pathCoordinate, "workspace", "the CLI marks the caller coordinate at the boundary");

    // The parsed action carries the marker, so the daemon entry translates it exactly as an `ha` call does.
    const shown = await cell.run(parsed.command.action, binding);
    assert.equal(shown.outcome, "applied", JSON.stringify(shown));
    assert.equal(shown.evidence, body);
  } finally {
    await cell.close();
    removeTempRepository(rootDir);
  }
});

test("the old authored-relative spelling is rejected at the CLI boundary", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-path-legacy-"));
  initRepo(rootDir);
  const repoId = workspaceId("doc-path-legacy"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "legacy" }),
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  try {
    const parsed = parseThinCommand(["doc", "show", "--path", "tasks/task_a/x.md"], rootDir);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const receipt = await cell.run(parsed.command.action, binding);
    assert.equal(receipt.outcome, "op_rejected", JSON.stringify(receipt));
    assert.equal(receipt.code, "invalid_field", JSON.stringify(receipt));
    assert.match(JSON.stringify(receipt), /outside the authored ledger root/u);
  } finally {
    await cell.close();
    removeTempRepository(rootDir);
  }
});

test("a zero-hit selection names the workspace path the caller typed", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-path-zero-hit-"));
  initRepo(rootDir);
  const repoId = workspaceId("doc-path-zero-hit"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "zero-hit" }),
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  try {
    const missing = await cell.run(
      { kind: "doc-submit", paths: ["harness/context/missing.md"], pathCoordinate: "workspace" },
      binding,
    );
    assert.equal(missing.outcome, "op_rejected", JSON.stringify(missing));
    assert.equal(missing.code, "document_not_found", JSON.stringify(missing));
    assert.match(String(missing.rejectionExplanation), /harness\/context\/missing\.md/u);
    assert.doesNotMatch(String(missing.rejectionExplanation), /(?:^|\s)context\/missing\.md/u);
  } finally {
    await cell.close();
    removeTempRepository(rootDir);
  }
});

test("a doc-synced closeout keeps the task submit next after coordinate translation", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-path-closeout-next-"));
  initRepo(rootDir);
  const repoId = workspaceId("doc-path-closeout-next"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "closeout-next" }),
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  try {
    const created = await cell.run(
      { kind: "task-create", taskId: "task-closeout-next", title: "Closeout next" },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const packagePath = String(created.packagePath);
    write(rootDir, `${packagePath}/task_plan.md`, realizedTaskPlan("Closeout next"));
    assert.equal(
      (await cell.run({ kind: "doc-submit", paths: [`${packagePath}/task_plan.md`] }, binding)).outcome,
      "applied",
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task-closeout-next", executionId: "exe_closeout_next" }, binding))
        .outcome,
      "applied",
    );
    write(rootDir, `${packagePath}/closeout.md`, "# Closeout\n\n## Summary\n\nDelivered.\n");
    const synced = await cell.run({ kind: "doc-submit", paths: [`${packagePath}/closeout.md`] }, binding);
    assert.equal(synced.outcome, "applied", JSON.stringify(synced));
    assert.match(
      JSON.stringify(synced.next),
      new RegExp(`ha task submit task-closeout-next`, "u"),
      JSON.stringify(synced),
    );
  } finally {
    await cell.close();
    removeTempRepository(rootDir);
  }
});

function parseCliDocAction(args: readonly string[], rootDir: string): Record<string, unknown> {
  const parsed = parseThinCommand(args, rootDir);
  assert.equal(parsed.ok, true, `expected CLI parse to succeed for ${args.join(" ")}`);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.command.action as Record<string, unknown>;
}

test("readEdgeDocWorkspace honors pathCoordinate=workspace and keeps daemon-internal authored keys", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-doc-read-coord-"));
  t.after(() => removeTempRepository(root));
  mkdirSync(path.join(root, "harness", "skills", "test-isolation"), { recursive: true });
  writeFileSync(
    path.join(root, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nname: edge-coord\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  const logical = "skills/test-isolation/active-runs.mjs";
  writeFileSync(path.join(root, "harness", ...logical.split("/")), "export const activeRuns = [];\n");
  const view: FleetMirrorView = {
    repoId: "edge-coord-repo",
    viewId: "node-one",
    viewDir: path.join(root, "view"),
    revision: 1,
    schemaGeneration: 1,
    headDigest: `sha256:${"0".repeat(64)}`,
    manifestDigest: `sha256:${"1".repeat(64)}:0`,
    ledgerGeneration: 1,
    readerProfile: null,
    authorizationShapeDigest: "",
    entries: new Map(),
  };
  const projection = { taskIdForDocumentPath: () => null } as never;

  const workspaceStatus = readEdgeDocWorkspace(root, view, projection, {
    kind: "doc-status",
    paths: [`harness/${logical}`],
    pathCoordinate: "workspace",
  } as never);
  assert.deepEqual(
    workspaceStatus.rows.map(({ path: rowPath, state }) => [rowPath, state]),
    [[`harness/${logical}`, "eligible"]],
  );
  assert.match(workspaceStatus.summary, /harness\/skills\/test-isolation\/active-runs\.mjs\teligible/u);
  assert.match(workspaceStatus.evidence, /"path":"harness\/skills\/test-isolation\/active-runs\.mjs"/u);

  for (const invalidPath of [logical, "../escape.md", "packages/cli/src/index.ts"]) {
    assert.throws(
      () =>
        readEdgeDocWorkspace(root, view, projection, {
          kind: "doc-status",
          paths: [invalidPath],
          pathCoordinate: "workspace",
        } as never),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "invalid_field" &&
        /outside the authored ledger root/u.test(error.message),
      `workspace coordinate must reject ${invalidPath}`,
    );
  }

  assert.throws(
    () =>
      readEdgeDocWorkspace(root, view, projection, {
        kind: "doc-status",
        paths: ["harness/skills/test-isolation/missing.mjs"],
        pathCoordinate: "workspace",
      } as never),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "document_not_found" &&
      /harness\/skills\/test-isolation\/missing\.mjs/u.test(error.message),
  );

  // Daemon-internal callers without pathCoordinate continue to use authored keys.
  const internalStatus = readEdgeDocWorkspace(root, view, projection, {
    kind: "doc-status",
    paths: [logical],
  } as never);
  assert.deepEqual(
    internalStatus.rows.map(({ path: rowPath, state }) => [rowPath, state]),
    [[logical, "eligible"]],
  );
});

test(
  "remote-edge doc status/sync --path round-trips non-tasks managed paths and rejects outside-root paths",
  { timeout: 120_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true),
      viewRoot = path.join(f.root, "edge-doc-path-view"),
      quota = 64 * 1024 * 1024;
    await catchUpReplica({ ...f.peer("node-one"), viewRoot, diskQuotaBytes: quota });
    const edge = await fleetEdgeHostFixture(t, f, { name: "edge-doc-path", viewRoot, nodeId: "node-one" });
    assert.equal(
      applyFleetMirrorCut(viewRoot, "lease-repo", edge.edgeRoot, "pull", { viewId: "node-one" }).outcome,
      "applied",
    );

    const skillLogical = "skills/test-isolation/active-runs.mjs",
      skillWorkspace = `harness/${skillLogical}`,
      skillBodyV1 = "export function listActiveRuns() {\n  return [];\n}\n",
      skillBodyV2 = "export function listActiveRuns() {\n  return ['run-1'];\n}\n",
      skillDisk = path.join(edge.edgeRoot, "harness", ...skillLogical.split("/"));
    mkdirSync(path.dirname(skillDisk), { recursive: true });
    writeFileSync(skillDisk, skillBodyV1);

    // 1. Negative control: authored-relative spelling (missing harness/ prefix) and genuinely
    //    outside-root paths must fail closed with invalid_field on BOTH doc status and doc sync --submit.
    for (const invalidPath of [skillLogical, "../escape.md", "packages/cli/src/index.ts", "harness/../../escape.md"]) {
      const statusRejected = await edge.command(
        parseCliDocAction(["doc", "status", "--path", invalidPath], edge.edgeRoot),
      );
      assert.equal(statusRejected.outcome, "op_rejected", `status ${invalidPath}: ${JSON.stringify(statusRejected)}`);
      assert.equal(statusRejected.code, "invalid_field", `status ${invalidPath}: ${JSON.stringify(statusRejected)}`);
      assert.match(String(statusRejected.rejectionExplanation), /outside the authored ledger root/u);

      const submitRejected = await edge.command(
        parseCliDocAction(["doc", "sync", "--submit", "--path", invalidPath], edge.edgeRoot),
      );
      assert.equal(submitRejected.outcome, "op_rejected", `submit ${invalidPath}: ${JSON.stringify(submitRejected)}`);
      assert.equal(submitRejected.code, "invalid_field", `submit ${invalidPath}: ${JSON.stringify(submitRejected)}`);
      assert.match(String(submitRejected.rejectionExplanation), /outside the authored ledger root/u);
    }

    // 2. Negative control: zero-hit missing path inside harness/ fails closed with document_not_found
    //    naming the workspace path the caller typed.
    const missingSubmit = await edge.command(
      parseCliDocAction(
        ["doc", "sync", "--submit", "--path", "harness/skills/test-isolation/absent.mjs"],
        edge.edgeRoot,
      ),
    );
    assert.equal(missingSubmit.outcome, "op_rejected", JSON.stringify(missingSubmit));
    assert.equal(missingSubmit.code, "document_not_found", JSON.stringify(missingSubmit));
    assert.match(String(missingSubmit.rejectionExplanation), /harness\/skills\/test-isolation\/absent\.mjs/u);

    // 3. Negative control: scopeless submit and --all are refused on remote-edge.
    for (const scopelessArgs of [
      ["doc", "sync", "--submit"],
      ["doc", "sync", "--submit", "--all"],
    ] as const) {
      const refused = await edge.command(parseCliDocAction(scopelessArgs, edge.edgeRoot));
      assert.equal(refused.outcome, "op_rejected", JSON.stringify(refused));
      assert.equal(refused.code, "doc_submit_scope_required", JSON.stringify(refused));
    }

    // 4. Negative control: route-owned path is rejected instead of silently returning no_changes.
    writeFileSync(
      path.join(edge.edgeRoot, "harness", "harness.yaml"),
      "schema: harness-anything/v1\nname: mutated\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    const routeOwnedRejected = await edge.command(
      parseCliDocAction(["doc", "sync", "--submit", "--path", "harness/harness.yaml"], edge.edgeRoot),
    );
    assert.equal(routeOwnedRejected.outcome, "op_rejected", JSON.stringify(routeOwnedRejected));
    assert.equal(routeOwnedRejected.code, "preview_blocked", JSON.stringify(routeOwnedRejected));

    // 5. Positive round-trip: doc status -> dry-run -> submit -> doc show -> status clean -> no_changes -> update.
    const status = await edge.command(parseCliDocAction(["doc", "status", "--path", skillWorkspace], edge.edgeRoot));
    assert.equal(status.outcome, "applied", JSON.stringify(status));
    const statusRows = status.rows as readonly { readonly path: string; readonly state: string }[];
    assert.deepEqual(
      statusRows.map(({ path: rowPath, state }) => [rowPath, state]),
      [[skillWorkspace, "eligible"]],
    );
    const printedPath = statusRows[0]!.path;

    const dryRun = await edge.command(
      parseCliDocAction(["doc", "sync", "--dry-run", "--path", printedPath], edge.edgeRoot),
    );
    assert.equal(dryRun.outcome, "applied", JSON.stringify(dryRun));
    assert.deepEqual(
      (dryRun.rows as readonly { readonly path: string; readonly state: string }[]).map(({ path: p, state }) => [
        p,
        state,
      ]),
      [[skillWorkspace, "eligible"]],
    );

    const submitted = await edge.command(
      parseCliDocAction(["doc", "sync", "--submit", "--path", printedPath], edge.edgeRoot),
    );
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const submittedDetail = submitted.detail as { readonly paths?: readonly { readonly path: string }[] } | undefined;
    assert.equal(submittedDetail?.paths?.[0]?.path, skillWorkspace, JSON.stringify(submitted));

    const centerEvent = makeTaskEventReader({ repoId: "lease-repo", rootDir: f.repo }).readEvent(
      String(submitted.opId),
    );
    assert.equal(centerEvent?.schema, "doc-event/v1", JSON.stringify(centerEvent));
    if (centerEvent?.schema === "doc-event/v1") {
      assert.deepEqual(
        centerEvent.payload.changes.map((change) => ({
          path: change.path,
          policyId: change.policyId,
          mediaType: change.candidate?.mediaType,
          sha256: change.candidate?.sha256,
        })),
        [
          {
            path: skillLogical,
            policyId: OPAQUE_TEXTUAL_POLICY_ID,
            mediaType: "text/javascript",
            sha256: sha256Text(skillBodyV1),
          },
        ],
      );
    }

    const shown = await edge.command(parseCliDocAction(["doc", "show", "--path", printedPath], edge.edgeRoot));
    assert.equal(shown.outcome, "applied", JSON.stringify(shown));
    assert.equal(shown.evidence, skillBodyV1);

    const statusAfter = await edge.command(parseCliDocAction(["doc", "status", "--path", printedPath], edge.edgeRoot));
    assert.equal(statusAfter.outcome, "applied", JSON.stringify(statusAfter));
    assert.deepEqual(
      (statusAfter.rows as readonly { readonly path: string; readonly state: string }[]).map(({ path: p, state }) => [
        p,
        state,
      ]),
      [[skillWorkspace, "clean"]],
    );

    const noOpSubmit = await edge.command(
      parseCliDocAction(["doc", "sync", "--submit", "--path", printedPath], edge.edgeRoot),
    );
    assert.equal(noOpSubmit.outcome, "no_changes", JSON.stringify(noOpSubmit));

    // Edit the already-published file on edge and submit the update.
    writeFileSync(skillDisk, skillBodyV2);
    const updated = await edge.command(
      parseCliDocAction(["doc", "sync", "--submit", "--path", printedPath], edge.edgeRoot),
    );
    assert.equal(updated.outcome, "applied", JSON.stringify(updated));
    const shownV2 = await edge.command(parseCliDocAction(["doc", "show", "--path", printedPath], edge.edgeRoot));
    assert.equal(shownV2.outcome, "applied", JSON.stringify(shownV2));
    assert.equal(shownV2.evidence, skillBodyV2);

    // 6. Non-task markdown under context/ works identically.
    const contextWorkspace = "harness/context/edge-note.md",
      contextDisk = path.join(edge.edgeRoot, "harness", "context", "edge-note.md"),
      contextBody = "# Edge Note\n\nSynced from remote-edge.\n";
    mkdirSync(path.dirname(contextDisk), { recursive: true });
    writeFileSync(contextDisk, contextBody);
    const contextSubmitted = await edge.command(
      parseCliDocAction(["doc", "sync", "--submit", "--path", contextWorkspace], edge.edgeRoot),
    );
    assert.equal(contextSubmitted.outcome, "applied", JSON.stringify(contextSubmitted));
    const shownContext = await edge.command(
      parseCliDocAction(["doc", "show", "--path", contextWorkspace], edge.edgeRoot),
    );
    assert.equal(shownContext.outcome, "applied", JSON.stringify(shownContext));
    assert.equal(shownContext.evidence, contextBody);

    // 7. Existing --task submit path continues to work on the same remote-edge.
    const createdTask = await edge.command({
      kind: "task-create",
      taskId: "task-edge-doc-keep",
      title: "Keep task submit working",
    });
    assert.equal(createdTask.outcome, "applied", JSON.stringify(createdTask));
    const packagePath = String(createdTask.packagePath),
      planDisk = path.join(edge.edgeRoot, "harness", ...packagePath.split("/"), "task_plan.md");
    mkdirSync(path.dirname(planDisk), { recursive: true });
    writeFileSync(planDisk, realizedTaskPlan("Keep task submit working"));
    const taskSubmitted = await edge.command(
      parseCliDocAction(["doc", "sync", "--submit", "--task", "task-edge-doc-keep"], edge.edgeRoot),
    );
    assert.equal(taskSubmitted.outcome, "applied", JSON.stringify(taskSubmitted));
  },
);

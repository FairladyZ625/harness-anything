// harness-test-tier: integration
// W3-C class-A/class-B dual sync state machines: every test drives the real
// product entry points (runFleetEdgeTask / runFleetEdgeDocSync /
// runFleetEdgeConflictExit) against a live fleet TLS center, mirroring the
// lease-broker and transport integration fixtures. P0 semantics under test:
// non-holder task-doc pushes are rejected; a base conflict voids the whole
// transition; CENTER_REJECTED never silently overwrites; conflict staging
// lands base/local/center with three explicit exits; pull-blocked is reported
// on the dual axis instead of masquerading as synced.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, sha256Bytes } from "@harness-anything/kernel";
import { readSubmissionArtifact } from "../src/submission-artifacts.ts";
import { settlePushRejection } from "../src/fleet-edge-doc-sync.ts";
import { readFleetUnresolvedConflicts } from "../src/fleet-edge-mirror.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { dualSyncFixture, ledgerRevision, type Fixture } from "./fleet-dual-sync.fixture.ts";

test(
  "remote-edge task and document reads use the authoritative cut after materialization",
  { timeout: 60_000 },
  async (t) => {
    const fixture: Fixture = await dualSyncFixture();
    t.after(() => fixture.close());
    const created = await fixture.createTask("node-one", "task-seeded", "Authoritative edge read");
    const shown = await fixture.edgeTask("node-one", { kind: "task-show", taskId: created.taskId });
    assert.equal(shown.ok, true, JSON.stringify(shown));
    assert.ok(Number(shown.revision) > 0);
    assert.doesNotMatch(String(shown.summary), /task=null/u);
    const logical = "context/shared-notes.md";
    fixture.writeWorktree("node-one", logical, "# Submitted once\n");
    const submitted = await fixture.edgeDocSync("node-one", { paths: [logical] });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    const status = await fixture.edgeDocSync("node-one", { dryRun: true, paths: [logical] });
    assert.equal(
      status.cut && (status.cut as { revision: number }).revision,
      submitted.cut && (submitted.cut as { revision: number }).revision,
    );
    assert.deepEqual(status.rows, [], `already-submitted document was re-eligible: ${JSON.stringify(status.rows)}`);
  },
);

test(
  "class A: a task command carries local task documents, and the effect lands in both mirrors",
  { timeout: 60_000 },
  async (t) => {
    const fixture: Fixture = await dualSyncFixture();
    t.after(() => fixture.close());
    const created = await fixture.createTask("node-one", "task_AAAA000000000000000000000A", "Class A carry");
    const planPath = `${created.packagePath}/task_plan.md`;
    const original = readFileSync(fixture.worktree("node-one", planPath), "utf8");
    fixture.writeWorktree(
      "node-one",
      planPath,
      `${original}\n## Edge owner notes\n\nEdited on the edge before starting the task.\n`,
    );
    const observed: unknown[] = [];
    const originalRun = fixture.host.run.bind(fixture.host);
    t.mock.method(fixture.host, "run", async (...args: Parameters<typeof fixture.host.run>) => {
      if (args[1].kind === "task-start") observed.push(args[1]);
      return originalRun(...args);
    });
    const base = fixture.view("node-one")!;
    const installation = await fixture.host.runtimeIngress(
      "dual-repo",
      {
        kind: "event",
        type: "runtime_installation_observed",
        opId: "unrelated-installation",
        payload: {
          installationId: "unrelated-installation",
          kindId: "codex",
          protocolFamily: "app-server",
          hostRef: "host:edge",
          version: "1",
          discoverySource: "wrapper",
          capabilities: [],
        },
      },
      fixture.owners.auth({ nodeId: "node-one" }),
    );
    assert.equal(installation.outcome, "applied", JSON.stringify(installation));
    const unrelated = await fixture.centerRun({ kind: "task-create", taskId: "task-unrelated", title: "Unrelated" });
    assert.equal(unrelated.outcome, "applied", JSON.stringify(unrelated));
    t.diagnostic(JSON.stringify({ mirrorBase: base.revision, centerRevision: ledgerRevision(fixture), planPath }));
    const started = await fixture.edgeTask("node-one", {
      kind: "task-start",
      taskId: created.taskId,
      executionId: "exe-a-carry",
    });
    assert.equal(started.ok, true, JSON.stringify(started).slice(0, 500));
    assert.equal(observed.length, 1, "one TLS task command reaches the center without a sync retry");
    assert.deepEqual((observed[0] as { mirrorBaseCut: unknown }).mirrorBaseCut, {
      revision: base.revision,
      headDigest: base.headDigest,
    });
    t.diagnostic(JSON.stringify({ centerReceived: observed[0] }));
    assert.equal(
      (started as { readonly docSync?: { readonly outcome?: string } }).docSync?.outcome,
      "applied",
      "the carried documents must land with the transition",
    );
    assert.equal((started as { readonly mirrorOutcome?: string }).mirrorOutcome, "applied");
    // The pushed bytes are now the mirror content on both nodes.
    assert.match(readFileSync(fixture.worktree("node-one", planPath), "utf8"), /Edge owner notes/u);
    await fixture.edgeTask("node-two", {
      kind: "task-create",
      taskId: "task_BBBB000000000000000000000B",
      title: "Peer view",
    }); // node-two pulls its own create
    const peerPlan = readFileSync(fixture.worktree("node-two", planPath), "utf8");
    assert.match(peerPlan, /Edge owner notes/u, "the second edge must see the carried document through its mirror");
  },
);

test(
  "F10: a hyphen-prefix sibling package never rides another task's class-A command",
  { timeout: 60_000 },
  async (t) => {
    const fixture: Fixture = await dualSyncFixture();
    t.after(() => fixture.close());
    const target = await fixture.createTask("node-one", "task-direct", "Direct");
    const sibling = await fixture.createTask("node-one", "task-direct-other", "Sibling");
    const siblingPlan = `${sibling.packagePath}/task_plan.md`,
      original = readFileSync(fixture.worktree("node-one", siblingPlan), "utf8");
    fixture.writeWorktree("node-one", siblingPlan, `${original}\nSibling-only local note.\n`);
    const started = await fixture.edgeTask("node-one", {
      kind: "task-start",
      taskId: target.taskId,
      executionId: "exe-prefix-target",
    });
    assert.equal(started.ok, true, JSON.stringify(started).slice(0, 500));
    assert.equal(
      (started as { readonly docSync?: unknown }).docSync,
      undefined,
      "the target command must not attach the sibling's dirty document",
    );
    assert.match(readFileSync(fixture.worktree("node-one", siblingPlan), "utf8"), /Sibling-only local note/u);
    // Refresh the peer through a real task command: it must not observe the
    // sibling note because it was not carried under the target's lease.
    assert.equal(
      (await fixture.edgeTask("node-two", { kind: "task-create", taskId: "task-prefix-observer", title: "Observer" }))
        .ok,
      true,
    );
    assert.doesNotMatch(readFileSync(fixture.worktree("node-two", siblingPlan), "utf8"), /Sibling-only local note/u);
  },
);

test(
  "class A: a base conflict voids the whole transition and stages base/local/center",
  { timeout: 60_000 },
  async (t) => {
    const fixture: Fixture = await dualSyncFixture();
    t.after(() => fixture.close());
    const created = await fixture.createTask("node-one", "task_CCCC000000000000000000000C", "Base conflict");
    const planPath = `${created.packagePath}/task_plan.md`,
      original = readFileSync(fixture.worktree("node-one", planPath), "utf8");
    // Another collaborator rewrites the plan at the center while this edge is
    // still based on the original cut. F1: the channel-less doc submit is
    // refused outright; the collaborator must hold the lease and name it.
    const centerVersion = `${original}\n## Rewritten at the center\n\nThe center moved this document first.\n`;
    const refused = await fixture.rawWrite("node-two", [
      { path: planPath, body: centerVersion, baseBlobSha256: sha256Bytes(Buffer.from(original)) },
    ]);
    assert.equal(refused.center.outcome, "op_rejected");
    assert.equal(refused.center.code, "task_docs_require_task_command");
    assert.equal(
      (
        await fixture.edgeTask("node-two", {
          kind: "task-start",
          taskId: created.taskId,
          executionId: "exe-center-writer",
        })
      ).ok,
      true,
    );
    const pushed = await fixture.rawWrite(
      "node-two",
      [{ path: planPath, body: centerVersion, baseBlobSha256: sha256Bytes(Buffer.from(original)) }],
      "exe-center-writer",
    );
    assert.equal(pushed.center.outcome, "applied");
    assert.equal(
      (
        await fixture.edgeTask("node-two", {
          kind: "task-release",
          taskId: created.taskId,
          reason: "center-side rewrite done",
        })
      ).ok,
      true,
    );
    const localVersion = `${original}\n## Edge owner notes\n\nLocal edit based on the stale cut.\n`;
    fixture.writeWorktree("node-one", planPath, localVersion);
    const started = await fixture.edgeTask("node-one", {
      kind: "task-start",
      taskId: created.taskId,
      executionId: "exe-a-conflict",
    });
    assert.equal(started.ok, false, "a base conflict must void the whole command");
    assert.equal(started.code, "base_blob_changed", "the authentic old cut reaches per-document conflict adjudication");
    // The transition did NOT happen: the task still has no lease at the center.
    const unchanged = await fixture.centerRun({ kind: "task-show", taskId: created.taskId });
    assert.equal(
      JSON.parse(String(unchanged.evidence)).lease,
      null,
      "the canonical task must not transition on a conflicted bundle",
    );
    // The divergence is staged with all three sides.
    const conflicts = readdirSync(fixture.conflictsRoot("node-one")).filter((entry) => entry.startsWith("cflt-"));
    assert.equal(conflicts.length, 1, `exactly one staged conflict expected, saw ${conflicts.join(",")}`);
    const dir = path.join(fixture.conflictsRoot("node-one"), conflicts[0]!);
    const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
      readonly code: string;
      readonly paths: readonly { readonly path: string }[];
      readonly exits: readonly string[];
      readonly state: string;
    };
    assert.deepEqual(
      manifest.paths.map((row) => row.path),
      [planPath],
    );
    assert.deepEqual(manifest.exits, ["resolve", "discard-local", "overwrite-center"]);
    assert.match(readFileSync(path.join(dir, "local", planPath), "utf8"), /Edge owner notes/u);
    assert.match(readFileSync(path.join(dir, "center", planPath), "utf8"), /Rewritten at the center/u);
    assert.ok(
      readFileSync(path.join(dir, "base", planPath), "utf8").startsWith(original.slice(0, 40).trim()),
      "the staged base side must hold the original cut bytes",
    );
    // The center document is untouched by the failed push and the local edit survives.
    assert.match(readFileSync(fixture.worktree("node-one", planPath), "utf8"), /Edge owner notes/u);
    // The per-path base guard itself: a bundle whose mirror cut is current but
    // whose declared per-path base no longer matches the projection is refused
    // with base_blob_changed and the transition never runs.
    const auth = fixture.owners.auth({
      nodeId: "node-one",
      repoId: "dual-repo",
      taskId: created.taskId,
      executionId: "exe-seeded",
      paths: ["tasks"],
    } as never);
    const status = await fixture.host.run("dual-repo", { kind: "doc-status", paths: [planPath] }, auth);
    if (status.detail?.kind !== "doc_sync") throw new Error("doc status lacks a canonical cut");
    const current = status.detail.currentLedgerSha;
    const probe = await fixture.host.run(
      "dual-repo",
      {
        kind: "task-start",
        taskId: created.taskId,
        executionId: "exe-a-probe",
        mirrorBaseCut: { revision: current.revision, headDigest: current.headDigest },
        docChanges: [
          {
            path: planPath,
            baseBlobSha256: sha256Bytes(Buffer.from(localVersion)),
            policyId: "markdown-body-replaceable/v1",
            candidate: {
              ref: `doc-sync-claims/${sha256Bytes(Buffer.from(centerVersion))}`,
              sha256: sha256Bytes(Buffer.from(centerVersion)),
              size: Buffer.byteLength(centerVersion),
              mediaType: "text/markdown",
            },
          },
        ],
      },
      auth,
    );
    assert.equal(probe.outcome, "op_rejected");
    assert.equal(probe.code, "base_blob_changed");
    assert.equal(
      JSON.parse(String((await fixture.centerRun({ kind: "task-show", taskId: created.taskId })).evidence)).lease,
      null,
      "the probe transition must not apply either",
    );
  },
);

test(
  "class A: unrelated document events do not reject an authentic historical mirror cut",
  { timeout: 60_000 },
  async (t) => {
    const fixture: Fixture = await dualSyncFixture();
    t.after(() => fixture.close());
    const created = await fixture.createTask("node-one", "task_DDDD000000000000000000000D", "Mirror gate");
    const planPath = `${created.packagePath}/task_plan.md`,
      original = readFileSync(fixture.worktree("node-one", planPath), "utf8");
    // The center advances on a path this edge does not touch, so only the mirror
    // base cut is old while every carried document base remains current.
    await fixture.rawWrite("node-two", [
      { path: "context/shared-notes.md", body: "# Shared\n\nFirst center version.\n" },
    ]);
    fixture.writeWorktree("node-one", planPath, `${original}\n## Local plan edit\n\nBased on the previous cut.\n`);
    const started = await fixture.edgeTask("node-one", {
      kind: "task-start",
      taskId: created.taskId,
      executionId: "exe-a-gate",
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal((started as { readonly docSync?: { readonly outcome?: string } }).docSync?.outcome, "applied");
    assert.match(readFileSync(fixture.worktree("node-one", planPath), "utf8"), /Local plan edit/u);
  },
);

test(
  "non-holder task-document pushes are rejected outright (no staging, no ledger effect)",
  { timeout: 60_000 },
  async (t) => {
    const fixture: Fixture = await dualSyncFixture();
    t.after(() => fixture.close());
    const created = await fixture.createTask("node-one", "task_EEEE000000000000000000000E", "Holder only");
    const started = await fixture.edgeTask("node-one", {
      kind: "task-start",
      taskId: created.taskId,
      executionId: "exe-a-holder",
    });
    assert.equal(started.ok, true);
    const planPath = `${created.packagePath}/task_plan.md`,
      original = readFileSync(fixture.worktree("node-one", planPath), "utf8");
    const before = ledgerRevision(fixture);
    // node-two names the holder's execution but is a different principal: the
    // domain lease rejects the push, bypassing the automatic entry changes
    // nothing.
    const attempt = await fixture.rawWrite(
      "node-two",
      [
        {
          path: planPath,
          body: `${original}\n## Non-holder edit\n\nMust not land.\n`,
          baseBlobSha256: sha256Bytes(Buffer.from(original)),
        },
      ],
      "exe-a-holder",
    );
    assert.equal(attempt.center.outcome, "op_rejected");
    assert.equal(attempt.center.code, "execution_scope_mismatch");
    assert.equal(ledgerRevision(fixture), before, "the ledger must not move for a non-holder push");
  },
);

test(
  "class B: doc sync compares, pushes, and CENTER_REJECTED stages instead of overwriting; all three exits work",
  { timeout: 60_000 },
  async (t) => {
    const fixture: Fixture = await dualSyncFixture();
    t.after(() => fixture.close());
    const shared = "context/shared-notes.md";
    await fixture.rawWrite("node-one", [{ path: shared, body: "# Shared\n\nv1 baseline.\n" }]);
    const first = await fixture.edgeDocSync("node-one", { paths: [shared] });
    assert.equal(first.ok, true, JSON.stringify(first).slice(0, 400));
    assert.equal(readFileSync(fixture.worktree("node-one", shared), "utf8"), "# Shared\n\nv1 baseline.\n");
    // Local edit on the edge; the center version moves underneath it.
    const localBody = "# Shared\n\nv1 baseline.\n\n## Edge one addition\n\nOnly on the edge.\n";
    fixture.writeWorktree("node-one", shared, localBody);
    await fixture.rawWrite("node-two", [
      {
        path: shared,
        body: "# Shared\n\nv1 baseline.\n\n## Center version two\n\nWritten by the peer edge.\n",
        baseBlobSha256: sha256Bytes(Buffer.from("# Shared\n\nv1 baseline.\n")),
      },
    ]);
    const conflicted = await fixture.edgeDocSync("node-one", { paths: [shared] });
    assert.equal(conflicted.ok, false, "the round must not report success over divergence");
    assert.equal((conflicted as { readonly syncState?: string }).syncState, "CONFLICT_STAGED");
    assert.equal((conflicted as { readonly code?: string }).code, "pull_blocked");
    const conflicts = readdirSync(fixture.conflictsRoot("node-one")).filter((entry) => entry.startsWith("cflt-"));
    assert.equal(conflicts.length, 1);
    const conflictId = conflicts[0]!,
      dir = path.join(fixture.conflictsRoot("node-one"), conflictId);
    assert.match(readFileSync(path.join(dir, "center", shared), "utf8"), /Center version two/u);
    assert.match(readFileSync(path.join(dir, "local", shared), "utf8"), /Edge one addition/u);
    // Nothing was merged or overwritten: the worktree keeps the local bytes and
    // the center keeps its own.
    assert.match(readFileSync(fixture.worktree("node-one", shared), "utf8"), /Edge one addition/u);
    // Exit 2 — discard-local: the worktree adopts the recorded center bytes.
    const discarded = await fixture.conflictExit("node-one", "discard-local", conflictId);
    assert.equal(discarded.ok, true, JSON.stringify(discarded).slice(0, 400));
    assert.match(readFileSync(fixture.worktree("node-one", shared), "utf8"), /Center version two/u);
    const settled = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
      readonly state: string;
      readonly resolvedVia: string;
    };
    assert.equal(settled.state, "resolved");
    assert.equal(settled.resolvedVia, "discard-local");
    // Stage a second divergence and take exit 3 — overwrite-center.
    fixture.writeWorktree(
      "node-one",
      shared,
      "# Shared\n\nv1 baseline.\n\n## Center version two\n\nWritten by the peer edge.\n\n## Edge one wins\n\nExplicit overwrite.\n",
    );
    // The center revision stays inside the existing region (no new heading):
    // the additive-region policy forbids wholesale rewrites, so the overwrite
    // exit must also operate within it.
    const v3 = await fixture.rawWrite("node-two", [
      {
        path: shared,
        body: "# Shared\n\nv1 baseline.\n\n## Center version two\n\nWritten by the peer edge, revised at the center.\n",
        baseBlobSha256: sha256Bytes(
          Buffer.from("# Shared\n\nv1 baseline.\n\n## Center version two\n\nWritten by the peer edge.\n"),
        ),
      },
    ]);
    assert.equal(v3.center.outcome, "applied", JSON.stringify(v3.center));
    const second = await fixture.edgeDocSync("node-one", { paths: [shared] });
    assert.equal(second.ok, false, JSON.stringify(second).slice(0, 600));
    const secondConflicts = readdirSync(fixture.conflictsRoot("node-one")).filter((entry) => entry.startsWith("cflt-"));
    assert.equal(
      secondConflicts.length,
      2,
      `expected the second divergence to stage separately, saw ${secondConflicts.join(",")}`,
    );
    const secondId = secondConflicts.find((entry) => entry !== conflictId)!;
    const overwritten = await fixture.conflictExit("node-one", "overwrite-center", secondId);
    assert.equal(overwritten.ok, true, JSON.stringify(overwritten).slice(0, 500));
    const afterOverwrite = readFileSync(fixture.worktree("node-one", shared), "utf8");
    assert.match(afterOverwrite, /Edge one wins/u, "the mirror must hold the explicit overwrite result");
    // Exit 1 — resolve closes a record by hand.
    fixture.writeWorktree("node-one", shared, `${afterOverwrite}\n## Merged by hand\n\nresolve exit.\n`);
    const resolved = await fixture.conflictExit("node-one", "resolve", conflictId);
    assert.equal(resolved.ok, true);
    const final = await fixture.edgeDocSync("node-one", { paths: [shared] });
    assert.equal(final.ok, true, `after resolving, the round must converge: ${JSON.stringify(final).slice(0, 400)}`);
    assert.equal((final as { readonly syncState?: string }).syncState, "SYNCED");
  },
);

test("class B: a clean push round applies at the center and reports SYNCED", { timeout: 60_000 }, async (t) => {
  const fixture: Fixture = await dualSyncFixture();
  t.after(() => fixture.close());
  const shared = "context/shared-notes.md";
  await fixture.rawWrite("node-one", [{ path: shared, body: "# Shared\n\nbaseline.\n" }]);
  const baseline = await fixture.edgeDocSync("node-one", { paths: [shared] });
  assert.equal(baseline.ok, true);
  fixture.writeWorktree("node-one", shared, "# Shared\n\nbaseline.\n\n## Push me\n\nClean local change.\n");
  const dryRun = await fixture.edgeDocSync("node-one", { paths: [shared], dryRun: true });
  assert.equal(dryRun.ok, true);
  assert.equal((dryRun as { readonly syncState?: string }).syncState, "LOCAL_DIRTY");
  const submitted = await fixture.edgeDocSync("node-one", { paths: [shared] });
  assert.equal(submitted.ok, true, JSON.stringify(submitted).slice(0, 400));
  assert.equal((submitted as { readonly syncState?: string }).syncState, "SYNCED");
  assert.equal(
    readFileSync(fixture.worktree("node-one", shared), "utf8"),
    "# Shared\n\nbaseline.\n\n## Push me\n\nClean local change.\n",
  );
  const peer = await fixture.edgeDocSync("node-two", { paths: [shared] });
  assert.equal(peer.ok, true);
  assert.match(readFileSync(fixture.worktree("node-two", shared), "utf8"), /Push me/u);
});

test("pull-blocked is reported on the dual axis instead of masquerading as synced", { timeout: 60_000 }, async (t) => {
  const fixture: Fixture = await dualSyncFixture();
  t.after(() => fixture.close());
  const taskA = await fixture.createTask("node-one", "task_FFFF000000000000000000000F", "Dual axis A");
  const taskB = await fixture.createTask("node-one", "task_GGGG000000000000000000000G", "Dual axis B");
  assert.equal(
    (await fixture.edgeTask("node-one", { kind: "task-start", taskId: taskA.taskId, executionId: "exe-dual-a" })).ok,
    true,
  );
  const planB = `${taskB.packagePath}/task_plan.md`;
  // node-one keeps a local edit on task B's plan while node-two takes B and
  // pushes a different version through its own task command.
  const original = readFileSync(fixture.worktree("node-one", planB), "utf8");
  fixture.writeWorktree("node-one", planB, `${original}\n## Node one local notes\n\nUnsynced.\n`);
  assert.equal(
    (await fixture.edgeTask("node-two", { kind: "task-start", taskId: taskB.taskId, executionId: "exe-dual-b" })).ok,
    true,
  );
  const peerOriginal = readFileSync(fixture.worktree("node-two", planB), "utf8");
  fixture.writeWorktree(
    "node-two",
    planB,
    `${peerOriginal}\n## Node two landed version\n\nPushed while node-one was dirty.\n`,
  );
  const peerPush = await fixture.edgeTask("node-two", {
    kind: "task-progress-append",
    taskId: taskB.taskId,
    text: "peer pushed the plan with this transition",
  });
  assert.equal(peerPush.ok, true, JSON.stringify(peerPush).slice(0, 500));
  // node-one's own command on task A applies at the center; the auto pull then
  // finds the diverged task B plan and must say pull_blocked, not synced.
  const progress = await fixture.edgeTask("node-one", {
    kind: "task-progress-append",
    taskId: taskA.taskId,
    text: "applied at the center while the mirror diverged",
  });
  assert.equal(progress.ok, false, "a pull-blocked outcome must not report ok");
  assert.equal((progress as { readonly canonicalOutcome?: string }).canonicalOutcome, "applied");
  assert.equal((progress as { readonly mirrorOutcome?: string }).mirrorOutcome, "pull_blocked");
  const conflicts = readdirSync(fixture.conflictsRoot("node-one")).filter((entry) => entry.startsWith("cflt-"));
  assert.equal(conflicts.length, 1);
  const manifest = JSON.parse(
    readFileSync(path.join(fixture.conflictsRoot("node-one"), conflicts[0]!, "manifest.json"), "utf8"),
  ) as { readonly paths: readonly { readonly path: string }[] };
  assert.deepEqual(
    manifest.paths.map((row) => row.path),
    [planB],
  );
  assert.match(
    readFileSync(fixture.worktree("node-one", planB), "utf8"),
    /Node one local notes/u,
    "the local bytes must survive untouched",
  );
});

test("F4: an unresolved conflict gates this task's later commands at the edge", { timeout: 60_000 }, async (t) => {
  const fixture: Fixture = await dualSyncFixture();
  t.after(() => fixture.close());
  const created = await fixture.createTask("node-one", "task_IIII000000000000000000000I", "Gate task");
  const planPath = `${created.packagePath}/task_plan.md`,
    original = readFileSync(fixture.worktree("node-one", planPath), "utf8");
  // Diverge the plan: center rewrite (holder channel) vs local edit.
  assert.equal(
    (await fixture.edgeTask("node-one", { kind: "task-start", taskId: created.taskId, executionId: "exe-gate-a" })).ok,
    true,
  );
  await fixture.rawWrite(
    "node-one",
    [{ path: planPath, body: `${original}\n## Center version\n`, baseBlobSha256: sha256Bytes(Buffer.from(original)) }],
    "exe-gate-a",
  );
  assert.equal(
    (await fixture.edgeTask("node-one", { kind: "task-release", taskId: created.taskId, reason: "handing over" })).ok,
    true,
  );
  fixture.writeWorktree("node-one", planPath, `${original}\n## Local version\n`);
  // A second node takes the lease and moves the plan; edge-one's local edit diverges.
  assert.equal((await fixture.edgeDocSync("node-two")).ok, true);
  const takeover = await fixture.edgeTask("node-two", { kind: "task-start", taskId: created.taskId });
  assert.equal(takeover.ok, true, JSON.stringify(takeover).slice(0, 500));
  const centerNow = `${original}\n## Center version\n`;
  const moved = await fixture.rawWrite(
    "node-two",
    [
      {
        path: planPath,
        body: `${centerNow}\n## Center moved again\n`,
        baseBlobSha256: sha256Bytes(Buffer.from(centerNow)),
      },
    ],
    "exe-gate-a",
  );
  assert.equal(moved.center.outcome, "applied", JSON.stringify(moved.center));
  assert.equal(
    (await fixture.edgeTask("node-two", { kind: "task-release", taskId: created.taskId, reason: "gate scenario" })).ok,
    true,
  );
  const diverged = await fixture.edgeDocSync("node-one", { paths: [planPath] });
  assert.equal(diverged.ok, false, JSON.stringify(diverged).slice(0, 400));
  assert.equal((diverged as { readonly syncState?: string }).syncState, "CONFLICT_STAGED");
  // The unresolved record gates this task's commands BEFORE any upload: no
  // center round-trip, no ledger movement.
  const beforeGate = ledgerRevision(fixture);
  const gated = await fixture.edgeTask("node-one", {
    kind: "task-start",
    taskId: created.taskId,
    executionId: "exe-gate-c",
  });
  assert.equal(gated.ok, false);
  assert.equal((gated as { readonly code?: string }).code, "conflict_open");
  assert.equal(ledgerRevision(fixture), beforeGate, "the gate must refuse without touching the center");
  // Another task is unaffected: its commands stay canonically admissible even
  // while this task's conflict is open (the mirror may still report the other
  // task's divergence on the dual axis — that is the honest outcome).
  const other = await fixture.edgeTask("node-one", {
    kind: "task-create",
    taskId: "task_JJJJ000000000000000000000J",
    title: "Unaffected task",
  });
  assert.equal(
    (other as { readonly canonicalOutcome?: string }).canonicalOutcome,
    "applied",
    JSON.stringify(other).slice(0, 400),
  );
  fixture.writeWorktree("node-one", `${String(other.packagePath)}/task_plan.md`, realizedTaskPlan("Unaffected task"));
  const otherStart = await fixture.edgeTask("node-one", {
    kind: "task-start",
    taskId: "task_JJJJ000000000000000000000J",
    executionId: "exe-gate-other",
  });
  assert.equal(
    (otherStart as { readonly canonicalOutcome?: string }).canonicalOutcome,
    "applied",
    JSON.stringify(otherStart).slice(0, 400),
  );
  // discard-local lifts the gate.
  const record = readFleetUnresolvedConflicts(path.join(fixture.root, "node-one-workspace"), "dual-repo")[0]!;
  const discarded = await fixture.conflictExit("node-one", "discard-local", record.conflictId);
  assert.equal(discarded.ok, true, JSON.stringify(discarded).slice(0, 400));
  const ungated = await fixture.edgeTask("node-one", { kind: "task-start", taskId: created.taskId });
  assert.equal(
    (ungated as { readonly canonicalOutcome?: string }).canonicalOutcome,
    "applied",
    JSON.stringify(ungated).slice(0, 400),
  );
});

test(
  "F5/F6: a rejected push settles honestly and overwrite-center is idempotent across a crash after the append",
  { timeout: 60_000 },
  async (t) => {
    const fixture: Fixture = await dualSyncFixture();
    t.after(() => fixture.close());
    const shared = "context/shared-notes.md";
    await fixture.rawWrite("node-one", [{ path: shared, body: "# Shared\n\nbaseline.\n" }]);
    assert.equal((await fixture.edgeDocSync("node-one", { paths: [shared] })).ok, true);
    const baseline = "# Shared\n\nbaseline.\n";
    // Keep both edits within the existing # Shared region. That creates a
    // legitimate shared-prose divergence and also lets the fixture emulate the
    // already-appended overwrite bytes without violating the heading policy.
    fixture.writeWorktree("node-one", shared, `${baseline}\nEdge one wins.\n`);
    await fixture.rawWrite("node-two", [
      { path: shared, body: `${baseline}\nCenter moved.\n`, baseBlobSha256: sha256Bytes(Buffer.from(baseline)) },
    ]);
    // settlePushRejection with a diverged mirror stages base/local/center and reports blocked.
    const peer = {
      hostname: "127.0.0.1",
      port: fixture.center.port,
      ca: readFileSync(path.join(fixture.root, "tls.crt")),
      servername: "localhost",
      nodeId: "node-one",
      credential: "secret-node-one",
      repoId: "dual-repo",
    };
    const diverged = await settlePushRejection({ ...fixture.channel("node-one") }, peer, 30_000, "base_blob_changed");
    assert.equal(diverged.blocked, true);
    assert.equal(diverged.conflicts.length, 1, "a same-path move must stage its record, not strand the operator");
    const record = diverged.conflicts[0]!;
    const manifest = JSON.parse(readFileSync(path.join(record.dir, "manifest.json"), "utf8")) as {
      readonly paths: readonly { readonly path: string }[];
    };
    assert.deepEqual(
      manifest.paths.map((row) => row.path),
      [shared],
    );
    // settlePushRejection with a NON-diverged mirror reports an honest
    // CENTER_REJECTED (blocked=false, nothing staged) instead of claiming
    // CONFLICT_STAGED with no record (F5).
    // Use the peer's clean mirror for the ledger-only rejection branch. The
    // node-one view intentionally still carries the unresolved same-path
    // conflict above; reusing it would test the persistent gate, not the
    // CENTER_REJECTED-without-staging outcome.
    assert.equal((await fixture.edgeDocSync("node-two", { paths: [shared] })).ok, true);
    const peerTwo = {
      hostname: "127.0.0.1",
      port: fixture.center.port,
      ca: readFileSync(path.join(fixture.root, "tls.crt")),
      servername: "localhost",
      nodeId: "node-two",
      credential: "secret-node-two",
      repoId: "dual-repo",
    };
    const clean = await settlePushRejection(
      { ...fixture.channel("node-two"), paths: [] },
      peerTwo,
      30_000,
      "base_ledger_changed",
    );
    assert.equal(clean.blocked, false);
    assert.deepEqual(clean.conflicts, []);
    // F6 idempotency: simulate a crash after the center append by pushing the
    // staged local bytes directly (holder-less shared channel), then retrying
    // the exit — it must settle without a second push.
    const settledRecord = readFleetUnresolvedConflicts(path.join(fixture.root, "node-one-workspace"), "dual-repo").find(
      (entry) => entry.paths.some((row) => row.path === shared),
    )!;
    // The simulated crash happens after the center append has committed the
    // staged local bytes verbatim. A retry must recognize that digest and close
    // the record without appending a second event.
    const stagedLocal = `${baseline}\nEdge one wins.\n`;
    const manual = await fixture.rawWrite("node-one", [
      { path: shared, body: stagedLocal, baseBlobSha256: sha256Bytes(Buffer.from(`${baseline}\nCenter moved.\n`)) },
    ]);
    assert.equal(manual.center.outcome, "applied", JSON.stringify(manual.center));
    const revisionAfterAppend = ledgerRevision(fixture);
    const idempotent = await fixture.conflictExit("node-one", "overwrite-center", settledRecord.conflictId);
    assert.equal(idempotent.ok, true, JSON.stringify(idempotent).slice(0, 400));
    assert.equal((idempotent as { readonly idempotent?: boolean }).idempotent, true);
    const after = JSON.parse(
      readFileSync(
        path.join(
          fixture.root,
          "node-one-workspace",
          ".harness",
          "conflicts",
          settledRecord.conflictId,
          "manifest.json",
        ),
        "utf8",
      ),
    ) as { readonly state: string };
    assert.equal(after.state, "resolved");
    assert.equal(
      ledgerRevision(fixture),
      revisionAfterAppend,
      "the idempotent retry must not append a second doc event",
    );
  },
);

test(
  "F6: an idempotent overwrite reports a newly pull-blocked mirror instead of masking it",
  { timeout: 60_000 },
  async (t) => {
    const fixture: Fixture = await dualSyncFixture();
    t.after(() => fixture.close());
    const shared = "context/shared-notes.md",
      other = "context/other-notes.md";
    const sharedBase = "# Shared\n\nbaseline.\n",
      otherBase = "# Other\n\nbaseline.\n";
    assert.equal((await fixture.rawWrite("node-one", [{ path: shared, body: sharedBase }])).center.outcome, "applied");
    assert.equal((await fixture.rawWrite("node-one", [{ path: other, body: otherBase }])).center.outcome, "applied");
    assert.equal((await fixture.edgeDocSync("node-one")).ok, true);
    const sharedLocal = `${sharedBase}\nedge wins.\n`;
    fixture.writeWorktree("node-one", shared, sharedLocal);
    assert.equal(
      (
        await fixture.rawWrite("node-two", [
          {
            path: shared,
            body: `${sharedBase}\ncenter moved.\n`,
            baseBlobSha256: sha256Bytes(Buffer.from(sharedBase)),
          },
        ])
      ).center.outcome,
      "applied",
    );
    const peer = {
      hostname: "127.0.0.1",
      port: fixture.center.port,
      ca: readFileSync(path.join(fixture.root, "tls.crt")),
      servername: "localhost",
      nodeId: "node-one",
      credential: "secret-node-one",
      repoId: "dual-repo",
    };
    const staged = await settlePushRejection({ ...fixture.channel("node-one") }, peer, 30_000, "base_blob_changed");
    assert.equal(staged.blocked, true);
    const original = staged.conflicts[0]!;
    // A different path diverges after the original record exists. The simulated
    // crashed overwrite then makes only the original path canonical.
    fixture.writeWorktree("node-one", other, `${otherBase}\nedge-local.\n`);
    assert.equal(
      (
        await fixture.rawWrite("node-two", [
          { path: other, body: `${otherBase}\ncenter-new.\n`, baseBlobSha256: sha256Bytes(Buffer.from(otherBase)) },
        ])
      ).center.outcome,
      "applied",
    );
    assert.equal(
      (
        await fixture.rawWrite("node-one", [
          {
            path: shared,
            body: sharedLocal,
            baseBlobSha256: sha256Bytes(Buffer.from(`${sharedBase}\ncenter moved.\n`)),
          },
        ])
      ).center.outcome,
      "applied",
    );
    const retried = await fixture.conflictExit("node-one", "overwrite-center", original.conflictId);
    assert.equal(retried.ok, false, JSON.stringify(retried).slice(0, 600));
    assert.equal((retried as { readonly idempotent?: boolean }).idempotent, true);
    assert.equal((retried as { readonly canonicalOutcome?: string }).canonicalOutcome, "applied");
    assert.equal((retried as { readonly mirrorOutcome?: string }).mirrorOutcome, "pull_blocked");
    const originalState = JSON.parse(readFileSync(path.join(original.dir, "manifest.json"), "utf8")) as {
      readonly state: string;
    };
    assert.equal(originalState.state, "resolved", "the already-canonical overwrite itself is settled");
    assert.ok(
      readFleetUnresolvedConflicts(path.join(fixture.root, "node-one-workspace"), "dual-repo").some((record) =>
        record.paths.some((row) => row.path === other),
      ),
      "the unrelated divergence must remain staged and visible",
    );
  },
);

for (const commandKind of ["task-submit", "task-settle"] as const)
  test(
    `class A ${commandKind} carries closing documents from edge through the center`,
    { timeout: 60_000 },
    async (t) => {
      const originalPath = process.env.PATH,
        bin = mkdtempSync(path.join(tmpdir(), "ha-fleet-ci-"));
      writeFileSync(path.join(bin, "gh"), "#!/usr/bin/env node\nprocess.stdout.write('[]');\n", { mode: 0o755 });
      process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
      t.after(() => {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(bin, { recursive: true, force: true });
      });
      const fixture: Fixture = await dualSyncFixture();
      t.after(() => fixture.close());
      const created = await fixture.createTask("node-one", "task-seeded", "Closing docs ride submit", "docs-task");
      const started = await fixture.edgeTask("node-one", {
        kind: "task-start",
        taskId: created.taskId,
        executionId: "exe-seeded",
      });
      assert.equal(started.ok, true, JSON.stringify(started).slice(0, 400));
      writeFileSync(path.join(fixture.repo, "verification.md"), "Verified fleet documentation delivery.\n");
      const artifactSync = await fixture.centerRun({
        kind: "task-artifact-add",
        taskId: created.taskId,
        source: "verification.md",
        destination: "verification.md",
      });
      assert.equal(artifactSync.outcome, "applied", JSON.stringify(artifactSync).slice(0, 500));
      await fixture.waitPublished(String(artifactSync.opId));
      const artifactPull = await fixture.edgeDocSync("node-one");
      assert.equal(artifactPull.ok, true, JSON.stringify(artifactPull).slice(0, 500));
      // Closing documents start from the published task-start cut; wait before editing the edge copy.
      await fixture.waitPublished(String(started.opId));
      const planPath = `${created.packagePath}/task_plan.md`,
        closeoutPath = `${created.packagePath}/closeout.md`,
        original = readFileSync(fixture.worktree("node-one", planPath), "utf8");
      fixture.writeWorktree("node-one", planPath, `${original}\n## Closing note\n\nRides the submit.\n`);
      fixture.writeWorktree(
        "node-one",
        closeoutPath,
        "# Closeout\n\n## Summary\n\nFleet documentation delivery is ready.\n\n" +
          "## Verification\n\nVerified by the dual-sync integration fixture.\n\n" +
          "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNo other path in this fixture.\n",
      );
      const reportPath = `${created.packagePath}/artifacts/verification.md`,
        correctedReport = "Corrected Fleet job=41; SQL 0–336h.\n";
      fixture.writeWorktree("node-one", reportPath, correctedReport);
      const beforeSubmit = ledgerRevision(fixture);
      const submitted = await fixture.edgeTask("node-one", {
        kind: commandKind,
        taskId: created.taskId,
        ...(commandKind === "task-submit" ? { executionId: "exe-seeded" } : {}),
      });
      assert.equal(submitted.ok, true, JSON.stringify(submitted).slice(0, 500));
      assert.equal(
        (submitted as { readonly docSync?: { readonly outcome?: string; readonly paths?: readonly string[] } }).docSync
          ?.outcome,
        "applied",
      );
      assert.deepEqual(
        (submitted as { readonly docSync?: { readonly paths?: readonly string[] } }).docSync?.paths?.slice().sort(),
        [closeoutPath, planPath, reportPath].sort(),
      );
      assert.match(readFileSync(fixture.worktree("node-one", planPath), "utf8"), /Closing note/u);
      const reader = makeTaskEventReader({ repoId: "dual-repo", rootDir: fixture.repo });
      t.after(() => reader.drain());
      const event = reader.read().events.find((event) => event.opId === submitted.opId);
      assert.ok(event && event.schema === "task-event/v1" && event.type === "execution_submitted");
      assert.equal(event.workspaceRevision, beforeSubmit + 1, "documents and submission accept in one event");
      const submission = event.payload.execution.submission!;
      assert.equal(submission.commitSha, null);
      const anchor = submission.artifacts!.find((anchor) => anchor.path === reportPath)!;
      assert.equal(anchor.revision, event.workspaceRevision);
      assert.equal(anchor.blobSha256, sha256Bytes(Buffer.from(correctedReport)));
      assert.ok(
        event.payload.carriedDocumentClaims?.some(
          (claim) => claim.path === reportPath && claim.candidate?.sha256 === anchor.blobSha256,
        ),
      );
      const reviewCell = {
        store: reader,
        cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
      };
      assert.equal(
        readSubmissionArtifact(reviewCell, created.packagePath, anchor.path, anchor.revision, anchor.blobSha256).body,
        correctedReport,
      );
      console.log(
        JSON.stringify({
          entry: commandKind,
          acceptance: event.opId,
          revision: event.workspaceRevision,
          artifactRevision: anchor.revision,
          reportPath,
        }),
      );
      if (commandKind === "task-settle") {
        const replay = await fixture.edgeTask("node-one", { kind: "task-settle", taskId: created.taskId });
        assert.equal(replay.ok, true, JSON.stringify(replay).slice(0, 1000));
        assert.equal(replay.opId, submitted.opId, "same node resumes the same cut after replica pull");
        const foreign = await fixture.edgeTask("node-two", { kind: "task-settle", taskId: created.taskId });
        assert.equal(foreign.ok, false, JSON.stringify(foreign));
        const changedCloseout = readFileSync(fixture.worktree("node-one", closeoutPath), "utf8").replace(
          "Verified by the dual-sync integration fixture.",
          "Amended verification from edge.",
        );
        fixture.writeWorktree("node-one", closeoutPath, changedCloseout);
        const changed = await fixture.edgeTask("node-one", { kind: "task-settle", taskId: created.taskId });
        assert.equal(changed.ok, false, JSON.stringify(changed));
        assert.match(JSON.stringify(changed), /amend/u);
        const amended = await fixture.edgeTask("node-one", {
          kind: "task-submit",
          taskId: created.taskId,
          amend: true,
        });
        assert.equal(amended.ok, true, JSON.stringify(amended).slice(0, 1500));
        // `applied` certifies SQLite acceptance only; the center worktree is materialized
        // by the WAL→Git follower on its own stage. Wait for the receipt's
        // worktree_visible facet before reading the file, as createTask does.
        const amendedPublication = (await fixture.centerRun({
          kind: "receipt-show",
          opId: amended.opId,
          waitFor: ["worktree_visible"],
          timeoutMs: 5000,
        })) as { readonly wait?: { readonly state?: string } };
        assert.equal(amendedPublication.wait?.state, "satisfied", JSON.stringify(amendedPublication));
        assert.match(
          readFileSync(path.join(fixture.repo, "harness", closeoutPath), "utf8"),
          /Amended verification from edge/u,
        );
      }
    },
  );

// Raw Task artifact bytes across the fleet. The publication and local read sides were proved in
// doc-sync-artifact-raw-bytes / task-raw-artifact-consumer-read; what is unproven until here is the
// transfer: a PDF and a PNG accepted at the center have to arrive on an edge as the same bytes, and
// the edge has to say something actionable about a raw file it cannot push back.
const rawPdf = Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    Buffer.from([0xff, 0xd8, 0x00, 0x1a, 0x80, 0xfe]),
    Buffer.from("\n%%EOF\n"),
  ]),
  rawPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x0a, 0x80]);

// The claim "these bytes survived" is only worth making about bytes a UTF-8 round trip destroys.
function utf8RoundTripDestroys(bytes: Buffer): boolean {
  return !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
}

test(
  "a raw task artifact accepted at the center reaches an edge replica as the exact bytes",
  { timeout: 90_000 },
  async (t) => {
    const fixture: Fixture = await dualSyncFixture();
    t.after(() => fixture.close());
    assert.ok(utf8RoundTripDestroys(rawPdf) && utf8RoundTripDestroys(rawPng), "the fixture bytes must not be UTF-8");
    const created = await fixture.createTask("node-one", "task_RAW0000000000000000000RAW", "Raw artifact replica"),
      artifacts = [
        { source: "dossier.pdf", destination: "reports/dossier.pdf", bytes: rawPdf },
        { source: "logo.png", destination: "screenshots/logo.png", bytes: rawPng },
      ];
    for (const artifact of artifacts) {
      writeFileSync(path.join(fixture.repo, artifact.source), artifact.bytes);
      const added = await fixture.centerRun({
        kind: "task-artifact-add",
        taskId: created.taskId,
        source: artifact.source,
        destination: artifact.destination,
      });
      assert.equal(added.outcome, "applied", `${artifact.destination}: ${JSON.stringify(added).slice(0, 400)}`);
      await fixture.waitPublished(String(added.opId));
      // The source is gone before anything is compared: whatever the edge shows came over the wire.
      rmSync(path.join(fixture.repo, artifact.source), { force: true });
    }
    for (const nodeId of ["node-one", "node-two"] as const) {
      const synced = await fixture.edgeDocSync(nodeId);
      assert.equal(synced.ok, true, `${nodeId}: ${JSON.stringify(synced).slice(0, 500)}`);
      const view = fixture.view(nodeId);
      assert.ok(view, `${nodeId} has no replica view`);
      for (const artifact of artifacts) {
        const logical = `${created.packagePath}/artifacts/${artifact.destination}`,
          entry = view.entries.get(logical);
        assert.ok(entry, `${nodeId} replica manifest is missing ${logical}`);
        assert.equal(entry.sha256, sha256Bytes(artifact.bytes));
        assert.equal(entry.size, artifact.bytes.byteLength);
        assert.equal(entry.mediaType, "application/octet-stream", "the replica entry must carry the raw media type");
        const mirrored = readFileSync(fixture.worktree(nodeId, logical));
        assert.deepEqual(mirrored, artifact.bytes, `${nodeId} materialized ${logical} with different bytes`);
        assert.equal(sha256Bytes(mirrored), entry.sha256);
      }
    }
    // Discriminating control: the same transfer under a string body would have produced the UTF-8
    // replacement bytes below, which is what an equality assertion on a decoded body would accept.
    const decoded = Buffer.from(
      readFileSync(fixture.worktree("node-two", `${created.packagePath}/artifacts/reports/dossier.pdf`)).toString(
        "utf8",
      ),
      "utf8",
    );
    assert.notDeepEqual(decoded, rawPdf, "a UTF-8 round trip must not reproduce the artifact");
  },
);

test(
  "a raw artifact authored on an edge is reported with its owning route instead of silently skipped",
  { timeout: 90_000 },
  async (t) => {
    const fixture: Fixture = await dualSyncFixture();
    t.after(() => fixture.close());
    const created = await fixture.createTask("node-one", "task_EDGE000000000000000000RAW", "Edge raw artifact"),
      logical = `${created.packagePath}/artifacts/edge-capture.png`,
      target = fixture.worktree("node-one", logical);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, rawPng);
    const status = await fixture.edgeDocSync("node-one", { dryRun: true });
    const rows = (status.rows ?? []) as readonly { readonly path: string }[],
      blocked = (status.blocked ?? []) as readonly {
        readonly path: string;
        readonly reason: string;
        readonly requiredRoute?: string;
        readonly code?: string;
      }[];
    assert.equal(
      rows.some((row) => row.path === logical),
      false,
      "a raw artifact must not become a doc-sync prose candidate",
    );
    const report = blocked.find((row) => row.path === logical);
    assert.ok(report, `the edge hid the raw artifact instead of reporting it: ${JSON.stringify(status).slice(0, 600)}`);
    assert.equal(report.requiredRoute, "typed-binary-content");
    assert.equal(report.code, "raw_artifact_outside_doc_sync");
    assert.match(report.reason, /ha task artifact add/u);
    // The local file is not touched by the report, and no push carried it.
    assert.deepEqual(readFileSync(target), rawPng);
    const pushed = await fixture.edgeDocSync("node-one");
    assert.equal(
      fixture.view("node-one")?.entries.has(logical) ?? false,
      false,
      `the edge push must not invent a center document: ${JSON.stringify(pushed).slice(0, 400)}`,
    );
  },
);

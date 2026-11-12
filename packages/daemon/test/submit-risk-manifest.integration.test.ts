// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  compileTaskLifecycleWrite,
  applyTransition,
  emptyTaskLifecycleSnapshot,
  lifecycleDocumentPaths,
  normalizeTaskLifecycleCommand,
  sha256Text,
  submissionDigest,
} from "@harness-anything/kernel";
import { reduceTaskEvent } from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import { openSqliteEventStore } from "@harness-anything/storage";
import { executionId, fixture, taskId } from "./task-completion-review.fixture.ts";

async function deliveryFixture(t: test.TestContext, artifactOnly = false) {
  const f = await fixture(false, false, false, false, false, {
    autoSubmit: false,
    create: { presetId: "standard-task" },
  });
  t.after(() => f.close());
  await f.cell().settlePendingMaterialization("risk manifest fixture");
  const worktree = path.join(f.root, ".worktrees", taskId);
  if (!artifactOnly) {
    writeFileSync(path.join(worktree, "delivery.txt"), "Manifest retry delivery.\n");
    execFileSync("git", ["-C", worktree, "add", "delivery.txt"]);
    execFileSync("git", ["-C", worktree, "commit", "-qm", "test: manifest retry delivery"]);
  }
  const closeout = path.join(f.root, "harness", f.packagePath, "closeout.md");
  writeFileSync(closeout, "## Summary\nFrozen delivery.\n## Verification\nDirected test.\n## Residual Risk\nNone.\n");
  return { f, closeout };
}

async function seedHistoricalCut(f: Awaited<ReturnType<typeof fixture>>, legacy: boolean) {
  let snapshot = emptyTaskLifecycleSnapshot();
  for (const event of f.events()) {
    if ((event.schema === "task-event/v1" || event.schema === "task-bootstrap-event/v1") && event.taskId === taskId)
      snapshot = reduceTaskEvent(snapshot, event);
  }
  const original = f.events().findLast((event) => event.type === "execution_submitted");
  assert.ok(original?.type === "execution_submitted");
  const frozen = original.payload.execution.submission!;
  assert.ok(frozen.riskTierAssessment, "the modern seed owns its frozen assessment");
  const { riskTierAssessment: _assessment, ...withoutAssessment } = frozen;
  assert.ok(frozen.artifacts?.length, "historical cut contains accepted artifact anchors");
  const historical = {
    ...(legacy ? withoutAssessment : frozen),
    outputs: [
      ...frozen.outputs.filter((output) => !output.startsWith("Artifact-Anchor: ")),
      ...frozen.artifacts.map((anchor) => `Artifact-Anchor: ${anchor.path}@${anchor.revision}`),
    ],
  };
  await f.cell().settlePendingMaterialization("seed historical risk-less cut");
  await f.cell().close();
  const store = openSqliteEventStore({ repoId: "completion-review", rootInput: f.root }),
    fence = { repoId: "completion-review", holder: "direct-store", epoch: (store.writerFence()?.epoch ?? 0) + 1 };
  try {
    store.claimWriter(fence);
    const command = {
        ...normalizeTaskLifecycleCommand(
          {
            workspaceId: "completion-review",
            actor: original.actor,
            source: "local",
            expectedRevision: snapshot.revision,
          },
          { type: "SubmitExecution", taskId, executionId, submission: historical, amend: true },
        ),
        eventId: sha256Text("historical-risk-less-submission"),
        workspaceRevision: store.revision() + 1,
        occurredAt: new Date().toISOString(),
      },
      changed = applyTransition(snapshot, command, {
        actorBinding: original.actor,
        leaseVersion: null,
        sessionDisposition: "unavailable",
      }),
      event = changed.event,
      written = compileTaskLifecycleWrite({
        event,
        snapshot: reduceTaskEvent(snapshot, event),
        packagePath: f.packagePath,
        currentDocuments: lifecycleDocumentPaths(event, f.packagePath).flatMap((target) => {
          const head = store.documentHead(target);
          return head && head !== "retired"
            ? [
                {
                  path: target,
                  body: Buffer.from(store.readContentObject(head.sha256)!).toString("utf8"),
                  blobSha256: head.sha256,
                },
              ]
            : [];
        }),
      });
    // Seed an old canonical cut through the offline append port, with correctly compiled documents.
    // Every resume below still traverses the actual RepoCell command runner and lifecycle writer.
    store.appendCommand({
      fence,
      intent: { opId: event.opId, intentDigest: command.commandDigest, summary: "historical cut" },
      events: [written.event],
      blobs: written.blobs,
    });
    store.releaseWriter(fence);
  } finally {
    store.close();
  }
  await f.reopen();
  await f.cell().settlePendingMaterialization("publish historical fixture");
}

for (const legacy of [false, true]) {
  for (const invalid of ["json", "schema", "unreadable"] as const) {
    test(`${legacy ? "legacy" : "assessed"} frozen resume survives ${invalid} manifest; changed amendment refuses`, async (t) => {
      const { f, closeout } = await deliveryFixture(t),
        submitted = await f.run({ kind: "task-submit", taskId, executionId });
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      await seedHistoricalCut(f, legacy);
      const cuts = () => f.events().filter((event) => event.type === "execution_submitted"),
        frozen = cuts().at(-1)!;
      assert.ok(frozen.type === "execution_submitted");
      assert.equal(frozen.payload.execution.submission?.riskTierAssessment === undefined, legacy);
      const count = cuts().length,
        manifest = path.join(f.root, "tools", "task-risk-manifest.json");
      mkdirSync(path.dirname(manifest), { recursive: true });
      if (invalid === "unreadable") mkdirSync(manifest);
      else writeFileSync(manifest, invalid === "json" ? "{" : '{"schema":"invalid","scripts":[]}');
      for (const kind of ["task-submit", "task-settle"] as const) {
        const resumed = await f.run({ kind, taskId, executionId });
        assert.equal(resumed.outcome, "applied", JSON.stringify(resumed));
        assert.equal(resumed.opId, frozen.opId, "resume keeps the frozen operation identity");
        assert.equal(cuts().length, count, "resume appends no new submission");
        assert.equal(
          submissionDigest(cuts().at(-1)!.payload.execution.submission!),
          submissionDigest(frozen.payload.execution.submission!),
        );
      }
      writeFileSync(closeout, readFileSync(closeout, "utf8").replace("Frozen delivery.", "Changed delivery claim."));
      const changed = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      assert.equal(changed.outcome, "op_rejected", JSON.stringify(changed));
      assert.match(JSON.stringify(changed), /task-risk-manifest\.json/u);
      assert.equal(cuts().length, count, "an invalid manifest never freezes a changed cut");
      console.log(
        `[manifest-resume:${legacy ? "legacy" : "assessed"}:${invalid}] submit/settle=same-op changed=${changed.code}`,
      );
    });
  }
}

test("an invalid manifest refuses a first submission", async (t) => {
  const { f } = await deliveryFixture(t),
    manifest = path.join(f.root, "tools", "task-risk-manifest.json");
  mkdirSync(path.dirname(manifest), { recursive: true });
  writeFileSync(manifest, "{");
  const rejected = await f.run({ kind: "task-submit", taskId, executionId });
  assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
  assert.match(JSON.stringify(rejected), /task-risk-manifest\.json/u);
  assert.equal(
    f.events().some((event) => event.type === "execution_submitted"),
    false,
  );
});

for (const artifactOnly of [false, true]) {
  for (const legacy of [false, true]) {
    test(`${artifactOnly ? "artifact-only" : "code"} ${legacy ? "legacy" : "assessed"} historical anchor outputs resume exactly and disappear on amendment`, async (t) => {
      const { f } = await deliveryFixture(t, artifactOnly);
      const submitted = await f.run({ kind: "task-submit", taskId, executionId });
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      await seedHistoricalCut(f, legacy);
      const cuts = () => f.events().filter((event) => event.type === "execution_submitted"),
        frozen = cuts().at(-1)!,
        original = frozen.payload.execution.submission!,
        bytes = JSON.stringify(original),
        digest = submissionDigest(original),
        count = cuts().length;
      assert.equal(original.commitSha === null, artifactOnly);
      assert.ok(original.outputs.some((output) => output.startsWith("Artifact-Anchor: ")));
      for (const kind of ["task-submit", "task-settle", "task-submit"] as const) {
        const resumed = await f.run({ kind, taskId, executionId });
        assert.equal(resumed.outcome, "applied", JSON.stringify(resumed));
        assert.equal(resumed.opId, frozen.opId);
        assert.equal(cuts().length, count);
        assert.equal(JSON.stringify(cuts().at(-1)!.payload.execution.submission), bytes);
        assert.equal(submissionDigest(cuts().at(-1)!.payload.execution.submission!), digest);
      }
      const amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      assert.equal(amended.outcome, "applied", JSON.stringify(amended));
      assert.notEqual(amended.opId, frozen.opId);
      const current = cuts().at(-1)!.payload.execution.submission!;
      assert.deepEqual(current.outputs, []);
      assert.deepEqual(current.artifacts, original.artifacts);
      assert.notEqual(submissionDigest(current), digest);
      const artifact = current.artifacts![0]!,
        artifactFile = path.join(f.root, "harness", artifact.path);
      writeFileSync(artifactFile, `${readFileSync(artifactFile, "utf8")}\nUpdated accepted artifact.\n`);
      const docs = await f.run({ kind: "doc-submit", taskId });
      assert.equal(docs.outcome, "applied", JSON.stringify(docs));
      const driftedResume = await f.run({ kind: "task-submit", taskId, executionId });
      assert.equal(driftedResume.outcome, "op_rejected", JSON.stringify(driftedResume));
      assert.match(JSON.stringify(driftedResume), /anchored artifacts differ/u);
      const driftedAmend = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      assert.equal(driftedAmend.outcome, "applied", JSON.stringify(driftedAmend));
      assert.match(JSON.stringify(driftedAmend), /Anchored artifact deliveries changed/u);
      const changed = cuts().at(-1)!.payload.execution.submission!;
      assert.deepEqual(changed.outputs, []);
      assert.notDeepEqual(changed.artifacts, current.artifacts);
    });
  }
}

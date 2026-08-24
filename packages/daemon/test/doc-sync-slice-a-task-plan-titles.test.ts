// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyTextualArtifactPath,
  compileTaskLifecycleWrite,
  makeTaskEventStore,
  makeTaskProjection,
  rebuildTaskProjection,
  reduceTaskEvent,
  sha256Text,
} from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

import { actor, blockedReason, initRepo, rows, write } from "./doc-sync-slice-a.fixtures.ts";
// F-42D28979/F-F4814511: a task plan whose H1 no longer matches the ledger
// title is the highest-frequency doc-sync block; the receipt must name the
// mechanical fix, and following it verbatim must leave the healed task idempotent.
test("a renamed task plan H1 receipt names the exact title restore and the heal is idempotent", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-h1-restore-"));
  initRepo(rootDir);
  const repoId = workspaceId("h1-restore"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "h1-restore-daemon",
    }),
    binding = { actor, source: "local" as const },
    taskId = "task_H1REST0RE000000000000AAAAA",
    title = "很长的自解释标题:带括号与路径的完整 create title";
  try {
    const created = (await cell.run({ kind: "task-create", taskId, title }, binding)) as { packagePath?: string },
      plan = `${created.packagePath}/task_plan.md`,
      target = path.join(rootDir, "harness", plan);
    const scaffold = readFileSync(target, "utf8");
    assert.match(
      scaffold.split("\n")[0] ?? "",
      new RegExp(`^# ${title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"),
    );
    writeFileSync(target, scaffold.replace(`# ${title}`, "# 好读的短标题"));
    const restore = new RegExp(
      `restore the H1 of ${plan.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} to the task title verbatim \\("# ${title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"\\), then rerun ha doc sync --submit --path ${plan.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`,
      "u",
    );
    const status = (await cell.run({ kind: "doc-status", paths: [plan] }, binding)) as {
      detail?: { nextAction?: string };
    };
    assert.equal(rows((await cell.run({ kind: "doc-status", paths: [plan] }, binding)).evidence)[0]?.state, "blocked");
    assert.match(status.detail?.nextAction ?? "", restore);
    const rejected = (await cell.run({ kind: "doc-submit", paths: [plan] }, binding)) as {
      outcome?: string;
      code?: string;
      nextAction?: string;
    };
    assert.equal(rejected.outcome, "op_rejected");
    assert.equal(rejected.code, "preview_blocked");
    assert.match(rejected.nextAction ?? "", restore);
    writeFileSync(target, readFileSync(target, "utf8").replace("# 好读的短标题", `# ${title}`));
    const healed = await cell.run({ kind: "doc-submit", taskId }, binding);
    assert.equal(healed.outcome, "no_changes", JSON.stringify(healed));
    assert.equal(healed.code, "no_changes", JSON.stringify(healed));
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("amending the title retitles the published plan through the typed route and the plan stays prose-submittable", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-amend-retitle-"));
  initRepo(rootDir);
  const repoId = workspaceId("amend-retitle"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "amend-retitle-daemon",
    }),
    binding = { actor, source: "local" as const },
    taskId = "task_AMENDRETITLE000000AAAAAA",
    firstTitle = "amend retitle first title",
    secondTitle = "amend retitle second title";
  try {
    const created = (await cell.run({ kind: "task-create", taskId, title: firstTitle }, binding)) as {
        packagePath?: string;
      },
      plan = `${created.packagePath}/task_plan.md`,
      target = path.join(rootDir, "harness", plan);
    const scaffold = readFileSync(target, "utf8");
    assert.match(scaffold.split("\n")[0] ?? "", /^# amend retitle first title$/u);
    writeFileSync(target, `${scaffold}\n## Worker Notes\n\nfirst round of worker prose\n`);
    assert.equal(
      (await cell.run({ kind: "doc-submit", paths: [plan] }, binding)).outcome,
      "applied",
      JSON.stringify(await cell.run({ kind: "doc-status", paths: [plan] }, binding)),
    );
    const amended = (await cell.run(
      {
        kind: "task-amend",
        taskId,
        patches: [{ field: "title", value: secondTitle }],
      },
      binding,
    )) as { outcome?: string; opId?: string; changedPaths?: readonly string[] };
    assert.equal(amended.outcome, "applied", JSON.stringify(amended));
    assert.ok(
      amended.changedPaths?.includes(plan),
      `amend changedPaths must retitle the plan: ${JSON.stringify(amended.changedPaths)}`,
    );
    const retitled = readFileSync(target, "utf8");
    assert.match(retitled.split("\n")[0] ?? "", /^# amend retitle second title$/u);
    assert.match(retitled, /## Worker Notes\n\nfirst round of worker prose/u);
    const amendEvent = makeTaskEventStore({ repoId, rootDir }).readEvent(amended.opId!);
    assert.equal(amendEvent?.type, "task_amended");
    if (amendEvent?.type === "task_amended") {
      const planClaim = amendEvent.payload.documentClaims.find((claim) => claim.path === plan);
      assert.ok(planClaim, "amend event must claim the retitled plan");
      assert.equal(planClaim.policyId, "markdown-body-replaceable/v1");
    }
    rebuildTaskProjection({ rootDir });
    const projected = (await cell.run({ kind: "doc-show", path: plan }, binding)) as { evidence?: string };
    assert.match((projected.evidence ?? "").split("\n")[0] ?? "", /^# amend retitle second title$/u);
    writeFileSync(target, retitled.replace("first round of worker prose", "second round of worker prose"));
    const status = await cell.run({ kind: "doc-status", paths: [plan] }, binding);
    assert.equal(rows(status.evidence)[0]?.state, "eligible", JSON.stringify(status));
    const resubmitted = await cell.run({ kind: "doc-submit", paths: [plan] }, binding);
    assert.equal(resubmitted.outcome, "applied", JSON.stringify(resubmitted));
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a no-op title amend heals a plan whose canonical base still holds the pre-amend H1", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-amend-noop-"));
  initRepo(rootDir);
  const repoId = workspaceId("amend-noop"),
    taskId = "task_AMENDNOOP000000000AAAAA",
    firstTitle = "no-op amend first title",
    secondTitle = "no-op amend second title";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "amend-noop-daemon",
    });
    const binding = { actor, source: "local" as const };
    const created = (await cell.run({ kind: "task-create", taskId, title: firstTitle }, binding)) as {
        packagePath?: string;
      },
      packagePath = created.packagePath!,
      plan = `${packagePath}/task_plan.md`,
      target = path.join(rootDir, "harness", plan);
    const initialSync = await cell.run({ kind: "doc-submit", taskId }, binding);
    assert.equal(initialSync.outcome, "no_changes", JSON.stringify(initialSync));
    assert.equal(initialSync.code, "no_changes", JSON.stringify(initialSync));
    // Seed the stock shape directly: a title amend whose ledger was written before the typed
    // retitle existed (claims INDEX + contract only), so canonical keeps the old-H1 plan base
    // while the ledger title — and the worker's local H1 — already moved on.
    await cell.close();
    cell = undefined;
    const store = makeTaskEventStore({ repoId, rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store }),
      read = projection.read(taskId),
      opId = "op-amend-noop-seed";
    const seedEvent = {
      schema: "task-event/v1",
      eventId: `event-${opId}`,
      workspaceRevision: (store.readHead()?.revision ?? 0) + 1,
      opId,
      taskId,
      type: "task_amended",
      actor,
      source: "local",
      occurredAt: "2026-08-23T00:00:00.000Z",
      payload: {
        task: { ...read.snapshot.task!, title: secondTitle },
        mutation: {
          command: "amend",
          reason: "declared retitle before the typed plan route existed",
          fields: ["title"],
        },
        documentClaims: [],
      },
    } as unknown as import("../../kernel/src/index.ts").TaskEventV1;
    const compiled = compileTaskLifecycleWrite({
      event: seedEvent,
      snapshot: reduceTaskEvent(read.snapshot, seedEvent),
      packagePath,
      currentDocuments: ["INDEX.md", "task-contract.json"].map((leaf) => {
        const document = projection.readDocument(`${packagePath}/${leaf}`).document!;
        return {
          path: document.path,
          body: document.body,
          blobSha256: document.blobSha256,
        };
      }),
    });
    assert.equal(compiled.changedPaths.includes(plan), false);
    store.append(compiled);
    projection.close();
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "amend-noop-replay",
    });
    const workerBody = readFileSync(target, "utf8")
      .replace(`# ${firstTitle}`, `# ${secondTitle}`)
      .concat("\n## Drift\n\nworker prose written under the already-renamed H1\n");
    writeFileSync(target, workerBody);
    const blocked = await cell.run({ kind: "doc-status", paths: [plan] }, binding);
    assert.equal(rows(blocked.evidence)[0]?.state, "blocked", JSON.stringify(blocked));
    assert.match(blockedReason(blocked.evidence), /base region is missing: "# no-op amend first title"/u);
    const noop = (await cell.run(
      {
        kind: "task-amend",
        taskId,
        patches: [{ field: "title", value: secondTitle }],
      },
      binding,
    )) as { outcome?: string; changedPaths?: readonly string[] };
    assert.equal(noop.outcome, "applied", JSON.stringify(noop));
    assert.ok(
      noop.changedPaths?.includes(plan),
      `no-op amend must retitle the plan: ${JSON.stringify(noop.changedPaths)}`,
    );
    // The typed settle preserves the unmerged worker edit as conflict scratch and lays down the
    // retitled base; merging the scratch back by hand restores the worker body on the fresh base.
    const scratches = readdirSync(path.dirname(target)).filter((name) =>
      /^task_plan\.conflict-[0-9a-f]{8}\.md$/u.test(name),
    );
    assert.equal(scratches.length, 1, `expected one conflict scratch, found ${JSON.stringify(scratches)}`);
    writeFileSync(target, workerBody);
    rmSync(path.join(path.dirname(target), scratches[0]!));
    const healed = await cell.run({ kind: "doc-status", paths: [plan] }, binding);
    assert.equal(rows(healed.evidence)[0]?.state, "eligible", JSON.stringify(healed));
    assert.equal((await cell.run({ kind: "doc-submit", paths: [plan] }, binding)).outcome, "applied");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("authored CRLF prose is canonicalized on scanner read and submitted as LF", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-crlf-"));
  initRepo(rootDir);
  const repoId = workspaceId("crlf"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "crlf-daemon",
    }),
    binding = { actor, source: "local" as const },
    logical = "context/crlf.md",
    canonical = "# CRLF\n\naccepted\n";
  try {
    write(rootDir, logical, canonical.replace(/\n/gu, "\r\n"));
    const submitted = await cell.run({ kind: "doc-submit", paths: [logical] }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const event = makeTaskEventStore({ repoId, rootDir }).readEvent(submitted.opId);
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1") {
      assert.equal(event.payload.changes[0]?.candidate.sha256, sha256Text(canonical));
      assert.equal(event.payload.changes[0]?.candidate.size, Buffer.byteLength(canonical));
    }
    assert.equal(readFileSync(path.join(rootDir, "harness", logical), "utf8"), canonical);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanner textual artifacts use the canonical classifier", () => {
  const opaque = "tasks/task-one/artifacts/scripts/report.mjs";
  assert.deepEqual(classifyTextualArtifactPath(opaque), {
    kind: "opaque-textual",
    mediaType: "text/javascript",
    policyId: "opaque-textual-whole-file/v1",
  });
});

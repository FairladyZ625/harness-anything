// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { fetchCiObservations, ingestCiObservations } from "../src/ci-observation-actions.ts";
import {
  makeTaskEventReader,
  makeTaskEventStore,
  makeTaskProjection,
  readDaemonRegistry,
} from "../../kernel/src/index.ts";
import { WRITE_RECEIPT_SCHEMA } from "../../kernel/src/index.ts";
import { validateWriteReceipt } from "../../kernel/test/contracts/receipt-acceptance.fixtures.ts";
import { reviewDigest } from "../../kernel/src/index.ts";
import {
  canonicalRoot,
  validateDaemonTaskSnapshotList,
  workspaceId,
} from "../src/protocol/daemon-protocol.contract.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { openRepoCell as openProductRepoCell } from "../src/repo-cell.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
const DOC_POLICY_ID = "markdown-body-replaceable/v1";
function assertValidWriteReceipt(value: unknown): void {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const allowed = new Set([...WRITE_RECEIPT_SCHEMA.required, ...WRITE_RECEIPT_SCHEMA.optional]),
    receipt = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => allowed.has(key)));
  assert.deepEqual(validateWriteReceipt(receipt), []);
}
async function waitForAcceptedReceipt(
  cell: Awaited<ReturnType<typeof openProductRepoCell>>,
  accepted: { readonly opId: string; readonly acceptance?: { readonly revisionTo?: number } | null },
  binding = repoWriteBinding,
  waitFor: readonly ("accepted_durable" | "projection_visible" | "git_verified" | "worktree_visible")[] = [
    "accepted_durable",
    "projection_visible",
    "git_verified",
    "worktree_visible",
  ],
): Promise<Awaited<ReturnType<typeof cell.run>>> {
  const shown = await cell.run({ kind: "receipt-show", opId: accepted.opId, waitFor, timeoutMs: 5_000 }, binding);
  assert.equal(shown.status, "accepted_durable", JSON.stringify(shown));
  assert.equal(shown.acceptance?.revisionTo, accepted.acceptance?.revisionTo);
  return shown;
}
const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;
const repoWriteBinding = withRoleBinding({ actor, source: "local" as const }, "repo-write");
// prettier-ignore

test("projection rebuild repairs a repository that has no authored settings document", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-projection-rebuild-bare-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openProductRepoCell({ repoId: workspaceId("projection-rebuild-bare"), rootDir: canonicalRoot(rootDir), ownerId: "projection-rebuild-bare" });
    const repaired = await cell.run({ kind: "projection-rebuild" }, repoWriteBinding) as Record<string, unknown>;
    assert.equal(repaired.outcome, "applied", JSON.stringify(repaired)); assert.equal(repaired.revision, 0); assert.deepEqual(makeTaskEventReader({ repoId: "projection-rebuild-bare", rootDir }).read().events, []);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});
// prettier-ignore

test("replay receipts retain their SQLite cut while Git identity settles independently", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-replay-current-cut-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("replay-current-cut"), rootDir: canonicalRoot(rootDir), ownerId: "replay-current-cut" }); const binding = repoWriteBinding; const created = await cell.run({ kind: "task-create", taskId: "task_replay_first", title: "First" }, binding); const createdVisible = await waitForAcceptedReceipt(cell, created, binding); assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible)); await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding)); const first = await cell.run({ kind: "task-start", taskId: "task_replay_first", executionId: "execution_replay_first" }, binding) as Record<string, unknown>, second = await cell.run({ kind: "task-create", taskId: "task_replay_second", title: "Second" }, binding) as Record<string, unknown>, replay = await cell.run({ kind: "receipt-show", opId: first.opId }, binding) as Record<string, unknown>; assert.notDeepEqual(first.cut, second.cut); assert.deepEqual(replay.cut, first.cut); assert.equal(replay.status, "accepted_durable"); await cell.close(); cell = await openRepoCell({ repoId: workspaceId("replay-current-cut"), rootDir: canonicalRoot(rootDir), ownerId: "replay-current-cut-reopened" }); const materialized = await waitForAcceptedReceipt(cell, first as { opId: string; acceptance?: { revisionTo?: number } | null }, binding, ["accepted_durable", "projection_visible", "git_verified"]); assert.equal(materialized.git.state, "verified"); assert.deepEqual(materialized.cut, first.cut); }
  finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});
// prettier-ignore

test("task create dry-run validates the exact package without event, revision, commit, or authored writes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-create-preview-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); mkdirSync(path.join(rootDir, "harness/custom"), { recursive: true }); mkdirSync(path.join(rootDir, "harness/templates"), { recursive: true }); writeFileSync(path.join(rootDir, "harness/harness.yaml"), "settings:\n  scaffolds:\n    task: custom/task-scaffold.json\n"); writeFileSync(path.join(rootDir, "harness/templates/notes.md"), "# Notes\n\n## Project Notes\n\nCustom.\n"); writeFileSync(path.join(rootDir, "harness/custom/task-scaffold.json"), `${JSON.stringify({ schema: "task-scaffold/v1", replaceTemplate: [], addDocument: [{ slot: "project.notes", path: "notes.md", template: "templates/notes.md", requiredAnchors: ["## Project Notes"] }] })}\n`); cell = await openRepoCell({ repoId: workspaceId("preview"), rootDir: canonicalRoot(rootDir), ownerId: "preview-daemon" }); const action = { kind: "task-create", taskId: "task-preview", title: "Preview Package" } as const, baselineRevision = makeTaskEventReader({ repoId: "preview", rootDir }).read().revision, before = git(rootDir, "rev-parse", "HEAD"), preview = await cell.run({ ...action, dryRun: true }, repoWriteBinding) as Record<string, unknown>; assert.equal(preview.outcome, "pending"); assert.equal(preview.packagePath, "tasks/task-preview-preview-package"); assert.equal(preview.dryRun, true); assert.equal((preview.generatedPaths as string[]).length, 6); assert.equal((preview.generatedPaths as string[]).includes("tasks/task-preview-preview-package/notes.md"), true); assert.equal(makeTaskEventReader({ repoId: "preview", rootDir }).read().revision, baselineRevision); assert.equal(git(rootDir, "rev-parse", "HEAD"), before); assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-preview-preview-package")), false);
    const created = await cell.run(action, repoWriteBinding) as Record<string, unknown>; assert.equal(created.packagePath, preview.packagePath); assert.equal(created.presetDigest, preview.presetDigest); assert.equal(created.scaffoldDigest, preview.scaffoldDigest); assert.equal(typeof created.cut, "object"); assert.equal((created.guidance as { kind: string }[]).some(({ kind }) => kind === "task-create-start"), true); const settled = await waitForAcceptedReceipt(cell, created as { opId: string; acceptance?: { revisionTo?: number } | null }, repoWriteBinding); assert.deepEqual(settled.wait, { state: "satisfied", unsatisfied: [] }); assert.equal(settled.worktree.state, "verified"); assert.equal(execFileSync("git", ["show", "HEAD:harness/tasks/task-preview-preview-package/notes.md"], { cwd: rootDir, encoding: "utf8" }), "# Notes\n\n## Project Notes\n\nCustom.\n"); assert.equal(readFileSync(path.join(rootDir, "harness/custom/task-scaffold.json"), "utf8").includes('"project.notes"'), true); assert.equal(makeTaskEventReader({ repoId: "preview", rootDir }).read().revision, baselineRevision + 1); const duplicate = await cell.run({ ...action, title: "Different title" }, repoWriteBinding); assert.equal(duplicate.outcome, "op_rejected"); assert.equal(duplicate.code, "task_exists"); assert.equal(makeTaskEventReader({ repoId: "preview", rootDir }).read().revision, baselineRevision + 1); const shown = await cell.run({ kind: "task-show", taskId: "task-preview" }, repoWriteBinding); const evidence = JSON.parse(String(shown.evidence)) as { packagePath: string; task: { title: string } }; assert.equal(evidence.packagePath, preview.packagePath); assert.equal(evidence.task.title, "Preview Package");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});
// prettier-ignore

test("RepoCell rejects completion on snapshot drift and preset upgrade publishes one canonical replacement", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-upgrade-cell-")), source = path.join(rootDir, "source/upgrade-task"), taskId = "task-upgrade-cell", binding = repoWriteBinding; let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const packageBody = (version: string) => JSON.stringify({ schema: "preset-manifest/v3", id: "upgrade-task", title: "Upgrade Task", vertical: "software/coding", version, kind: "template-content", outputShape: "repository-diff", kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" }, capabilityImports: [], profiles: [{ id: "baseline", title: "Baseline", completionGates: ["ci", "code-doc-reconciliation"], templateSelections: [] }], defaultProfile: "baseline" });
  try {
    initRepo(rootDir); mkdirSync(source, { recursive: true }); writeFileSync(path.join(source, "preset.json"), packageBody("3.1.0")); writeFileSync(path.join(source, "PRESET.md"), "---\nschema: preset-document/v1\ndescription: Upgrade fixture.\nwhenToUse: Test upgrade.\n---\n# Upgrade\n"); cell = await openRepoCell({ repoId: workspaceId("preset-upgrade-cell"), rootDir: canonicalRoot(rootDir), ownerId: "preset-upgrade-daemon" }); const installed = await cell.run({ kind: "preset-install", packageSource: "source/upgrade-task" }, binding); assert.equal(installed.outcome, "pending"); assert.equal(installed.acceptance, null); const created = await cell.run({ kind: "task-create", taskId, title: "Upgrade Cell", presetId: "upgrade-task" }, binding) as Record<string, unknown>, previousDigest = String(created.presetDigest); const createdVisible = await waitForAcceptedReceipt(cell, created as { opId: string; acceptance?: { revisionTo?: number } | null }, binding); assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible)); writeFileSync(path.join(source, "preset.json"), packageBody("3.2.0")); const reinstalled = await cell.run({ kind: "preset-install", packageSource: "source/upgrade-task" }, binding); assert.equal(reinstalled.outcome, "pending"); assert.equal(reinstalled.acceptance, null);
    const blocked = await cell.run({ kind: "task-complete", taskId, executionId: "execution-missing" }, binding); assert.equal(blocked.code, "preset_snapshot_mismatch"); const upgraded = await cell.run({ kind: "preset-upgrade", taskId }, binding) as Record<string, unknown>; assert.equal(upgraded.outcome, "applied"); const evidence = JSON.parse(String(upgraded.evidence)) as { previousDigest: string; digest: string }; assert.equal(evidence.previousDigest, previousDigest); assert.notEqual(evidence.digest, previousDigest); const event = makeTaskEventReader({ repoId: "preset-upgrade-cell", rootDir }).readEvent(String(upgraded.opId)); assert.equal(event?.schema, "preset-snapshot-upgrade-event/v1"); assert.equal((await cell.run({ kind: "task-complete", taskId, executionId: "execution-missing" }, binding)).code, "not_in_review");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});
// prettier-ignore

test("RepoCell completion recognizes the frozen snapshot of a docs task", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-docs-snapshot-cell-")), taskId = "task-docs-snapshot"; let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("docs-snapshot"), rootDir: canonicalRoot(rootDir), ownerId: "docs-snapshot" });
    const created = await cell.run({ kind: "task-create", taskId, title: "Docs snapshot", workKind: "docs" }, repoWriteBinding); assert.equal(created.outcome, "applied");
    const blocked = await cell.run({ kind: "task-complete", taskId, executionId: "execution-missing" }, repoWriteBinding); assert.notEqual(blocked.code, "preset_snapshot_mismatch", String(blocked.code));
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});
// prettier-ignore

test("RepoCell serializes identical lifecycle intents into one accepted SQLite outcome", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId: workspaceId("alpha"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" });
    const baselineRevision = makeTaskEventReader({ repoId: "alpha", rootDir }).read().revision;
    const action = { kind: "task-create", taskId: "task-alpha", title: "Alpha task" } as const;

    const [left, right] = await Promise.all([
      cell.run(action, repoWriteBinding),
      cell.run(action, repoWriteBinding)
    ]);

    assert.deepEqual([left.outcome, right.outcome], ["applied", "applied"], JSON.stringify([left, right]));
    assert.equal(left.opId, right.opId);
    assert.equal(left.revision, baselineRevision + 1);
    assert.deepEqual(left.cut, right.cut);
    assert.equal(left.status, "accepted_durable");
    assert.equal(right.status, "accepted_durable");
    assertValidWriteReceipt(left);
    assertValidWriteReceipt(right);
    const reader = makeTaskEventReader({ repoId: "alpha", rootDir });
    assert.equal(reader.read().events.filter((event) => event.opId === left.opId).length, 1);
    assert.equal(reader.readCommandOutcome(left.opId)?.status, "accepted_durable");
    await reader.drain();
    const shown = await cell.run({ kind: "task-show", verb: "show", taskId: "task-alpha" }, repoWriteBinding);
    assert.equal(shown.outcome, "applied");
    assert.match(String(shown.evidence), /Alpha task/u);
    const settled = await cell.run({ kind: "receipt-show", opId: left.opId,
      waitFor: ["accepted_durable", "projection_visible", "git_verified"], timeoutMs: 5_000 }, repoWriteBinding);
    assert.equal(settled.wait?.state, "satisfied", JSON.stringify(settled));
    await cell.close(); cell = undefined;
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
// prettier-ignore

test("GUI and CLI submit derive the same canonical event from closeout", async () => {
  const roots = ["packet", "structured"].map((name) => mkdtempSync(path.join(tmpdir(), `ha-submit-ab-${name}-`)));
  const cells: Awaited<ReturnType<typeof openRepoCell>>[] = [];
  const now = () => "2026-08-14T01:02:03.000Z", taskId = "task-submit-ab", executionId = "execution-submit-ab", binding = repoWriteBinding;
  try {
    roots.forEach(initDeterministicRepo);
    for (const [index, rootDir] of roots.entries()) cells.push(await openRepoCell({ repoId: workspaceId("submit-ab"), rootDir: canonicalRoot(rootDir), ownerId: `submit-ab-${index}`, now }));
    for (const [index, cell] of cells.entries()) { const created = await cell.run({ kind: "task-create", taskId, title: "Submit A B" }, binding); assert.equal(created.outcome, "applied"); const visible = await waitForAcceptedReceipt(cell, created, binding); assert.equal(visible.wait?.state, "satisfied", JSON.stringify(visible)); await realizeTaskPlanFixture(roots[index]!, String((created as Record<string, unknown>).packagePath), (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding)); assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, binding)).outcome, "applied"); }
    for (const [index, rootDir] of roots.entries())
      await writeCloseout(
        () => cells[index]!.settlePendingMaterialization("closeout git commit"),
        rootDir,
        "tasks/task-submit-ab-submit-a-b",
        "Typed GUI submit is equivalent.",
      );
    assert.equal((await cells[0]!.run({ kind: "task-submit", taskId, executionId }, binding)).outcome, "applied");
    const server = createJsonRpcProtocolServer({ host: { remoteProxy: { route: () => false }, run: async (_repoId: string, action: Record<string, unknown>) => cells[1]!.run(action as { readonly kind: string }, binding) } as never, build: { commit: null }, authContext: {} as never, emit: async () => undefined }); await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } }); const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "repo.task.submit", params: { repo: { repoId: "submit-ab" }, payload: { taskId, executionId } } }); assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response)); assert.equal((response as { result: { outcome: string } }).result.outcome, "applied", JSON.stringify(response)); server.close();
    const events = roots.map((rootDir) => makeTaskEventReader({ repoId: "submit-ab", rootDir }).read().events.find((event) => event.type === "execution_submitted"));
    assert.equal(events[0]?.schema, "task-event/v1"); assert.equal(events[1]?.schema, "task-event/v1"); assert.equal(events[0]?.type, "execution_submitted"); assert.equal(events[1]?.type, "execution_submitted"); if (events[0]?.schema === "task-event/v1" && events[1]?.schema === "task-event/v1" && events[0].type === "execution_submitted" && events[1].type === "execution_submitted") { assert.deepEqual({ taskId: events[1].taskId, actor: events[1].actor, source: events[1].source, submission: { ...events[1].payload.submission, commitSha: "<repo-cut>" } }, { taskId: events[0].taskId, actor: events[0].actor, source: events[0].source, submission: { ...events[0].payload.submission, commitSha: "<repo-cut>" } }); }
    const projected = await cells[1]!.read("repo.tasks.list"), row = projected.rows[0]!;
    assert.deepEqual(row.snapshotAvailability, { consents: "known", codeDocWitnesses: "known", gateWitnesses: "known" });
    assert.deepEqual({ parentTaskId: row.placement.parentTaskId, origin: row.placement.origin, packageDisposition: row.placement.packageDisposition }, { parentTaskId: null, origin: "native", packageDisposition: "active" });
    assert.equal(row.placement.provenance.length > 0, true);
    assert.equal(row.executionEvidence[0]!.executionId, executionId);
    assert.deepEqual(row.executionEvidence[0]!.outputs, []);
    assert.deepEqual(validateDaemonTaskSnapshotList(projected), []);
  } finally { await Promise.all(cells.map((cell) => cell.close())); roots.forEach((root) => rmSync(root, { recursive: true, force: true })); }
});
// prettier-ignore

test("lifecycle commands publish typed events, machine files, rebuildable L2, and complete receipts in one cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-files-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const taskId = "task-life", executionId = "execution-life", packagePath = "tasks/task-life-lifecycle-files", binding = repoWriteBinding;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("lifecycle-files"), rootDir: canonicalRoot(rootDir), ownerId: "lifecycle-daemon" });
    const created = await cell.run({ kind: "task-create", taskId, title: "Lifecycle files" }, binding); assert.equal(created.outcome, "applied"); const createdVisible = await waitForAcceptedReceipt(cell, created, binding); assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible)); await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding));
    const assertCut = async (receipt: Record<string, unknown>, type: string, paths: readonly string[]) => { assert.equal(receipt.outcome, "applied", JSON.stringify(receipt)); assert.equal(receipt.status, "accepted_durable"); assert.equal(receipt.taskId, taskId); assert.equal(receipt.executionId, executionId); assert.deepEqual(receipt.changedPaths, paths); assert.equal(typeof receipt.cut, "object"); assert.equal(typeof receipt.transition, "object"); assert.equal(Array.isArray(receipt.next), true); const event = makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).readEvent(String(receipt.opId)); assert.equal(event?.type, type); if (event?.schema !== "task-event/v1") throw new Error("lifecycle receipt requires a TaskEvent"); assert.deepEqual(event.payload.documentClaims?.map((claim) => claim.path), paths); const visible = await waitForAcceptedReceipt(cell!, receipt as { opId: string; acceptance?: { revisionTo?: number } | null }, binding); assert.equal(visible.wait?.state, "satisfied", JSON.stringify(visible)); for (const target of paths) assert.equal(existsSync(path.join(rootDir, "harness", target)), true, target); };
    const indexPath = `${packagePath}/INDEX.md`, executionPath = `${packagePath}/executions/${executionId}.md`, reviewPath = `${packagePath}/reviews/review-life.md`, codeDocPath = `${packagePath}/code-doc-anchors.json`;
    const started = await cell.run({ kind: "task-start", taskId, executionId }, binding) as unknown as Record<string, unknown>; await assertCut(started, "execution_started", [indexPath, executionPath]); assert.match(readFileSync(path.join(rootDir, "harness", executionPath), "utf8"), /State: active/u);
    assert.equal((started.authorizationDecision as Record<string, unknown>).policyRef, "default@5");
    assert.equal((started.authorizationDecision as Record<string, unknown>).outcome, "allowed");
    const beforeInvalidSubmit = makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).readHead()?.revision;
    writeFileSync(path.join(rootDir, "harness", packagePath, "closeout.md"), "# Closeout\n\n## Summary\n\nIncomplete.\n");
    const invalidSubmit = await cell.run({ kind: "task-submit", taskId, executionId }, binding);
    assert.equal(invalidSubmit.outcome, "op_rejected");
    assert.equal(makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).readHead()?.revision, Number(beforeInvalidSubmit) + 1);
    assert.equal(makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).read().events.some((event) => event.type === "execution_submitted"), false);
    const commitSha = await writeCloseout(
      () => cell!.settlePendingMaterialization("closeout git commit"),
      rootDir,
      packagePath,
      "Lifecycle output is ready.",
    );
    const submitted = await cell.run({ kind: "task-submit", taskId, executionId }, binding) as unknown as Record<string, unknown>; await assertCut(submitted, "execution_submitted", [indexPath, executionPath]); assert.deepEqual(submitted.transition, { from: "active/implementation", to: "in_review/review" }); assert.match(readFileSync(path.join(rootDir, "harness", executionPath), "utf8"), /State: submitted[\s\S]*Lifecycle output is ready/u);
    writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict: "approved", reason: "Independent review passed.", evidenceChecked: ["tests"] })); const reviewBinding = withRoleBinding({ actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent" as const, id: "arbiter" } }, source: "local" as const }, "arbiter");
    const reviewed = await cell.run({ kind: "task-review-execution", taskId, executionId, reviewId: "review-life", fromFile: "review.json" }, reviewBinding) as unknown as Record<string, unknown>; await assertCut(reviewed, "review_recorded", [indexPath, executionPath, reviewPath]); assert.equal(reviewed.reviewId, "review-life"); assert.match(readFileSync(path.join(rootDir, "harness", reviewPath), "utf8"), /Verdict: approved[\s\S]*Consent: pending/u);
    assert.equal((reviewed.authorizationDecision as Record<string, unknown>).policyRef, "default@5");
    assert.equal((reviewed.authorizationDecision as Record<string, unknown>).outcome, "allowed");
    const reviewEvent = makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).readEvent(String(reviewed.opId)); if (reviewEvent?.type !== "review_recorded") throw new Error("review event missing"); assert.equal(reviewed.reviewDigest, reviewDigest(reviewEvent.payload.review)); assert.equal(reviewed.contentDigest, reviewEvent.payload.review.contentDigest);
    const consented = await cell.run({ kind: "task-review-consent", taskId, executionId, reviewId: "review-life" }, binding) as unknown as Record<string, unknown>; await assertCut(consented, "review_consent_recorded", [indexPath, executionPath, reviewPath]); assert.match(readFileSync(path.join(rootDir, "harness", reviewPath), "utf8"), /Consent: consent-[0-9a-f]+[\s\S]*Consent actor: person-owner/u);
    assert.equal((consented.authorizationDecision as Record<string, unknown>).policyRef, "default@5");
    assert.equal((consented.authorizationDecision as Record<string, unknown>).outcome, "allowed");
    const witnessedPath = "README.md", beforeInvalidWitness = makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).readHead()?.revision; assert.equal((await cell.run({ kind: "task-code-doc-reconcile", taskId, executionId, commitSha, iteration: 0, paths: [witnessedPath] }, binding)).outcome, "op_rejected"); assert.equal(makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).readHead()?.revision, beforeInvalidWitness); const reconciled = await cell.run({ kind: "task-code-doc-reconcile", taskId, paths: [witnessedPath] }, binding) as unknown as Record<string, unknown>; await assertCut(reconciled, "code_doc_reconciled", [indexPath, executionPath, codeDocPath]); assert.deepEqual(JSON.parse(readFileSync(path.join(rootDir, "harness", codeDocPath), "utf8")), { schema: "code-doc-witness/v1", witnessId: String((makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).readEvent(String(reconciled.opId)) as { payload: { witness: { witnessId: string } } }).payload.witness.witnessId), taskId, executionId, commitSha, iteration: 0, paths: [witnessedPath], actor, source: "local", reconciledAt: (makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).readEvent(String(reconciled.opId)) as { occurredAt: string }).occurredAt });
    const lookedUp = await cell.run({ kind: "receipt-show", opId: reconciled.opId }, binding) as unknown as Record<string, unknown>; assert.deepEqual({ taskId: lookedUp.taskId, executionId: lookedUp.executionId, transition: lookedUp.transition, changedPaths: lookedUp.changedPaths }, { taskId, executionId, transition: reconciled.transition, changedPaths: reconciled.changedPaths });
    await cell.close(); cell = undefined; const store = makeTaskEventReader({ repoId: "lifecycle-files", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore: store }); projection.close(); rmSync(projection.path, { force: true }); assert.equal(projection.rebuild().watermark, store.read().revision); assert.equal(projection.read(taskId).snapshot.codeDocWitnesses.length, 1); for (const target of [indexPath, executionPath, reviewPath, codeDocPath]) assert.equal(projection.readDocument(target).document?.body, readFileSync(path.join(rootDir, "harness", target), "utf8")); projection.close(); await store.drain();
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});
// prettier-ignore

test("code-doc repoint appends a replacement witness and rejects stale or unknown records", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-code-doc-repoint-")),
    taskId = "task-code-doc-repoint",
    executionId = "execution-code-doc-repoint",
    repoId = workspaceId("code-doc-repoint");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "code-doc-repoint" });
    await prepareReadyCompletion(cell, rootDir, repoId, taskId, executionId, "Repoint Ledger");
    const anchorPath = path.join(
        rootDir,
        "harness",
        "tasks/task-code-doc-repoint-repoint-ledger/code-doc-anchors.json",
      ),
      originalBytes = readFileSync(anchorPath),
      original = JSON.parse(originalBytes.toString("utf8")) as { witnessId: string; commitSha: string };
    const completed = await cell.run(
      { kind: "task-complete", taskId, executionId },
      repoWriteBinding,
    );
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    const missingBefore = makeTaskEventReader({ repoId, rootDir }).read().revision,
      unknown = await cell.run(
        {
          kind: "task-code-doc-repoint",
          taskId,
          record: "code-doc-missing",
          paths: ["README.md"],
          reason: "Unknown anchor",
        },
        repoWriteBinding,
      );
    assert.equal(unknown.outcome, "op_rejected");
    assert.equal(makeTaskEventReader({ repoId, rootDir }).read().revision, missingBefore);
    const action = {
        kind: "task-code-doc-repoint",
        taskId,
        record: original.witnessId,
        paths: ["README.md"],
        reason: "Correct archive root",
      } as const,
      repointed = (await cell.run(action, repoWriteBinding)) as Record<string, unknown>;
    assert.equal(repointed.outcome, "applied", JSON.stringify(repointed));
    const repointedVisible = await waitForAcceptedReceipt(cell, repointed as { opId: string; acceptance?: { revisionTo?: number } | null });
    assert.equal(repointedVisible.wait?.state, "satisfied", JSON.stringify(repointedVisible));
    const afterBytes = readFileSync(anchorPath),
      lines = afterBytes
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(afterBytes.subarray(0, originalBytes.length), originalBytes);
    assert.equal(lines.length, 2);
    assert.equal(lines[1]!.supersedes, original.witnessId);
    assert.equal(lines[1]!.disposition, "repointed");
    const projection = await cell.read("repo.tasks.list"),
      row = projection.rows.find((value) => value.taskId === taskId);
    assert.ok(row, JSON.stringify(projection));
    assert.deepEqual(validateDaemonTaskSnapshotList(projection), []);
    assert.equal(
      row.closeoutAssessment.gates.find((gate) => gate.gateId === "code-doc-reconciliation")?.status,
      "passed",
    );
    assert.deepEqual(
      row.snapshot.codeDocWitnesses.map((witness) =>
        witness.schema === "code-doc-witness/v1" ? witness.witnessId : witness.recordId,
      ),
      [original.witnessId, lines[1]!.recordId],
    );
    const duplicate = await cell.run(action, repoWriteBinding);
    assert.equal(duplicate.outcome, "op_rejected");
    assert.deepEqual(readFileSync(anchorPath), afterBytes);
    const knownInvalid = (await cell.run(
      {
        ...action,
        record: String(lines[1]!.recordId),
        paths: [],
        reason: "Commit unresolvable after rebuild line reset",
      },
      repoWriteBinding,
    )) as Record<string, unknown>;
    assert.equal(knownInvalid.outcome, "applied", JSON.stringify(knownInvalid));
    const invalidVisible = await waitForAcceptedReceipt(cell, knownInvalid as { opId: string; acceptance?: { revisionTo?: number } | null });
    assert.equal(invalidVisible.wait?.state, "satisfied", JSON.stringify(invalidVisible));
    const afterKnownInvalid = readFileSync(anchorPath),
      invalidLines = afterKnownInvalid
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(afterKnownInvalid.subarray(0, afterBytes.length), afterBytes);
    assert.equal(invalidLines[2]!.supersedes, lines[1]!.recordId);
    assert.equal(invalidLines[2]!.disposition, "known-invalid");
    const invalidProjection = await cell.read("repo.tasks.list"),
      invalidRow = invalidProjection.rows.find((value) => value.taskId === taskId)!;
    assert.deepEqual(validateDaemonTaskSnapshotList(invalidProjection), []);
    assert.equal(
      invalidRow.closeoutAssessment.gates.find((gate) => gate.gateId === "code-doc-reconciliation")?.status,
      "missing",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
// prettier-ignore

test("RepoCell doc mapping enforces strict dual CAS, holder receipts, deletion rejection, and worktree preservation", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-cell-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("docs"), rootDir: canonicalRoot(rootDir), ownerId: "doc-daemon" });
    const binding = repoWriteBinding, created = await cell.run({ kind: "task-create", taskId: "task-doc", title: "Docs" }, binding); assert.equal(created.outcome, "applied"); const createdVisible = await waitForAcceptedReceipt(cell, created, binding); assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible)); await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding));
    assert.equal((await cell.run({ kind: "task-start", taskId: "task-doc", executionId: "execution-doc" }, repoWriteBinding)).outcome, "applied");
    const claims = path.join(rootDir, ".harness/doc-sync-claims"), authored = path.join(rootDir, "harness/context/notes.md"); mkdirSync(claims, { recursive: true }); mkdirSync(path.dirname(authored), { recursive: true });
    let body = "# Notes\nA\n"; writeFileSync(authored, body);
    const statusBefore = await cell.run({ kind: "doc-status", paths: ["context/notes.md"] }, repoWriteBinding); assert.equal(statusBefore.outcome, "applied"); assert.equal(statusBefore.proof?.worktreeVisible, false);
    const action = { kind: "doc-submit", executionId: "execution-doc", paths: ["context/notes.md"] } as const;
    const before = { revision: makeTaskEventReader({ repoId: "docs", rootDir }).read().revision, bytes: readFileSync(authored).toString("hex") }, applied = await cell.run(action, repoWriteBinding);
    assert.equal(applied.outcome, "applied", JSON.stringify(applied)); assert.equal(applied.detail?.kind, "doc_sync"); assert.equal(applied.status, "accepted_durable"); assert.ok(applied.cut); assert.equal(readFileSync(authored).toString("hex"), before.bytes); assertValidWriteReceipt(applied);
    const shown = await cell.run({ kind: "receipt-show", opId: applied.opId, waitFor: ["git_verified", "worktree_visible"], timeoutMs: 5_000 }, repoWriteBinding); assert.equal(shown.outcome, "applied"); assert.equal(shown.detail?.kind, "doc_sync"); assert.equal(shown.wait?.state, "satisfied", JSON.stringify(shown));
    const retried = await cell.run(action, repoWriteBinding); assert.equal(retried.outcome, "no_changes"); assert.equal(retried.code, "no_changes"); assert.match(retried.opId, /^noop:/u); assert.equal(makeTaskEventReader({ repoId: "docs", rootDir }).read().revision, before.revision + 1);
    const next = `${body}B\n`; writeFileSync(authored, next);
    const updated = await cell.run(action, repoWriteBinding); assert.equal(updated.outcome, "applied", JSON.stringify(updated)); body = next;
    rmSync(authored); const deletion = await cell.run(action, repoWriteBinding); assert.equal(deletion.code, "deletion_forbidden"); writeFileSync(authored, body);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});
// prettier-ignore

test("doc ingress rejects symbolic links in claim and authored path chains", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-claim-link-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("claim-link"), rootDir: canonicalRoot(rootDir), ownerId: "doc-daemon" }); const source = { kind: "assignment", nodeId: "node", assignmentId: "assignment" } as const, sourceBinding = withRoleBinding({ actor, source }, "repo-write");
    const created = await cell.run({ kind: "task-create", taskId: "task-doc", title: "Docs" }, repoWriteBinding); const createdVisible = await waitForAcceptedReceipt(cell, created, repoWriteBinding); assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible)); await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, repoWriteBinding)); await cell.run({ kind: "task-start", taskId: "task-doc", executionId: "execution-doc" }, sourceBinding);
    const body = "# Outside\n", hash = createHash("sha256").update(body).digest("hex"), claims = path.join(rootDir, ".harness/doc-sync-claims"); mkdirSync(claims, { recursive: true }); writeFileSync(path.join(rootDir, "outside.md"), body); symlinkSync("../../outside.md", path.join(claims, "linked"));
    const binding = { actor, source, assignmentScope: { repoId: "claim-link", scope: { kind: "task" as const, taskId: "task-doc", executionId: "execution-doc", paths: ["context/link.md"] } } }, base = makeTaskEventReader({ repoId: "claim-link", rootDir }).currentCut(), beforeRevision = makeTaskEventReader({ repoId: "claim-link", rootDir }).read().revision, result = await cell.run({ kind: "doc-submit", executionId: "execution-doc", baseLedgerSha: base, changes: [{ path: "context/link.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: { ref: "doc-sync-claims/linked", sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" } }] }, binding);
    assert.equal(result.code, "content_claim_mismatch"); assert.equal(makeTaskEventReader({ repoId: "claim-link", rootDir }).read().revision, beforeRevision);
    writeFileSync(path.join(claims, "plain"), body); mkdirSync(path.join(rootDir, "harness/context"), { recursive: true }); symlinkSync("../../outside.md", path.join(rootDir, "harness/context/link.md"));
    const authoredLink = await cell.run({ kind: "doc-submit", executionId: "execution-doc", baseLedgerSha: base, changes: [{ path: "context/link.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: { ref: "doc-sync-claims/plain", sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" } }] }, binding);
    assert.equal(authoredLink.code, "invalid_command"); assert.equal(makeTaskEventReader({ repoId: "claim-link", rootDir }).read().revision, beforeRevision);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});
// prettier-ignore

test("bootstrap concurrent writer admission commits one complete workspace", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-bootstrap-writer-")), rootDir = path.join(parent, "repo");
  const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0,
    source: "unix-socket-filesystem-owner-boundary" } } as const;
  const hosts = await Promise.all(["one", "two"].map((daemonId) => openDaemonHost({ daemonId, userRoot: path.join(parent, daemonId) })));
  try { const results = await Promise.allSettled(hosts.map((host) => host.bootstrap({ rootDir, repoId: "fresh", personId: "owner", displayName: "Owner" }, auth)));
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1); assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
    const ledgerRoot = path.join(rootDir, "harness"); assert.equal(git(ledgerRoot, "rev-list", "--count", "HEAD"), "2"); assert.equal(git(rootDir, "check-ignore", "harness"), "harness"); assert.equal(git(rootDir, "check-ignore", ".harness"), ".harness"); }
  finally { await Promise.all(hosts.map((host) => host.close())); rmSync(parent, { recursive: true, force: true }); }
});
// prettier-ignore

test("bootstrap binds the ledger repository branch independently of the project branch", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-bootstrap-branch-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user");
  const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0,
    source: "unix-socket-filesystem-owner-boundary" } } as const;
  mkdirSync(rootDir, { recursive: true }); initRepo(rootDir); git(rootDir, "branch", "-M", "main"); git(rootDir, "branch", "feature"); git(rootDir, "checkout", "--quiet", "feature");
  git(rootDir, "update-ref", "refs/remotes/origin/main", "refs/heads/main"); git(rootDir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  let host = await openDaemonHost({ daemonId: "bootstrap-one", userRoot });
  try {
    const initialized = await host.bootstrap({ rootDir, repoId: "branch-bound", personId: "owner", displayName: "Owner" }, auth); assert.equal(initialized.outcome, "applied");
    const ledgerRoot = path.join(rootDir, "harness"), registered = readDaemonRegistry({ userRoot }).repos.find((repo) => repo.repoId === "branch-bound"), ledgerBranch = git(ledgerRoot, "branch", "--show-current"); assert.equal(registered?.authoredBranch, ledgerBranch);
    assert.equal(git(ledgerRoot, "rev-parse", "HEAD"), git(ledgerRoot, "rev-parse", `refs/heads/${ledgerBranch}`)); assert.equal(git(rootDir, "branch", "--show-current"), "feature");
    await host.close(); host = await openDaemonHost({ daemonId: "bootstrap-two", userRoot }); await host.attachmentsSettled();
    const afterRestart = await host.run("branch-bound", { kind: "task-create", taskId: "task-after-restart", title: "After restart" }, auth); assert.equal(afterRestart.outcome, "applied", JSON.stringify(afterRestart)); const settled = await host.run("branch-bound", { kind: "receipt-show", opId: afterRestart.opId, waitFor: ["accepted_durable", "projection_visible", "git_verified"], timeoutMs: 5_000 }, auth); assert.equal(settled.wait?.state, "satisfied", JSON.stringify(settled));
    assert.equal(git(ledgerRoot, "rev-parse", "HEAD"), git(ledgerRoot, "rev-parse", `refs/heads/${ledgerBranch}`)); assert.equal(git(rootDir, "branch", "--show-current"), "feature");
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});
// prettier-ignore

test("bootstrap validates local identity before repository initialization", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-bootstrap-identity-")), rootDir = path.join(parent, "repo"), host = await openDaemonHost({ daemonId: "bootstrap-identity", userRoot: path.join(parent, "user") });
  try { await assert.rejects(host.bootstrap({ rootDir, repoId: "identity", personId: "owner", displayName: "Owner" }, { transportKind: "unix-socket" }), hasCode("bootstrap_identity_unavailable")); assert.equal(existsSync(path.join(rootDir, ".git")), false); }
  finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});
// prettier-ignore

test("unrelated workspace lock collision does not block either workspace", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-lock-collision-")), owners = new Map<number, string>(); let roots: string[] | undefined;
  for (let index = 0; index < 1_000 && !roots; index += 1) { const root = path.join(parent, `repo-${index}`), port = 40_000 + Number.parseInt(createHash("sha256").update(root).digest("hex").slice(0, 4), 16) % 20_000;
    const prior = owners.get(port); if (prior) roots = [prior, root]; else owners.set(port, root); }
  assert.ok(roots, "fixture must find roots that collide under the retired 16-bit TCP-port lock");
  roots.forEach((root) => { mkdirSync(root); initRepo(root); }); const cells = await Promise.all(roots.map((rootDir, index) => openRepoCell({ repoId: workspaceId(`repo-${index}`),
    rootDir: canonicalRoot(rootDir), ownerId: `daemon-${index}` })));
  try { assert.deepEqual(cells.map((cell) => cell.status().state), ["attached", "attached"]); }
  finally { await Promise.all(cells.map((cell) => cell.close())); rmSync(parent, { recursive: true, force: true }); }
});
async function writeCloseout(
  drain: () => Promise<unknown>,
  rootDir: string,
  packagePath: string,
  summary: string,
  verification = "Verified.",
): Promise<string> {
  // The cell publishes ledger cuts to the same repo Git; drain its writer queue before this fixture
  // commit, or the two HEAD writers race and git dies with `cannot lock ref 'HEAD'`.
  await drain();
  writeFileSync(path.join(rootDir, "README.md"), "# Verified delivery\n");
  git(rootDir, "add", "README.md");
  execFileSync("git", ["-C", rootDir, "commit", "--quiet", "-m", "test: verified delivery"], {
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-14T00:01:00Z", GIT_COMMITTER_DATE: "2026-08-14T00:01:00Z" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const commitSha = git(rootDir, "rev-parse", "HEAD");
  writeFileSync(
    path.join(rootDir, "harness", packagePath, "closeout.md"),
    `# Closeout\n\n## Summary\n\n${summary} Commit ${commitSha}.\n\n## Verification\n\n${verification}\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNot applicable to this fixture.\n`,
  );
  return commitSha;
}
function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "RepoCell Test");
  git(rootDir, "config", "user.email", "repo-cell@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  writeFileSync(path.join(rootDir, "README.md"), "# Fixture\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "--quiet", "-m", "fixture base");
}
function initDeterministicRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "RepoCell Test");
  git(rootDir, "config", "user.email", "repo-cell@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  execFileSync("git", ["-C", rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base"], {
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-14T00:00:00Z", GIT_COMMITTER_DATE: "2026-08-14T00:00:00Z" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function prepareReadyCompletion(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  rootDir: string,
  repoId: string,
  taskId: string,
  executionId: string,
  title: string,
  publishObservation = true,
  observationCommitSha?: string,
): Promise<string> {
  const binding = repoWriteBinding;
  const created = await cell.run({ kind: "task-create", taskId, title }, binding);
  const createdVisible = await waitForAcceptedReceipt(cell, created, binding);
  assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible));
  await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
    cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
  );
  const started = await cell.run({ kind: "task-start", taskId, executionId }, binding);
  assert.equal((await waitForAcceptedReceipt(cell, started, binding)).wait?.state, "satisfied");
  const fact = await cell.run(
    {
      kind: "fact-record",
      taskId,
      statement: "Completion has a canonical task-owned observation.",
      evidenceSource: "test:completion",
      confidence: "high",
      memoryClass: "semantic",
      memoryTags: [],
    },
    binding,
  );
  assert.equal((await waitForAcceptedReceipt(cell, fact, binding)).wait?.state, "satisfied");
  const packagePath = `tasks/${taskId}-${title
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")}`;
  const commitSha = await writeCloseout(
    () => cell.settlePendingMaterialization("closeout git commit"),
    rootDir,
    packagePath,
    "Ready.",
  );
  const submitted = await cell.run({ kind: "task-submit", taskId, executionId }, binding);
  assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  assert.equal((await waitForAcceptedReceipt(cell, submitted, binding)).wait?.state, "satisfied");
  writeFileSync(
    path.join(rootDir, "review.json"),
    JSON.stringify({ verdict: "approved", reason: "Approved.", evidenceChecked: ["verified"] }),
  );
  const reviewed = await cell.run(
    { kind: "task-review-execution", taskId, executionId, reviewId: "review-ready", fromFile: "review.json" },
    withRoleBinding(
      {
        actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent", id: "arbiter" } },
        source: "local",
      },
      "arbiter",
    ),
  );
  assert.equal((await waitForAcceptedReceipt(cell, reviewed, binding)).wait?.state, "satisfied");
  const consented = await cell.run(
    { kind: "task-review-consent", taskId, executionId, reviewId: "review-ready" },
    binding,
  );
  assert.equal((await waitForAcceptedReceipt(cell, consented, binding)).wait?.state, "satisfied");
  if (!publishObservation && !observationCommitSha) return "";
  const ciReceipt = await publishCiObservation(
    repoId,
    rootDir,
    executionId,
    observationCommitSha ?? commitSha,
    `run-${taskId}`,
  );
  return ciReceipt;
}
async function publishCiObservation(
  repoId: string,
  rootDir: string,
  executionId: string,
  commitSha: string,
  runId: string,
  verified = true,
): Promise<string> {
  const stateRoot = path.join(rootDir, ".harness", "fixture-writer-epochs"),
    authority = openPersistentWriterEpoch({ stateRoot, holderId: "direct-store" }),
    lease = authority.current(repoId);
  assert.ok(lease, "the isolated repo cell owns a current writer epoch");
  const store = makeTaskEventStore({
      repoId,
      rootDir,
      writerFence: () => ({
        schema: "harness-writer-epoch-fence/v1",
        stateRoot,
        repoId,
        holderId: lease.holderId,
        epoch: lease.epoch,
      }),
    }),
    projection = makeTaskProjection({ rootDir, eventStore: store }),
    databaseId = Number.parseInt(createHash("sha256").update(runId).digest("hex").slice(0, 8), 16) + 1,
    observedRunId = `${databaseId}.1`;
  try {
    const cell = {
      rootDir,
      settings: { read: () => ({ ci: { workflows: ["rewrite-ci", "rebuild-gates"] } }) },
      store,
      projection,
      now: () => "2026-09-09T00:00:00.000Z",
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    } as unknown as Parameters<typeof ingestCiObservations>[0];
    const fetched = await fetchCiObservations(cell, { kind: "ci-observe-pull", limit: 1 }, async (_command, args) => {
      if (args[1] === "list")
        return JSON.stringify([{ databaseId, headBranch: "main", createdAt: "2026-09-09T00:00:00.000Z" }]);
      if (args[1] === "view")
        return JSON.stringify({
          workflowName: verified ? "rewrite-ci" : "other-ci",
          headSha: commitSha,
          headBranch: "main",
          status: "completed",
          conclusion: "success",
          attempt: 1,
          event: "push",
        });
      assert.equal(args[1], "download");
      const output = String(args[args.indexOf("--dir") + 1]);
      mkdirSync(output, { recursive: true });
      writeFileSync(
        path.join(output, "observation.json"),
        JSON.stringify({
          schema: "ci-run-artifact/v1",
          run: {
            runId: observedRunId,
            sha: commitSha,
            branch: "main",
            prNumber: null,
            job: "full-check (24)",
            wallclockMs: 25,
            runner: "fixture-runner",
          },
          tests: [],
          gates: [{ gate: "ci", result: "pass", metrics: { runAttempt: 1 } }],
        }),
      );
      return "";
    });
    const receipt = ingestCiObservations(cell, repoWriteBinding, fetched);
    assert.equal(JSON.parse(receipt.evidence).imported, 1);
    const event = store
      .read()
      .events.find(
        (candidate) => candidate.type === "ci_run_observed" && candidate.payload.run.runId === observedRunId,
      );
    assert.ok(event && event.type === "ci_run_observed");
    assert.equal(event.payload.verification?.conclusion, verified ? "success" : undefined);
    assert.ok(
      store
        .read()
        .events.some(
          (candidate) =>
            candidate.type === "execution_submitted" && candidate.payload.execution.executionId === executionId,
        ),
    );
    await store.drain();
    const eventRefs = JSON.parse(receipt.evidence).eventRefs;
    assert.deepEqual(eventRefs, [`event:${event.opId}`]);
    return eventRefs[0];
  } finally {
    projection.close();
    await store.drain();
    authority.close();
  }
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function hasCode(expected: string): (error: unknown) => boolean {
  return (error) => typeof error === "object" && error !== null && "code" in error && error.code === expected;
}

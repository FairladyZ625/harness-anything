// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyTextualArtifactPath, makeTaskEventStore, makeTaskProjection, serializeCanonicalEvent, type TaskProjection } from "../../kernel/src/index.ts";
import { DOC_POLICY_ID, MIGRATION_DOCUMENT_POLICY_ID, MIGRATION_IMPORT_SOURCE, migrationImportWritePlan, sha256Text, type CanonicalWriteBundle, type MigrationImportEventV1 } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { readDocReceipt, runDocAction } from "../src/doc-sync-actions.ts";
import { openRepoCell } from "../src/repo-cell.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;
const opaqueTextualMediaType = "application/json";

test("status, dry-run, and submit share the repeatable-path scanner and automatic base", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-scanner-")); initRepo(rootDir); const cell = await openRepoCell({ repoId: workspaceId("scanner"), rootDir: canonicalRoot(rootDir), ownerId: "scanner-daemon" }), binding = { actor, source: "local" as const };
  try { write(rootDir, "context/a.md", "# A\n\nfirst\n"); write(rootDir, "context/b.md", "# B\n\nsecond\n"); write(rootDir, "tasks/task-one/progress.md", "# Progress\n"); write(rootDir, "tasks/task-one/artifacts/data.json", "{}\n"); write(rootDir, "context/ignored.json", "{}\n"); const before = git(rootDir, "rev-parse", "HEAD"), status = await cell.run({ kind: "doc-status", paths: [] }, binding), statusRows = rows(status.evidence);
    assert.deepEqual(statusRows.map((row) => [row.path, row.state]), [["context/a.md", "eligible"], ["context/b.md", "eligible"], ["tasks/task-one/artifacts/data.json", "eligible"], ["tasks/task-one/progress.md", "blocked"]]); assert.equal(statusRows.find((row) => row.path.endsWith("artifacts/data.json"))?.mediaType, opaqueTextualMediaType); assert.equal(git(rootDir, "rev-parse", "HEAD"), before);
    const dry = await cell.run({ kind: "doc-dry-run", paths: ["context/a.md", "context/b.md"] }, binding); assert.equal(dry.outcome, "pending"); assert.equal(dry.proof?.canonicalVisible, false); assert.deepEqual(rows(dry.evidence), statusRows.slice(0, 2)); assert.equal(git(rootDir, "rev-parse", "HEAD"), before);
    const submitted = await cell.run({ kind: "doc-submit", paths: ["context/a.md"] }, binding); assert.equal(submitted.outcome, "applied", JSON.stringify(submitted)); assert.equal(submitted.commitSha, null); const event = makeTaskEventStore({ repoId: "scanner", rootDir }).readEvent(submitted.opId); assert.equal(event?.schema, "doc-event/v1"); if (event?.schema === "doc-event/v1") { assert.deepEqual(event.payload.baseLedgerSha, (JSON.parse(status.evidence!.slice("doc-scan:".length)) as { baseLedgerSha: unknown }).baseLedgerSha); assert.equal(event.payload.executionId, null); assert.deepEqual(event.payload.changes.map((change) => change.path), ["context/a.md"]); }
    assert.deepEqual(git(rootDir, "status", "--porcelain", "-uall").split("\n").filter((line) => line.includes(" harness/")).sort(), ["?? harness/context/a.md", "?? harness/context/b.md", "?? harness/context/ignored.json", "?? harness/tasks/task-one/artifacts/data.json", "?? harness/tasks/task-one/progress.md"]);
    write(rootDir, "context/a.md", "# Renamed\n\nfirst\n"); const acceptedCut = git(rootDir, "rev-parse", "HEAD"), blocked = await cell.run({ kind: "doc-dry-run", paths: ["context/a.md"] }, binding); assert.equal(rows(blocked.evidence)[0]?.state, "blocked"); assert.match(blocked.detail?.nextAction ?? "", /listed blocked candidates/u); assert.doesNotMatch(blocked.detail?.nextAction ?? "", /doc retire|conflict scratch/iu); const rejected = await cell.run({ kind: "doc-submit", paths: ["context/a.md"] }, binding); assert.equal(rejected.outcome, "op_rejected"); assert.equal(rejected.code, "preview_blocked"); assert.equal(git(rootDir, "rev-parse", "HEAD"), acceptedCut);
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("doc retire deletes one projected document and returns an auditable retirement receipt", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-retire-")); initRepo(rootDir); const cell = await openRepoCell({ repoId: workspaceId("retire"), rootDir: canonicalRoot(rootDir), ownerId: "retire-daemon" }), binding = { actor, source: "local" as const }, logical = "context/temporary.md", reason = "superseded temporary evidence";
  try { write(rootDir, logical, "# Temporary\n\nRetire me.\n"); const submitted = await cell.run({ kind: "doc-submit", paths: [logical] }, binding); assert.equal(submitted.outcome, "applied", JSON.stringify(submitted)); rmSync(path.join(rootDir, "harness", logical));
    const mutation = await cell.run({ kind: "doc-status", paths: [logical] }, binding); assert.equal(rows(mutation.evidence)[0]?.state, "deletion"); assert.match(mutation.detail?.nextAction ?? "", new RegExp(`ha doc retire --path ${logical}`, "u")); assert.doesNotMatch(mutation.detail?.nextAction ?? "", /resolve blocked/iu);
    const retired = await cell.run({ kind: "doc-retire", path: logical, reason }, binding); assert.equal(retired.outcome, "applied", JSON.stringify(retired)); assert.equal(retired.proof?.canonicalVisible, true); assert.equal(retired.proof?.worktreeVisible, true); assert.match(retired.evidence ?? "", /^doc-retirement:/u); const receipt = JSON.parse((retired.evidence ?? "").slice("doc-retirement:".length)) as { readonly schema: string; readonly path: string; readonly reason: string }; assert.deepEqual(receipt, { schema: "doc-retirement-receipt/v1", path: logical, baseBlobSha256: sha256Text("# Temporary\n\nRetire me.\n"), reason });
    const event = makeTaskEventStore({ repoId: "retire", rootDir }).readEvent(retired.opId); assert.equal(event?.schema, "doc-event/v1"); if (event?.schema === "doc-event/v1") { assert.equal(event.payload.retirementReason, reason); assert.equal(event.payload.changes[0]?.candidate, null); }
    const shown = await cell.run({ kind: "doc-show", path: logical }, binding); assert.equal(shown.code, "document_not_found"); assert.equal(git(rootDir, "ls-tree", "--name-only", "HEAD", `harness/${logical}`), ""); assert.equal(rows((await cell.run({ kind: "doc-status", paths: [] }, binding)).evidence).some((row) => row.state === "deletion"), false);
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("doc retire follows status for a Git-tracked document that was never projected", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-retire-tracked-")); initRepo(rootDir); const logical = "tmp/legacy-tracked.md", body = "# Legacy tracked document\n", reason = "retire pre-doc-sync ledger debt";
  write(rootDir, logical, body); git(rootDir, "add", `harness/${logical}`); git(rootDir, "commit", "-qm", "track legacy document");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined = await openRepoCell({ repoId: workspaceId("retire-tracked"), rootDir: canonicalRoot(rootDir), ownerId: "retire-tracked-daemon" }); const binding = { actor, source: "local" as const };
  try {
    rmSync(path.join(rootDir, "harness", logical));
    const status = await cell.run({ kind: "doc-status", paths: [] }, binding);
    assert.deepEqual(rows(status.evidence).map((row) => [row.path, row.state]), [[logical, "deletion"]]);
    assert.match(status.detail?.nextAction ?? "", new RegExp(`ha doc retire --path ${logical}`, "u"));

    const retired = await cell.run({ kind: "doc-retire", path: logical, reason }, binding);
    assert.equal(retired.outcome, "applied", JSON.stringify(retired));
    assert.match(retired.evidence ?? "", /^doc-retirement:/u);
    assert.equal(makeTaskEventStore({ repoId: "retire-tracked", rootDir }).readEvent(retired.opId)?.schema, "doc-event/v1");
    assert.equal(rows((await cell.run({ kind: "doc-status", paths: [] }, binding)).evidence).some((row) => row.state === "deletion"), false);
    await cell.close(); cell = undefined;
    assert.equal(git(rootDir, "ls-tree", "--name-only", "HEAD", `harness/${logical}`), "");
    assert.equal(git(rootDir, "status", "--porcelain", "--untracked-files=no"), "");
    const reopened = await openRepoCell({ repoId: workspaceId("retire-tracked"), rootDir: canonicalRoot(rootDir), ownerId: "retire-tracked-reopened" });
    try { assert.deepEqual(rows((await reopened.run({ kind: "doc-status", paths: [] }, binding)).evidence), []); }
    finally { await reopened.close(); }
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("new non-textual artifacts are inapplicable while binary replacement of canonical text remains blocked", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-non-textual-")); initRepo(rootDir); const cell = await openRepoCell({ repoId: workspaceId("non-textual"), rootDir: canonicalRoot(rootDir), ownerId: "non-textual-daemon" }), binding = { actor, source: "local" as const }, fresh = "tasks/task-proof/artifacts/screenshots/evidence.png", tracked = "tasks/task-proof/artifacts/report.bin";
  try {
    const freshTarget = path.join(rootDir, "harness", fresh); mkdirSync(path.dirname(freshTarget), { recursive: true }); writeFileSync(freshTarget, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]));
    const status = await cell.run({ kind: "doc-status", paths: [fresh] }, binding), row = rows(status.evidence)[0] as { readonly state: string; readonly reason?: string } | undefined;
    assert.deepEqual([row?.state, row?.reason], ["inapplicable", "non-textual artifact is outside doc sync"]); assert.deepEqual(status.detail?.unresolvedTouches, []); assert.equal(status.detail?.nextAction, "no action required; inapplicable candidates are outside doc sync");
    const noOp = await cell.run({ kind: "doc-submit", paths: [fresh] }, binding) as Record<string, unknown>; assert.equal(noOp.outcome, "applied"); assert.match(String(noOp.opId), /^noop:/u);

    write(rootDir, tracked, "textual baseline\n"); assert.equal((await cell.run({ kind: "doc-submit", paths: [tracked] }, binding)).outcome, "applied"); writeFileSync(path.join(rootDir, "harness", tracked), Buffer.from([0xff, 0x00]));
    const blocked = await cell.run({ kind: "doc-status", paths: [tracked] }, binding); assert.equal(rows(blocked.evidence)[0]?.state, "blocked"); assert.equal(blocked.detail?.unresolvedTouches[0]?.requiredRoute, "typed-binary-content");
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("people-registry ownership is inapplicable while typed writable routes remain blocked", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-owned-route-")); initRepo(rootDir); const cell = await openRepoCell({ repoId: workspaceId("owned-route"), rootDir: canonicalRoot(rootDir), ownerId: "owned-route-daemon" }), binding = { actor, source: "local" as const };
  try {
    write(rootDir, "people.yaml", "schema: harness-people/v1\npeople: []\nroles: []\n"); write(rootDir, "harness.yaml", "schema: harness-anything/v1\nname: hand-edited\n");
    const people = await cell.run({ kind: "doc-status", paths: ["people.yaml"] }, binding), peopleRow = rows(people.evidence)[0] as { readonly state: string; readonly reason?: string } | undefined;
    assert.deepEqual([peopleRow?.state, peopleRow?.reason], ["inapplicable", "path is owned by people-registry and is outside doc sync"]); assert.deepEqual(people.detail?.unresolvedTouches, []); assert.equal(people.detail?.nextAction, "no action required; inapplicable candidates are outside doc sync");
    const noOp = await cell.run({ kind: "doc-submit", paths: ["people.yaml"] }, binding); assert.equal(noOp.outcome, "applied"); assert.match(noOp.opId, /^noop:/u);

    const workspace = await cell.run({ kind: "doc-status", paths: ["harness.yaml"] }, binding), workspaceRow = rows(workspace.evidence)[0] as { readonly state: string; readonly reason?: string } | undefined;
    assert.deepEqual([workspaceRow?.state, workspaceRow?.reason], ["blocked", "path is owned by workspace-config"]); assert.equal(workspace.detail?.unresolvedTouches[0]?.requiredRoute, "workspace-config");
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("implicit submit applies eligible prose and reports an unrelated blocked row as skipped", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-partial-blocked-")); initRepo(rootDir); const repoId = workspaceId("partial-blocked"), cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "partial-blocked-daemon" }), binding = { actor, source: "local" as const };
  try {
    write(rootDir, "context/blocked.md", "# Stable\n\nbase\n"); assert.equal((await cell.run({ kind: "doc-submit", paths: ["context/blocked.md"] }, binding)).outcome, "applied");
    write(rootDir, "context/blocked.md", "# Renamed\n\nbase\n"); write(rootDir, "context/eligible.md", "# Eligible\n\nship me\n");
    const submitted = await cell.run({ kind: "doc-submit", paths: [] }, binding) as Record<string, unknown>;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.match(String(submitted.summary), /doc-submit: applied[\s\S]*context\/eligible\.md[\s\S]*skipped:[\s\S]*context\/blocked\.md\tblocked\tbase region is missing: "# Stable"/u);
    const event = makeTaskEventStore({ repoId, rootDir }).readEvent(String(submitted.opId)); assert.equal(event?.schema, "doc-event/v1"); if (event?.schema === "doc-event/v1") assert.deepEqual(event.payload.changes.map((change) => change.path), ["context/eligible.md"]);
    assert.equal(readFileSync(path.join(rootDir, "harness/context/eligible.md"), "utf8"), "# Eligible\n\nship me\n"); assert.equal(readFileSync(path.join(rootDir, "harness/context/blocked.md"), "utf8"), "# Renamed\n\nbase\n");
    const settledHead = git(rootDir, "rev-parse", "HEAD"), skippedOnly = await cell.run({ kind: "doc-submit", paths: [] }, binding) as Record<string, unknown>; assert.equal(skippedOnly.outcome, "op_rejected", JSON.stringify(skippedOnly)); assert.equal(skippedOnly.code, "preview_blocked"); assert.match(String(skippedOnly.nextAction), /ha doc status[\s\S]*ha doc sync --submit/u); assert.equal(git(rootDir, "rev-parse", "HEAD"), settledHead, "a blocked-only implicit submit must reject without publishing an event");
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("implicit submit applies eligible prose and reports an unrelated deletion as skipped", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-partial-deletion-")); initRepo(rootDir); const repoId = workspaceId("partial-deletion"), cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "partial-deletion-daemon" }), binding = { actor, source: "local" as const };
  try {
    write(rootDir, "context/deleted.md", "# Retained\n"); assert.equal((await cell.run({ kind: "doc-submit", paths: ["context/deleted.md"] }, binding)).outcome, "applied");
    rmSync(path.join(rootDir, "harness/context/deleted.md")); write(rootDir, "context/eligible.md", "# Eligible\n");
    const submitted = await cell.run({ kind: "doc-submit", paths: [] }, binding) as Record<string, unknown>;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.match(String(submitted.summary), /doc-submit: applied[\s\S]*context\/eligible\.md[\s\S]*skipped:[\s\S]*context\/deleted\.md\tdeletion\tcanonical document is missing from the worktree/u);
    const event = makeTaskEventStore({ repoId, rootDir }).readEvent(String(submitted.opId)); assert.equal(event?.schema, "doc-event/v1"); if (event?.schema === "doc-event/v1") assert.deepEqual(event.payload.changes.map((change) => change.path), ["context/eligible.md"]);
    assert.equal(existsSync(path.join(rootDir, "harness/context/deleted.md")), false); assert.equal(readFileSync(path.join(rootDir, "harness/context/eligible.md"), "utf8"), "# Eligible\n");
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("a runtime session with multiple matching held executions rejects with exact retry commands", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-runtime-routes-")); initRepo(rootDir); const runtimeActor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "runtime-session:runtime-routes" } } as const, source = "local" as const, now = "2026-08-23T00:00:00.000Z", paths = ["tasks/task-route-a-a/artifacts/a.md", "tasks/task-route-b-b/artifacts/b.md"] as const;
  try {
    for (const target of paths) write(rootDir, target, `# ${target}\n`);
    const lease = (taskId: string, executionId: string) => ({ schema: "lease/v1", taskId, executionId, actor: { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "dispatch-holder" } }, source, phase: "held", expiresAt: "2026-08-23T01:00:00.000Z", ttlMs: 3_600_000, version: 1 } as const), leases = [lease("task-route-a", "exec-route-a"), lease("task-route-b", "exec-route-b")], projection = { taskIdForDocumentPath: (target: string) => target.includes("task-route-a-a") ? "task-route-a" : target.includes("task-route-b-b") ? "task-route-b" : null, currentLeaseForExecution: (executionId: string) => leases.find((value) => value.executionId === executionId) ?? null, readRuntimeSession: () => ({ runtimeSessionId: "runtime-routes", instanceId: "codex", installationId: "installation", kindId: "codex", definitionSnapshotRef: "artifact:runtime-definition/test", providerSessionId: "provider", transcriptRef: "provider:codex/provider", launchGeneration: 1, liveness: "live", attachable: true, taskBindings: leases.map(({ taskId, executionId }) => ({ taskId, executionId, providerSessionId: "provider", transcriptRef: "provider:codex/provider", boundAt: now })), outcome: null, exitCode: null, resultRef: null, lastObservedAt: now }), readDocument: () => ({ status: "ready", watermark: 0, sourceRevision: 0, document: null }) } as unknown as TaskProjection, store = makeTaskEventStore({ repoId: "runtime-routes", rootDir });
    const rejected = await runDocAction({ action: { kind: "doc-submit", paths: [] }, binding: { actor: runtimeActor, source }, workspaceId: workspaceId("runtime-routes"), rootDir, store, projection, now: () => now }); assert.equal(rejected.outcome, "op_rejected"); assert.equal(rejected.code, "lease_conflict"); assert.match(rejected.nextAction ?? "", /ha doc sync --submit --execution-id exec-route-a[\s\S]*ha doc sync --submit --execution-id exec-route-b/u);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

// The scanner used to pin a single-task selection to that task's CURRENT lease
// regardless of who held it, so `ha doc sync --submit --path <p>` reported
// lease_conflict for a legal repository-prose write whenever the task was
// leased by a dispatched runtime — while an implicit submit escaped only when
// the dirty set happened to span two task packages. Both shapes must now ride
// the prose channel for a non-holder.
test("path and implicit submits ride the repository prose channel when the task lease is held by another executor", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-path-prose-")); initRepo(rootDir); const repoId = workspaceId("path-prose"), cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "path-prose-daemon" });
  const person = { actor: { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } }, source: "local" as const }, holder = { actor: { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "runtime-session:lease-holder" } }, source: "local" as const }, taskId = "task_PATHPR0SE000000000000AAAAA";
  try {
    const created = await cell.run({ kind: "task-create", taskId, title: "path submit prose channel" }, person) as { packagePath?: string }, packagePath = created.packagePath!;
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId: "exec-path-prose" }, holder)).outcome, "applied");
    write(rootDir, `${packagePath}/artifacts/reports/leased.md`, "# Leased task report\n"); write(rootDir, "context/shared.md", "# Shared\n");
    const status = await cell.run({ kind: "doc-status", paths: [`${packagePath}/artifacts/reports/leased.md`] }, person);
    assert.deepEqual(rows(status.evidence).map((row) => [row.path, row.state]), [[`${packagePath}/artifacts/reports/leased.md`, "eligible"]], JSON.stringify(status.evidence));
    const scoped = await cell.run({ kind: "doc-submit", paths: [`${packagePath}/artifacts/reports/leased.md`] }, person);
    assert.equal(scoped.outcome, "applied", JSON.stringify(scoped));
    const event = makeTaskEventStore({ repoId, rootDir }).readEvent(scoped.opId); assert.equal(event?.schema, "doc-event/v1"); if (event?.schema === "doc-event/v1") { assert.equal(event.payload.executionId, null, "a non-holder rides the lease-free prose channel, not the foreign lease"); assert.deepEqual(event.payload.changes.map((change) => change.path), [`${packagePath}/artifacts/reports/leased.md`]); }
    // A dirty set confined to the leased task package must not regress to the old single-task lease pin either.
    write(rootDir, "context/shared.md", "# Shared\nsynced\n"); assert.equal((await cell.run({ kind: "doc-submit", paths: ["context/shared.md"] }, person)).outcome, "applied");
    write(rootDir, `${packagePath}/artifacts/reports/second.md`, "# Second\n");
    const implicit = await cell.run({ kind: "doc-submit", paths: [] }, person) as Record<string, unknown>;
    assert.equal(implicit.outcome, "applied", JSON.stringify(implicit)); assert.match(String(implicit.summary), new RegExp(`applied:\\n${packagePath}/artifacts/reports/second\\.md`, "u"));
    // Naming the foreign execution explicitly still refuses — and the receipt names the exit that works.
    write(rootDir, `${packagePath}/artifacts/reports/third.md`, "# Third\n");
    const explicit = await cell.run({ kind: "doc-submit", executionId: "exec-path-prose", paths: [`${packagePath}/artifacts/reports/third.md`] }, person) as { outcome?: string; code?: string; nextAction?: string };
    assert.equal(explicit.outcome, "op_rejected"); assert.equal(explicit.code, "lease_conflict"); assert.match(explicit.nextAction ?? "", /execution exec-path-prose is not held by this principal; rerun ha doc sync --submit without --execution-id to submit through the repository prose channel/u);
    const unnamed = await cell.run({ kind: "doc-submit", paths: [`${packagePath}/artifacts/reports/third.md`] }, person) as Record<string, unknown>;
    assert.equal(unnamed.outcome, "applied", JSON.stringify(unnamed));
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

// A runtime actor whose lease lapsed must be told the same release+re-enter
// recovery `ha task progress append` names — not a rerun of the refused
// command shape.
test("a runtime actor with a lapsed lease is told the release and re-enter recovery", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-lapsed-recovery-")); initRepo(rootDir); const repoId = workspaceId("lapsed-recovery"), cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "lapsed-recovery-daemon" });
  const person = { actor: { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } }, source: "local" as const }, worker = { actor: { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "runtime-session:lapsed-worker" } }, source: "local" as const }, taskId = "task_REENTER00000000000000AAAAA";
  try {
    const created = await cell.run({ kind: "task-create", taskId, title: "lapsed lease recovery receipt" }, person) as { packagePath?: string }, report = `${created.packagePath}/artifacts/reports/r.md`;
    write(rootDir, report, "# R\n\nship me\n");
    assert.ok(["applied", "pending"].includes(String((await cell.run({ kind: "task-start", taskId, executionId: "exec-lapsed", ttlMs: 1 }, worker) as { outcome?: string }).outcome)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rejected = await cell.run({ kind: "doc-submit", paths: [report] }, worker) as { outcome?: string; code?: string; nextAction?: string; detail?: { nextAction?: string } };
    assert.equal(rejected.outcome, "op_rejected"); assert.equal(rejected.code, "lease_conflict");
    const recipe = new RegExp(`the lease for execution exec-lapsed lapsed at [^;]+; run ha task release ${taskId}, then re-enter the round with ha task start ${taskId} --execution-id exec-lapsed`, "u");
    assert.match(rejected.nextAction ?? "", recipe); assert.match(rejected.detail?.nextAction ?? "", recipe);
    // The named recovery is real: same-execution re-entry restores a held lease this principal holds.
    const released = await cell.run({ kind: "task-release", taskId }, worker) as { outcome?: string }, reentered = await cell.run({ kind: "task-start", taskId, executionId: "exec-lapsed" }, worker) as { outcome?: string };
    assert.ok(["applied", "pending"].includes(String(released.outcome)), JSON.stringify(released)); assert.ok(["applied", "pending"].includes(String(reentered.outcome)), JSON.stringify(reentered));
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

// …and the named recovery terminates for a session that is actually bound:
// flipping the same lease back to held (what release+start does) makes the
// identical submit apply.
test("the named release-and-re-enter recovery terminates for a bound runtime session", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-recovery-terminates-")); initRepo(rootDir); const runtimeActor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "runtime-session:recovery" } } as const, source = "local" as const, now = "2026-08-23T00:00:00.000Z", logical = "tasks/task-recover-x/artifacts/r.md";
  try {
    write(rootDir, logical, "# Recoverable\n");
    let phase: "held" | "orphaned" = "orphaned";
    const lease = { schema: "lease/v1", taskId: "task-recover", executionId: "exec-recover", actor: { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } }, source, get phase() { return phase; }, expiresAt: "2026-08-23T00:30:00.000Z", ttlMs: 1_800_000, version: 1 } as const;
    const documents = new Map<string, { readonly path: string; readonly blobSha256: string }>(); let watermark = 0;
    const projection = { taskIdForDocumentPath: (target: string) => target.startsWith("tasks/task-recover-x/") ? "task-recover" : null, currentLease: (taskId: string) => taskId === "task-recover" ? lease : null, currentLeaseForExecution: (executionId: string) => executionId === "exec-recover" ? lease : null, readRuntimeSession: () => ({ runtimeSessionId: "recovery", liveness: "live", taskBindings: [{ taskId: "task-recover", executionId: "exec-recover" }] }), readDocument: (target: string) => ({ status: "ready", watermark, sourceRevision: watermark, document: documents.get(target) ?? null }), apply: (event: { readonly workspaceRevision: number; readonly payload: { readonly changes: readonly { readonly path: string; readonly candidate: { readonly sha256: string } | null }[] } }) => { watermark = event.workspaceRevision; for (const change of event.payload.changes) if (change.candidate) documents.set(change.path, { path: change.path, blobSha256: change.candidate.sha256 }); }, read: (taskId: string) => ({ snapshot: { task: { taskId, title: "recovery terminates", status: "active", currentNode: "implementation", iteration: 0 }, executions: [{ schema: "execution/v1", executionId: "exec-recover", taskId, nodeId: "implementation", iteration: 0, state: "active", actor: { principal: { personId: "person-owner" }, executor: null }, claimedAt: now, submittedAt: null, closedAt: null, submission: null }], lease: null }, watermark: 0, sourceRevision: 0 }) } as unknown as TaskProjection, store = makeTaskEventStore({ repoId: "recovery-terminates", rootDir });
    const rejected = await runDocAction({ action: { kind: "doc-submit", paths: [logical] }, binding: { actor: runtimeActor, source }, workspaceId: workspaceId("recovery-terminates"), rootDir, store, projection, now: () => now }) as { outcome?: string; code?: string; nextAction?: string };
    assert.equal(rejected.outcome, "op_rejected"); assert.equal(rejected.code, "lease_conflict"); assert.match(rejected.nextAction ?? "", new RegExp(`run ha task release task-recover, then re-enter the round with ha task start task-recover --execution-id exec-recover`, "u"));
    phase = "held";
    const recovered = await runDocAction({ action: { kind: "doc-submit", paths: [logical] }, binding: { actor: runtimeActor, source }, workspaceId: workspaceId("recovery-terminates"), rootDir, store, projection, now: () => now }) as { outcome?: string; opId?: string };
    assert.equal(recovered.outcome, "applied", JSON.stringify(recovered)); assert.equal(makeTaskEventStore({ repoId: "recovery-terminates", rootDir }).readEvent(String(recovered.opId))?.schema, "doc-event/v1");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

// F-42D28979/F-F4814511: a task plan whose H1 no longer matches the ledger
// title is the highest-frequency doc-sync block; the receipt must name the
// mechanical fix, and following it verbatim must apply.
test("a renamed task plan H1 receipt names the exact title restore and the fix applies", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-h1-restore-")); initRepo(rootDir); const repoId = workspaceId("h1-restore"), cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "h1-restore-daemon" }), binding = { actor, source: "local" as const }, taskId = "task_H1REST0RE000000000000AAAAA", title = "很长的自解释标题:带括号与路径的完整 create title";
  try {
    const created = await cell.run({ kind: "task-create", taskId, title }, binding) as { packagePath?: string }, plan = `${created.packagePath}/task_plan.md`, target = path.join(rootDir, "harness", plan);
    const scaffold = readFileSync(target, "utf8"); assert.match(scaffold.split("\n")[0] ?? "", new RegExp(`^# ${title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"));
    writeFileSync(target, scaffold.replace(`# ${title}`, "# 好读的短标题"));
    const restore = new RegExp(`restore the H1 of ${plan.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} to the task title verbatim \\("# ${title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"\\), then rerun ha doc sync --submit --path ${plan.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u");
    const status = await cell.run({ kind: "doc-status", paths: [plan] }, binding) as { detail?: { nextAction?: string } };
    assert.equal(rows((await cell.run({ kind: "doc-status", paths: [plan] }, binding)).evidence)[0]?.state, "blocked"); assert.match(status.detail?.nextAction ?? "", restore);
    const rejected = await cell.run({ kind: "doc-submit", paths: [plan] }, binding) as { outcome?: string; code?: string; nextAction?: string };
    assert.equal(rejected.outcome, "op_rejected"); assert.equal(rejected.code, "preview_blocked"); assert.match(rejected.nextAction ?? "", restore);
    writeFileSync(target, readFileSync(target, "utf8").replace("# 好读的短标题", `# ${title}`));
    assert.equal((await cell.run({ kind: "doc-submit", paths: [plan] }, binding)).outcome, "applied");
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("authored CRLF prose is canonicalized on scanner read and submitted as LF", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-crlf-")); initRepo(rootDir); const repoId = workspaceId("crlf"), cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "crlf-daemon" }), binding = { actor, source: "local" as const }, logical = "context/crlf.md", canonical = "# CRLF\n\naccepted\n";
  try {
    write(rootDir, logical, canonical.replace(/\n/gu, "\r\n"));
    const submitted = await cell.run({ kind: "doc-submit", paths: [logical] }, binding); assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const event = makeTaskEventStore({ repoId, rootDir }).readEvent(submitted.opId); assert.equal(event?.schema, "doc-event/v1"); if (event?.schema === "doc-event/v1") { assert.equal(event.payload.changes[0]?.candidate.sha256, sha256Text(canonical)); assert.equal(event.payload.changes[0]?.candidate.size, Buffer.byteLength(canonical)); }
    assert.equal(readFileSync(path.join(rootDir, "harness", logical), "utf8"), canonical);
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("scanner textual artifacts use the canonical classifier", () => {
  const opaque = "tasks/task-one/artifacts/scripts/report.mjs";
  assert.deepEqual(classifyTextualArtifactPath(opaque), { kind: "opaque-textual", mediaType: "text/javascript", policyId: "opaque-textual-whole-file/v1" });
});

test("a committed DocEvent reports pending with its stable receipt id until L2 reaches the event cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-pending-")), repoId = workspaceId("doc-pending"), binding = { actor, source: "local" as const }; initRepo(rootDir); const cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "doc-pending" });
  try { await cell.run({ kind: "task-create", taskId: "task-pending", title: "Pending" }, binding); write(rootDir, "context/pending.md", "# Pending\n"); const applied = await cell.run({ kind: "doc-submit", paths: ["context/pending.md"] }, binding); assert.equal(applied.outcome, "applied"); await cell.close(); const store = makeTaskEventStore({ repoId, rootDir }), event = store.readEvent(applied.opId); if (event?.schema !== "doc-event/v1") throw new Error("DocEvent missing"); const projection = makeTaskProjection({ rootDir, eventStore: store, projectionPath: path.join(rootDir, ".harness/pending.sqlite"), catchUpLimit: 1 }), pending = readDocReceipt({ binding, workspaceId: repoId, rootDir, store, projection, now: () => "2026-08-14T00:00:00.000Z" }, event); assert.equal(pending.outcome, "pending"); assert.equal(pending.opId, event.opId); assert.equal(pending.proof?.committedRevision, event.workspaceRevision); assert.equal(pending.proof?.canonicalVisible, false); assert.match(pending.nextAction ?? "", new RegExp(`receipt show ${event.opId}`, "u")); projection.close(); }
  finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("materialize restores task-bootstrap and doc-event files and is idempotent", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-materialize-")); initRepo(rootDir); const cell = await openRepoCell({ repoId: workspaceId("materialize"), rootDir: canonicalRoot(rootDir), ownerId: "materialize-daemon" }), binding = { actor, source: "local" as const };
  try { assert.equal((await cell.run({ kind: "task-create", taskId: "task-materialize", title: "Materialize" }, binding)).outcome, "applied"); const packagePath = "tasks/task-materialize-materialize", taskRoot = path.join(rootDir, "harness", packagePath), prosePaths = [`${packagePath}/task_plan.md`, `${packagePath}/closeout.md`]; for (const logical of prosePaths) write(rootDir, logical, `${readFileSync(path.join(rootDir, "harness", logical), "utf8")}\n## Project Extension\n\nCanonical prose update.\n`); const prose = await cell.run({ kind: "doc-submit", paths: prosePaths }, binding); assert.equal(prose.outcome, "applied", JSON.stringify(prose)); const proseEvent = makeTaskEventStore({ repoId: "materialize", rootDir }).readEvent(prose.opId); assert.equal(proseEvent?.schema, "doc-event/v1"); if (proseEvent?.schema === "doc-event/v1") assert.deepEqual(proseEvent.payload.changes.map(({ path: target }) => target).sort(), [...prosePaths].sort()); write(rootDir, "context/notes.md", "# Notes\n\ncanonical\n"); assert.equal((await cell.run({ kind: "doc-submit", paths: ["context/notes.md"] }, binding)).outcome, "applied"); const cut = git(rootDir, "rev-parse", "HEAD"), count = git(rootDir, "rev-list", "--count", "HEAD"); rmSync(taskRoot, { recursive: true, force: true }); rmSync(path.join(rootDir, "harness/context/notes.md"));
    const first = await cell.run({ kind: "doc-materialize" }, binding), firstReport = materializeReport(first.evidence); assert.equal(first.outcome, "applied", JSON.stringify(first)); assert.equal(firstReport.changed.includes("context/notes.md"), true); assert.equal(firstReport.changed.some((value) => value.startsWith(`${packagePath}/`)), true); assert.equal(existsSync(taskRoot), true); for (const logical of prosePaths) assert.match(readFileSync(path.join(rootDir, "harness", logical), "utf8"), /Canonical prose update/u); assert.equal(git(rootDir, "diff", "--name-only"), "");
    const second = await cell.run({ kind: "doc-materialize" }, binding), secondReport = materializeReport(second.evidence); assert.deepEqual(secondReport.changed, []); assert.deepEqual(secondReport.conflicts, []); assert.equal(git(rootDir, "rev-parse", "HEAD"), cut); assert.equal(git(rootDir, "rev-list", "--count", "HEAD"), count); assert.equal(git(rootDir, "diff", "--name-only"), "");
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("materialize preserves a divergent local edit in one ignored deterministic conflict scratch", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-conflict-")); initRepo(rootDir); const cell = await openRepoCell({ repoId: workspaceId("conflict"), rootDir: canonicalRoot(rootDir), ownerId: "conflict-daemon" }), binding = { actor, source: "local" as const }, canonical = "# Notes\n\ncanonical\n", local = "# Notes\n\nlocal draft\n";
  try { write(rootDir, "context/notes.md", canonical); assert.equal((await cell.run({ kind: "doc-submit", paths: ["context/notes.md"] }, binding)).outcome, "applied"); write(rootDir, "context/notes.md", local); const first = materializeReport((await cell.run({ kind: "doc-materialize" }, binding)).evidence); assert.deepEqual(first.changed, ["context/notes.md"]); assert.equal(first.conflicts.length, 1); assert.equal(readFileSync(path.join(rootDir, first.conflicts[0]!), "utf8"), local); assert.equal(readFileSync(path.join(rootDir, "harness/context/notes.md"), "utf8"), canonical); assert.equal(git(rootDir, "status", "--porcelain", "-uall").includes("conflict-"), false); const conflicted = await cell.run({ kind: "doc-status", paths: ["context/notes.md"] }, binding); assert.equal(rows(conflicted.evidence)[0]?.state, "conflict"); assert.match(conflicted.detail?.nextAction ?? "", /listed conflict scratch/u); assert.doesNotMatch(conflicted.detail?.nextAction ?? "", /doc retire|blocked candidates/iu); const second = materializeReport((await cell.run({ kind: "doc-materialize" }, binding)).evidence); assert.deepEqual(second, { changed: [], conflicts: [] });
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("an authored branch advanced outside the daemon remains an ancestor of the asynchronously materialized cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-diverged-")); initRepo(rootDir); const cell = await openRepoCell({ repoId: workspaceId("diverged"), rootDir: canonicalRoot(rootDir), ownerId: "diverged-daemon" }), binding = { actor, source: "local" as const };
  try { write(rootDir, "context/notes.md", "# Notes\n"); git(rootDir, "add", "harness/context/notes.md"); git(rootDir, "commit", "-qm", "external advance"); const external = git(rootDir, "rev-parse", "HEAD"), result = await cell.run({ kind: "doc-submit", paths: ["context/notes.md"] }, binding); assert.equal(result.outcome, "applied"); assert.equal(result.commitSha, null); assert.equal(cell.status().state, "attached"); await cell.close(); assert.equal(git(rootDir, "merge-base", "--is-ancestor", external, "HEAD") === "", true); assert.equal(git(rootDir, "log", "-1", "--format=%s"), "harness WAL flush 1-1"); }
  finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("artifact add is the untracked UTF-8 canonical subset of doc submit", async () => { const parent = mkdtempSync(path.join(tmpdir(), "ha-artifact-equivalence-")), left = path.join(parent, "left"), right = path.join(parent, "right"), now = () => "2026-08-14T00:00:00.000Z", binding = { actor, source: "local" as const }, repoId = workspaceId("artifact-equivalence"); mkdirSync(left); initRepo(left); const seed = await openRepoCell({ repoId, rootDir: canonicalRoot(left), ownerId: "artifact-seed", now });
  try { assert.equal((await seed.run({ kind: "task-create", taskId: "task-artifact", title: "Artifacts" }, binding)).outcome, "applied"); await seed.close(); cpSync(left, right, { recursive: true }); const artifactCell = await openRepoCell({ repoId, rootDir: canonicalRoot(left), ownerId: "artifact-route", now }), docCell = await openRepoCell({ repoId, rootDir: canonicalRoot(right), ownerId: "doc-route", now }), destination = "tasks/task-artifact-artifacts/artifacts/report.md", source = path.join(left, "incoming.md"), body = "# Report\n\nCanonical evidence.\n"; writeFileSync(source, body); write(right, destination, body);
    try { const artifact = await artifactCell.run({ kind: "task-artifact-add", taskId: "task-artifact", source: "incoming.md", destination: "report.md" }, binding) as Record<string, unknown>, doc = await docCell.run({ kind: "doc-submit", paths: [destination] }, binding) as Record<string, unknown>; assert.equal(artifact.outcome, "applied", JSON.stringify(artifact)); assert.equal(doc.outcome, "applied", JSON.stringify(doc)); assert.deepEqual({ opId: artifact.opId, revision: artifact.revision, commitSha: artifact.commitSha, settlement: artifact.settlement, receiptId: artifact.receiptId }, { opId: doc.opId, revision: doc.revision, commitSha: doc.commitSha, settlement: doc.settlement, receiptId: doc.receiptId }); const artifactStore = makeTaskEventStore({ repoId, rootDir: left }), docStore = makeTaskEventStore({ repoId, rootDir: right }), artifactEvent = artifactStore.readEvent(String(artifact.opId)), docEvent = docStore.readEvent(String(doc.opId)); assert.ok(artifactEvent && docEvent); assert.equal(serializeCanonicalEvent(artifactEvent), serializeCanonicalEvent(docEvent)); assert.equal(readFileSync(path.join(left, "harness/events/head.json"), "utf8"), readFileSync(path.join(right, "harness/events/head.json"), "utf8")); const shown = await artifactCell.run({ kind: "receipt-show", opId: String(artifact.receiptId) }, binding) as Record<string, unknown>; assert.equal(shown.receiptId, artifact.receiptId); assert.equal(shown.commitSha, artifact.commitSha);
      writeFileSync(source, "next\n"); const collision = await artifactCell.run({ kind: "task-artifact-add", taskId: "task-artifact", source: "incoming.md", destination: "report.md" }, binding); assert.equal(collision.code, "artifact_collision"); writeFileSync(path.join(left, "harness", destination), "edited\n"); const trackedEdit = await artifactCell.run({ kind: "task-artifact-add", taskId: "task-artifact", source: "incoming.md", destination: "report.md" }, binding); assert.equal(trackedEdit.code, "artifact_tracked_edit"); assert.match(trackedEdit.nextAction ?? "", /ha doc sync --submit --path/u); const trackedSource = await artifactCell.run({ kind: "task-artifact-add", taskId: "task-artifact", source: `harness/${destination}`, destination: "other.md" }, binding); assert.equal(trackedSource.code, "artifact_source_tracked"); writeFileSync(path.join(left, "bad.md"), Buffer.from([0xff])); assert.equal((await artifactCell.run({ kind: "task-artifact-add", taskId: "task-artifact", source: "bad.md", destination: "bad.md" }, binding)).code, "artifact_invalid_utf8"); assert.equal((await artifactCell.run({ kind: "task-artifact-add", taskId: "task-artifact", source: "incoming.md", destination: "../escape.md" }, binding)).code, "invalid_artifact_path"); }
    finally { await artifactCell.close(); await docCell.close(); }
  } finally { await seed.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("artifact unknown settlement returns the canonical DocEvent receipt id without retrying", async () => { const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-unknown-")); initRepo(rootDir); let armed = false, cell = await openRepoCell({ repoId: workspaceId("artifact-unknown"), rootDir: canonicalRoot(rootDir), ownerId: "artifact-unknown-one", now: () => "2026-08-14T00:00:00.000Z", killpoint: (point) => { if (armed && point === "before_response_write") throw new Error("response lost"); } }); const binding = { actor, source: "local" as const };
  try { assert.equal((await cell.run({ kind: "task-create", taskId: "task-unknown", title: "Unknown" }, binding)).outcome, "applied"); writeFileSync(path.join(rootDir, "unknown.md"), "# Unknown\n"); armed = true; const unknown = await cell.run({ kind: "task-artifact-add", taskId: "task-unknown", source: "unknown.md", destination: "unknown.md" }, binding); assert.equal(unknown.outcome, "indeterminate"); assert.equal(unknown.code, "publication_indeterminate"); assert.match(unknown.opId, /^op_/u); assert.match(unknown.nextAction ?? "", new RegExp(`receipt show ${unknown.opId}`, "u")); assert.equal(makeTaskEventStore({ repoId: "artifact-unknown", rootDir }).read().revision, 2); await cell.close(); cell = await openRepoCell({ repoId: workspaceId("artifact-unknown"), rootDir: canonicalRoot(rootDir), ownerId: "artifact-unknown-two", now: () => "2026-08-14T00:00:00.000Z" }); const settled = await cell.run({ kind: "receipt-show", opId: unknown.opId }, binding) as Record<string, unknown>; assert.equal(settled.outcome, "applied"); assert.equal(settled.receiptId, unknown.opId); }
  finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("an authored edit of a migrated governance standard upgrades its policy in the same write event", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-upgrade-")); initRepo(rootDir);
  const standard = "governance/standards/doc-library-standard.md", legacy = "# Docs Library\n\nfact 用 invalidate。\n", repoId = workspaceId("upgrade"), binding = { actor, source: "local" as const };
  makeTaskEventStore({ repoId, rootDir }).append(standardMigration(1, standard, legacy));
  const cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "upgrade-daemon" });
  try {
    write(rootDir, standard, `${legacy}fact 退场用 supersedes-fact。\n`);
    const dry = await cell.run({ kind: "doc-dry-run", paths: [standard] }, binding);
    assert.deepEqual(rows(dry.evidence).map((row) => [row.path, row.state]), [[standard, "eligible"]]);
    const applied = await cell.run({ kind: "doc-submit", paths: [standard] }, binding);
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    const upgraded = makeTaskEventStore({ repoId, rootDir }).readEvent(applied.opId);
    assert.equal(upgraded?.schema, "doc-event/v1");
    if (upgraded?.schema === "doc-event/v1") assert.deepEqual(upgraded.payload.changes[0]?.policyUpgrade, { from: MIGRATION_DOCUMENT_POLICY_ID, to: DOC_POLICY_ID });

    const secondBody = `${legacy}fact 退场用 supersedes-fact。\n删前先查 relation 入边。\n`;
    write(rootDir, standard, secondBody);
    const second = await cell.run({ kind: "doc-submit", paths: [standard] }, binding);
    assert.equal(second.outcome, "applied", JSON.stringify(second));
    const native = makeTaskEventStore({ repoId, rootDir }).readEvent(second.opId);
    if (native?.schema === "doc-event/v1") assert.equal("policyUpgrade" in native.payload.changes[0]!, false);

    write(rootDir, standard, `${secondBody}hand edit outside doc sync\n`); git(rootDir, "add", "harness"); git(rootDir, "commit", "-qm", "manual ledger advance");
    const accepted = await cell.run({ kind: "doc-submit", paths: [standard] }, binding);
    assert.equal(accepted.outcome, "applied"); assert.equal(accepted.commitSha, null);
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

function standardMigration(revision: number, target: string, body: string): CanonicalWriteBundle {
  const opId = `op-migration-${revision}`;
  const migration: MigrationImportEventV1 = { schema: "migration-import-event/v1", eventId: `event-${opId}`, workspaceRevision: revision, opId, type: "entity_migrated", actor, source: MIGRATION_IMPORT_SOURCE, occurredAt: "2026-08-11T00:00:00.000Z", payload: { migratedFrom: target, generation: "v0", entity: { kind: "repo-document", nodeKind: "file", documentClaim: { path: target, sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: "text/markdown", policyId: MIGRATION_DOCUMENT_POLICY_ID }, referencedContentClaims: [] } } };
  return { event: migration, plan: migrationImportWritePlan(migration), blobs: [{ sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: "text/markdown", body }] };
}
function rows(evidence: string | undefined): readonly { readonly path: string; readonly state: string }[] { assert.match(evidence ?? "", /^doc-scan:/u); return (JSON.parse((evidence ?? "").slice("doc-scan:".length)) as { rows: readonly { path: string; state: string }[] }).rows; }
function materializeReport(evidence: string | undefined): { readonly changed: readonly string[]; readonly conflicts: readonly string[] } { assert.match(evidence ?? "", /^doc-materialize:/u); return JSON.parse((evidence ?? "").slice("doc-materialize:".length)) as { changed: readonly string[]; conflicts: readonly string[] }; }
function write(rootDir: string, target: string, body: string): void { const file = path.join(rootDir, "harness", target); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); }
function initRepo(rootDir: string): void { git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Doc A Test"); git(rootDir, "config", "user.email", "doc-a@example.invalid"); git(rootDir, "commit", "--allow-empty", "-qm", "base"); }
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }

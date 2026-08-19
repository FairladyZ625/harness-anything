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
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { registerDaemonRepo, serializeEventHead, sha256Bytes, sha256Text } from "../../kernel/src/index.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { runFleetEdgeTask } from "../src/fleet-edge-task.ts";
import { runFleetEdgeConflictExit, runFleetEdgeDocSync, settlePushRejection } from "../src/fleet-edge-doc-sync.ts";
import { locateFleetMirrorView, readFleetUnresolvedConflicts } from "../src/fleet-edge-mirror.ts";
import { listenFleetTls, type FleetAssignmentRecord, type FleetTlsCenter } from "../src/fleet/center.ts";
import { runFleetWriteClient } from "../src/fleet/edge.ts";

const replicaQuota = 64 * 1024 * 1024, nodes = ["node-one", "node-two"] as const;
type NodeId = typeof nodes[number];
const submissionPacket = { completionClaim: "complete", deliverables: [], outputs: [], verificationNotes: ["dual-sync integration"], knownGaps: [], residualRisks: [], commitSha: "a".repeat(40) };

async function dualSyncFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-dual-")), repo = path.join(root, "repo"), userRoot = path.join(root, "user"), stateRoot = path.join(root, "state"), keyFile = path.join(root, "tls.key"), certFile = path.join(root, "tls.crt");
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  const git = (...args: readonly string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Dual Sync Test"); git("config", "user.email", "dual@example.invalid"); git("commit", "--allow-empty", "-qm", "base");
  writeFileSync(path.join(repo, "harness/harness.yaml"), "schema: harness-anything/v1\nname: dual\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n");
  git("add", "harness"); git("commit", "-qm", "harness");
  registerDaemonRepo({ canonicalRoot: repo, repoId: "dual-repo", userRoot, createConvenienceLinks: false });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-subj", "/CN=localhost", "-days", "1", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  const key = readFileSync(keyFile), cert = readFileSync(certFile), host = await openDaemonHost({ daemonId: "dual-center", userRoot });
  await host.attachmentsSettled();
  // Scope covers every task package plus one shared-surface document: tasks/
  // paths are lease-arbitrated (class A), context/ is the class-B surface.
  const assignment = (nodeId: NodeId): FleetAssignmentRecord => ({ nodeId, assignmentId: `assignment-${nodeId}`, repoId: "dual-repo", taskId: "task-seeded", executionId: "exe-seeded", paths: ["tasks", "context/shared-notes.md", "context/other-notes.md"], viewId: `${nodeId}-view`, expiresAt: "2099-01-01T00:00:00.000Z", actor: { principal: { personId: `person-${nodeId}` }, executor: { kind: "agent", id: `agent-${nodeId}` } } });
  const byId = new Map(nodes.map((nodeId) => [assignment(nodeId).assignmentId, assignment(nodeId)]));
  const center: FleetTlsCenter = await listenFleetTls({ host, stateRoot, key, cert, replicaDiskQuotaBytes: replicaQuota, authenticate: (nodeId, credential) => credential === `secret-${nodeId}`, resolveAssignment: (assignmentId) => byId.get(assignmentId) ?? null });
  const edgeRoot = (nodeId: NodeId): string => path.join(root, `${nodeId}-edge`), workspace = (nodeId: NodeId): string => path.join(root, `${nodeId}-workspace`);
  for (const nodeId of nodes) mkdirSync(workspace(nodeId), { recursive: true });
  const channel = (nodeId: NodeId) => ({ host: "127.0.0.1", port: center.port, caPath: certFile, servername: "localhost", nodeId, credential: `secret-${nodeId}`, assignmentId: `assignment-${nodeId}`, repoId: "dual-repo", viewRoot: edgeRoot(nodeId), quotaBytes: replicaQuota, workspaceRoot: workspace(nodeId) });
  const edgeTask = (nodeId: NodeId, action: Record<string, unknown>): Promise<Record<string, unknown>> => runFleetEdgeTask({ payload: { ...channel(nodeId), action: action as never } });
  const edgeDocSync = (nodeId: NodeId, options: { readonly dryRun?: boolean; readonly paths?: readonly string[] } = {}): Promise<Record<string, unknown>> => runFleetEdgeDocSync({ payload: { ...channel(nodeId), ...options } as never });
  const conflictExit = (nodeId: NodeId, action: "resolve" | "discard-local" | "overwrite-center", conflictId: string): Promise<Record<string, unknown>> => runFleetEdgeConflictExit({ payload: { ...channel(nodeId), action, conflictId } as never });
  const rawWrite = (nodeId: NodeId, changes: readonly { readonly path: string; readonly body: string; readonly baseBlobSha256?: string | null }[], executionId: string | null = null) => runFleetWriteClient({ hostname: "127.0.0.1", port: center.port, ca: cert, servername: "localhost", nodeId, credential: `secret-${nodeId}`, assignmentId: `assignment-${nodeId}`, timeoutMs: 30_000, executionId, changes });
  const view = (nodeId: NodeId) => locateFleetMirrorView(edgeRoot(nodeId), "dual-repo");
  const worktree = (nodeId: NodeId, logical: string): string => { const current = view(nodeId); assert.ok(current, `mirror view for ${nodeId} must exist`); return path.join(current.worktreeRoot, ...logical.split("/")); };
  const writeWorktree = (nodeId: NodeId, logical: string, body: string): void => { const target = worktree(nodeId, logical); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, body); };
  const conflictsRoot = (nodeId: NodeId): string => path.join(workspace(nodeId), ".harness", "conflicts");
  const createTask = async (nodeId: NodeId, taskId: string, title: string): Promise<{ readonly taskId: string; readonly packagePath: string }> => { const receipt = await edgeTask(nodeId, { kind: "task-create", taskId, title }); assert.equal(receipt.ok, true, `task create failed: ${JSON.stringify(receipt).slice(0, 400)}`); return { taskId: String(receipt.taskId), packagePath: String(receipt.packagePath) }; };
  return { root, repo, host, center, channel, edgeTask, edgeDocSync, conflictExit, rawWrite, view, worktree, writeWorktree, conflictsRoot, createTask, git, close: async () => { await center.close(); await host.close(); rmSync(root, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof dualSyncFixture>>;

test("class A: a task command carries local task documents, and the effect lands in both mirrors", { timeout: 60_000 }, async (t) => {
  const fixture: Fixture = await dualSyncFixture(); t.after(() => fixture.close());
  const created = await fixture.createTask("node-one", "task_AAAA000000000000000000000A", "Class A carry");
  const planPath = `${created.packagePath}/task_plan.md`;
  const original = readFileSync(fixture.worktree("node-one", planPath), "utf8");
  fixture.writeWorktree("node-one", planPath, `${original}\n## Edge owner notes\n\nEdited on the edge before starting the task.\n`);
  const started = await fixture.edgeTask("node-one", { kind: "task-start", taskId: created.taskId, executionId: "exe-a-carry" });
  assert.equal(started.ok, true, JSON.stringify(started).slice(0, 500));
  assert.equal((started as { readonly docSync?: { readonly outcome?: string } }).docSync?.outcome, "applied", "the carried documents must land with the transition");
  assert.equal((started as { readonly mirrorOutcome?: string }).mirrorOutcome, "applied");
  // The pushed bytes are now the mirror content on both nodes.
  assert.match(readFileSync(fixture.worktree("node-one", planPath), "utf8"), /Edge owner notes/u);
  await fixture.edgeTask("node-two", { kind: "task-create", taskId: "task_BBBB000000000000000000000B", title: "Peer view" }); // node-two pulls its own create
  const peerPlan = readFileSync(fixture.worktree("node-two", planPath), "utf8");
  assert.match(peerPlan, /Edge owner notes/u, "the second edge must see the carried document through its mirror");
});

test("F10: a hyphen-prefix sibling package never rides another task's class-A command", { timeout: 60_000 }, async (t) => {
  const fixture: Fixture = await dualSyncFixture(); t.after(() => fixture.close());
  const target = await fixture.createTask("node-one", "task-direct", "Direct");
  const sibling = await fixture.createTask("node-one", "task-direct-other", "Sibling");
  const siblingPlan = `${sibling.packagePath}/task_plan.md`, original = readFileSync(fixture.worktree("node-one", siblingPlan), "utf8");
  fixture.writeWorktree("node-one", siblingPlan, `${original}\nSibling-only local note.\n`);
  const started = await fixture.edgeTask("node-one", { kind: "task-start", taskId: target.taskId, executionId: "exe-prefix-target" });
  assert.equal(started.ok, true, JSON.stringify(started).slice(0, 500));
  assert.equal((started as { readonly docSync?: unknown }).docSync, undefined, "the target command must not attach the sibling's dirty document");
  assert.match(readFileSync(fixture.worktree("node-one", siblingPlan), "utf8"), /Sibling-only local note/u);
  // Refresh the peer through a real task command: it must not observe the
  // sibling note because it was not carried under the target's lease.
  assert.equal((await fixture.edgeTask("node-two", { kind: "task-create", taskId: "task-prefix-observer", title: "Observer" })).ok, true);
  assert.doesNotMatch(readFileSync(fixture.worktree("node-two", siblingPlan), "utf8"), /Sibling-only local note/u);
});

test("class A: a base conflict voids the whole transition and stages base/local/center", { timeout: 60_000 }, async (t) => {
  const fixture: Fixture = await dualSyncFixture(); t.after(() => fixture.close());
  const created = await fixture.createTask("node-one", "task_CCCC000000000000000000000C", "Base conflict");
  const planPath = `${created.packagePath}/task_plan.md`, original = readFileSync(fixture.worktree("node-one", planPath), "utf8");
  // Another collaborator rewrites the plan at the center while this edge is
  // still based on the original cut. F1: the channel-less doc submit is
  // refused outright; the collaborator must hold the lease and name it.
  const centerVersion = `${original}\n## Rewritten at the center\n\nThe center moved this document first.\n`;
  const refused = await fixture.rawWrite("node-two", [{ path: planPath, body: centerVersion, baseBlobSha256: sha256Bytes(Buffer.from(original)) }]);
  assert.equal(refused.center.outcome, "op_rejected");
  assert.equal(refused.center.code, "task_docs_require_task_command");
  assert.equal((await fixture.edgeTask("node-two", { kind: "task-start", taskId: created.taskId, executionId: "exe-center-writer" })).ok, true);
  const pushed = await fixture.rawWrite("node-two", [{ path: planPath, body: centerVersion, baseBlobSha256: sha256Bytes(Buffer.from(original)) }], "exe-center-writer");
  assert.equal(pushed.center.outcome, "applied");
  assert.equal((await fixture.edgeTask("node-two", { kind: "task-release", taskId: created.taskId, reason: "center-side rewrite done" })).ok, true);
  const localVersion = `${original}\n## Edge owner notes\n\nLocal edit based on the stale cut.\n`;
  fixture.writeWorktree("node-one", planPath, localVersion);
  const started = await fixture.edgeTask("node-one", { kind: "task-start", taskId: created.taskId, executionId: "exe-a-conflict" });
  assert.equal(started.ok, false, "a base conflict must void the whole command");
  assert.ok(["mirror_behind_center", "base_blob_changed"].includes(String((started as { readonly code?: string }).code)), `a conflict code was expected, saw ${String((started as { readonly code?: string }).code)}`);
  // The transition did NOT happen: the task still has no lease at the center.
  const leases = fixture.center.status().leases.leases.filter((row) => row.taskId === created.taskId);
  assert.equal(leases.length, 0, "the center state must not transition on a conflicted bundle");
  // The divergence is staged with all three sides.
  const conflicts = readdirSync(fixture.conflictsRoot("node-one")).filter((entry) => entry.startsWith("cflt-"));
  assert.equal(conflicts.length, 1, `exactly one staged conflict expected, saw ${conflicts.join(",")}`);
  const dir = path.join(fixture.conflictsRoot("node-one"), conflicts[0]!);
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as { readonly code: string; readonly paths: readonly { readonly path: string }[]; readonly exits: readonly string[]; readonly state: string };
  assert.deepEqual(manifest.paths.map((row) => row.path), [planPath]);
  assert.deepEqual(manifest.exits, ["resolve", "discard-local", "overwrite-center"]);
  assert.match(readFileSync(path.join(dir, "local", planPath), "utf8"), /Edge owner notes/u);
  assert.match(readFileSync(path.join(dir, "center", planPath), "utf8"), /Rewritten at the center/u);
  assert.ok(readFileSync(path.join(dir, "base", planPath), "utf8").startsWith(original.slice(0, 40).trim()), "the staged base side must hold the original cut bytes");
  // The center document is untouched by the failed push and the local edit survives.
  assert.match(readFileSync(fixture.worktree("node-one", planPath), "utf8"), /Edge owner notes/u);
  // The per-path base guard itself: a bundle whose mirror cut is current but
  // whose declared per-path base no longer matches the projection is refused
  // with base_blob_changed and the transition never runs.
  const auth = { transportKind: "fleet-tls" as const, assignmentBinding: { nodeId: "node-one", assignmentId: "assignment-node-one", repoId: "dual-repo", taskId: created.taskId, executionId: "exe-seeded", paths: ["tasks"], actor: { principal: { personId: "person-node-one" }, executor: { kind: "agent" as const, id: "agent-node-one" } } } };
  const head = JSON.parse(fixture.git("show", "refs/ha/canonical:harness/events/head.json")) as { revision: number; opId: string; eventDigest: string };
  const probe = await fixture.host.run("dual-repo", { kind: "task-start", taskId: created.taskId, executionId: "exe-a-probe", mirrorBaseCut: { revision: head.revision, headDigest: `sha256:${sha256Text(serializeEventHead(head))}` }, docChanges: [{ path: planPath, baseBlobSha256: sha256Bytes(Buffer.from(localVersion)), policyId: "markdown-body-replaceable/v1", candidate: { ref: `doc-sync-claims/${sha256Bytes(Buffer.from(centerVersion))}`, sha256: sha256Bytes(Buffer.from(centerVersion)), size: Buffer.byteLength(centerVersion), mediaType: "text/markdown" } }] }, auth);
  assert.equal(probe.outcome, "op_rejected");
  assert.equal(probe.code, "base_blob_changed");
  assert.equal(fixture.center.status().leases.leases.filter((row) => row.taskId === created.taskId).length, 0, "the probe transition must not apply either");
});

test("class A: a stale mirror cut is refused, then the same command applies after a sync", { timeout: 60_000 }, async (t) => {
  const fixture: Fixture = await dualSyncFixture(); t.after(() => fixture.close());
  const created = await fixture.createTask("node-one", "task_DDDD000000000000000000000D", "Mirror gate");
  const planPath = `${created.packagePath}/task_plan.md`, original = readFileSync(fixture.worktree("node-one", planPath), "utf8");
  // The center advances on a path this edge does not touch, so only the mirror
  // base cut is stale — the gate must still refuse to carry documents on it.
  await fixture.rawWrite("node-two", [{ path: "context/shared-notes.md", body: "# Shared\n\nFirst center version.\n" }]);
  fixture.writeWorktree("node-one", planPath, `${original}\n## Local plan edit\n\nBased on the previous cut.\n`);
  const refused = await fixture.edgeTask("node-one", { kind: "task-start", taskId: created.taskId, executionId: "exe-a-gate" });
  assert.equal(refused.ok, false);
  assert.equal((refused as { readonly code?: string }).code, "mirror_behind_center");
  assert.equal(fixture.center.status().leases.leases.filter((row) => row.taskId === created.taskId).length, 0, "the transition must not apply behind the gate");
  // The explicit sync round refreshes the mirror; the retried command applies.
  const synced = await fixture.edgeDocSync("node-one");
  assert.equal(synced.ok, true, JSON.stringify(synced).slice(0, 400));
  const retried = await fixture.edgeTask("node-one", { kind: "task-start", taskId: created.taskId, executionId: "exe-a-gate" });
  assert.equal(retried.ok, true, JSON.stringify(retried).slice(0, 500));
  assert.equal((retried as { readonly docSync?: { readonly outcome?: string } }).docSync?.outcome, "applied");
  assert.match(readFileSync(fixture.worktree("node-one", planPath), "utf8"), /Local plan edit/u);
});

test("non-holder task-document pushes are rejected outright (no staging, no ledger effect)", { timeout: 60_000 }, async (t) => {
  const fixture: Fixture = await dualSyncFixture(); t.after(() => fixture.close());
  const created = await fixture.createTask("node-one", "task_EEEE000000000000000000000E", "Holder only");
  const started = await fixture.edgeTask("node-one", { kind: "task-start", taskId: created.taskId, executionId: "exe-a-holder" });
  assert.equal(started.ok, true);
  const planPath = `${created.packagePath}/task_plan.md`, original = readFileSync(fixture.worktree("node-one", planPath), "utf8");
  const before = Number(fixture.git("rev-list", "--count", "refs/ha/canonical"));
  // node-two names the holder's execution but is a different principal: the
  // domain lease rejects the push, bypassing the automatic entry changes
  // nothing.
  const attempt = await fixture.rawWrite("node-two", [{ path: planPath, body: `${original}\n## Non-holder edit\n\nMust not land.\n`, baseBlobSha256: sha256Bytes(Buffer.from(original)) }], "exe-a-holder");
  assert.equal(attempt.center.outcome, "op_rejected");
  assert.equal(attempt.center.code, "lease_conflict");
  assert.equal(Number(fixture.git("rev-list", "--count", "refs/ha/canonical")), before, "the ledger must not move for a non-holder push");
});

test("class B: doc sync compares, pushes, and CENTER_REJECTED stages instead of overwriting; all three exits work", { timeout: 60_000 }, async (t) => {
  const fixture: Fixture = await dualSyncFixture(); t.after(() => fixture.close());
  const shared = "context/shared-notes.md";
  await fixture.rawWrite("node-one", [{ path: shared, body: "# Shared\n\nv1 baseline.\n" }]);
  const first = await fixture.edgeDocSync("node-one", { paths: [shared] });
  assert.equal(first.ok, true, JSON.stringify(first).slice(0, 400));
  assert.equal(readFileSync(fixture.worktree("node-one", shared), "utf8"), "# Shared\n\nv1 baseline.\n");
  // Local edit on the edge; the center version moves underneath it.
  const localBody = "# Shared\n\nv1 baseline.\n\n## Edge one addition\n\nOnly on the edge.\n";
  fixture.writeWorktree("node-one", shared, localBody);
  await fixture.rawWrite("node-two", [{ path: shared, body: "# Shared\n\nv1 baseline.\n\n## Center version two\n\nWritten by the peer edge.\n", baseBlobSha256: sha256Bytes(Buffer.from("# Shared\n\nv1 baseline.\n")) }]);
  const conflicted = await fixture.edgeDocSync("node-one", { paths: [shared] });
  assert.equal(conflicted.ok, false, "the round must not report success over divergence");
  assert.equal((conflicted as { readonly syncState?: string }).syncState, "CONFLICT_STAGED");
  assert.equal((conflicted as { readonly code?: string }).code, "pull_blocked");
  const conflicts = readdirSync(fixture.conflictsRoot("node-one")).filter((entry) => entry.startsWith("cflt-"));
  assert.equal(conflicts.length, 1);
  const conflictId = conflicts[0]!, dir = path.join(fixture.conflictsRoot("node-one"), conflictId);
  assert.match(readFileSync(path.join(dir, "center", shared), "utf8"), /Center version two/u);
  assert.match(readFileSync(path.join(dir, "local", shared), "utf8"), /Edge one addition/u);
  // Nothing was merged or overwritten: the worktree keeps the local bytes and
  // the center keeps its own.
  assert.match(readFileSync(fixture.worktree("node-one", shared), "utf8"), /Edge one addition/u);
  // Exit 2 — discard-local: the worktree adopts the recorded center bytes.
  const discarded = await fixture.conflictExit("node-one", "discard-local", conflictId);
  assert.equal(discarded.ok, true, JSON.stringify(discarded).slice(0, 400));
  assert.match(readFileSync(fixture.worktree("node-one", shared), "utf8"), /Center version two/u);
  const settled = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as { readonly state: string; readonly resolvedVia: string };
  assert.equal(settled.state, "resolved"); assert.equal(settled.resolvedVia, "discard-local");
  // Stage a second divergence and take exit 3 — overwrite-center.
  fixture.writeWorktree("node-one", shared, "# Shared\n\nv1 baseline.\n\n## Center version two\n\nWritten by the peer edge.\n\n## Edge one wins\n\nExplicit overwrite.\n");
  // The center revision stays inside the existing region (no new heading):
  // the additive-region policy forbids wholesale rewrites, so the overwrite
  // exit must also operate within it.
  const v3 = await fixture.rawWrite("node-two", [{ path: shared, body: "# Shared\n\nv1 baseline.\n\n## Center version two\n\nWritten by the peer edge, revised at the center.\n", baseBlobSha256: sha256Bytes(Buffer.from("# Shared\n\nv1 baseline.\n\n## Center version two\n\nWritten by the peer edge.\n")) }]);
  assert.equal(v3.center.outcome, "applied", JSON.stringify(v3.center));
  const second = await fixture.edgeDocSync("node-one", { paths: [shared] });
  assert.equal(second.ok, false, JSON.stringify(second).slice(0, 600));
  const secondConflicts = readdirSync(fixture.conflictsRoot("node-one")).filter((entry) => entry.startsWith("cflt-"));
  assert.equal(secondConflicts.length, 2, `expected the second divergence to stage separately, saw ${secondConflicts.join(",")}`);
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
});

test("class B: a clean push round applies at the center and reports SYNCED", { timeout: 60_000 }, async (t) => {
  const fixture: Fixture = await dualSyncFixture(); t.after(() => fixture.close());
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
  assert.equal(readFileSync(fixture.worktree("node-one", shared), "utf8"), "# Shared\n\nbaseline.\n\n## Push me\n\nClean local change.\n");
  const peer = await fixture.edgeDocSync("node-two", { paths: [shared] });
  assert.equal(peer.ok, true);
  assert.match(readFileSync(fixture.worktree("node-two", shared), "utf8"), /Push me/u);
});

test("pull-blocked is reported on the dual axis instead of masquerading as synced", { timeout: 60_000 }, async (t) => {
  const fixture: Fixture = await dualSyncFixture(); t.after(() => fixture.close());
  const taskA = await fixture.createTask("node-one", "task_FFFF000000000000000000000F", "Dual axis A");
  const taskB = await fixture.createTask("node-one", "task_GGGG000000000000000000000G", "Dual axis B");
  assert.equal((await fixture.edgeTask("node-one", { kind: "task-start", taskId: taskA.taskId, executionId: "exe-dual-a" })).ok, true);
  const planB = `${taskB.packagePath}/task_plan.md`;
  // node-one keeps a local edit on task B's plan while node-two takes B and
  // pushes a different version through its own task command.
  const original = readFileSync(fixture.worktree("node-one", planB), "utf8");
  fixture.writeWorktree("node-one", planB, `${original}\n## Node one local notes\n\nUnsynced.\n`);
  assert.equal((await fixture.edgeTask("node-two", { kind: "task-start", taskId: taskB.taskId, executionId: "exe-dual-b" })).ok, true);
  const peerOriginal = readFileSync(fixture.worktree("node-two", planB), "utf8");
  fixture.writeWorktree("node-two", planB, `${peerOriginal}\n## Node two landed version\n\nPushed while node-one was dirty.\n`);
  const peerPush = await fixture.edgeTask("node-two", { kind: "task-progress-append", taskId: taskB.taskId, text: "peer pushed the plan with this transition" });
  assert.equal(peerPush.ok, true, JSON.stringify(peerPush).slice(0, 500));
  // node-one's own command on task A applies at the center; the auto pull then
  // finds the diverged task B plan and must say pull_blocked, not synced.
  const progress = await fixture.edgeTask("node-one", { kind: "task-progress-append", taskId: taskA.taskId, text: "applied at the center while the mirror diverged" });
  assert.equal(progress.ok, false, "a pull-blocked outcome must not report ok");
  assert.equal((progress as { readonly canonicalOutcome?: string }).canonicalOutcome, "applied");
  assert.equal((progress as { readonly mirrorOutcome?: string }).mirrorOutcome, "pull_blocked");
  const conflicts = readdirSync(fixture.conflictsRoot("node-one")).filter((entry) => entry.startsWith("cflt-"));
  assert.equal(conflicts.length, 1);
  const manifest = JSON.parse(readFileSync(path.join(fixture.conflictsRoot("node-one"), conflicts[0]!, "manifest.json"), "utf8")) as { readonly paths: readonly { readonly path: string }[] };
  assert.deepEqual(manifest.paths.map((row) => row.path), [planB]);
  assert.match(readFileSync(fixture.worktree("node-one", planB), "utf8"), /Node one local notes/u, "the local bytes must survive untouched");
});

test("F4: an unresolved conflict gates this task's later commands at the edge", { timeout: 60_000 }, async (t) => {
  const fixture: Fixture = await dualSyncFixture(); t.after(() => fixture.close());
  const created = await fixture.createTask("node-one", "task_IIII000000000000000000000I", "Gate task");
  const planPath = `${created.packagePath}/task_plan.md`, original = readFileSync(fixture.worktree("node-one", planPath), "utf8");
  // Diverge the plan: center rewrite (holder channel) vs local edit.
  assert.equal((await fixture.edgeTask("node-one", { kind: "task-start", taskId: created.taskId, executionId: "exe-gate-a" })).ok, true);
  await fixture.rawWrite("node-one", [{ path: planPath, body: `${original}\n## Center version\n`, baseBlobSha256: sha256Bytes(Buffer.from(original)) }], "exe-gate-a");
  assert.equal((await fixture.edgeTask("node-one", { kind: "task-release", taskId: created.taskId, reason: "handing over" })).ok, true);
  fixture.writeWorktree("node-one", planPath, `${original}\n## Local version\n`);
  // A second node takes the lease and moves the plan; edge-one's local edit diverges.
  const takeover = await fixture.edgeTask("node-two", { kind: "task-start", taskId: created.taskId });
  assert.equal(takeover.ok, true, JSON.stringify(takeover).slice(0, 500));
  const centerNow = `${original}\n## Center version\n`;
  const moved = await fixture.rawWrite("node-two", [{ path: planPath, body: `${centerNow}\n## Center moved again\n`, baseBlobSha256: sha256Bytes(Buffer.from(centerNow)) }], "exe-gate-a");
  assert.equal(moved.center.outcome, "applied", JSON.stringify(moved.center));
  assert.equal((await fixture.edgeTask("node-two", { kind: "task-release", taskId: created.taskId, reason: "gate scenario" })).ok, true);
  const diverged = await fixture.edgeDocSync("node-one", { paths: [planPath] });
  assert.equal(diverged.ok, false, JSON.stringify(diverged).slice(0, 400));
  assert.equal((diverged as { readonly syncState?: string }).syncState, "CONFLICT_STAGED");
  // The unresolved record gates this task's commands BEFORE any upload: no
  // center round-trip, no ledger movement.
  const beforeGate = Number(fixture.git("rev-list", "--count", "refs/ha/canonical"));
  const gated = await fixture.edgeTask("node-one", { kind: "task-start", taskId: created.taskId, executionId: "exe-gate-c" });
  assert.equal(gated.ok, false);
  assert.equal((gated as { readonly code?: string }).code, "conflict_open");
  assert.equal(Number(fixture.git("rev-list", "--count", "refs/ha/canonical")), beforeGate, "the gate must refuse without touching the center");
  // Another task is unaffected: its commands stay canonically admissible even
  // while this task's conflict is open (the mirror may still report the other
  // task's divergence on the dual axis — that is the honest outcome).
  const other = await fixture.edgeTask("node-one", { kind: "task-create", taskId: "task_JJJJ000000000000000000000J", title: "Unaffected task" });
  assert.equal((other as { readonly canonicalOutcome?: string }).canonicalOutcome, "applied", JSON.stringify(other).slice(0, 400));
  const otherStart = await fixture.edgeTask("node-one", { kind: "task-start", taskId: "task_JJJJ000000000000000000000J", executionId: "exe-gate-other" });
  assert.equal((otherStart as { readonly canonicalOutcome?: string }).canonicalOutcome, "applied", JSON.stringify(otherStart).slice(0, 400));
  // discard-local lifts the gate.
  const record = readFleetUnresolvedConflicts(path.join(fixture.root, "node-one-workspace"), "dual-repo")[0]!;
  const discarded = await fixture.conflictExit("node-one", "discard-local", record.conflictId);
  assert.equal(discarded.ok, true, JSON.stringify(discarded).slice(0, 400));
  const ungated = await fixture.edgeTask("node-one", { kind: "task-start", taskId: created.taskId });
  assert.equal((ungated as { readonly canonicalOutcome?: string }).canonicalOutcome, "applied", JSON.stringify(ungated).slice(0, 400));
});

test("F5/F6: a rejected push settles honestly and overwrite-center is idempotent across a crash after the append", { timeout: 60_000 }, async (t) => {
  const fixture: Fixture = await dualSyncFixture(); t.after(() => fixture.close());
  const shared = "context/shared-notes.md";
  await fixture.rawWrite("node-one", [{ path: shared, body: "# Shared\n\nbaseline.\n" }]);
  assert.equal((await fixture.edgeDocSync("node-one", { paths: [shared] })).ok, true);
  const baseline = "# Shared\n\nbaseline.\n";
  // Keep both edits within the existing # Shared region. That creates a
  // legitimate shared-prose divergence and also lets the fixture emulate the
  // already-appended overwrite bytes without violating the heading policy.
  fixture.writeWorktree("node-one", shared, `${baseline}\nEdge one wins.\n`);
  await fixture.rawWrite("node-two", [{ path: shared, body: `${baseline}\nCenter moved.\n`, baseBlobSha256: sha256Bytes(Buffer.from(baseline)) }]);
  // settlePushRejection with a diverged mirror stages base/local/center and reports blocked.
  const peer = { hostname: "127.0.0.1", port: fixture.center.port, ca: readFileSync(path.join(fixture.root, "tls.crt")), servername: "localhost", nodeId: "node-one", credential: "secret-node-one", assignmentId: "assignment-node-one" };
  const diverged = await settlePushRejection({ ...fixture.channel("node-one") }, peer, 30_000, "base_blob_changed");
  assert.equal(diverged.blocked, true);
  assert.equal(diverged.conflicts.length, 1, "a same-path move must stage its record, not strand the operator");
  const record = diverged.conflicts[0]!;
  const manifest = JSON.parse(readFileSync(path.join(record.dir, "manifest.json"), "utf8")) as { readonly paths: readonly { readonly path: string }[] };
  assert.deepEqual(manifest.paths.map((row) => row.path), [shared]);
  // settlePushRejection with a NON-diverged mirror reports an honest
  // CENTER_REJECTED (blocked=false, nothing staged) instead of claiming
  // CONFLICT_STAGED with no record (F5).
  // Use the peer's clean mirror for the ledger-only rejection branch. The
  // node-one view intentionally still carries the unresolved same-path
  // conflict above; reusing it would test the persistent gate, not the
  // CENTER_REJECTED-without-staging outcome.
  assert.equal((await fixture.edgeDocSync("node-two", { paths: [shared] })).ok, true);
  const peerTwo = { hostname: "127.0.0.1", port: fixture.center.port, ca: readFileSync(path.join(fixture.root, "tls.crt")), servername: "localhost", nodeId: "node-two", credential: "secret-node-two", assignmentId: "assignment-node-two" };
  const clean = await settlePushRejection({ ...fixture.channel("node-two"), paths: [] }, peerTwo, 30_000, "base_ledger_changed");
  assert.equal(clean.blocked, false);
  assert.deepEqual(clean.conflicts, []);
  // F6 idempotency: simulate a crash after the center append by pushing the
  // staged local bytes directly (holder-less shared channel), then retrying
  // the exit — it must settle without a second push.
  const settledRecord = readFleetUnresolvedConflicts(path.join(fixture.root, "node-one-workspace"), "dual-repo").find((entry) => entry.paths.some((row) => row.path === shared))!;
  // The simulated crash happens after the center append has committed the
  // staged local bytes verbatim. A retry must recognize that digest and close
  // the record without appending a second event.
  const stagedLocal = `${baseline}\nEdge one wins.\n`;
  const manual = await fixture.rawWrite("node-one", [{ path: shared, body: stagedLocal, baseBlobSha256: sha256Bytes(Buffer.from(`${baseline}\nCenter moved.\n`)) }]);
  assert.equal(manual.center.outcome, "applied", JSON.stringify(manual.center));
  const commitsAfterAppend = Number(fixture.git("rev-list", "--count", "refs/ha/canonical"));
  const idempotent = await fixture.conflictExit("node-one", "overwrite-center", settledRecord.conflictId);
  assert.equal(idempotent.ok, true, JSON.stringify(idempotent).slice(0, 400));
  assert.equal((idempotent as { readonly idempotent?: boolean }).idempotent, true);
  const after = JSON.parse(readFileSync(path.join(fixture.root, "node-one-workspace", ".harness", "conflicts", settledRecord.conflictId, "manifest.json"), "utf8")) as { readonly state: string };
  assert.equal(after.state, "resolved");
  assert.equal(Number(fixture.git("rev-list", "--count", "refs/ha/canonical")), commitsAfterAppend, "the idempotent retry must not append a second doc event");
});

test("F6: an idempotent overwrite reports a newly pull-blocked mirror instead of masking it", { timeout: 60_000 }, async (t) => {
  const fixture: Fixture = await dualSyncFixture(); t.after(() => fixture.close());
  const shared = "context/shared-notes.md", other = "context/other-notes.md";
  const sharedBase = "# Shared\n\nbaseline.\n", otherBase = "# Other\n\nbaseline.\n";
  assert.equal((await fixture.rawWrite("node-one", [{ path: shared, body: sharedBase }])).center.outcome, "applied");
  assert.equal((await fixture.rawWrite("node-one", [{ path: other, body: otherBase }])).center.outcome, "applied");
  assert.equal((await fixture.edgeDocSync("node-one")).ok, true);
  const sharedLocal = `${sharedBase}\nedge wins.\n`;
  fixture.writeWorktree("node-one", shared, sharedLocal);
  assert.equal((await fixture.rawWrite("node-two", [{ path: shared, body: `${sharedBase}\ncenter moved.\n`, baseBlobSha256: sha256Bytes(Buffer.from(sharedBase)) }])).center.outcome, "applied");
  const peer = { hostname: "127.0.0.1", port: fixture.center.port, ca: readFileSync(path.join(fixture.root, "tls.crt")), servername: "localhost", nodeId: "node-one", credential: "secret-node-one", assignmentId: "assignment-node-one" };
  const staged = await settlePushRejection({ ...fixture.channel("node-one") }, peer, 30_000, "base_blob_changed");
  assert.equal(staged.blocked, true);
  const original = staged.conflicts[0]!;
  // A different path diverges after the original record exists. The simulated
  // crashed overwrite then makes only the original path canonical.
  fixture.writeWorktree("node-one", other, `${otherBase}\nedge-local.\n`);
  assert.equal((await fixture.rawWrite("node-two", [{ path: other, body: `${otherBase}\ncenter-new.\n`, baseBlobSha256: sha256Bytes(Buffer.from(otherBase)) }])).center.outcome, "applied");
  assert.equal((await fixture.rawWrite("node-one", [{ path: shared, body: sharedLocal, baseBlobSha256: sha256Bytes(Buffer.from(`${sharedBase}\ncenter moved.\n`)) }])).center.outcome, "applied");
  const retried = await fixture.conflictExit("node-one", "overwrite-center", original.conflictId);
  assert.equal(retried.ok, false, JSON.stringify(retried).slice(0, 600));
  assert.equal((retried as { readonly idempotent?: boolean }).idempotent, true);
  assert.equal((retried as { readonly canonicalOutcome?: string }).canonicalOutcome, "applied");
  assert.equal((retried as { readonly mirrorOutcome?: string }).mirrorOutcome, "pull_blocked");
  const originalState = JSON.parse(readFileSync(path.join(original.dir, "manifest.json"), "utf8")) as { readonly state: string };
  assert.equal(originalState.state, "resolved", "the already-canonical overwrite itself is settled");
  assert.ok(readFleetUnresolvedConflicts(path.join(fixture.root, "node-one-workspace"), "dual-repo").some((record) => record.paths.some((row) => row.path === other)), "the unrelated divergence must remain staged and visible");
});

test("class A submit carries the closing documents in the same serial command", { timeout: 60_000 }, async (t) => {
  const fixture: Fixture = await dualSyncFixture(); t.after(() => fixture.close());
  const created = await fixture.createTask("node-one", "task_HHHH000000000000000000000H", "Closing docs ride submit");
  assert.equal((await fixture.edgeTask("node-one", { kind: "task-start", taskId: created.taskId, executionId: "exe-a-submit" })).ok, true);
  const planPath = `${created.packagePath}/task_plan.md`, original = readFileSync(fixture.worktree("node-one", planPath), "utf8");
  fixture.writeWorktree("node-one", planPath, `${original}\n## Closing note\n\nRides the submit.\n`);
  const submitted = await fixture.edgeTask("node-one", { kind: "task-submit", taskId: created.taskId, executionId: "exe-a-submit", submission: submissionPacket });
  assert.equal(submitted.ok, true, JSON.stringify(submitted).slice(0, 500));
  assert.equal((submitted as { readonly docSync?: { readonly outcome?: string; readonly paths?: readonly string[] } }).docSync?.outcome, "applied");
  assert.deepEqual((submitted as { readonly docSync?: { readonly paths?: readonly string[] } }).docSync?.paths, [planPath]);
  assert.match(readFileSync(fixture.worktree("node-one", planPath), "utf8"), /Closing note/u);
});

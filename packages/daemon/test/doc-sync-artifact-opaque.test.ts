// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { decideDocWrite, docSyncWritePlan, makeTaskEventStore, parseDocWriteIntent, sha256Bytes } from "../../kernel/src/index.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";

const PROSE_POLICY_ID = "markdown-body-replaceable/v1", OPAQUE_POLICY_ID = "opaque-textual-whole-file/v1";
const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;
const reviewerBinding = { actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent", id: "arbiter" } }, source: "local" as const, roles: ["$arbiter"] } as const;

test("artifact add treats every artifacts/ path as opaque while preserving media type and bytes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-opaque-")); initRepo(rootDir);
  const repoId = workspaceId("artifact-opaque"), cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-opaque" }), binding = { actor, source: "local" as const };
  try {
    assert.equal((await cell.run({ kind: "task-create", taskId: "task-opaque", title: "Opaque Artifacts" }, binding)).outcome, "applied");
    const cases = [
      { source: "tool.mjs", destination: "scripts/tool.mjs", mediaType: "text/javascript", body: "export const render = (rows) => rows.map((row) => `${row.id}: ${row.label} — UTF-8 报告\n`).join(\"\");\n" },
      { source: "page.html", destination: "reports/page.html", mediaType: "text/html", body: "<!doctype html>\n<html lang=\"zh\">\n<meta charset=\"utf-8\">\n<title>Dossier — 报告</title>\n<p>byte-fidelity ✓</p>\n" },
      { source: "payload.json", destination: "data/payload.json", mediaType: "application/json", body: "{\n  \"label\": \"报告 — dossier\",\n  \"rows\": [{ \"id\": 1, \"ok\": true }]\n}\n" },
      { source: "style.css", destination: "artifacts/reports/assets/style.css", mediaType: "text/css", body: "body { font-family: sans-serif; content: \"报告 ✓\"; }\n" },
      { source: "report.md", destination: "reports/report.md", mediaType: "text/markdown", body: "---\ntitle: Opaque report\n---\n\n# Same\n\n# Same\n\nByte-preserved frontmatter.\n" },
      { source: "notes.txt", destination: "reports/notes.txt", mediaType: "text/plain", body: "plain-text artifact\n" },
      { source: "windows.md", destination: "reports/windows.md", mediaType: "text/markdown", body: "---\r\ntitle: CRLF report\r\n---\r\n\r\n# Windows\r\n" },
      { source: "script.ts", destination: "scripts/script.ts", mediaType: "text/x-harness-opaque", body: "export const typed: number = 1;\n" },
      { source: "view.tsx", destination: "scripts/view.tsx", mediaType: "text/x-harness-opaque", body: "export const View = () => <main>artifact</main>;\n" }
    ];
    const packagePath = "tasks/task-opaque-opaque-artifacts";
    for (const { source, destination, mediaType, body } of cases) {
      const bytes = Buffer.from(body, "utf8"), relative = destination.replace(/^artifacts\//u, "");
      writeFileSync(path.join(rootDir, source), bytes);
      const added = await cell.run({ kind: "task-artifact-add", taskId: "task-opaque", source, destination }, binding) as Record<string, unknown>;
      assert.equal(added.outcome, "applied", JSON.stringify(added));
      const logical = String(added.destination);
      assert.equal(logical, `${packagePath}/artifacts/${relative}`);
      const event = makeTaskEventStore({ repoId, rootDir }).readEvent(String(added.opId));
      assert.equal(event?.schema, "doc-event/v1", `${destination}: no doc event`);
      if (event?.schema !== "doc-event/v1") continue;
      const change = event.payload.changes[0]!;
      assert.equal(change.path, logical);
      assert.equal(change.policyId, OPAQUE_POLICY_ID, `${destination}: policy`);
      assert.equal(change.candidate.mediaType, mediaType, `${destination}: media type`);
      assert.equal(change.candidate.sha256, sha256Bytes(bytes));
      assert.equal(change.candidate.size, bytes.byteLength);
      assert.deepEqual(change.regionProofs, [], `${destination}: opaque whole-file policy must not emit region proofs`);
      const onDisk = readFileSync(path.join(rootDir, "harness", ...logical.split("/")));
      assert.equal(onDisk.equals(bytes), true, `${destination}: authored bytes must equal source bytes`);
      const status = await cell.run({ kind: "doc-status", paths: [logical] }, binding);
      const row = rows(status.evidence).find((candidate) => candidate.path === logical);
      assert.deepEqual([row?.state, row?.mediaType], ["clean", mediaType], `${destination}: doc status`);
    }
    rmSync(path.join(rootDir, "harness", "tasks"), { recursive: true, force: true });
    const materialized = await cell.run({ kind: "doc-materialize" }, binding);
    assert.equal(materialized.outcome, "applied", JSON.stringify(materialized));
    for (const { destination, body } of cases) assert.equal(readFileSync(path.join(rootDir, "harness", packagePath, "artifacts", ...destination.replace(/^artifacts\//u, "").split("/"))).equals(Buffer.from(body, "utf8")), true, `${destination}: materialize must restore source bytes`);
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("artifact add still rejects escapes, symlinked path segments, and non-UTF-8 sources", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-guards-")); initRepo(rootDir);
  const cell = await openRepoCell({ repoId: workspaceId("artifact-guards"), rootDir: canonicalRoot(rootDir), ownerId: "artifact-guards" }), binding = { actor, source: "local" as const };
  try {
    assert.equal((await cell.run({ kind: "task-create", taskId: "task-guards", title: "Guards" }, binding)).outcome, "applied");
    const packagePath = "tasks/task-guards-guards", artifactsDir = path.join(rootDir, "harness", packagePath, "artifacts");
    writeFileSync(path.join(rootDir, "incoming.mjs"), "export const one = 1;\n");
    const escape = await cell.run({ kind: "task-artifact-add", taskId: "task-guards", source: "incoming.mjs", destination: "../escape.md" }, binding) as Record<string, unknown>;
    assert.equal(escape.code, "invalid_artifact_path");
    writeFileSync(path.join(rootDir, "outside.mjs"), "export const two = 2;\n");
    mkdirSync(artifactsDir, { recursive: true });
    symlinkSync(path.join(rootDir), path.join(artifactsDir, "linked"));
    const viaSymlink = await cell.run({ kind: "task-artifact-add", taskId: "task-guards", source: "outside.mjs", destination: "linked/escape.mjs" }, binding) as Record<string, unknown>;
    assert.equal(viaSymlink.code, "invalid_artifact_path");
    writeFileSync(path.join(rootDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x0a]));
    assert.equal((await cell.run({ kind: "task-artifact-add", taskId: "task-guards", source: "logo.png", destination: "img/logo.png" }, binding) as Record<string, unknown>).code, "artifact_invalid_utf8");
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("a historical prose artifact is rewritten as opaque without a policy upgrade", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-policy-reclassify-")); initRepo(rootDir);
  const repoId = workspaceId("artifact-policy-reclassify"), binding = { actor, source: "local" as const };
  let cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-policy-reclassify" });
  try {
    assert.equal((await cell.run({ kind: "task-create", taskId: "task-reclassify", title: "Reclassify" }, binding)).outcome, "applied");
    await cell.close();
    const packagePath = "tasks/task-reclassify-reclassify", report = `${packagePath}/artifacts/report.md`, legacy = "# Legacy\n\n## Same\n\nfirst\n";
    const store = makeTaskEventStore({ repoId, rootDir }), bytes = Buffer.from(legacy), sha = sha256Bytes(bytes), base = store.currentCut();
    const historic = decideDocWrite({ intent: parseDocWriteIntent({ schema: "doc-write-intent/v1", executionId: null, baseLedgerSha: base, changes: [{ path: report, baseBlobSha256: null, policyId: PROSE_POLICY_ID, candidate: { ref: `doc-sync-claims/${sha}`, sha256: sha, size: bytes.byteLength, mediaType: "text/markdown" } }] }, repoId), opId: "op_historical_prose_artifact", eventId: "event-historical-prose-artifact", workspaceRevision: store.read().revision + 1, actor, source: "local", occurredAt: "2026-08-19T00:00:00.000Z", currentLedgerSha: base, lease: null, documents: [null], claims: [bytes] });
    assert.equal(historic.accepted, true, JSON.stringify(historic));
    if (!historic.accepted) return;
    store.append({ event: historic.event, plan: docSyncWritePlan(historic.event), blobs: historic.blobs });
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-policy-reclassify-next" });
    const rewritten = "---\ntitle: Rewritten report\n---\n\n# Same\n\n# Same\n\nopaque rewrite\n";
    write(rootDir, report, rewritten);
    const submitted = await cell.run({ kind: "doc-submit", paths: [report] }, binding) as Record<string, unknown>;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const event = makeTaskEventStore({ repoId, rootDir }).readEvent(String(submitted.opId));
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema !== "doc-event/v1") return;
    const change = event.payload.changes[0]!;
    assert.equal(change.policyId, OPAQUE_POLICY_ID);
    assert.equal(change.candidate.mediaType, "text/markdown");
    assert.deepEqual(change.regionProofs, []);
    assert.equal("policyUpgrade" in change, false);
    assert.equal(readFileSync(path.join(rootDir, "harness", ...report.split("/"))).equals(Buffer.from(rewritten)), true);
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("task_plan.md and closeout.md retain prose policy, proofs, and deletion protection", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-prose-")); initRepo(rootDir);
  const repoId = workspaceId("task-prose"), cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "task-prose" }), binding = { actor, source: "local" as const };
  try {
    assert.equal((await cell.run({ kind: "task-create", taskId: "task-prose", title: "Prose" }, binding)).outcome, "applied");
    const packagePath = "tasks/task-prose-prose", prosePaths = [`${packagePath}/task_plan.md`, `${packagePath}/closeout.md`];
    for (const logical of prosePaths) write(rootDir, logical, `${readFileSync(path.join(rootDir, "harness", logical), "utf8")}\n## Extension\n\nCanonical prose update.\n`);
    const submitted = await cell.run({ kind: "doc-submit", paths: prosePaths }, binding) as Record<string, unknown>;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const event = makeTaskEventStore({ repoId, rootDir }).readEvent(String(submitted.opId));
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema !== "doc-event/v1") return;
    for (const change of event.payload.changes) {
      assert.equal(change.policyId, PROSE_POLICY_ID, change.path);
      assert.ok(change.regionProofs.length > 0, `${change.path}: prose must carry region proofs`);
    }
    for (const logical of prosePaths) {
      write(rootDir, logical, "# Removed\n");
      const blocked = await blockedRow(cell, logical);
      assert.equal(blocked[0], logical);
      assert.match(String(blocked[1]), /missing|forbidden/u);
    }
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("completion preflight publishes a dirty opaque artifact and completes with canonical opaque artifacts in place", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-complete-")); initRepo(rootDir);
  const repoId = workspaceId("artifact-complete"), binding = { actor, source: "local" as const };
  let cell: Awaited<ReturnType<typeof openRepoCell>> | null = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-complete" });
  const taskId = "task-complete", executionId = "exe-complete";
  try {
    assert.equal((await cell.run({ kind: "task-create", taskId, title: "Complete" }, binding)).outcome, "applied");
    writeFileSync(path.join(rootDir, "gen.mjs"), "export const generated = true;\n");
    const added = await cell.run({ kind: "task-artifact-add", taskId, source: "gen.mjs", destination: "scripts/gen.mjs" }, binding) as Record<string, unknown>;
    assert.equal(added.outcome, "applied", JSON.stringify(added));
    const packagePath = String(added.destination).split("/artifacts/")[0]!, manual = `${packagePath}/artifacts/reports/manual.html`;
    write(rootDir, manual, "<!doctype html>\n<title>Manual report</title>\n");
    await reachGreenInReview(cell, rootDir, taskId, executionId, packagePath);
    const completed = await cell.run({ kind: "task-complete", taskId, executionId, ci: "passed", paths: ["packages/kernel/src/domain/task.ts"] }, binding) as Record<string, unknown>;
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    assert.equal(completed.commitSha, null);
    const store = makeTaskEventStore({ repoId, rootDir });
    assert.equal(store.read().events.some((event) => event.schema === "doc-event/v1" && event.payload.changes.some((change) => change.path === manual)), true, "completion must publish the dirty opaque artifact");
    assert.equal(store.read().events.some((event) => event.type === "task_completed"), true);
    assert.equal(readFileSync(path.join(rootDir, "harness", manual), "utf8"), "<!doctype html>\n<title>Manual report</title>\n");
    await cell.close();
    cell = null;
    assert.equal(git(rootDir, "status", "--porcelain", "-uall").includes("manual.html"), false, "close must drain the pending cut into Git");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

async function reachGreenInReview(cell: Awaited<ReturnType<typeof openRepoCell>>, rootDir: string, taskId: string, executionId: string, packagePath: string): Promise<string> {
  const binding = { actor, source: "local" as const };
  await cell.run({ kind: "task-start", taskId, executionId }, binding);
  writeFileSync(path.join(rootDir, "harness", `${packagePath}/closeout.md`), "# Closeout\n\n## Summary\n\nDone.\n\n## Verification\n\nVerified.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNot applicable to this fixture.\n");
  assert.equal((await cell.run({ kind: "doc-submit", paths: [`${packagePath}/closeout.md`] }, binding)).outcome, "applied");
  const commitSha = git(rootDir, "rev-parse", "HEAD");
  writeFileSync(path.join(rootDir, "submission.json"), JSON.stringify({ completionClaim: "Implemented.", deliverables: ["opaque artifacts"], outputs: [`${packagePath}/closeout.md`], verificationNotes: ["verified"], knownGaps: [], residualRisks: [], commitSha }));
  await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, binding);
  writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict: "approved", reason: "Approved.", evidenceChecked: ["verified"] }));
  const reviewed = await cell.run({ kind: "task-review-execution", taskId, executionId, reviewId: "review-opaque", fromFile: "review.json" }, reviewerBinding) as unknown as Record<string, unknown>;
  writeFileSync(path.join(rootDir, "consent.json"), JSON.stringify({ reviewDigest: reviewed.reviewDigest, contentDigest: reviewed.contentDigest }));
  await cell.run({ kind: "task-review-consent", taskId, executionId, reviewId: "review-opaque", consentId: "consent-opaque", fromFile: "consent.json" }, binding);
  return commitSha;
}

async function blockedRow(cell: Awaited<ReturnType<typeof openRepoCell>>, logical: string): Promise<readonly unknown[]> {
  const dry = await cell.run({ kind: "doc-dry-run", paths: [logical] }, { actor, source: "local" }) as Record<string, unknown>;
  const row = rows(String(dry.evidence)).find((candidate) => candidate.path === logical);
  assert.equal(row?.state, "blocked", JSON.stringify(row));
  return [row?.path, row?.reason];
}
function rows(evidence: string): readonly { readonly path: string; readonly state: string; readonly reason: string | null; readonly mediaType: string | null }[] { assert.match(evidence, /^doc-scan:/u); return (JSON.parse(evidence.slice("doc-scan:".length)) as { rows: readonly { path: string; state: string; reason: string | null; mediaType: string | null }[] }).rows; }
function write(rootDir: string, target: string, body: string): void { const file = path.join(rootDir, "harness", target); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); }
function initRepo(rootDir: string): void { git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Doc Opaque Test"); git(rootDir, "config", "user.email", "doc-opaque@example.invalid"); git(rootDir, "config", "gc.auto", "0"); git(rootDir, "commit", "--allow-empty", "-qm", "base"); }
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }

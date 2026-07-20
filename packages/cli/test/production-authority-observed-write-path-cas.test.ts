// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { decisionEntityId, taskEntityId, type WriteOp } from "../../kernel/src/index.ts";
import type { ParsedCommand } from "../src/cli/types.ts";
import { productionObservedWriteAttemptIntent, resolveHostedDocument } from "@harness-anything/daemon";

test("observed-write path CAS matches the authority read set for slugged task packages", () => {
  const fixture = createPathCasFixture();
  try {
    const one = `tasks/${fixture.sourceTaskId}/INDEX.md`;
    const two = [one, `tasks/${fixture.targetTaskId}/INDEX.md`];
    const operation = (kind: WriteOp["kind"], entityId = taskEntityId(fixture.sourceTaskId), payload: unknown = {
      path: "INDEX.md", body: fixture.body
    }) => ({ opId: "path-cas-test", entityId, kind, payload }) as WriteOp;
    const taskCommand = (action: object) => ({ action } as unknown as ParsedCommand);

    const cases = [
      ["task-amend", taskCommand({ kind: "task-amend", taskId: fixture.sourceTaskId, patches: [] }), operation("doc_write"), [one]],
      ["task-archive", taskCommand({ kind: "task-archive", taskId: fixture.sourceTaskId, reason: "done" }), operation("package_archive"), [one]],
      ["task-delete soft", taskCommand({ kind: "task-delete", taskId: fixture.sourceTaskId, mode: "soft", reason: "cleanup" }), operation("package_tombstone"), [one]],
      ["task-reopen", taskCommand({ kind: "task-reopen", taskId: fixture.sourceTaskId, reason: "needed" }), operation("package_reopen"), [one]],
      ["task-relate", taskCommand({
        kind: "task-relate", sourceTaskId: fixture.sourceTaskId, targetTaskId: fixture.targetTaskId,
        relationType: "depends-on", rationale: "needs target", dryRun: false
      }), operation("doc_write"), two],
      ["task-supersede existing", taskCommand({
        kind: "task-supersede", oldTaskId: fixture.sourceTaskId, byTaskId: fixture.targetTaskId
      }), operation("package_archive"), two],
      ["task-supersede writes", taskCommand({ kind: "task-supersede", oldTaskId: fixture.sourceTaskId }), operation(
        "package_supersede", taskEntityId(fixture.sourceTaskId), {
          writes: [
            { taskId: fixture.sourceTaskId, path: "INDEX.md", body: fixture.body },
            { taskId: fixture.newTaskId, path: "INDEX.md", body: fixture.body, packageSlug: "replacement" },
            { taskId: fixture.newTaskId, path: "relations.md", body: "replacement relation", packageSlug: "replacement" }
          ]
        }
      ), [one]],
      ["decision-relation-replace task write", taskCommand({
        kind: "decision-relation-replace", decisionId: fixture.decisionId, relationId: "rel_old"
      }), operation("relation_replace", decisionEntityId(fixture.decisionId), {
        decision: {
          schema: "decision-package/v1", decision_id: fixture.decisionId, title: "Path CAS", state: "proposed",
          riskTier: "medium", urgency: "medium", vertical: "software/coding", preset: "architecture-decision",
          applies_to: { modules: ["cli"], productLines: [] }, proposedAt: "2026-07-19T00:00:00.000Z",
          provenance: [{ runtime: "codex", sessionId: "path-cas-test", boundAt: "2026-07-19T00:00:00.000Z" }],
          question: "Does CAS resolve slugged tasks?", chosen: [{ id: "CH1", text: "Yes" }],
          rejected: [{ id: "RJ1", text: "No", why_not: "The shared resolver finds them." }], claims: [],
          relations: [{
            relation_id: "rel_new", source: `decision/${fixture.decisionId}`, target: `task/${fixture.sourceTaskId}`,
            type: "derives", strength: "strong", direction: "directed", origin: "declared",
            rationale: "materialize task priority", state: "active"
          }]
        },
        taskWrites: [{ taskId: fixture.sourceTaskId, path: "INDEX.md", body: fixture.body }]
      }), [`decisions/decision-${fixture.decisionId}/decision.md`, one]]
    ] as const;

    for (const [label, command, write, expected] of cases) {
      const intent = productionObservedWriteAttemptIntent(command, write, fixture.authoredRoot);
      assert.deepEqual(intent.declaredPathCas.map((entry) => entry.path), expected, label);
    }

    const resolved = resolveHostedDocument(fixture.authoredRoot, one);
    assert.ok(resolved);
    assert.equal(resolved.portablePath, one);
    // portablePath stays logical (forward slashes, asserted above); physicalPath is a native
    // path, so build the expected suffix with path.join rather than hard-coding a separator.
    const sluggedSuffix = path.join(`${fixture.sourceTaskId}-source`, "INDEX.md");
    assert.ok(
      resolved.physicalPath.endsWith(sluggedSuffix),
      `physicalPath should resolve into the slugged package (expected suffix ${sluggedSuffix}): ${resolved.physicalPath}`
    );
  } finally {
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("observed-write attempt compilation fails explicitly when required path CAS cannot resolve", () => {
  const fixture = createPathCasFixture();
  try {
    const missingTaskId = "task_01KXT3E1MN1VBS64DCNZ4VX99Z";
    assert.throws(() => productionObservedWriteAttemptIntent({
      action: { kind: "task-amend", taskId: missingTaskId, patches: [] }
    } as unknown as ParsedCommand, {
      opId: "path-cas-test", entityId: taskEntityId(missingTaskId), kind: "doc_write",
      payload: { path: "INDEX.md", body: fixture.body }
    }, fixture.authoredRoot), new RegExp(`AUTHORITY_CANONICAL_HOST_DOCUMENT_REQUIRED:path=tasks/${missingTaskId}/INDEX\\.md`, "u"));
  } finally {
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("task archive observed-write intent requires the selected task entity", () => {
  const fixture = createPathCasFixture();
  try {
    const command = {
      action: { kind: "task-archive", taskId: fixture.sourceTaskId, reason: "archive regression" }
    } as unknown as ParsedCommand;
    const matchingOperation = {
      opId: "archive-entity-match",
      entityId: taskEntityId(fixture.sourceTaskId),
      kind: "package_archive",
      payload: { path: "INDEX.md", body: fixture.body }
    } satisfies WriteOp;

    const intent = productionObservedWriteAttemptIntent(command, matchingOperation, fixture.authoredRoot);
    assert.equal(intent.physicalEntityId, taskEntityId(fixture.sourceTaskId));

    assert.throws(() => productionObservedWriteAttemptIntent(command, {
      ...matchingOperation,
      entityId: "module/distill-candidate"
    }, fixture.authoredRoot), /AUTHORITY_TASK_ARCHIVE_OPERATION_MISMATCH/u);
  } finally {
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

function createPathCasFixture() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-observed-path-cas-"));
  const authoredRoot = path.join(rootDir, "harness");
  const sourceTaskId = "task_01KXT3E1MN1VBS64DCNZ4VX82B";
  const targetTaskId = "task_01KXT3E1MN1VBS64DCNZ4VX82C";
  const newTaskId = "task_01KXT3E1MN1VBS64DCNZ4VX82D";
  const decisionId = "dec_01KXT3E1MN1VBS64DCNZ4VX82E";
  const taskBody = (taskId: string) => `---\nschema: task-package/v2\ntask_id: ${taskId}\n---\n`;
  mkdirSync(authoredRoot, { recursive: true });
  writeFileSync(path.join(authoredRoot, "harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n");
  for (const [taskId, slug] of [[sourceTaskId, "source"], [targetTaskId, "target"]]) {
    const taskRoot = path.join(authoredRoot, "tasks", `${taskId}-${slug}`);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskBody(taskId));
  }
  const decisionRoot = path.join(authoredRoot, "decisions", `decision-${decisionId}`);
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(path.join(decisionRoot, "decision.md"), "# Decision\n");
  return { rootDir, authoredRoot, sourceTaskId, targetTaskId, newTaskId, decisionId, body: taskBody(sourceTaskId) };
}

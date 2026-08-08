// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { compileManagedCandidateTreeV2 } from "../src/index.ts";
import {
  compileRegistryMutationPlan,
  createWritableEntityRegistry,
  entityRegistry,
  ManagedSemanticDiffError
} from "../../kernel/src/index.ts";

test("managed heading regions merge multi-file task prose without guessing the subject from its path", () => {
  const taskId = "task_T";
  const indexPath = `tasks/${taskId}-folder/INDEX.md`;
  const planPath = `tasks/${taskId}-folder/task_plan.md`;
  const briefPath = `tasks/${taskId}-folder/brief.md`;
  const base = {
    documents: [
      { path: indexPath, body: taskIndex(taskId, "active") },
      { path: planPath, body: managedBody("Plan", "## Goal", "Old goal") },
      { path: briefPath, body: managedBody("Brief", "## Summary", "Old summary") }
    ]
  };
  const candidate = {
    documents: [
      { path: indexPath, body: taskIndex(taskId, "active") },
      { path: planPath, body: managedBody("Plan", "## Goal", "New goal") },
      { path: briefPath, body: managedBody("Brief", "## Summary", "New summary") }
    ]
  };
  const mutationPlan = compileManagedCandidateTreeV2(base, candidate, [
    freeProsePolicy(planPath, "## Goal"),
    freeProsePolicy(briefPath, "## Summary")
  ], [{ kind: "task", semanticDiff: entityRegistry.task.semanticDiff }]);
  assert.equal(mutationPlan.mutations.length, 1);
  assert.deepEqual(mutationPlan.mutations[0]?.identity, { taskId });
  assert.equal(mutationPlan.mutations[0]?.action, "document");
  const compiled = compileRegistryMutationPlan(createWritableEntityRegistry([entityRegistry.task]), mutationPlan);
  assert.deepEqual(compiled.storagePlan.touchedPaths, [briefPath, planPath]);

  assert.throws(() => compileManagedCandidateTreeV2({
    documents: [{ path: planPath, body: managedBody("Plan", "## Goal", "Old goal") }]
  }, {
    documents: [{ path: planPath, body: managedBody("Plan", "## Goal", "New goal") }]
  }, [freeProsePolicy(planPath, "## Goal")], [{ kind: "task", semanticDiff: entityRegistry.task.semanticDiff }]), /SEMANTIC_DIFF_REQUIRED:task identity must come from INDEX\.md/u);
});

test("managed heading regions fail closed on undeclared, duplicate, machine-written, and forbidden edits", () => {
  const documentPath = "tasks/task_T-folder/task_plan.md";
  const index = { path: "tasks/task_T-folder/INDEX.md", body: taskIndex("task_T", "active") };
  const compile = (baseBody: string, candidateBody: string, writeMode: "free-prose" | "machine-written" | "forbidden") =>
    compileManagedCandidateTreeV2({ documents: [index, { path: documentPath, body: baseBody }] }, {
      documents: [index, { path: documentPath, body: candidateBody }]
    }, [{
      path: documentPath,
      sections: [{
        anchor: "## Goal",
        writeMode,
        ...(writeMode === "free-prose" ? { semanticClass: "host-prose-only" as const } : {})
      }]
    }], [{ kind: "task", semanticDiff: entityRegistry.task.semanticDiff }]);

  assert.throws(() => compile(
    managedBody("Plan", "## Goal", "Old"),
    `${managedBody("Plan", "## Goal", "New")}\n## Surprise\n\nUndeclared.\n`,
    "free-prose"
  ), (error: unknown) => error instanceof ManagedSemanticDiffError
    && error.code === "SEMANTIC_DIFF_REQUIRED"
    && /undeclared section/u.test(error.message));
  assert.throws(() => compile(
    managedBody("Plan", "## Goal", "Old"),
    `${managedBody("Plan", "## Goal", "New")}\n## Goal\n\nDuplicate.\n`,
    "free-prose"
  ), (error: unknown) => error instanceof ManagedSemanticDiffError
    && error.code === "SEMANTIC_DIFF_AMBIGUOUS"
    && /duplicate heading/u.test(error.message));
  assert.throws(() => compile(
    managedBody("Plan", "## Goal", "Old"), managedBody("Plan", "## Goal", "New"), "machine-written"
  ), /SEMANTIC_DIFF_REQUIRED:machine-written section requires typed command/u);
  assert.throws(() => compile(
    managedBody("Plan", "## Goal", "Old"), managedBody("Plan", "## Goal", "New"), "forbidden"
  ), /SEMANTIC_DIFF_REQUIRED:forbidden section changed/u);
});

test("host-prose policies allow undeclared sections without weakening their declared skeleton", () => {
  const taskId = "task_T";
  const documentPath = `tasks/${taskId}-folder/task_plan.md`;
  const index = { path: `tasks/${taskId}-folder/INDEX.md`, body: taskIndex(taskId, "active") };
  const policy = {
    ...freeProsePolicy(documentPath, "## Goal"),
    undeclaredSections: "allow" as const
  };

  assert.doesNotThrow(() => compileManagedCandidateTreeV2({
    documents: [index, { path: documentPath, body: managedBody("Plan", "## Goal", "Old") }]
  }, {
    documents: [index, {
      path: documentPath,
      body: `${managedBody("Plan", "## Goal", "Old")}\n## Review Addendum\n\nNew context.\n`
    }]
  }, [policy], [{ kind: "task", semanticDiff: entityRegistry.task.semanticDiff }]));

  assert.throws(() => compileManagedCandidateTreeV2({
    documents: [index, { path: documentPath, body: managedBody("Plan", "## Goal", "Old") }]
  }, {
    documents: [index, { path: documentPath, body: managedBody("Plan", "## Purpose", "Old") }]
  }, [policy], [{ kind: "task", semanticDiff: entityRegistry.task.semanticDiff }]),
  /SEMANTIC_DIFF_AMBIGUOUS:.*## Goal/u);
});

function taskIndex(
  taskId: string,
  status: string,
  packageDisposition: "active" | "archived" | "tombstoned" = "active"
): string {
  return [
    "---", "schema: task-package/v2", `task_id: ${taskId}`, `title: ${taskId}`,
    "lifecycle:", "  bindingSchema: lifecycle-binding/v1", "  engine: local", `  status: ${status}`,
    "  ref: ", `  titleSnapshot: ${taskId}`, "  url: ",
    "  bindingCreatedAt: 2026-07-14T00:00:00.000Z", `  bindingFingerprint: sha256:${"b".repeat(64)}`,
    `packageDisposition: ${packageDisposition}`, "vertical: default", "preset: default",
    "provenance:", "  - {runtime: codex, sessionId: session-w3, boundAt: 2026-07-14T00:00:00.000Z}",
    "---", "", `# ${taskId}`, ""
  ].join("\n");
}

function managedBody(title: string, anchor: string, body: string): string {
  return [`# ${title}`, "", anchor, "", body, ""].join("\n");
}

function freeProsePolicy(pathValue: string, anchor: string) {
  return {
    path: pathValue,
    sections: [{ anchor, writeMode: "free-prose" as const, semanticClass: "host-prose-only" as const }]
  };
}

// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { readTaskEscalations, renderTaskEscalations } from "../src/queries/task-escalation-context.ts";
import { renderEvidencePayload } from "../src/queries/repo-cell-evidence.ts";

const taskId = "task_ruling",
  packagePath = "tasks/task_ruling",
  actor = {
    principal: { personId: "person_owner" },
    executor: { kind: "agent" as const, id: "ceo" },
  };
function fixture() {
  const documents = new Map<string, { body: string; workspaceRevision: number }>();
  const projection = {
    readTaskIndex: () => ({ rows: [{ taskId, packagePath }] }),
    readDocuments: () => ({ documents: [...documents.keys()].map((path) => ({ path })) }),
    readDocument: (path: string) => ({ document: documents.get(path) ?? null }),
    readEventWitness: () => ({ actor }),
  } as never;
  const add = (number: number, question: string, answer: string, revision: number) => {
    const dispatchId = `dispatch_${number.toString(16).padStart(24, "0")}`,
      questionPath = `${packagePath}/artifacts/rulings/${dispatchId}.md`,
      resolutionPath = `${packagePath}/artifacts/rulings/${dispatchId}.resolution.md`;
    documents.set(questionPath, {
      body: JSON.stringify({ schema: "worker-escalation/v1", taskId, dispatchId, question, status: "awaiting" }),
      workspaceRevision: revision - 1,
    });
    documents.set(resolutionPath, {
      body: JSON.stringify({
        schema: "worker-escalation-resolution/v1",
        taskId,
        dispatchId,
        answer,
        answeredAt: "2026-11-17T00:00:00Z",
      }),
      workspaceRevision: revision,
    });
    return { dispatchId, questionPath, resolutionPath };
  };
  return { projection, documents, add };
}

test("all distinct resolved questions survive; the later ledger answer replaces only the same question", () => {
  const f = fixture(),
    first = f.add(1, "Which boundary?", "Old answer", 20),
    other = f.add(2, "Which tests?", "Run focused tests", 30),
    replacement = f.add(3, "  Which boundary?  ", "Keep it", 40);
  // Enumeration and wall-clock order do not define authority.
  const earlier = f.add(4, "Which boundary?", "Earlier revision inserted last", 10);
  const records = readTaskEscalations(f.projection, taskId);
  assert.deepEqual(
    records.map(({ dispatchId }) => dispatchId),
    [other.dispatchId, replacement.dispatchId],
  );
  assert.deepEqual(records[1]?.actor, actor);
  assert.equal(records[1]?.question, "Which boundary?");
  const text = renderTaskEscalations(records)!;
  for (const expected of [
    "Which boundary?",
    "Keep it",
    "Which tests?",
    "Run focused tests",
    "person_owner",
    "agent:ceo",
    "2026-11-17T00:00:00Z",
    replacement.resolutionPath,
  ])
    assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes(first.dispatchId));
  assert.ok(!text.includes(earlier.dispatchId));
});

test("an unresolved or mismatched ruling does not become owner context", () => {
  const f = fixture(),
    { questionPath, resolutionPath } = f.add(1, "Question", "Answer", 2);
  f.documents.delete(resolutionPath);
  assert.deepEqual(readTaskEscalations(f.projection, taskId), []);
  f.documents.set(resolutionPath, {
    body: JSON.stringify({
      schema: "worker-escalation-resolution/v1",
      taskId: "another",
      dispatchId: "dispatch_000000000000000000000001",
      answer: "Wrong task",
      answeredAt: "2026-11-17T00:00:00Z",
    }),
    workspaceRevision: 3,
  });
  assert.deepEqual(readTaskEscalations(f.projection, taskId), []);
  f.add(1, "Question", "Answer", 2);
  f.documents.delete(questionPath);
  assert.deepEqual(readTaskEscalations(f.projection, taskId), []);
});

test("legacy awaiting frontmatter joins its immutable answer without changing stored bytes", () => {
  const f = fixture(),
    { questionPath } = f.add(1, "Question", "Keep it", 2);
  f.documents.set(questionPath, {
    body: "---\nruling: awaiting\nquestion: Which boundary?\n---\n",
    workspaceRevision: 1,
  });
  assert.equal(readTaskEscalations(f.projection, taskId)[0]?.question, "Which boundary?");
});

test("read-set text renders the same question, answer, actor, timestamp and source paths", () => {
  const f = fixture();
  f.add(1, "Which boundary?", "Keep it", 2);
  const escalations = readTaskEscalations(f.projection, taskId),
    text = renderEvidencePayload({
      schema: "read-set/v1",
      entries: [],
      escalations,
      taskRef: `task/${taskId}`,
      blocked: false,
    });
  assert.ok(text?.includes(renderTaskEscalations(escalations)!));
});

test("the canonical dispatch archive preserves the question when the working ruling is cleared", () => {
  const f = fixture(),
    { dispatchId, questionPath } = f.add(1, "Which boundary?", "Keep it", 2),
    original = f.documents.get(questionPath)!.body,
    archivePath = `${packagePath}/artifacts/dispatches/${dispatchId}.json`;
  f.documents.set(questionPath, { body: "", workspaceRevision: 3 });
  f.documents.set(archivePath, {
    body: JSON.stringify({
      schema: "runtime-dispatch/v1",
      taskId,
      dispatchId,
      classification: "awaiting_ruling",
      reason: JSON.parse(original).question,
    }),
    workspaceRevision: 2,
  });
  const record = readTaskEscalations(f.projection, taskId)[0]!;
  assert.equal(record.question, "Which boundary?");
  assert.equal(record.answer, "Keep it");
  assert.equal(record.questionPath, archivePath);
});

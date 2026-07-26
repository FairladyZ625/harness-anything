export const taskProgressParseCases = [
  {
    name: "execution submit infers the active lease without token replay",
    argv: ["task", "transition", "task_1", "in_review", "--completion-claim", "ready"],
    kind: "status-set",
    fields: {
      taskId: "task_1",
      status: "in_review",
      force: false,
      executionSubmission: {
        completionClaim: "ready",
        deliverables: [],
        verificationNotes: [],
        knownGaps: [],
        residualRisks: [],
        outputs: []
      }
    }
  },
  {
    name: "progress append repeated evidence",
    argv: ["task", "progress", "append", "task_1", "--text", "hello", "--evidence", "log:artifacts/run.log:passed", "--evidence", "test:artifacts/unit.log:green"],
    kind: "progress-append",
    fields: { taskId: "task_1", text: "hello", evidence: [{ type: "log", path: "artifacts/run.log", summary: "passed" }, { type: "test", path: "artifacts/unit.log", summary: "green" }] }
  },
  {
    name: "task artifact add",
    argv: ["task", "artifact", "add", "task_1", "report.txt", "notes.md"],
    kind: "artifact-add",
    fields: { taskId: "task_1", sourcePaths: ["report.txt", "notes.md"] }
  }
] as const;

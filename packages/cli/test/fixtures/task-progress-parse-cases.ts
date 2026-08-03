export const taskProgressParseCases = [
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
